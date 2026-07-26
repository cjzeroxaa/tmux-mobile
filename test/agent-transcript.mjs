import assert from "node:assert/strict";
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  agentTranscriptSnapshotMetrics,
  findClaudeSessionFromBackend,
  findClaudeTranscriptFromSessionFile,
  localBackend,
  processTreeFromSnapshot,
  readClaudeTranscriptFromSession,
  readLocalAgentTranscript,
  resetAgentTranscriptSnapshotCache,
  selectNewestOpenTranscriptPath,
} from "../lib/backend.mjs";

const tmp = await mkdtemp(path.join(os.tmpdir(), "tmux-mobile-agent-transcript-"));

try {
  const cwd = "/Users/test/src/project";
  const projectDir = path.join(tmp, ".claude", "projects", "-Users-test-src-project");
  const sessionsDir = path.join(tmp, ".claude", "sessions");
  await mkdir(projectDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });

  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  await writeFile(path.join(projectDir, `${first}.jsonl`), "{}\n");
  await writeFile(path.join(projectDir, `${second}.jsonl`), "{}\n");
  await writeFile(
    path.join(sessionsDir, "101.json"),
    JSON.stringify({ pid: 101, sessionId: first, cwd }),
  );
  await writeFile(
    path.join(sessionsDir, "202.json"),
    JSON.stringify({ pid: 202, sessionId: second, cwd }),
  );

  assert.equal(
    await findClaudeTranscriptFromSessionFile(101, cwd, { homeDir: tmp }),
    path.join(projectDir, `${first}.jsonl`),
    "pid 101 maps to its own Claude transcript",
  );
  assert.equal(
    await findClaudeTranscriptFromSessionFile(202, cwd, { homeDir: tmp }),
    path.join(projectDir, `${second}.jsonl`),
    "pid 202 maps to its own Claude transcript even with the same cwd",
  );
  assert.equal(
    await findClaudeTranscriptFromSessionFile(202, "/Users/test/src/other", { homeDir: tmp }),
    "",
    "cwd mismatch is ignored instead of crossing sessions",
  );

  await writeFile(
    path.join(projectDir, `${first}.jsonl`),
    [
      JSON.stringify({ type: "mode", sessionId: first }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-06-11T01:00:00.000Z",
        message: { role: "user", content: "first prompt" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-11T01:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "first response" }] },
      }),
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(projectDir, `${second}.jsonl`),
    [
      JSON.stringify({ type: "mode", sessionId: second }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-06-11T02:00:00.000Z",
        message: { role: "user", content: "second prompt" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-11T02:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "second response" }] },
      }),
      "",
    ].join("\n"),
  );

  const fakeRemoteBackend = {
    async processTree(rootPid) {
      return [
        { pid: rootPid, ppid: 1, command: "zsh" },
        { pid: rootPid + 1000, ppid: rootPid, command: "claude --dangerously-skip-permissions" },
      ];
    },
    async readfile(filePath, { maxBytes } = {}) {
      const resolved = String(filePath).replace(/^~/, tmp);
      const buffer = await readFile(resolved);
      const slice = maxBytes && buffer.length > maxBytes ? buffer.subarray(0, maxBytes) : buffer;
      return {
        base64: slice.toString("base64"),
        size: buffer.length,
        truncated: slice.length < buffer.length,
      };
    },
  };
  await writeFile(
    path.join(sessionsDir, "1101.json"),
    JSON.stringify({ pid: 1101, sessionId: first, cwd }),
  );
  await writeFile(
    path.join(sessionsDir, "1202.json"),
    JSON.stringify({ pid: 1202, sessionId: second, cwd }),
  );

  const firstSession = await findClaudeSessionFromBackend(fakeRemoteBackend, {
    rootPid: 101,
    cwd,
  });
  const secondSession = await findClaudeSessionFromBackend(fakeRemoteBackend, {
    rootPid: 202,
    cwd,
  });
  assert.equal(firstSession.sessionId, first, "remote root pid 101 maps to first session id");
  assert.equal(secondSession.sessionId, second, "remote root pid 202 maps to second session id");

  const snapshotSession = await findClaudeSessionFromBackend(
    {
      ...fakeRemoteBackend,
      async processTree() {
        throw new Error("supplied process snapshot should be reused");
      },
    },
    {
      rootPid: 101,
      cwd,
      processes: await fakeRemoteBackend.processTree(101),
    },
  );
  assert.equal(
    snapshotSession.sessionId,
    first,
    "supplied pane processes avoid another backend process-tree query",
  );

  const firstTranscript = await readClaudeTranscriptFromSession(fakeRemoteBackend, firstSession);
  const secondTranscript = await readClaudeTranscriptFromSession(fakeRemoteBackend, secondSession);
  assert.equal(firstTranscript.turns.at(-1).text, "first response");
  assert.equal(secondTranscript.turns.at(-1).text, "second response");

  const oldCodexTranscript = "/Users/test/.codex/sessions/old.jsonl";
  const newCodexTranscript = "/Users/test/.codex/sessions/new.jsonl";
  const mixedCodexLsof = [
    `codex 123 test 40w REG 1,15 100 111 ${oldCodexTranscript}`,
    `codex 123 test 48w REG 1,15 100 222 ${newCodexTranscript}`,
  ].join("\n");
  const newest = await selectNewestOpenTranscriptPath(mixedCodexLsof, "codex", async (filePath) => ({
    mtimeMs: filePath === newCodexTranscript ? 200 : 100,
  }));
  assert.equal(
    newest,
    newCodexTranscript,
    "Codex transcript selection uses the most recently written open rollout, not lsof order",
  );

  const mixedOpenFilesRoot = path.join(tmp, "mixed-open-files");
  const mixedCodexPath = path.join(
    mixedOpenFilesRoot,
    ".codex",
    "sessions",
    "33333333-3333-4333-8333-333333333333.jsonl",
  );
  const mixedClaudePath = path.join(
    mixedOpenFilesRoot,
    ".claude",
    "projects",
    "project",
    "44444444-4444-4444-8444-444444444444.jsonl",
  );
  const mixedCodexSubagentPath = path.join(
    mixedOpenFilesRoot,
    ".codex",
    "sessions",
    "55555555-5555-4555-8555-555555555555.jsonl",
  );
  await mkdir(path.dirname(mixedCodexPath), { recursive: true });
  await mkdir(path.dirname(mixedClaudePath), { recursive: true });
  await writeFile(
    mixedCodexPath,
    [
      JSON.stringify({
        type: "session_meta",
        payload: { source: "cli" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "correct codex transcript" }],
        },
      }),
      "",
    ].join("\n"),
  );
  await writeFile(
    mixedCodexSubagentPath,
    [
      JSON.stringify({
        type: "session_meta",
        payload: { source: { subagent: { thread_spawn: {} } } },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "subagent transcript" }],
        },
      }),
      "",
    ].join("\n"),
  );
  await writeFile(mixedClaudePath, "{}\n");
  const mixedOpenFilesResult = await localBackend.agentTranscript({
    rootPid: 303,
    cwd: mixedOpenFilesRoot,
    foregroundCommand: "codex",
    processes: [{ pid: 303, ppid: 1, command: "codex" }],
    openFiles: new Map([
      [
        303,
        [mixedClaudePath, mixedCodexSubagentPath, mixedCodexPath],
      ],
    ]),
  });
  assert.equal(
    mixedOpenFilesResult.kind,
    "codex",
    "global open-file snapshots do not mix Claude paths into Codex selection",
  );
  assert.equal(mixedOpenFilesResult.transcriptPath, mixedCodexPath);
  assert.notEqual(
    mixedOpenFilesResult.transcriptPath,
    mixedCodexSubagentPath,
    "a newer subagent rollout does not replace the pane's root Codex session",
  );
  assert.equal(
    mixedOpenFilesResult.turns.at(-1).text,
    "correct codex transcript",
  );

  const processSnapshot = [
    { pid: 10, ppid: 1, command: "zsh" },
    { pid: 20, ppid: 10, command: "node /usr/bin/codex" },
    { pid: 30, ppid: 20, command: "codex --yolo" },
    { pid: 40, ppid: 1, command: "unrelated" },
  ];
  assert.deepEqual(
    processTreeFromSnapshot(processSnapshot, 10).map(({ pid }) => pid),
    [10, 20, 30],
    "one process snapshot derives a pane subtree without another ps call",
  );
  assert.deepEqual(
    processTreeFromSnapshot(processSnapshot, 999),
    [],
    "missing process roots produce an empty subtree",
  );

  const cachePath = path.join(tmp, "incremental-codex.jsonl");
  const codexRecord = (role, text) =>
    JSON.stringify({
      type: "response_item",
      timestamp: `2026-07-25T00:00:0${text.length}.000Z`,
      payload: {
        type: "message",
        role,
        content: [
          {
            type: role === "assistant" ? "output_text" : "input_text",
            text,
          },
        ],
      },
    });
  await writeFile(
    cachePath,
    `${codexRecord("user", "one")}\n${codexRecord("assistant", "two")}\n`,
  );
  resetAgentTranscriptSnapshotCache();
  const firstCached = await readLocalAgentTranscript("codex", cachePath);
  assert.equal(firstCached.total, 2, "initial cached transcript parses existing turns");
  const afterFirst = agentTranscriptSnapshotMetrics();
  assert.equal(afterFirst.rebuilds, 1, "initial cached transcript performs one rebuild");
  assert.ok(afterFirst.bytesRead > 0, "initial cached transcript reads file bytes");

  const unchangedCached = await readLocalAgentTranscript("codex", cachePath);
  assert.deepEqual(unchangedCached, firstCached, "unchanged transcript reuses its summary");
  const afterUnchanged = agentTranscriptSnapshotMetrics();
  assert.equal(
    afterUnchanged.bytesRead,
    afterFirst.bytesRead,
    "unchanged transcript performs no additional range read",
  );
  assert.equal(afterUnchanged.cacheHits, 1, "unchanged transcript records a cache hit");

  const appended = `${codexRecord("assistant", "three")}\n`;
  await appendFile(cachePath, appended);
  const afterAppend = await readLocalAgentTranscript("codex", cachePath);
  assert.equal(afterAppend.total, 3, "append increments the cached turn count");
  assert.equal(afterAppend.turns.at(-1).text, "three", "append updates the last turn");
  const appendMetrics = agentTranscriptSnapshotMetrics();
  assert.equal(appendMetrics.appends, 1, "growth uses the incremental append path");
  assert.ok(
    appendMetrics.bytesRead - afterUnchanged.bytesRead <=
      Buffer.byteLength(appended) + 4 * 1024,
    "append reads only the new bytes plus a small rewrite boundary",
  );

  const unicodeLine = Buffer.from(`${codexRecord("user", "跨 chunk 的中文")}\n`);
  const splitAt = unicodeLine.indexOf(Buffer.from("中")) + 1;
  await appendFile(cachePath, unicodeLine.subarray(0, splitAt));
  const partial = await readLocalAgentTranscript("codex", cachePath);
  assert.equal(partial.total, 3, "partial JSONL does not create a turn");
  await appendFile(cachePath, unicodeLine.subarray(splitAt));
  const completed = await readLocalAgentTranscript("codex", cachePath);
  assert.equal(completed.total, 4, "partial JSONL is completed exactly once");
  assert.equal(
    completed.turns.at(-1).text,
    "跨 chunk 的中文",
    "UTF-8 split across appends is preserved",
  );

  await writeFile(cachePath, `${codexRecord("assistant", "after truncate")}\n`);
  const truncated = await readLocalAgentTranscript("codex", cachePath);
  assert.equal(truncated.total, 1, "truncate rebuilds the cached transcript");
  assert.equal(truncated.turns.at(-1).text, "after truncate");

  const replacementPath = `${cachePath}.replacement`;
  await writeFile(replacementPath, `${codexRecord("assistant", "replacement inode")}\n`);
  await rename(replacementPath, cachePath);
  const replaced = await readLocalAgentTranscript("codex", cachePath);
  assert.equal(replaced.total, 1, "inode replacement rebuilds the cached transcript");
  assert.equal(replaced.turns.at(-1).text, "replacement inode");

  const oversizedPartialPath = path.join(tmp, "oversized-partial.jsonl");
  const oversizedUserText = "x".repeat(2 * 1024 * 1024 + 1);
  await writeFile(
    oversizedPartialPath,
    codexRecord("user", oversizedUserText),
  );
  resetAgentTranscriptSnapshotCache();
  const oversizedPartial = await readLocalAgentTranscript(
    "codex",
    oversizedPartialPath,
  );
  assert.equal(oversizedPartial.total, 0, "oversized partial JSONL is ignored");
  assert.ok(
    agentTranscriptSnapshotMetrics().bufferedBytes < 64 * 1024,
    "oversized partial JSONL is not retained in the transcript cache",
  );
  await appendFile(
    oversizedPartialPath,
    `\n${codexRecord("assistant", "after oversized partial")}\n`,
  );
  const recoveredAfterOversizedPartial = await readLocalAgentTranscript(
    "codex",
    oversizedPartialPath,
  );
  assert.equal(
    recoveredAfterOversizedPartial.turns.at(-1).text,
    "after oversized partial",
    "parsing resumes after the oversized record reaches its newline",
  );
  assert.equal(
    recoveredAfterOversizedPartial.turns.at(-2).text.length,
    oversizedUserText.length,
    "the bounded rebuild recovers the complete oversized turn",
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log("agent-transcript unit tests passed");

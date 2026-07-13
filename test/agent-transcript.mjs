import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  findClaudeSessionFromBackend,
  findClaudeTranscriptFromSessionFile,
  readClaudeTranscriptFromSession,
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
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log("agent-transcript unit tests passed");

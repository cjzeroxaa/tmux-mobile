import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { codexResumeSessionId, findCodexResumeTranscript } from "../lib/codex-resume.mjs";
import { localBackend } from "../lib/backend.mjs";
const id = "01a12547-9a2e-7d73-8c9e-3fd027fbca45";
const other = "22222222-2222-4222-8222-222222222222";
const command = `node /home/test/.local/bin/codex --dangerously-bypass-approvals-and-sandbox resume ${id}`;
assert.equal(codexResumeSessionId(command), id);
assert.equal(codexResumeSessionId(`codex -c 'model="example"' resume ${id}`), id);
assert.equal(codexResumeSessionId(`node /usr/lib/codex/dist/cli.js resume ${id}`), id);
for (const cmd of [`codex --last`, "codex resume --last", `codex fork ${id}`, `codex exec 'resume ${id}'`, `claude resume ${id}`, `codex resume title`, `codex -c 'resume ${id}'`, `codex 'resume ${id}'`]) {
  assert.equal(codexResumeSessionId(cmd), "", cmd);
}
const tmp = await mkdtemp(path.join(os.tmpdir(), "codex-resume-"));
const originalRoot = process.env.TMUX_MOBILE_CODEX_TRANSCRIPT_ROOT;
try {
  const root = path.join(tmp, "sessions");
  await mkdir(root);
  const filename = path.join(root, `rollout-${id}.jsonl`);
  const otherFile = path.join(root, `rollout-${other}.jsonl`);
  const transcript = sessionId => [
    { type: "session_meta", payload: { id: sessionId, cwd: "/same/directory", source: "cli" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `Response for ${sessionId}` }] } },
  ].map(JSON.stringify).join("\n") + "\n";
  await writeFile(filename, transcript(id));
  await writeFile(otherFile, transcript(other));
  const options = { roots: [{ kind: "codex", root }] };
  assert.equal(await findCodexResumeTranscript(command, options), await realpath(filename));
  assert.equal(await findCodexResumeTranscript("codex", options), "", "never choose a transcript by cwd or modification time");
  process.env.TMUX_MOBILE_CODEX_TRANSCRIPT_ROOT = root;
  const arg = { rootPid: 101, cwd: "/same/directory", foregroundCommand: "node", processes: [{ pid: 101, ppid: 1, command }], openFiles: new Map() };
  const result = await localBackend.agentTranscript(arg);
  assert.equal(result.sessionId, id);
  assert.equal(result.turns.at(-1).text, `Response for ${id}`, "daemon-owned resumed transcript supplies the Response");
  // A live owned rollout outranks the original launch argument after /new.
  const liveRoot = path.join(tmp, ".codex", "sessions");
  await mkdir(liveRoot, { recursive: true });
  const liveFile = path.join(liveRoot, `rollout-${other}.jsonl`);
  await writeFile(liveFile, transcript(other));
  assert.equal((await localBackend.agentTranscript({ ...arg, openFiles: new Map([[101, [liveFile]]]) })).sessionId, other);
  await writeFile(filename, transcript(other));
  assert.equal(await findCodexResumeTranscript(command, options), "", "validate header identity, not just filename");
  await writeFile(filename, JSON.stringify({ type: "session_meta", payload: { id, source: { subagent: "helper" } } }) + "\n");
  assert.equal(await findCodexResumeTranscript(command, options), "", "do not attach a child transcript to its parent TUI");
  console.log("Codex resume discovery: exact UUID, daemon writer, live-file priority and rejection cases passed");
} finally {
  if (originalRoot === undefined) delete process.env.TMUX_MOBILE_CODEX_TRANSCRIPT_ROOT;
  else process.env.TMUX_MOBILE_CODEX_TRANSCRIPT_ROOT = originalRoot;
  await rm(tmp, { recursive: true, force: true });
}

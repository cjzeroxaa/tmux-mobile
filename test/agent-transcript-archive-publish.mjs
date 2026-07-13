import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(os.tmpdir(), "tmux-mobile-agent-archive-"));
const transcriptRoot = path.join(dir, "codex-sessions");
const transcriptPath = path.join(transcriptRoot, "session.jsonl");
process.env.TMUX_MOBILE_CODEX_TRANSCRIPT_ROOT = transcriptRoot;
process.env.TMUX_MOBILE_TRANSCRIPT_STATE = path.join(dir, "publisher-state.json");
process.env.TMUX_MOBILE_TRANSCRIPT_SYNC_MS = "1000";

const { createTranscriptArchive } = await import("../lib/transcript-archive.mjs");
const { createHub } = await import("../lib/hub.mjs");
const { runAgent } = await import("../lib/agent.mjs");

const OWNER = { userId: "owner@example.com", email: "owner@example.com", hd: "" };
const objects = new Map();
const storage = {
  kind: "memory",
  async put(key, bytes) {
    objects.set(key, Buffer.from(bytes));
    return { key, size: bytes.length };
  },
  async get(key) {
    const bytes = objects.get(key);
    return bytes ? { bytes: Buffer.from(bytes), size: bytes.length } : null;
  },
};
const commits = [];
const archive = createTranscriptArchive({
  storage,
  onChunkCommitted: async (item) => commits.push(item),
});
const server = http.createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, revision: "test" }));
    return;
  }
  res.writeHead(404);
  res.end();
});
const hub = createHub(server, {
  authenticateAgent: () => OWNER,
  currentRevision: "test",
  onTranscriptChunk: ({ owner, machine, chunk }) =>
    archive.commitChunk({
      ownerId: owner.userId,
      machineId: machine.machineId,
      agentId: machine.agentId,
      chunk,
    }),
});

function waitFor(label, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(async () => {
      try {
        const result = await predicate();
        if (result) {
          clearInterval(timer);
          resolve(result);
          return;
        }
      } catch (error) {
        clearInterval(timer);
        reject(error);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${label}`));
      }
    }, 25);
  });
}

await mkdir(transcriptRoot, { recursive: true });
const transcript = [
  JSON.stringify({ timestamp: "2026-07-12T00:00:00Z", type: "session_meta", payload: { id: "session-1" } }),
  JSON.stringify({ timestamp: "2026-07-12T00:00:01Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } }),
].join("\n") + "\n";
await writeFile(transcriptPath, transcript);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

let agent;
try {
  agent = runAgent(`http://127.0.0.1:${port}`, {
    async tmux() {
      return "tmux 3.5\n";
    },
  }, {
    inventoryProvider: async () => ({
      agents: [
        {
          kind: "codex",
          agentSessionId: "session-1",
          transcriptPath,
          status: "idle",
        },
      ],
    }),
  });

  await waitFor("archived transcript", () => commits.length === 1);
  assert.equal(commits[0].bytes.toString(), transcript);
  assert.equal(commits[0].agentKind, "codex");
  assert.equal(commits[0].agentSessionId, "session-1");
  assert.equal(commits[0].nextLineSeq, 2);

  const persisted = await waitFor("persisted transcript ACK cursor", async () => {
    try {
      const candidate = JSON.parse(
        await readFile(process.env.TMUX_MOBILE_TRANSCRIPT_STATE, "utf8"),
      );
      const sessionState = Object.entries(candidate.sessions || {}).find(
        ([key]) => key.startsWith("codex:session-1:file-"),
      )?.[1];
      return sessionState?.cursor?.byteOffset === Buffer.byteLength(transcript)
        ? candidate
        : null;
    } catch {
      return null;
    }
  });
  const state = Object.entries(persisted.sessions).find(
    ([key]) => key.startsWith("codex:session-1:file-"),
  )[1];
  assert.equal(state.cursor.byteOffset, Buffer.byteLength(transcript));
  assert.equal(state.cursor.lineSeq, 2);
  assert.equal(state.pending, null);

  console.log("agent transcript archive publish test passed");
} finally {
  agent?.stop();
  hub.shutdown();
  await new Promise((resolve) => server.close(resolve));
  delete process.env.TMUX_MOBILE_CODEX_TRANSCRIPT_ROOT;
  delete process.env.TMUX_MOBILE_TRANSCRIPT_STATE;
  delete process.env.TMUX_MOBILE_TRANSCRIPT_SYNC_MS;
  await rm(dir, { recursive: true, force: true });
}

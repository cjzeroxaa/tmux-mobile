import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAgentTranscriptPublisher,
  createFileTranscriptStateStore,
} from "../lib/transcript-publisher.mjs";

const dir = await mkdtemp(path.join(os.tmpdir(), "tmux-mobile-transcript-publisher-"));
const statePath = path.join(dir, "state.json");
const transcriptDir = path.join(os.homedir(), ".codex", "sessions", "publisher-test");
const transcriptPath = path.join(transcriptDir, "publisher-test.jsonl");

// Inject stat/readRange so the unit test does not create anything under the
// real ~/.codex tree; path validation still exercises the expected root.
let fileBytes = Buffer.from('{"type":"session_meta"}\n');
const fakeStat = async () => ({
  dev: 1,
  ino: 2,
  size: fileBytes.length,
  isFile: () => true,
});
const fakeReadRange = async (_filePath, start, end) => fileBytes.subarray(start, end);
const identityRealpath = async (filePath) => filePath;
const uploads = [];

try {
  const publisher = createAgentTranscriptPublisher({
    stateStore: createFileTranscriptStateStore({ filePath: statePath }),
    stat: fakeStat,
    readRange: fakeReadRange,
    realpathImpl: identityRealpath,
    createFileEpoch: () => "epoch-1",
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
    uploadChunk: async (chunk) => {
      uploads.push(chunk);
      return { ack: true, chunkId: chunk.chunkId };
    },
  });
  await publisher.observeAgents([
    {
      kind: "codex",
      agentSessionId: "session-1",
      transcriptPath,
    },
  ]);
  assert.equal(publisher.trackedSessions, 1);
  publisher.setEnabled(true);
  await publisher.syncNow();
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].agentKind, "codex");
  assert.equal(uploads[0].agentSessionId, "session-1");
  assert.equal(Buffer.from(uploads[0].base64, "base64").toString(), fileBytes.toString());

  // A new publisher process restores the tracked path and acknowledged cursor
  // from the same durable state file, then sends only appended bytes.
  fileBytes = Buffer.concat([fileBytes, Buffer.from('{"type":"event_msg"}\n')]);
  const restoredUploads = [];
  const restored = createAgentTranscriptPublisher({
    stateStore: createFileTranscriptStateStore({ filePath: statePath }),
    stat: fakeStat,
    readRange: fakeReadRange,
    realpathImpl: identityRealpath,
    createFileEpoch: () => {
      throw new Error("restored source should retain its epoch");
    },
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
    uploadChunk: async (chunk) => {
      restoredUploads.push(chunk);
      return { ack: true, chunkId: chunk.chunkId };
    },
  });
  restored.setEnabled(true);
  await restored.syncNow();
  assert.equal(restored.trackedSessions, 1);
  assert.equal(restoredUploads.length, 1);
  assert.equal(
    Buffer.from(restoredUploads[0].base64, "base64").toString(),
    '{"type":"event_msg"}\n',
  );
  publisher.stop();
  restored.stop();

  // Invalid paths never enter the registry.
  const ignored = createAgentTranscriptPublisher({
    stateStore: createFileTranscriptStateStore({ filePath: path.join(dir, "ignored.json") }),
    stat: fakeStat,
    readRange: fakeReadRange,
    realpathImpl: identityRealpath,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
    uploadChunk: async () => ({ ack: true }),
  });
  await ignored.observeAgents([
    { kind: "codex", agentSessionId: "bad", transcriptPath: "/tmp/not-codex.jsonl" },
  ]);
  assert.equal(ignored.trackedSessions, 0);
  ignored.stop();

  // Root discovery can register closed/non-active files, and two physical
  // files carrying the same vendor session id remain independent sources.
  const discoveredPublisher = createAgentTranscriptPublisher({
    stateStore: createFileTranscriptStateStore({
      filePath: path.join(dir, "discovered-state.json"),
    }),
    realpathImpl: identityRealpath,
    discoverFiles: async () => [
      {
        kind: "codex",
        agentSessionId: "shared-session",
        transcriptPath: path.join(transcriptDir, "source-a.jsonl"),
      },
      {
        kind: "codex",
        agentSessionId: "shared-session",
        transcriptPath: path.join(transcriptDir, "source-b.jsonl"),
      },
    ],
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
    uploadChunk: async () => ({ ack: true }),
  });
  discoveredPublisher.setDiscoveryEnabled(true);
  assert.equal(await discoveredPublisher.discoverNow({ force: true }), 2);
  assert.equal(discoveredPublisher.trackedSessions, 2);
  discoveredPublisher.stop();

  // Lexically-allowed symlinks cannot escape the configured transcript root.
  const symlinkRoot = path.join(dir, "allowed-root");
  const outsideTranscript = path.join(dir, "outside.jsonl");
  const escapedLink = path.join(symlinkRoot, "escaped.jsonl");
  await mkdir(symlinkRoot, { recursive: true });
  await writeFile(outsideTranscript, "{}\n");
  await symlink(outsideTranscript, escapedLink);
  const previousCodexRoot = process.env.TMUX_MOBILE_CODEX_TRANSCRIPT_ROOT;
  process.env.TMUX_MOBILE_CODEX_TRANSCRIPT_ROOT = symlinkRoot;
  try {
    const symlinkPublisher = createAgentTranscriptPublisher({
      stateStore: createFileTranscriptStateStore({
        filePath: path.join(dir, "symlink-state.json"),
      }),
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: () => {},
      uploadChunk: async () => ({ ack: true }),
    });
    await symlinkPublisher.observeAgents([
      {
        kind: "codex",
        agentSessionId: "escaped",
        transcriptPath: escapedLink,
      },
    ]);
    assert.equal(symlinkPublisher.trackedSessions, 0);
    symlinkPublisher.stop();
  } finally {
    if (previousCodexRoot == null) {
      delete process.env.TMUX_MOBILE_CODEX_TRANSCRIPT_ROOT;
    } else {
      process.env.TMUX_MOBILE_CODEX_TRANSCRIPT_ROOT = previousCodexRoot;
    }
  }

  // A corrupt optional archive state file disables transcript sync without
  // breaking the connector's inventory path.
  const corruptPath = path.join(dir, "corrupt.json");
  await writeFile(corruptPath, "not-json");
  const stateErrors = [];
  const corrupt = createAgentTranscriptPublisher({
    stateStore: createFileTranscriptStateStore({ filePath: corruptPath }),
    stat: fakeStat,
    readRange: fakeReadRange,
    realpathImpl: identityRealpath,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
    logEvent: (event) => stateErrors.push(event),
    uploadChunk: async () => {
      throw new Error("corrupt state must not attempt upload");
    },
  });
  await corrupt.observeAgents([
    { kind: "codex", agentSessionId: "corrupt", transcriptPath },
  ]);
  corrupt.setEnabled(true);
  const corruptResult = await corrupt.syncNow();
  assert.equal(corruptResult.failures, 1);
  assert.deepEqual(stateErrors, ["transcript_state_load_failed"]);
  corrupt.stop();

  // Ensure the test used the state store rather than a fixture file.
  await writeFile(path.join(dir, "marker"), "ok");
  console.log("transcript publisher tests passed");
} finally {
  await rm(dir, { recursive: true, force: true });
}

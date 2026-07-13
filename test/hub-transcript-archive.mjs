import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";
import { createHub } from "../lib/hub.mjs";
import {
  AGENT_WS_PATH,
  MSG,
  helloFrame,
  transcriptChunkFrame,
} from "../lib/protocol.mjs";

const OWNER = { userId: "owner@example.com", email: "owner@example.com", hd: "" };
const AGENT_ID = "00000000-0000-4000-8000-000000000201";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const received = [];
const server = http.createServer();
const hub = createHub(server, {
  authenticateAgent: () => OWNER,
  transcriptRootDiscovery: true,
  transcriptArchiveEnabledForMachine: ({ machine }) =>
    machine.machineId === "archive-test",
  onTranscriptChunk: async (item) => {
    received.push(item);
    if (item.chunk.fileEpoch === "reject") {
      const error = new Error("expected another cursor");
      error.code = "transcript_cursor_mismatch";
      error.expected = { committedOffset: 12, nextLineSeq: 1 };
      throw error;
    }
    return {
      chunkId: item.chunk.chunkId,
      committedOffset: item.chunk.endOffsetExclusive,
      nextLineSeq: item.chunk.nextLineSeq,
    };
  },
});

function waitForFrame(socket, predicate, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("timed out waiting for protocol frame"));
    }, timeoutMs);
    function onMessage(raw) {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!predicate(frame)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(frame);
    }
    socket.on("message", onMessage);
  });
}

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const socket = io(`http://127.0.0.1:${port}`, {
  path: AGENT_WS_PATH,
  transports: ["websocket"],
  reconnection: false,
  forceNew: true,
});

try {
  await new Promise((resolve) => socket.once("connect", resolve));
  let infoBeforeHello = false;
  const prematureInfoListener = (raw) => {
    try {
      if (JSON.parse(raw.toString()).t === MSG.INFO) infoBeforeHello = true;
    } catch {}
  };
  socket.on("message", prematureInfoListener);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(infoBeforeHello, false, "capabilities wait for authenticated HELLO identity");
  socket.off("message", prematureInfoListener);
  const infoPromise = waitForFrame(socket, (frame) => frame.t === MSG.INFO);
  socket.send(
    JSON.stringify(
      helloFrame({
        agentId: AGENT_ID,
        machine: "archive-test",
        os: "darwin",
        arch: "arm64",
        revision: "test",
      }),
    ),
  );
  const info = await infoPromise;
  assert.equal(info.features.transcriptArchive, true);
  assert.equal(info.features.transcriptRootDiscovery, true);

  const body = Buffer.from('{"type":"session_meta"}\n');
  const chunk = {
    chunkId: "chunk-1",
    agentKind: "codex",
    agentSessionId: "session-1",
    fileEpoch: "epoch-1",
    startOffset: 0,
    endOffsetExclusive: body.length,
    firstLineSeq: 0,
    nextLineSeq: 1,
    sha256: "unused-by-hub",
    base64: body.toString("base64"),
  };
  const ackPromise = waitForFrame(
    socket,
    (frame) => frame.t === MSG.TRANSCRIPT_ACK && frame.id === chunk.chunkId,
  );
  socket.send(JSON.stringify(transcriptChunkFrame(chunk.chunkId, chunk)));
  const ack = await ackPromise;
  assert.equal(ack.ok, true);
  assert.equal(ack.result.committedOffset, body.length);
  assert.equal(received.length, 1);
  assert.equal(received[0].owner.userId, OWNER.userId);
  assert.equal(received[0].machine.agentId, AGENT_ID);
  assert.equal(received[0].machine.machineId, "archive-test");

  const rejected = { ...chunk, chunkId: "chunk-2", fileEpoch: "reject" };
  const rejectPromise = waitForFrame(
    socket,
    (frame) => frame.t === MSG.TRANSCRIPT_ACK && frame.id === rejected.chunkId,
  );
  socket.send(JSON.stringify(transcriptChunkFrame(rejected.chunkId, rejected)));
  const reject = await rejectPromise;
  assert.equal(reject.ok, false);
  assert.equal(reject.error.code, "transcript_cursor_mismatch");
  assert.deepEqual(reject.error.expected, { committedOffset: 12, nextLineSeq: 1 });

  const deniedSocket = io(`http://127.0.0.1:${port}`, {
    path: AGENT_WS_PATH,
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
  try {
    await new Promise((resolve) => deniedSocket.once("connect", resolve));
    const deniedInfoPromise = waitForFrame(
      deniedSocket,
      (frame) => frame.t === MSG.INFO,
    );
    deniedSocket.send(
      JSON.stringify(
        helloFrame({
          agentId: "00000000-0000-4000-8000-000000000202",
          machine: "not-on-canary-list",
          os: "darwin",
          arch: "arm64",
          revision: "test",
        }),
      ),
    );
    const deniedInfo = await deniedInfoPromise;
    assert.equal(deniedInfo.features.transcriptArchive, false);
    assert.equal(deniedInfo.features.transcriptRootDiscovery, false);
    const deniedAckPromise = waitForFrame(
      deniedSocket,
      (frame) => frame.t === MSG.TRANSCRIPT_ACK && frame.id === "denied-chunk",
    );
    deniedSocket.send(
      JSON.stringify(
        transcriptChunkFrame("denied-chunk", { ...chunk, chunkId: "denied-chunk" }),
      ),
    );
    const deniedAck = await deniedAckPromise;
    assert.equal(deniedAck.ok, false);
    assert.equal(deniedAck.error.code, "transcript_archive_disabled");
    assert.equal(received.length, 2, "denied machine never reaches archive handler");
  } finally {
    deniedSocket.disconnect();
  }

  console.log("hub transcript archive tests passed");
} finally {
  socket.disconnect();
  hub.shutdown();
  await new Promise((resolve) => server.close(resolve));
}

// The controller-level env gate remains fail-closed unless either a canary
// machine is named or the operator explicitly enables the full-fleet switch.
assert.equal(
  await controllerTranscriptFeature({ machine: "not-allowlisted" }),
  false,
  "an empty machine allowlist stays disabled by default",
);
assert.equal(
  await controllerTranscriptFeature({
    machine: "canary-machine",
    machineAllowlist: "canary-machine",
  }),
  true,
  "the existing canary machine allowlist remains supported",
);
assert.equal(
  await controllerTranscriptFeature({
    machine: "full-fleet-machine",
    allowAll: true,
    ownerAllowlist: "some-other-owner@example.com",
  }),
  true,
  "the explicit full-fleet switch bypasses machine and owner allowlists",
);

async function controllerTranscriptFeature({
  machine,
  machineAllowlist = "",
  ownerAllowlist = "",
  allowAll = false,
}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tmux-mobile-archive-gate-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const secret = `archive-gate-${process.pid}`;
  const child = spawn(process.execPath, ["server.mjs", "--controller"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      SESSION_SECRET: `archive-session-${process.pid}`,
      GOOGLE_OAUTH_CLIENT_ID: "archive-test-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "archive-test-secret",
      GOOGLE_DEVICE_CLIENT_ID: "archive-test-device-client",
      GOOGLE_DEVICE_CLIENT_SECRET: "archive-test-device-secret",
      OPENAI_API_KEY: "archive-test-openai-key",
      TMUX_MOBILE_ENABLE_LEGACY_AUTH: "1",
      AGENT_SECRET: secret,
      TMUX_MOBILE_USER: "archive-owner@example.com",
      TMUX_MOBILE_ARTIFACT_STORAGE: "local",
      TMUX_MOBILE_ARTIFACT_DIR: path.join(dir, "artifacts"),
      TMUX_MOBILE_PIN_INDEX: "memory",
      TMUX_MOBILE_TRANSCRIPT_ARCHIVE_ENABLED: "1",
      TMUX_MOBILE_TRANSCRIPT_ARCHIVE_ALLOW_ALL: allowAll ? "1" : "0",
      TMUX_MOBILE_TRANSCRIPT_ARCHIVE_MACHINE_ALLOWLIST: machineAllowlist,
      TMUX_MOBILE_TRANSCRIPT_ARCHIVE_OWNER_ALLOWLIST: ownerAllowlist,
      TMUX_MOBILE_TRANSCRIPT_ARCHIVE_ROOT_DISCOVERY: "0",
      TMUX_MOBILE_TRANSCRIPT_STORAGE: "local",
      TMUX_MOBILE_TRANSCRIPT_ALLOW_EPHEMERAL_LOCAL: "1",
      TMUX_MOBILE_TRANSCRIPT_DIR: path.join(dir, "transcripts"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  let childSocket = null;
  try {
    await waitForController(baseUrl, child, () => output);
    childSocket = io(baseUrl, {
      path: AGENT_WS_PATH,
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
      auth: { secret },
    });
    await waitForSocketConnect(childSocket);
    const infoPromise = waitForFrame(childSocket, (frame) => frame.t === MSG.INFO);
    childSocket.send(
      JSON.stringify(
        helloFrame({
          agentId: "00000000-0000-4000-8000-000000000299",
          machine,
          os: "linux",
          arch: "arm64",
          revision: "test",
        }),
      ),
    );
    const info = await infoPromise;
    assert.equal(
      info.features.transcriptRootDiscovery,
      false,
      "ALLOW_ALL does not implicitly enable root discovery",
    );
    return info.features.transcriptArchive;
  } finally {
    childSocket?.disconnect();
    await stopChild(child);
    await rm(dir, { recursive: true, force: true });
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForController(baseUrl, child, output) {
  const deadline = Date.now() + 8_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`controller exited with ${child.exitCode}: ${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`controller did not become ready: ${lastError?.message || output()}`);
}

function waitForSocketConnect(socket, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out connecting authenticated transcript test socket"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", connected);
      socket.off("connect_error", failed);
    };
    const connected = () => {
      cleanup();
      resolve();
    };
    const failed = (error) => {
      cleanup();
      reject(error);
    };
    socket.once("connect", connected);
    socket.once("connect_error", failed);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_500)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

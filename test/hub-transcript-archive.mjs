import assert from "node:assert/strict";
import http from "node:http";
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

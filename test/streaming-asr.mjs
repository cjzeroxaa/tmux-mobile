import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter, once } from "node:events";
import WebSocket from "ws";
import { Server } from "socket.io";
import {
  attachStreamingAsr,
  ASR_PATH,
  decoderArguments,
} from "../lib/streaming-asr.mjs";
import { decodeAsrResponse, encodeAsrRequest } from "../lib/free-asr.mjs";
import {
  createPcmResampler,
  dictationText,
  createStreamingAsrSession,
} from "../public/streaming-asr-session.js";
assert.equal(
  dictationText("Existing text", "new words"),
  "Existing text new words",
);
assert.equal(
  dictationText("Existing text\n", "new words"),
  "Existing text\nnew words",
);
for (const rate of [16000, 44100, 48000]) {
  const samples = Float32Array.from({ length: rate }, (_, i) =>
    Math.sin(i / 13),
  );
  const whole = Buffer.from(createPcmResampler(rate)(samples));
  const convert = createPcmResampler(rate),
    parts = [];
  for (let offset = 0; offset < samples.length; offset += 127)
    parts.push(Buffer.from(convert(samples.subarray(offset, offset + 127))));
  assert.deepEqual(Buffer.concat(parts), whole);
  assert.equal(whole.length, 32000);
}
assert.throws(() => decodeAsrResponse(Buffer.from([0x3a, 100, 1])));
assert.throws(() => decodeAsrResponse(Buffer.alloc(20, 255)));
assert.equal(
  decodeAsrResponse(Buffer.from([0x22, 7, ...Buffer.from("Started")])).event,
  "Started",
);
assert.ok(
  encodeAsrRequest({
    event: "TaskRequest",
    taskId: "test",
    data: Buffer.from([1, 2]),
    seq: 128,
  }).includes(Buffer.from([0x48, 0x80, 1])),
);
assert.throws(() => decoderArguments("http"));
assert.ok(decoderArguments("wav").includes("-ignore_length"));
class FakeSession extends EventEmitter {
  start() {
    queueMicrotask(() => this.emit("ready"));
  }
  audio(bytes) {
    this.emit("transcript", { text: "live " + bytes.length, final: false });
  }
  finish() {
    this.emit("transcript", { text: "Final words.", final: true });
    this.emit("done");
  }
  close() {}
}
const server = http.createServer(),
  io = new Server(server, { path: "/agent", transports: ["websocket"] });
const wss = attachStreamingAsr(server, {
  authenticate: (req) =>
    req.headers.authorization === "Bearer valid" ? { userId: "owner" } : null,
  origin: () => `http://127.0.0.1:${server.address().port}`,
  secret: "test",
  createSession: () => new FakeSession(),
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `ws://127.0.0.1:${server.address().port}${ASR_PATH}`;
const denied = (headers) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(base, { headers });
    ws.on("unexpected-response", (_, res) => {
      resolve(res.statusCode);
      res.resume();
      ws.terminate();
    });
    ws.on("error", () => {});
    ws.on("open", () => reject(new Error("unexpected authentication success")));
  });
try {
  assert.equal(await denied({}), 401);
  assert.equal(
    await denied({
      authorization: "Bearer valid",
      origin: "https://attacker.invalid",
    }),
    403,
  );
  const updates = [],
    ends = [];
  const client = createStreamingAsrSession({
    url: base,
    createSocket: (url) =>
      new WebSocket(url, { headers: { authorization: "Bearer valid" } }),
    onTranscript: (text, final) => updates.push({ text, final }),
    onEnd: (error) => ends.push(error),
  });
  await client.start();
  // Engine.IO's other upgrade listener must not close this separate connection.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  client.audio(new Uint8Array([1, 0, 2, 0]).buffer);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(updates, [{ text: "live 4", final: false }]);
  client.finish();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(updates.at(-1), { text: "Final words.", final: true });
  assert.deepEqual(ends, [undefined]);
  client.cancel();
  assert.equal(ends.length, 1);
  const first = new WebSocket(base, {
    headers: { authorization: "Bearer valid" },
  });
  await once(first, "open");
  const second = new WebSocket(base, {
    headers: { authorization: "Bearer valid" },
  });
  await once(second, "open");
  assert.equal(await denied({ authorization: "Bearer valid" }), 429);
  first.close();
  second.close();
  await Promise.all([once(first, "close"), once(second, "close")]);
  const invalid = new WebSocket(base, {
    headers: { authorization: "Bearer valid" },
  });
  await once(invalid, "open");
  const response = once(invalid, "message");
  invalid.send(JSON.stringify({ type: "start", format: "evil" }));
  assert.equal(JSON.parse((await response)[0]).type, "error");
  await once(invalid, "close");
  console.log(
    "Streaming ASR: auth/origin, per-user limits, upgrade coexistence, interim/final transport, cleanup, framing and continuous resampling passed.",
  );
} finally {
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  io.close();
  server.close();
}

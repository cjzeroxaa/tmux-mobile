import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { FailoverAsrSession } from "../lib/asr-failover.mjs";
import { compress, decompress, parse, uint, bytes, OggOpusPackets } from "../lib/wetype-codec.mjs";
import { spawnSync } from "node:child_process";
import { opusArguments } from "../lib/wetype-asr.mjs";

for (const n of [0, 1, 60, 256, 65536, 100000]) {
  const data = Buffer.alloc(n, 97);
  assert.deepEqual(decompress(compress(data)), data);
}
assert.deepEqual(decompress(Buffer.from([6, 0, 97, 18, 1, 0])), Buffer.from("aaaaaa"));
for (const value of [[255], [2, 0, 97], [5, 1, 0], [1, 4, 97, 98]]) assert.throws(() => decompress(Buffer.from(value)));
assert.equal(parse(uint(2, 18446744073709551615n))[0][1], 18446744073709551615n);
assert.equal(parse(bytes(1, "你好"))[0][1].toString(), "你好");
assert.throws(() => parse(Buffer.from([10, 100, 1])));
assert.throws(() => parse(Buffer.alloc(20, 255)));

// Exercise the actual installed Opus encoder and split every Ogg page boundary.
const encoded = spawnSync("ffmpeg", opusArguments(), { input: Buffer.alloc(32000), maxBuffer: 1024 * 1024 });
assert.equal(encoded.status, 0, encoded.stderr?.toString());
const packets = [], parser = new OggOpusPackets((data) => packets.push(data));
for (let i = 0; i < encoded.stdout.length; i += 7) parser.write(encoded.stdout.subarray(i, i + 7));
parser.finish();
assert.ok(packets.length >= 50);
assert.ok(packets.every((p) => p.length > 0 && p.length <= 1275));

class Fake extends EventEmitter {
  chunks = [];
  start() { queueMicrotask(() => this.emit("ready")); }
  audio(data) { this.chunks.push(Buffer.from(data)); }
  finish() { this.emit("transcript", { text: "完整转写。", final: true }); this.emit("done"); }
  close() { this.closed = true; }
}
function setup(overrides = {}) {
  const created = [];
  const session = new FailoverAsrSession({ deviceId: "stable", connectMs: 30, finishMs: 30,
    createProvider(name, options) { assert.equal(options.deviceId, "stable"); const p = new Fake(); overrides.configure?.(p, name, created.length); created.push(p); return p; }, ...overrides });
  return { session, created };
}
// Startup failure and timeout both reach the backup, with only one client ready.
for (const mode of ["error", "timeout"]) {
  const { session, created } = setup({ configure(p, _, i) { if (!i) p.start = () => { if (mode === "error") p.emit("error", new Error("offline")); }; } });
  const ready = once(session, "ready"); session.start(); await ready;
  assert.equal(created.length, 2); assert.ok(created[0].closed);
  const done = once(session, "done"); session.finish(); await done;
  assert.ok(created[1].closed); assert.equal(session.audioChunks.length, 0);
}
// Replay every byte, including audio arriving during reconnection; no old events.
for (const order of [["doubao", "wetype"], ["wetype", "doubao"]]) {
  const { session, created } = setup({ providers: order });
  const texts = []; let readyCount = 0;
  session.on("transcript", (r) => texts.push(r)); session.on("ready", () => readyCount++);
  const ready = once(session, "ready"); session.start(); await ready;
  const a = Buffer.alloc(8000, 1), b = Buffer.alloc(1000, 2);
  session.audio(a); await delay(10);
  created[0].emit("transcript", { text: "已有的文字", final: false });
  created[0].emit("error", new Error("disconnected"));
  created[0].emit("transcript", { text: "stale result", final: true });
  session.audio(b);
  const done = once(session, "done"); session.finish(); await done;
  assert.deepEqual(Buffer.concat(created[1].chunks), Buffer.concat([a, b]));
  assert.equal(readyCount, 1); assert.equal(texts.length, 2);
  assert.equal(texts.at(-1).text, "完整转写。"); assert.equal(texts.at(-1).provider, order[1]);
}
// A stalled final response also replays into the backup after Stop.
{
  const { session, created } = setup({ configure(p, _, i) { if (!i) p.finish = () => {}; } });
  const ready = once(session, "ready"); session.start(); await ready;
  session.audio(Buffer.alloc(640)); const done = once(session, "done"); session.finish(); await done;
  assert.equal(Buffer.concat(created[1].chunks).length, 640);
}
// Both fail once; cancellation never retries; encoder backpressure pauses replay.
{
  const { session, created } = setup({ configure(p) { p.start = () => p.emit("error", new Error("offline")); } });
  const failed = once(session, "error"); session.start(); assert.match((await failed)[0].message, /Both/);
  assert.equal(created.length, 2); assert.ok(created.every((p) => p.closed));
}
{
  const { session, created } = setup(); const ready = once(session, "ready"); session.start(); await ready;
  created[0].writable = false; session.audio(Buffer.alloc(640)); await delay(5);
  assert.equal(created[0].chunks.length, 0);
  session.close(); created[0].emit("error", new Error("late")); await delay(40);
  assert.equal(created.length, 1); assert.equal(session.audioChunks.length, 0);
}
console.log("ASR: real FFmpeg Opus framing, bounded codecs, startup/midstream/final timeout failover both directions, replay, cancellation and backpressure passed.");

// A manual selection must never use the other service, including final timeouts.
for (const provider of ["doubao", "wetype"]) {
  for (const stage of ["start", "finish"]) {
    const { session, created } = setup({ providers: [provider], configure(p) {
      if (stage === "start") p.start = () => p.emit("error", new Error("offline"));
      else p.finish = () => {};
    }});
    const failure = once(session, "error");
    if (stage === "finish") {
      const ready = once(session, "ready"); session.start(); await ready; session.finish();
    } else session.start();
    assert.match((await failure)[0].message, provider === "wetype" ? /WeChat speech is unavailable/ : /Doubao speech is unavailable/);
    assert.equal(created.length, 1);
  }
}

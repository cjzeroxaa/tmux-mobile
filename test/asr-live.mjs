// Opt-in network canary: node test/asr-live.mjs /path/to/synthetic-16k-mono.pcm
// Never records the microphone or sends text to an Agent.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { FailoverAsrSession, PROVIDERS } from "../lib/asr-failover.mjs";

const pcm = readFileSync(process.argv[2]);
const expected = "今天我们测试语音识别，微信和豆包可以互相备用。";
for (const [primary, fault] of [["doubao", null], ["wetype", null], ["doubao", "startup"], ["doubao", "midstream"], ["wetype", "midstream"]]) {
  await new Promise((resolve, reject) => {
    const start = Date.now(), records = [], providers = [];
    let failed = false, stopped = false, firstPartial, finishedAt;
    const s = new FailoverAsrSession({ deviceId: "1234567890123456", providers: primary === "doubao" ? ["doubao", "wetype"] : ["wetype", "doubao"],
      createProvider(name, options) {
        const p = new PROVIDERS[name](options);
        if (name === primary && fault === "startup") p.start = () => queueMicrotask(() => p.emit("error", new Error("test connection failure")));
        if (name === primary && fault === "midstream") {
          const audio = p.audio.bind(p); let count = 0;
          p.audio = (data) => {
            count += data.length;
            if (!failed && count > pcm.length / 2) { failed = true; p.ws.terminate(); }
            else audio(data);
          };
        }
        return p;
      },
    });
    const timer = setTimeout(() => { stopped = true; s.close(); reject(new Error("Live ASR timeout")); }, 25000);
    s.on("error", (error) => { stopped = true; clearTimeout(timer); reject(error); });
    s.on("provider", (event) => providers.push(event.provider));
    s.on("transcript", (result) => { records.push(result); if (result.text && !result.final) firstPartial ??= Date.now() - start; });
    s.on("ready", async () => {
      for (let at = 0; at < pcm.length && !stopped; at += 3200) { s.audio(pcm.subarray(at, at + 3200)); await delay(100); }
      if (!stopped) { finishedAt = Date.now(); s.finish(); }
    });
    s.on("done", () => {
      stopped = true; clearTimeout(timer);
      try {
        assert.equal(records.at(-1)?.text, expected);
        assert.equal(records.at(-1)?.final, true);
        assert.ok(firstPartial < finishedAt - start, "No live text before Stop");
        if (fault) assert.notEqual(records.at(-1).provider, primary);
        console.log(JSON.stringify({ primary, fault, providers, firstPartialMs: firstPartial, finalAfterStopMs: Date.now() - finishedAt, text: records.at(-1).text }));
        resolve();
      } catch (error) { reject(error); }
    });
    s.start();
  });
}

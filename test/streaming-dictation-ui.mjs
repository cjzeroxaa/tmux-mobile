import assert from "node:assert/strict";
import { bindStreamingDictation } from "../public/streaming-asr.js";
const tick = () => new Promise((resolve) => setImmediate(resolve));
class Element extends EventTarget {
  disabled = false;
  dataset = {};
  attributes = {};
  innerHTML = "";
  contentEditable = "true";
  classList = { add() {}, toggle() {} };
  setAttribute(key, value) {
    this.attributes[key] = value;
  }
  removeAttribute(key) {
    delete this.attributes[key];
  }
  click() {
    if (!this.disabled) this.dispatchEvent(new Event("click"));
  }
}
class Socket {
  static instances = [];
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  constructor() {
    Socket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(value) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  message(value) {
    this.onmessage({ data: JSON.stringify(value) });
  }
}
let track, pendingMicrophone;
const newStream = () => {
  const ownTrack = {
    readyState: "live",
    stop() {
      this.readyState = "ended";
    },
  };
  track = ownTrack;
  return { getTracks: () => [ownTrack] };
};
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia: () => pendingMicrophone || Promise.resolve(newStream()),
    },
  },
});
globalThis.document = new EventTarget();
document.hidden = false;
globalThis.window = new EventTarget();
globalThis.location = {
  href: "https://controller.example/app",
  protocol: "https:",
};
globalThis.WebSocket = Socket;
const connection = () => ({
  connect() {
    return this;
  },
  disconnect() {},
});
globalThis.AudioContext = class {
  sampleRate = 48000;
  audioWorklet = { addModule: async () => {} };
  destination = {};
  async resume() {}
  async close() {}
  createMediaStreamSource() {
    return connection();
  }
  createGain() {
    return { ...connection(), gain: { value: 0 } };
  }
};
globalThis.AudioWorkletNode = window.AudioWorkletNode = class {
  static instance;
  port = {
    postMessage: (message) => {
      this.pendingMessage = message;
    },
  };
  constructor() {
    AudioWorkletNode.instance = this;
  }
  connect() {
    return connection();
  }
  disconnect() {}
};
const button = new Element(),
  send = new Element(),
  input = new Element();
let text = "Keep my draft.",
  status = "";
const controller = bindStreamingDictation({
  button,
  input,
  controls: [send],
  getText: () => text,
  setText: (value) => (text = value),
  setStatus: (value) => (status = value),
});
assert.match(button.innerHTML, />Start</);
button.click();
await tick();
assert.equal(button.dataset.streamingState, "connecting");
assert.equal(button.disabled, false);
assert.match(button.innerHTML, />Cancel</);
const ws = Socket.instances.at(-1);
ws.message({ type: "ready" });
await tick();
assert.equal(button.dataset.streamingState, "recording");
assert.match(button.innerHTML, />Stop</);
assert.equal(send.disabled, true);
ws.message({ type: "transcript", text: "partial", final: false });
assert.equal(text, "Keep my draft. partial");
button.click();
// Stop must close the microphone BEFORE the worklet acknowledges its final flush.
assert.equal(track.readyState, "ended");
assert.equal(AudioWorkletNode.instance.pendingMessage, "finish");
assert.equal(button.dataset.streamingState, "finishing");
assert.equal(button.attributes["aria-pressed"], "false");
assert.equal(button.disabled, true);
assert.match(status, /Microphone off/);
assert.equal(
  ws.sent.some(
    (value) => typeof value === "string" && JSON.parse(value).type === "finish",
  ),
  false,
);
AudioWorkletNode.instance.port.onmessage({ data: { done: true } });
assert.equal(JSON.parse(ws.sent.at(-1)).type, "finish");
ws.message({ type: "transcript", text: "Final words.", final: true });
ws.message({ type: "done" });
await tick();
assert.equal(text, "Keep my draft. Final words.");
assert.equal(button.dataset.streamingState, "idle");
assert.match(button.innerHTML, />Start</);
assert.equal(send.disabled, false);
assert.equal(input.contentEditable, "true");
// Cancelling while permission/connection is pending cannot restart capture later.
let grant;
pendingMicrophone = new Promise((resolve) => (grant = resolve));
button.click();
assert.equal(button.dataset.streamingState, "connecting");
button.click();
assert.equal(controller.active, false);
assert.equal(button.dataset.streamingState, "idle");
grant(newStream());
await tick();
assert.equal(track.readyState, "ended");
assert.equal(Socket.instances.length, 1);
assert.equal(text, "Keep my draft. Final words.");
console.log(
  "Streaming UI: visible Start/Stop, immediate microphone stop, separate finalization, final correction and pending-start cancellation passed.",
);

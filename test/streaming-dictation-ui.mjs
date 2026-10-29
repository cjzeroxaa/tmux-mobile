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
  controls: [],
  submitButton: send,
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
assert.equal(send.disabled, false);
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
// Existing composers can bind before their pane is selected. Their existing
// caller-owned enablement must not become permanently disabled on first render.
const existingButton = new Element();
bindStreamingDictation({ button: existingButton, getText: () => '', setText() {}, setStatus() {}, isBlocked: () => true });
assert.equal(existingButton.disabled, false);
let writable = false;
const sharedButton = new Element();
const shared = bindStreamingDictation({ button: sharedButton, getText: () => '', setText() {}, setStatus() {}, isBlocked: () => !writable, disableWhenBlocked: true });
assert.equal(sharedButton.disabled, true);
writable = true;
shared.refresh();
assert.equal(sharedButton.disabled, false);
console.log(
  "Streaming UI: visible Start/Stop, immediate microphone stop, separate finalization, final correction and pending-start cancellation passed.",
);

pendingMicrophone = undefined;
const startRecording = async () => {
  button.click(); await tick();
  const socket = Socket.instances.at(-1);
  socket.message({ type: "ready" }); await tick();
  assert.equal(button.dataset.streamingState, "recording");
  assert.equal(send.disabled, false, "Send is enabled before the first partial");
  return socket;
};
const flush = async () => {
  assert.equal(track.readyState, "ended", "Send stops the mic immediately");
  AudioWorkletNode.instance.port.onmessage({ data: { done: true } });
  await tick();
};
const sent = [];
let sending = await startRecording();
sending.message({ type: 'transcript', text: 'uncorrected', final: false });
const submission = controller.submit(async value => { sent.push(value); });
const duplicate = controller.submit(async value => { sent.push(value); });
assert.equal(send.disabled, true);
assert.equal(sent.length, 0);
await flush();
sending.message({ type: 'transcript', text: 'Corrected final sentence.', final: true });
sending.message({ type: 'done' });
await Promise.all([submission, duplicate]);
assert.deepEqual(sent, ['Keep my draft. Final words. Corrected final sentence.']);
assert.equal(send.disabled, false);

text = '';
sending = await startRecording();
button.click(); // Stop first, then Send while the final transcript is pending.
const afterStop = controller.submit(async value => { sent.push(value); });
await flush();
sending.message({ type: 'transcript', text: 'Late sentence.', final: true });
sending.message({ type: 'done' });
await afterStop;
assert.equal(sent.at(-1), 'Late sentence.');

for (const failure of ['cancel', 'background', 'error', 'empty']) {
  text = '';
  sending = await startRecording();
  const before = sent.length;
  const pending = controller.submit(async value => { sent.push(value); });
  await flush();
  if (failure === 'cancel') controller.cancel();
  if (failure === 'background') {
    document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); document.hidden = false;
  }
  if (failure === 'error') sending.message({ type: 'error', message: 'ASR unavailable' });
  if (failure === 'empty') sending.message({ type: 'done' });
  sending.message({ type: 'transcript', text: 'Must not send', final: true });
  sending.message({ type: 'done' });
  await pending;
  assert.equal(sent.length, before, failure + ' must not send');
  assert.equal(send.disabled, false);
}
text = 'Typed text';
let releaseSend;
const idleSubmit = controller.submit(async value => { sent.push(value); await new Promise(r => { releaseSend = r; }); });
await tick();
await controller.submit(async value => { sent.push(value); });
releaseSend(); await idleSubmit;
assert.equal(sent.filter(value => value === 'Typed text').length, 1);
console.log('Streaming submit: final correction, single send, Stop then Send, empty speech, cancellation, background and errors passed.');

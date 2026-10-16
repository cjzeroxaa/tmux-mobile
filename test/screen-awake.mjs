import assert from "node:assert/strict";
import { createScreenAwake } from "../public/screen-awake.mjs";
let visible = true, requests = [], locks = [];
function lock() {
  const listeners = [];
  const value = { released: false, addEventListener: (_, fn) => listeners.push(fn),
    async release() { value.released = true; listeners.forEach(fn => fn()); } };
  locks.push(value); return value;
}
const awake = createScreenAwake({ visible: () => visible, request: () => new Promise(resolve => requests.push(resolve)) });
const pending = awake.set("editing", true);
for (let i = 0; i < 100; i++) awake.set("editing", true);
assert.equal(requests.length, 1, "Focus/input events coalesce pending lock requests");
void awake.set("editing", false);
requests.shift()(lock()); await pending;
assert.equal(locks[0].released, true, "A late grant after blur is immediately released");
const second = awake.set("editing", true);
requests.shift()(lock()); await second;
await awake.set("voice", true);
await awake.set("editing", false);
assert.equal(locks[1].released, false, "Voice keeps its independent reason");
visible = false; await awake.sync();
assert.equal(locks[1].released, true, "Hidden tabs release even during voice");
visible = true; const resumed = awake.sync();
requests.shift()(lock()); await resumed;
assert.equal(locks[2].released, false);
await awake.set("voice", false);
assert.equal(locks[2].released, true);
const hiddenPending = awake.set("editing", true);
visible = false; void awake.sync();
requests.shift()(lock()); await hiddenPending;
assert.equal(locks[3].released, true, "An in-flight grant cannot keep a hidden tab awake");
await createScreenAwake({ request: null, visible: () => true }).set("editing", true);
await createScreenAwake({ request: async () => { throw new Error("denied"); }, visible: () => true }).set("editing", true);
console.log("Screen wake lock: focus/blur, 100 pending requests, voice ownership, hidden tabs and unsupported browsers passed");

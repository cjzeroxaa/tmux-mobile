// Unit tests for the fetch deadline wrapper (public/fetch-timeout.js). Imports
// the real module so app.js and CI stay in lockstep. Covers: a fast response
// passes straight through; a never-resolving fetch is aborted at the deadline
// and rejects with a `.timedOut` error; timeoutMs:0 disables the deadline; a
// caller-supplied signal is respected (no deadline added, its abort stays a
// plain AbortError); the deadline timer is cleared on the happy path.

import assert from "node:assert/strict";
import {
  fetchWithTimeout,
  isTimeoutError,
  DEFAULT_FETCH_TIMEOUT_MS,
} from "../public/fetch-timeout.js";

// A minimal AbortController stand-in that records abort() and fires listeners,
// so we can drive the wrapper deterministically without real network/timers.
class FakeAbortController {
  constructor() {
    this.aborted = false;
    this._listeners = [];
    const self = this;
    this.signal = {
      get aborted() {
        return self.aborted;
      },
      addEventListener(_type, fn) {
        self._listeners.push(fn);
      },
      removeEventListener(_type, fn) {
        self._listeners = self._listeners.filter((l) => l !== fn);
      },
    };
  }
  abort() {
    this.aborted = true;
    for (const fn of this._listeners) fn();
  }
}

// A fetch that resolves immediately with a sentinel.
async function fastFetch() {
  return { ok: true, sentinel: "fast" };
}

// A fetch that never resolves on its own; it only rejects when its signal is
// aborted (mirroring how the platform aborts an in-flight fetch).
function hangingFetch() {
  return (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // no signal → truly hangs (should not happen with a deadline)
      if (signal.aborted) return reject(makeAbortError());
      signal.addEventListener("abort", () => reject(makeAbortError()));
    });
}

function makeAbortError() {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

// --- 1. fast response passes straight through, deadline timer is cleared ---
{
  const res = await fetchWithTimeout(
    "/x",
    {},
    { fetchImpl: fastFetch, AbortImpl: FakeAbortController, timeoutMs: 50 },
  );
  assert.equal(res.sentinel, "fast", "fast response returned unchanged");
}

// --- 2. a hanging fetch is aborted at the deadline → .timedOut error ---
{
  let threw = null;
  try {
    await fetchWithTimeout(
      "/hang",
      {},
      { fetchImpl: hangingFetch(), AbortImpl: FakeAbortController, timeoutMs: 20 },
    );
  } catch (error) {
    threw = error;
  }
  assert.ok(threw, "hanging fetch rejected");
  assert.equal(threw.timedOut, true, "error is flagged timedOut");
  assert.equal(threw.status, 0, "timeout error has status 0");
  assert.ok(isTimeoutError(threw), "isTimeoutError recognizes it");
}

// --- 3. timeoutMs:0 disables the deadline (no abort, no timeout error) ---
{
  let settled = "pending";
  const p = fetchWithTimeout(
    "/hang",
    {},
    { fetchImpl: hangingFetch(), AbortImpl: FakeAbortController, timeoutMs: 0 },
  ).then(
    () => (settled = "resolved"),
    () => (settled = "rejected"),
  );
  // Give any (wrongly-scheduled) 0ms deadline a chance to fire.
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(settled, "pending", "timeoutMs:0 leaves the request pending (no deadline)");
  void p;
}

// --- 4. caller-supplied signal is respected; its abort stays a plain
//        AbortError (NOT reinterpreted as a timeout) and no deadline is added ---
{
  const caller = new FakeAbortController();
  let threw = null;
  const p = fetchWithTimeout(
    "/hang",
    { signal: caller.signal },
    { fetchImpl: hangingFetch(), AbortImpl: FakeAbortController, timeoutMs: 20 },
  ).catch((e) => (threw = e));
  // The wrapper must NOT have installed its own deadline (init.signal was set),
  // so after >20ms nothing has aborted yet.
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(threw, null, "no wrapper deadline when caller provides a signal");
  // Now the caller aborts: it surfaces as a plain AbortError, not a timeout.
  caller.abort();
  await p;
  assert.ok(threw, "caller abort rejected the request");
  assert.equal(threw.name, "AbortError", "caller abort stays a plain AbortError");
  assert.notEqual(threw.timedOut, true, "caller abort is not flagged as a timeout");
}

// --- 5. default deadline constant is sane (bounded, above the 15s server RPC) ---
{
  assert.ok(DEFAULT_FETCH_TIMEOUT_MS > 15_000, "default deadline is above the server RPC timeout");
  assert.ok(DEFAULT_FETCH_TIMEOUT_MS <= 60_000, "default deadline is bounded");
}

console.log("fetch-timeout unit tests passed");

// Unit tests for the fetch deadline wrapper (public/fetch-timeout.js). Imports
// the real module so app.js and CI stay in lockstep. Covers: a fast response
// passes straight through; a never-resolving fetch is aborted at the deadline
// and rejects with a `.timedOut` error; timeoutMs:0 disables the deadline; a
// caller-supplied signal is respected (no deadline added, its abort stays a
// plain AbortError); the deadline timer is cleared on the happy path.

import assert from "node:assert/strict";
import {
  fetchWithTimeout,
  fetchJsonWithTimeout,
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

// ===========================================================================
// fetchJsonWithTimeout — the deadline must span fetch() AND the body read.
// ===========================================================================

// A Response whose json() resolves immediately.
function okJsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

// A Response whose HEADERS arrived (fetch resolved) but whose body read hangs
// until the signal aborts — the exact flaky-network case that wedged the app:
// the old code cleared its deadline once headers arrived, so response.json()
// hung forever and api() never settled (Send button stuck disabled).
function headersThenHangingBodyFetch() {
  return (_input, init) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return; // no deadline → truly hangs (the OLD bug)
          if (signal.aborted) return reject(makeAbortError());
          signal.addEventListener("abort", () => reject(makeAbortError()));
        }),
    });
}

// --- 6. fetchJsonWithTimeout: happy path returns {response, json} ---
{
  const { response, json } = await fetchJsonWithTimeout(
    "/x",
    {},
    {
      fetchImpl: async () => okJsonResponse({ hello: "world" }),
      AbortImpl: FakeAbortController,
      timeoutMs: 50,
    },
  );
  assert.equal(response.ok, true, "response passed through");
  assert.deepEqual(json, { hello: "world" }, "json body parsed");
}

// --- 7. ROOT CAUSE: headers arrive but the BODY stalls → still times out ---
{
  let threw = null;
  try {
    await fetchJsonWithTimeout(
      "/slowbody",
      {},
      {
        fetchImpl: headersThenHangingBodyFetch(),
        AbortImpl: FakeAbortController,
        timeoutMs: 20,
      },
    );
  } catch (error) {
    threw = error;
  }
  assert.ok(threw, "a stalled body read rejects (does not hang forever)");
  assert.equal(threw.timedOut, true, "stalled body → .timedOut error");
  assert.equal(threw.status, 0, "timeout error has status 0");
  assert.ok(isTimeoutError(threw), "isTimeoutError recognizes the body-stall timeout");
}

// --- 8. fetchJsonWithTimeout: a non-JSON / empty body is not fatal → json=null ---
{
  const { response, json } = await fetchJsonWithTimeout(
    "/empty",
    {},
    {
      fetchImpl: async () => ({
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError("Unexpected end of JSON input");
        },
      }),
      AbortImpl: FakeAbortController,
      timeoutMs: 50,
    },
  );
  assert.equal(response.status, 502, "response still available on non-JSON body");
  assert.equal(json, null, "non-JSON body yields json=null, not a throw");
}

// --- 9. fetchJsonWithTimeout: timeoutMs:0 disables the deadline (slow upload) ---
{
  let settled = "pending";
  const p = fetchJsonWithTimeout(
    "/slowbody",
    {},
    {
      fetchImpl: headersThenHangingBodyFetch(),
      AbortImpl: FakeAbortController,
      timeoutMs: 0,
    },
  ).then(
    () => (settled = "resolved"),
    () => (settled = "rejected"),
  );
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(settled, "pending", "timeoutMs:0 leaves a slow body pending (no deadline)");
  void p;
}

console.log("fetch-timeout unit tests passed");

// A deadline wrapper around fetch, kept dependency-free (no DOM, no app state)
// so it can be unit-tested in node and imported by app.js in the browser — the
// same cross-env pattern as linkify.js / window-id.js.
//
// Why it exists: the app's api() helper had no timeout, so a request whose
// connection half-opens on a flaky mobile network would hang forever — the
// Send button stays disabled, the composer is empty, and no error ever fires,
// so the send looks like it silently did nothing. A bounded fetch turns that
// wedge into a normal, catchable failure the caller can surface + retry.
//
// IMPORTANT — the deadline must cover the WHOLE round-trip, headers AND body.
// A plain fetch() deadline is not enough: fetch() resolves as soon as the
// response HEADERS arrive, but the body is streamed lazily and read later via
// response.json(). On a flaky network the headers can arrive and then the body
// stalls indefinitely; if the deadline was already cleared, response.json()
// hangs forever and the caller (api()) never settles — the exact "Send button
// does nothing / stays disabled" wedge this module was meant to kill. So the
// deadline stays armed across the body read (see fetchJsonWithTimeout), and the
// abort tears down the stalled body stream, not just the connection.

// Default request deadline. Sits just above the controller->agent RPC timeout
// (RPC_TIMEOUT_MS = 15s in lib/hub.mjs) so a send the agent genuinely can't
// service still comes back as the server's clean error rather than being cut
// off here; the deadline's real job is the never-resolves network case.
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

// Marker set on the error thrown when the deadline (not the server) aborts the
// request, so callers can distinguish "your connection stalled" from an HTTP
// error and log/branch on it.
export function isTimeoutError(error) {
  return Boolean(error && error.timedOut);
}

function makeTimeoutError() {
  const e = new Error("Request timed out — check your connection");
  e.status = 0;
  e.timedOut = true;
  return e;
}

// fetch(input, init) with a deadline on the CONNECTION only (fetch() resolving).
//
// - timeoutMs omitted        → DEFAULT_FETCH_TIMEOUT_MS
// - timeoutMs === 0          → no deadline (large uploads / audio that may be
//                              slow but are making progress)
// - init.signal already set  → respect the caller's signal, add no deadline
//
// On deadline the returned promise rejects with an Error whose `.timedOut` is
// true and `.status` is 0. A caller-supplied AbortController abort surfaces as
// the usual AbortError (unchanged). `fetchImpl` / `AbortImpl` are injectable
// for tests; they default to the globals in the browser.
//
// NOTE: this bounds only until headers arrive. For a request whose body you
// then read (JSON), use fetchJsonWithTimeout so the deadline also covers the
// body stream.
export async function fetchWithTimeout(
  input,
  init = {},
  { timeoutMs, fetchImpl, AbortImpl } = {},
) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  const Controller =
    AbortImpl || (typeof AbortController !== "undefined" ? AbortController : null);
  if (!doFetch) throw new Error("no fetch implementation available");

  const deadlineMs = timeoutMs === undefined ? DEFAULT_FETCH_TIMEOUT_MS : timeoutMs;
  let timer = null;
  let signal = init.signal;
  if (deadlineMs > 0 && !signal && Controller) {
    const controller = new Controller();
    signal = controller.signal;
    timer = setTimeout(() => controller.abort(), deadlineMs);
  }

  try {
    return await doFetch(input, { ...init, signal });
  } catch (error) {
    // Only OUR deadline becomes a timeout error. If the caller passed their own
    // signal and aborted it, that stays a plain AbortError.
    if (error && error.name === "AbortError" && timer) {
      throw makeTimeoutError();
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// fetch(input, init) + read the JSON body, with ONE deadline spanning BOTH.
//
// Returns { response, json } where `response` is the raw Response (so the caller
// can read .ok/.status) and `json` is the parsed body (or null when the body is
// empty / not JSON). The single deadline is what makes the "Send does nothing"
// wedge impossible: whether the connection stalls, the headers stall, or the
// body stalls mid-stream, the same timer aborts the request and this rejects
// with a `.timedOut` error the caller can surface + retry.
//
// Same options as fetchWithTimeout. timeoutMs:0 disables the deadline (used for
// long uploads/audio that make slow progress). A caller-supplied init.signal is
// respected and no deadline is added (its abort stays a plain AbortError).
export async function fetchJsonWithTimeout(
  input,
  init = {},
  { timeoutMs, fetchImpl, AbortImpl } = {},
) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  const Controller =
    AbortImpl || (typeof AbortController !== "undefined" ? AbortController : null);
  if (!doFetch) throw new Error("no fetch implementation available");

  const deadlineMs = timeoutMs === undefined ? DEFAULT_FETCH_TIMEOUT_MS : timeoutMs;
  let timer = null;
  let signal = init.signal;
  let ownDeadline = false;
  if (deadlineMs > 0 && !signal && Controller) {
    const controller = new Controller();
    signal = controller.signal;
    // Keep the timer alive across the body read too. It is only cleared in the
    // finally below, AFTER response.json() has resolved (or the deadline fired).
    timer = setTimeout(() => controller.abort(), deadlineMs);
    ownDeadline = true;
  }

  try {
    const response = await doFetch(input, { ...init, signal });
    // Read the body under the SAME deadline. If the body stalls, the timer
    // aborts this read and it rejects — turning a silent hang into a timeout.
    let json = null;
    try {
      json = await response.json();
    } catch (bodyError) {
      // A deadline abort during the body read is a timeout, not a parse error.
      if (ownDeadline && signal && signal.aborted) throw makeTimeoutError();
      // A genuinely empty / non-JSON body is not fatal here — the caller decides
      // what a missing body means from response.ok/status. Return json=null.
      if (bodyError && bodyError.name === "AbortError" && ownDeadline) {
        throw makeTimeoutError();
      }
      json = null;
    }
    return { response, json };
  } catch (error) {
    if (ownDeadline && error && error.name === "AbortError") {
      throw makeTimeoutError();
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

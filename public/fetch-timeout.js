// A deadline wrapper around fetch, kept dependency-free (no DOM, no app state)
// so it can be unit-tested in node and imported by app.js in the browser — the
// same cross-env pattern as linkify.js / window-id.js.
//
// Why it exists: the app's api() helper had no timeout, so a request whose
// connection half-opens on a flaky mobile network would hang forever — the
// Send button stays disabled, the composer is empty, and no error ever fires,
// so the send looks like it silently did nothing. A bounded fetch turns that
// wedge into a normal, catchable failure the caller can surface + retry.

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

// fetch(input, init) with a deadline.
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
      const timeoutError = new Error("Request timed out — check your connection");
      timeoutError.status = 0;
      timeoutError.timedOut = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

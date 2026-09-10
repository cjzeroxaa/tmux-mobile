// A fixed foreground update window. Network responses never extend it.
export const TERMINAL_REFRESH_WINDOW_MS = 5 * 60 * 1000;

export function createRefreshWindow({ onExpire, durationMs = TERMINAL_REFRESH_WINDOW_MS, now = Date.now }) {
  let deadline = 0, timer = null, generation = 0, expired = false;
  function stop() {
    generation++;
    clearTimeout(timer);
    timer = null;
    deadline = 0;
    expired = false;
  }
  function check() {
    if (deadline && now() >= deadline) {
      clearTimeout(timer);
      timer = null;
      deadline = 0;
      expired = true;
      onExpire();
    }
    return expired;
  }
  function renew() {
    stop();
    deadline = now() + durationMs;
    const version = generation;
    timer = setTimeout(() => { if (version === generation) check(); }, durationMs);
  }
  return { renew, stop, get expired() { return check(); } };
}

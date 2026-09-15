// Foreground inactivity window. Only user activity renews it, never responses.
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

// Scroll events also come from following new terminal output. Observe the
// user's wheel/touch gesture instead so output cannot keep an idle tab alive.
export function watchTerminalActivity({ target, isActive, onActivity }) {
  const events = ['keydown', 'pointerdown', 'wheel', 'touchmove', 'input'];
  const listener = (event) => {
    if (event.isTrusted && isActive(event)) onActivity();
  };
  for (const type of events) target.addEventListener(type, listener, { capture: true, passive: true });
  return () => {
    for (const type of events) target.removeEventListener(type, listener, { capture: true });
  };
}

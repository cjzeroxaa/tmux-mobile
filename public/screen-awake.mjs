// One shared lock for both SPA views. Merge asynchronous requests so focus,
// visibility and voice events cannot create untracked locks.
export function createScreenAwake({ request, visible }) {
  const reasons = new Set();
  let lock = null, pending = null;
  const wanted = () => reasons.size > 0 && visible();
  const release = value => { void value.release().catch(() => {}); };
  function sync() {
    if (!wanted()) {
      if (lock) { const previous = lock; lock = null; release(previous); }
      return pending || Promise.resolve();
    }
    if (!request || lock || pending) return pending || Promise.resolve();
    pending = (async () => {
      try {
        const acquired = await request();
        if (!wanted()) { release(acquired); return; }
        lock = acquired;
        acquired.addEventListener("release", () => { if (lock === acquired) lock = null; });
      } catch { /* Unsupported/power-saving browsers may deny the lock. */ }
    })().finally(() => { pending = null; });
    return pending;
  }
  return {
    sync,
    set(reason, enabled) { if (enabled) reasons.add(reason); else reasons.delete(reason); return sync(); },
  };
}

let controller;
let pageVisible = true;
function screenAwake() {
  if (controller) return controller;
  controller = createScreenAwake({
    request: navigator.wakeLock ? () => navigator.wakeLock.request("screen") : null,
    visible: () => pageVisible && !document.hidden,
  });
  document.addEventListener("focusin", syncInputWakeLock);
  document.addEventListener("focusout", () => queueMicrotask(syncInputWakeLock));
  document.addEventListener("input", syncInputWakeLock);
  document.addEventListener("visibilitychange", syncInputWakeLock);
  window.addEventListener("pagehide", () => { pageVisible = false; void controller.sync(); });
  window.addEventListener("pageshow", () => { pageVisible = true; syncInputWakeLock(); });
  return controller;
}

export function syncInputWakeLock() {
  const element = document.activeElement;
  const editing = !!element && !element.disabled && !element.readOnly &&
    (element.matches('textarea, input:not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="submit"])') || element.isContentEditable) &&
    !element.closest("[hidden]") && element.getClientRects().length > 0;
  void screenAwake().set("editing", editing);
}

export function setScreenAwake(reason, enabled) {
  return screenAwake().set(reason, enabled);
}

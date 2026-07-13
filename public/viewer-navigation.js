// Internal artifact viewers need to stay inside the installed mobile/PWA
// browsing context. Opening `_blank` on iOS can either be blocked or escape to
// Safari, where the standalone app's auth cookie may not be available. Desktop
// keeps the useful new-tab behavior, with a same-tab fallback for popup policy.

export function shouldUseSameTabForViewer({
  standalone = false,
  coarsePointer = false,
  compactViewport = false,
  mobileBrowser = false,
  touchCapable = false,
} = {}) {
  return Boolean(
    standalone ||
      mobileBrowser ||
      (compactViewport && (coarsePointer || touchCapable)),
  );
}

function mediaMatches(win, query) {
  try {
    return Boolean(win?.matchMedia?.(query)?.matches);
  } catch {
    return false;
  }
}

export function viewerNavigationContext(win = globalThis.window) {
  const userAgent = String(win?.navigator?.userAgent || "");
  return {
    standalone:
      win?.navigator?.standalone === true ||
      mediaMatches(win, "(display-mode: standalone)"),
    coarsePointer: mediaMatches(win, "(pointer: coarse)"),
    compactViewport: mediaMatches(win, "(max-width: 1023px)"),
    mobileBrowser: /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent),
    touchCapable: Number(win?.navigator?.maxTouchPoints || 0) > 0,
  };
}

export function openViewerUrl(url, win = globalThis.window) {
  const target = String(url || "");
  if (!target || !win) return "none";

  if (shouldUseSameTabForViewer(viewerNavigationContext(win))) {
    win.location.assign(target);
    return "same-tab";
  }

  // Do not pass the `noopener` window feature here: browsers are allowed to
  // return null for a successfully-opened no-opener tab, which made the old
  // fallback open a duplicate tab. Set opener to null on the returned handle.
  let tab = null;
  try {
    tab = win.open(target, "_blank");
  } catch {}
  if (tab) {
    try {
      tab.opener = null;
    } catch {}
    return "new-tab";
  }

  win.location.assign(target);
  return "same-tab";
}

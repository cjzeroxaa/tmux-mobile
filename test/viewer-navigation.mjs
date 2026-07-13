import assert from "node:assert/strict";
import {
  openViewerUrl,
  shouldUseSameTabForViewer,
  viewerNavigationContext,
} from "../public/viewer-navigation.js";

assert.equal(
  shouldUseSameTabForViewer({ standalone: true }),
  true,
  "installed PWA stays in its authenticated browsing context",
);
assert.equal(
  shouldUseSameTabForViewer({ coarsePointer: true, compactViewport: true }),
  true,
  "phone-sized touch UI uses same-tab navigation",
);
assert.equal(
  shouldUseSameTabForViewer({ coarsePointer: true, compactViewport: false }),
  false,
  "a wide touch-capable desktop can keep new-tab behavior",
);

function fakeWindow({ standalone = false, coarse = false, compact = false, popup = null } = {}) {
  const calls = { assigned: [], opened: [] };
  const win = {
    navigator: { standalone },
    location: { assign: (url) => calls.assigned.push(url) },
    matchMedia(query) {
      if (query === "(display-mode: standalone)") return { matches: standalone };
      if (query === "(pointer: coarse)") return { matches: coarse };
      if (query === "(max-width: 1023px)") return { matches: compact };
      return { matches: false };
    },
    open(url, target) {
      calls.opened.push({ url, target });
      return popup;
    },
  };
  return { win, calls };
}

{
  const { win, calls } = fakeWindow({ coarse: true, compact: true });
  assert.deepEqual(viewerNavigationContext(win), {
    standalone: false,
    coarsePointer: true,
    compactViewport: true,
  });
  assert.equal(openViewerUrl("/api/file-view?x=1", win), "same-tab");
  assert.deepEqual(calls.assigned, ["/api/file-view?x=1"]);
  assert.deepEqual(calls.opened, [], "mobile does not attempt a popup first");
}

{
  const popup = { opener: "parent" };
  const { win, calls } = fakeWindow({ popup });
  assert.equal(openViewerUrl("/api/file-page?x=1", win), "new-tab");
  assert.deepEqual(calls.opened, [{ url: "/api/file-page?x=1", target: "_blank" }]);
  assert.equal(popup.opener, null, "desktop tab cannot reach the opener");
  assert.deepEqual(calls.assigned, []);
}

{
  const { win, calls } = fakeWindow({ popup: null });
  assert.equal(openViewerUrl("/api/file-raw?x=1", win), "same-tab");
  assert.deepEqual(calls.assigned, ["/api/file-raw?x=1"], "blocked popup falls back in place");
}

console.log("viewer-navigation.mjs: all assertions passed");

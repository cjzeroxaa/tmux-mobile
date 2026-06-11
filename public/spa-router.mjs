// SPA shell router. The site has two views — the main app (/app, terminal
// driver) and the Command Center (/ , agent dashboard). They used to be two
// completely separate HTML documents, so jumping between them tore down the
// JS heap, re-downloaded HTML/CSS/JS (cache-control: no-store), and re-ran
// each view's full bootstrap chain. That's the lag you feel when you click
// "Main app →" or "/command-center".
//
// This router keeps both views alive in one document. On first nav to a
// view, it fetches that view's existing HTML once, takes its body content,
// drops it into a wrapper inside #viewRoot, and dynamic-imports the view's
// JS module. Subsequent navigations just hide one wrapper and show the
// other — no fetches, no re-imports, no state loss. windowId stays put.
// pollings keep ticking. The captured snapshot is still on screen the
// moment the view comes back.
//
// State preservation across views is the WHOLE POINT. We deliberately
// don't unload anything except CSS visibility, even when the view is
// hidden — see "no pause/resume" note at the bottom.

const ROUTES = {
  "/": "command-center",
  "/command-center": "command-center",
  "/command-center/": "command-center",
  "/app": "app",
  "/app/": "app",
};

// Source HTML for each view's body content + the module that drives it.
// Kept reachable as standalone files so the router can fetch them, and so
// curl/no-JS clients still have a path that works.
const VIEW_SOURCES = {
  "command-center": { html: "/command-center.html", js: "/command-center.js" },
  app: { html: "/index.html", js: "/app.js" },
};

const viewRoot = document.getElementById("viewRoot");
// Loaded views, keyed by route name. Each entry:
//   { wrapper: <div>, module: ES module, ready: Promise<void> }
const views = new Map();
let currentRoute = null;

function routeFor(pathname) {
  return ROUTES[pathname] || "command-center";
}

// First-time load of a view: fetch its HTML, splice the body content into a
// scoped wrapper, then dynamic-import its JS so its top-level boot runs
// against the freshly-mounted DOM. We cache the module + wrapper so a
// second nav to this view is just "unhide the wrapper".
async function loadView(route) {
  const src = VIEW_SOURCES[route];
  const html = await fetch(src.html, { credentials: "same-origin" }).then((r) => {
    if (!r.ok) throw new Error(`${src.html} → HTTP ${r.status}`);
    return r.text();
  });
  const doc = new DOMParser().parseFromString(html, "text/html");

  const wrapper = document.createElement("div");
  wrapper.className = `spa-view spa-view-${route}`;
  // Carry over the original <body> class so view-scoped CSS (e.g.
  // `.command-center-body .cc-list`) keeps matching, even though we're not
  // actually setting the class on <body>. CSS rules in command-center.css
  // that target ".command-center-body" via descendant selectors will hit
  // because the wrapper now carries it.
  if (doc.body.className) {
    for (const cls of doc.body.className.split(/\s+/).filter(Boolean)) {
      wrapper.classList.add(cls);
    }
  }
  // Drop in the original body's children. We deliberately DON'T copy over
  // <script> tags — we control script execution via dynamic import below
  // so the module loads exactly once per session, and we know when it's
  // ready.
  for (const child of Array.from(doc.body.children)) {
    if (child.tagName === "SCRIPT") continue;
    wrapper.appendChild(child);
  }
  viewRoot.appendChild(wrapper);

  // Capture the source doc's <title> so we can restore it when this view
  // becomes current. Each view's HTML head fills the title; the shell's
  // own title is just a placeholder.
  const title = doc.querySelector("title")?.textContent || document.title;

  // Now import the view's module. Top-level code runs once, against the
  // wrapper we just appended. `els = document.querySelector(...)` calls
  // see live nodes — IDs are document-global, no conflict between views.
  const module = await import(src.js);

  return { wrapper, module, title };
}

async function mount(route) {
  let view = views.get(route);
  const firstMount = !view;
  if (!view) {
    // Stake the slot BEFORE the await so concurrent navigations don't
    // race-load the same view twice.
    const promise = loadView(route);
    views.set(route, { pending: promise });
    view = await promise;
    views.set(route, view);
  } else if (view.pending) {
    view = await view.pending;
    views.set(route, view);
  }
  view.wrapper.hidden = false;
  document.title = view.title;
  // Tell the view it's active again so it can fire a one-shot refresh. On
  // first mount this is redundant (the module's top-level boot already runs
  // its initial load), so we only call it on a re-mount. Without this the
  // user sees up-to-one-poll-interval stale data when they come back — the
  // periodic refresh keeps ticking in the background but the user's eye
  // lands on the screen between ticks. resumeView is an opt-in export; a
  // view module that doesn't define it just silently skips this step.
  if (!firstMount && typeof view.module.resumeView === "function") {
    try {
      view.module.resumeView();
    } catch (err) {
      console.error(`[spa-router] resumeView for ${route} threw:`, err);
    }
  }
  return view;
}

function unmount(route) {
  const view = views.get(route);
  if (!view || view.pending || !view.wrapper) return;
  view.wrapper.hidden = true;
}

async function navigate(pathname, search = window.location.search, { push = true } = {}) {
  const route = routeFor(pathname);
  if (push) {
    history.pushState({ route }, "", pathname + search);
  }
  if (route === currentRoute) {
    if (push) await mount(route);
    return;
  }
  if (currentRoute) unmount(currentRoute);
  await mount(route);
  currentRoute = route;
  // Let the newly-current view know its query string may have changed
  // (e.g. /app?session=2&window=3 deep link). Today the app view re-reads
  // the URL on a popstate event, so synthesizing one keeps that path live.
  if (!push) window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
}

// Intercept same-origin clicks on internal links so they swap views in
// place instead of triggering a document navigation. Anything that isn't
// one of our known routes falls through and the browser handles it.
document.addEventListener("click", (event) => {
  if (event.defaultPrevented) return;
  if (event.button !== 0) return; // only plain left-clicks
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest("a");
  if (!link) return;
  if (link.target && link.target !== "_self") return;
  const href = link.getAttribute("href");
  if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
  let url;
  try {
    url = new URL(link.href, window.location.href);
  } catch {
    return;
  }
  if (url.origin !== window.location.origin) return;
  if (!(url.pathname in ROUTES)) return; // unknown route → let browser handle
  event.preventDefault();
  navigate(url.pathname, url.search);
});

window.addEventListener("popstate", () => {
  navigate(window.location.pathname, window.location.search, { push: false });
});

// Boot: mount whichever view the current URL points to.
navigate(window.location.pathname, window.location.search, { push: false });

// NOTE on "no pause/resume": both views' pollings keep ticking even while
// hidden. That doubles the background traffic the user pays when they've
// visited both views — acceptable for the win of instant switching with
// no state loss. If/when this matters, each view module can export
// pause()/resume() and the router can call them around unmount/mount.

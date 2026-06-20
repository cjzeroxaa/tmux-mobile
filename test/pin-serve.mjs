// Unit tests for the pure servePin() helper (lib/pins.mjs). Covers: 404 on an
// unknown token, 403 for a viewer the pin is not shared with, 200 + correct
// content-type/disposition/cache-control for an authorized viewer on a local
// (proxy) driver, attachment disposition under dl, markdown render-on-view, and
// the presigned-redirect shape when the driver servesDirectly(). Uses an
// in-memory PinIndex.

import assert from "node:assert/strict";

const { createPin, servePin, setPinIndex, hydratePins } = await import("../lib/pins.mjs");
const { createMemoryPinIndex } = await import("../lib/pin-index.mjs");

setPinIndex(createMemoryPinIndex());
await hydratePins();

function localFake() {
  const objects = new Map();
  return {
    kind: "local",
    objects,
    servesDirectly() {
      return false;
    },
    async put(key, bytes) {
      objects.set(key, Buffer.from(bytes));
      return { key, size: bytes.length };
    },
    async get(key) {
      const bytes = objects.get(key);
      return bytes ? { bytes, size: bytes.length } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async url() {
      return "";
    },
  };
}

function cloudFake() {
  const local = localFake();
  return {
    ...local,
    kind: "s3",
    servesDirectly() {
      return true;
    },
    async url(key, { filename } = {}) {
      return `https://signed.example/${key}?fn=${encodeURIComponent(filename || "")}`;
    },
  };
}

const alice = { userId: "alice@x.com", email: "alice@x.com", hd: "x.com" };
const bob = { userId: "bob@x.com", email: "bob@x.com", hd: "x.com" };
// Capture the manage descriptor the renderer is handed so we can assert it.
let lastManage;
const renderMarkdown = (name, text, _truncated, managePin) => {
  lastManage = managePin;
  const owned = managePin && managePin.owned ? "OWNER" : "VIEWER";
  return `<html><title>${name}</title>${text}<!--${owned}--></html>`;
};
// Viewer-wrapper renderer for html/image pins. Capture its args.
let lastViewer;
const renderViewer = (name, kind, rawUrl, managePin) => {
  lastViewer = { name, kind, rawUrl, managePin };
  const owned = managePin && managePin.owned ? "OWNER" : "VIEWER";
  return `<html><title>${name}</title><iframe src="${rawUrl}"></iframe><!--${kind}:${owned}--></html>`;
};

let clock = 1;
const now = () => clock++;

{
  const storage = localFake();
  const { pin } = await createPin(
    {
      viewer: alice,
      bytes: Buffer.from("# Title\nbody"),
      name: "doc.md",
      ext: ".md",
      kind: "markdown",
      contentType: "text/markdown; charset=utf-8",
      sourcePath: "/p/doc.md",
      sourceMachineId: "m1",
      share: { scope: "all" },
    },
    { storage, now },
  );

  // Unknown token → 404.
  assert.equal((await servePin(alice, "no-such-token-xxxxxxxx", { storage })).status, 404);

  // Not shared → 403 (use a private pin for this).
  const { pin: secret } = await createPin(
    { viewer: alice, bytes: Buffer.from("x"), name: "s.txt", ext: ".txt", kind: "other",
      contentType: "text/plain", sourcePath: "/s.txt", sourceMachineId: "m1", share: { scope: "private" } },
    { storage, now },
  );
  assert.equal((await servePin(bob, secret.token, { storage })).status, 403);

  // Owner opening a MARKDOWN pin → renders by default (no view flag), and the
  // renderer is handed a manage descriptor flagged owned.
  const rendered = await servePin(alice, pin.token, { storage, renderMarkdown });
  assert.equal(rendered.status, 200);
  assert.equal(rendered.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(rendered.headers["cache-control"], "private, no-store");
  assert.match(rendered.body.toString(), /<title>doc\.md<\/title>/);
  assert.match(rendered.body.toString(), /<!--OWNER-->/, "owner gets owned=true descriptor");
  assert.equal(lastManage.id, pin.id);
  assert.equal(lastManage.share.scope, "all");

  // A NON-owner viewer (pin is scope:all so bob can see it) → still renders, but
  // the descriptor is NOT owned (overlay hides its controls for them).
  const renderedBob = await servePin(bob, pin.token, { storage, renderMarkdown });
  assert.equal(renderedBob.status, 200);
  assert.match(renderedBob.body.toString(), /<!--VIEWER-->/, "non-owner descriptor not owned");

  // raw=1 → source text, not rendered HTML.
  const raw = await servePin(alice, pin.token, { storage, raw: true });
  assert.equal(raw.headers["content-type"], "text/markdown; charset=utf-8");
  assert.match(raw.headers["content-disposition"], /^inline; filename="doc.md"$/);
  assert.equal(raw.body.toString(), "# Title\nbody");

  // dl=1 → attachment of the source (not rendered).
  const dl = await servePin(alice, pin.token, { storage, dl: true, renderMarkdown });
  assert.match(dl.headers["content-disposition"], /^attachment;/);
  assert.equal(dl.body.toString(), "# Title\nbody");

  // Cloud driver (presign) → raw markdown would render (proxy), but raw=1 takes
  // the presigned redirect path.
  const cloud = cloudFake();
  const { pin: cpin } = await createPin(
    {
      viewer: alice,
      bytes: Buffer.from("# C\nx"),
      name: "c.md",
      ext: ".md",
      kind: "markdown",
      contentType: "text/markdown; charset=utf-8",
      sourcePath: "/p/c.md",
      sourceMachineId: "m1",
      share: { scope: "all" },
    },
    { storage: cloud, now },
  );
  // Default (render) on a presign cloud driver still PROXIES so it can render.
  const cloudRendered = await servePin(bob, cpin.token, { storage: cloud, renderMarkdown });
  assert.equal(cloudRendered.status, 200, "markdown renders (proxies) even on a presign cloud driver");
  assert.match(cloudRendered.body.toString(), /<title>c\.md<\/title>/);
  // raw=1 → 302 to the presigned URL (no render needed).
  const redir = await servePin(bob, cpin.token, { storage: cloud, raw: true });
  assert.equal(redir.status, 302);
  assert.match(redir.redirect, /^https:\/\/signed\.example\//);

  // --- HTML pin → viewer-wrapper page with the owner overlay (the bug: an HTML
  // pin served raw bytes with no management overlay). ---
  const htmlStore = localFake();
  const { pin: hpin } = await createPin(
    {
      viewer: alice,
      bytes: Buffer.from("<html><body><script>1</script></body></html>"),
      name: "flow.forge.html",
      ext: ".html",
      kind: "external",
      contentType: "text/html; charset=utf-8",
      sourcePath: "/p/flow.forge.html",
      sourceMachineId: "m1",
      share: { scope: "all" },
    },
    { storage: htmlStore, now },
  );
  // Owner: wrapper page rendered, overlay flagged owned, iframe points at raw URL.
  const hres = await servePin(alice, hpin.token, { storage: htmlStore, renderViewer, renderMarkdown });
  assert.equal(hres.status, 200);
  assert.equal(hres.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(lastViewer.kind, "html", "html pin uses the html wrapper");
  assert.equal(lastViewer.managePin.owned, true, "owner gets owned overlay");
  assert.match(lastViewer.rawUrl, /token=.*&raw=1$/, "wrapper embeds the raw URL");
  assert.match(hres.body.toString(), /<!--html:OWNER-->/);

  // Non-owner viewer (scope:all) still sees the wrapper, but not owned.
  const hresBob = await servePin(bob, hpin.token, { storage: htmlStore, renderViewer, renderMarkdown });
  assert.match(hresBob.body.toString(), /<!--html:VIEWER-->/, "non-owner not owned");

  // raw=1 → the actual HTML bytes, sandboxed via CSP, NOT the wrapper.
  const hraw = await servePin(alice, hpin.token, { storage: htmlStore, raw: true, renderViewer });
  assert.equal(hraw.headers["content-type"], "text/html; charset=utf-8");
  assert.match(hraw.headers["content-security-policy"], /^sandbox /);
  assert.match(hraw.body.toString(), /<script>/, "raw serves the source bytes");

  // An IMAGE pin uses the image wrapper.
  const imgStore = localFake();
  const { pin: ipin } = await createPin(
    { viewer: alice, bytes: Buffer.from("PNGDATA"), name: "p.png", ext: ".png", kind: "image",
      contentType: "image/png", sourcePath: "/p/p.png", sourceMachineId: "m1", share: { scope: "private" } },
    { storage: imgStore, now },
  );
  await servePin(alice, ipin.token, { storage: imgStore, renderViewer, renderMarkdown });
  assert.equal(lastViewer.kind, "image", "image pin uses the image wrapper");

  console.log("pin-serve unit tests passed");
}

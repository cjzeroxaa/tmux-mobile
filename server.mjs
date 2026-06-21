import { readFileSync } from "node:fs";
import http from "node:http";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import {
  currentBackend,
  findClaudeSessionFromBackend,
  localBackend,
  readClaudeTranscriptFromSession,
  withBackend,
} from "./lib/backend.mjs";
import { CONNECTOR_COMPAT_VERSION, OP } from "./lib/protocol.mjs";
import {
  computeWindowMetadata,
  createMetadataCache,
  detectCommandCenterAgentType,
} from "./lib/window-metadata.mjs";
import {
  createWindowRuntime,
  isNoMuxServerError,
  tmuxFormats,
} from "./lib/window-runtime.mjs";
import { detectTurn } from "./lib/turn-detection.mjs";
import { detectAgentMode, AGENT_MODES } from "./lib/agent-mode.mjs";
import { renderMarkdown } from "./public/markdown.js";
import { escapeHtml as escapeHtmlShared } from "./public/linkify.js";
import { detectAskQuestion, parseAskQuestion } from "./lib/ask-question.mjs";
import {
  singleSelectKeys,
  multiSelectKeys,
  reviewSubmitKeys,
  freeFormKeys,
  cancelKeys,
} from "./lib/ask-question-keys.mjs";
import {
  VOICE_OPTIONS,
  describeVoiceConfig,
  getVoiceConfig,
  updateVoiceConfig,
  withVoiceUser,
} from "./lib/voice-config.mjs";
import { appRevision } from "./lib/revision.mjs";
import {
  createAgentRoundNtfyNotifier,
  createNtfyConfig,
  NTFY_TOPIC_PREFIX,
} from "./lib/agent-ntfy.mjs";
import {
  createArtifactStorage,
  createLocalArtifactStorage,
} from "./lib/artifact-storage.mjs";
import {
  createPin,
  deletePin,
  hydratePins,
  listPins,
  publicPinView,
  renamePin,
  servePin,
  setPinIndex,
  updateShare,
  withPinViewer,
} from "./lib/pins.mjs";
import { createPinIndex } from "./lib/pin-index.mjs";
import {
  addComment,
  deleteComment,
  listComments,
  setCommentIndex,
} from "./lib/comments.mjs";
import { createCommentIndex } from "./lib/comment-index.mjs";
import { stampAids } from "./lib/anchor-stamp.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const connectorDistDir = path.join(__dirname, "dist");
const connectorScriptsDir = path.join(__dirname, "scripts");
const CONNECTOR_BUNDLE_ROUTE = "/connector/tmux-mobile-connector.mjs";
const CONNECTOR_MANIFEST_ROUTE = "/connector/tmux-mobile-connector.json";
// Clone-free join + self-update, served by the controller. The installer is a
// shell one-liner (curl … | sh); the updater is run `curl … | node` like the
// legacy git updater but pulls the bundle instead of a repo.
const CONNECTOR_INSTALL_ROUTE = "/connector/install.sh";
const CONNECTOR_UPDATE_BUNDLE_ROUTE = "/connector/update.mjs";

loadLocalEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3737);
// Browser tab / PWA name. Defaults to a clean product name rather than the host
// name (which on Cloud Run / local shows unhelpful values like "localhost").
// Override with TMUX_MOBILE_APP_TITLE.
const APP_TITLE = process.env.TMUX_MOBILE_APP_TITLE || "tmux Mobile";
const APP_REVISION = appRevision(__dirname);
const CONNECTOR_VERSION =
  process.env.TMUX_MOBILE_CONNECTOR_VERSION || CONNECTOR_COMPAT_VERSION;
const DEFAULT_MACHINE_ALIASES = {
  "homos-mac-mini.local": "mini",
  "macbook-pro-15.local": "MacBook",
  "macbook": "MacBook",
  "fulong-mini": "FIN Mini",
  "ip-172-31-7-169.ec2.internal": "MSB-REBYTE",
  "msbbuild-rebyte": "MSB-REBYTE",
  "msb-build-srp.us-central1-a.c.cj-dev-498907.internal": "MSB-SRP",
  "msb-build-srp": "MSB-SRP",
  "msb-srp": "MSB-SRP",
};
const MACHINE_ALIASES = readMachineAliases(
  process.env.TMUX_MOBILE_MACHINE_ALIASES,
  DEFAULT_MACHINE_ALIASES,
);
function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const MAX_TEXT_BYTES = positiveIntEnv("TMUX_MOBILE_MAX_TEXT_BYTES", 5 * 1024 * 1024);
const MAX_BODY_BYTES = Math.max(
  positiveIntEnv("TMUX_MOBILE_MAX_BODY_BYTES", 512 * 1024),
  MAX_TEXT_BYTES + 64 * 1024,
);
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_ANNOTATION_BYTES = 64 * 1024;
const MAX_CAPTURE_LINES = 5000;
const RMUX_WEB_SHARE_TTL_SECONDS = Number(process.env.RMUX_WEB_SHARE_TTL_SECONDS || 24 * 60 * 60);
const RMUX_WEB_SHARE_TUNNEL_PROVIDER = String(
  process.env.RMUX_WEB_SHARE_TUNNEL_PROVIDER || "localhost-run",
).trim();
const muxStore = new AsyncLocalStorage();
// Voice models (transcription / realtime / TTS) are now runtime-configurable
// via lib/voice-config.mjs and the web app's Settings panel; read them at call
// time with getVoiceConfig() rather than freezing them at module load.
// Max bytes the smart content viewer will read from a pane-referenced file.
const FILE_VIEWER_MAX_BYTES = 5 * 1024 * 1024;
// Larger cap for media/html opened in an external tab (video especially).
const FILE_EXTERNAL_MAX_BYTES = 50 * 1024 * 1024;
// Extensions the viewer recognizes, mapped to a kind + content type.
const IMAGE_EXTS = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"],
]);
const MARKDOWN_EXTS = new Set([".md", ".markdown", ".mdown", ".mkd"]);
// Types opened in an external browser tab (not rendered in the in-app modal):
// video, audio, and standalone HTML. The browser handles playback/rendering
// natively (audio opens with built-in <audio> controls in the new tab).
const EXTERNAL_EXTS = new Map([
  [".webm", "video/webm"],
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".mov", "video/quicktime"],
  // Audio — served inline so the browser tab plays it with native controls.
  [".wav", "audio/wav"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".m4a", "audio/mp4"],
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
]);
function fileExt(filePath) {
  return path.extname(String(filePath)).toLowerCase();
}
function fileKind(filePath) {
  const ext = fileExt(filePath);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (EXTERNAL_EXTS.has(ext)) return "external";
  return "other";
}
function fileContentType(filePath) {
  const ext = fileExt(filePath);
  return (
    IMAGE_EXTS.get(ext) ||
    EXTERNAL_EXTS.get(ext) ||
    "text/markdown; charset=utf-8"
  );
}

// Is this content HTML the browser would execute as a document? Used to decide
// whether to sandbox the response.
function isHtmlContentType(contentType) {
  return /^text\/html\b/i.test(String(contentType || ""));
}

// Security headers for serving a RAW artifact's bytes. Artifacts are arbitrary,
// possibly-hostile, agent-authored content served from this (cookie-bearing)
// origin. For HTML we add `Content-Security-Policy: sandbox` so the document —
// even when opened as a top-level tab ("Open raw") — runs in a unique OPAQUE
// origin: scripts may run (allow-scripts) but the document cannot read this
// origin's cookies/storage or call its APIs. `nosniff` stops a non-HTML type
// from being reinterpreted as HTML. `download` forces the attachment path, which
// never executes, so no sandbox is needed there.
function rawArtifactSecurityHeaders(contentType, { download = false } = {}) {
  const headers = { "x-content-type-options": "nosniff" };
  if (!download && isHtmlContentType(contentType)) {
    // allow-scripts so self-contained pages work; NO allow-same-origin, so the
    // sandboxed document can't reach the app origin.
    headers["content-security-policy"] = "sandbox allow-scripts allow-popups allow-forms";
  }
  return headers;
}

// Make a basename safe for a Content-Disposition filename: strip path bits and
// quotes/control chars that could break the header or smuggle directives.
function sanitizeFilename(name) {
  return String(name || "file")
    .replace(/^.*[/\\]/, "") // basename only
    .replace(/["\r\n]/g, "") // no quotes/newlines in the header
    .replace(/[\x00-\x1f]/g, "")
    .slice(0, 255) || "file";
}

// A self-contained pin overlay injected into the app-rendered pages. It has TWO
// modes, both small fixed-position widgets with no external assets:
//
//  • CREATE mode — on the viewer pages reached from the pane (URL carries
//    paneId/path/machineId). Shows a "Pin" button that POSTs /api/pins, then
//    reveals the share link + scope controls.
//  • MANAGE mode — on the SERVED pin page (/api/pin, e.g. a rendered markdown
//    pin). `managePin` is supplied server-side. For the OWNER it shows the
//    current share scope with controls to change it, copy the link, or unpin
//    (operating on the pin id). For a non-owner it shows nothing — they only see
//    the artifact.
//
// Styles favor the "kami" look (warm card, indigo accent), text labels not emoji
// (per the product's no-emoji rule). Same-origin cookie authenticates requests.
// `managePin` is embedded as a JSON literal with "<" escaped so a value can't
// break out of the <script>.
function pinOverlayHtml(managePin) {
  const manageJson = managePin
    ? JSON.stringify(managePin).replace(/</g, "\\u003c")
    : "null";
  return `
<div id="tm-pin" class="tm-pin" hidden>
  <button id="tm-pin-btn" class="tm-pin-btn" type="button">Pin</button>
  <div id="tm-pin-panel" class="tm-pin-panel" hidden>
    <div class="tm-pin-row">
      <input id="tm-pin-link" class="tm-pin-link" readonly />
      <button id="tm-pin-copy" class="tm-pin-copy" type="button">Copy</button>
    </div>
    <label class="tm-pin-scope">Shared with
      <select id="tm-pin-share">
        <option value="private">Only me</option>
        <option value="users">Specific people…</option>
        <option value="org">My organization</option>
        <option value="all">All logged-in users</option>
      </select>
    </label>
    <input id="tm-pin-users" class="tm-pin-users" placeholder="emails, comma-separated" hidden />
    <button id="tm-pin-unpin" class="tm-pin-unpin" type="button" hidden>Unpin</button>
    <div id="tm-pin-status" class="tm-pin-status"></div>
  </div>
</div>
<style>
  .tm-pin { position: fixed; top: 12px; right: 12px; z-index: 2147483000;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .tm-pin-btn, .tm-pin-copy { cursor: pointer; border: 1px solid rgba(99,102,241,.5);
    background: #6366f1; color: #fff; border-radius: 999px; padding: 6px 14px;
    font-weight: 600; }
  .tm-pin-copy { padding: 4px 10px; font-weight: 500; }
  .tm-pin-panel { margin-top: 8px; background: #fffdf7; color: #1c1917;
    border: 1px solid rgba(0,0,0,.12); border-radius: 10px; padding: 10px;
    width: 280px; box-shadow: 0 6px 24px rgba(0,0,0,.18); }
  @media (prefers-color-scheme: dark) { .tm-pin-panel { background: #2a2622; color: #f5f5f4;
    border-color: rgba(255,255,255,.14); } }
  .tm-pin-row { display: flex; gap: 6px; align-items: center; }
  .tm-pin-link { flex: 1; min-width: 0; font: 12px monospace; padding: 4px 6px;
    border: 1px solid rgba(127,127,127,.4); border-radius: 6px; background: transparent;
    color: inherit; }
  .tm-pin-scope { display: block; margin-top: 8px; }
  .tm-pin-scope select { margin-left: 6px; }
  .tm-pin-users { margin-top: 6px; width: 100%; box-sizing: border-box; padding: 4px 6px;
    border: 1px solid rgba(127,127,127,.4); border-radius: 6px; background: transparent;
    color: inherit; }
  .tm-pin-unpin { margin-top: 8px; cursor: pointer; border: 1px solid rgba(235,93,76,.5);
    background: transparent; color: #eb5d4c; border-radius: 8px; padding: 5px 12px;
    font-weight: 600; }
  .tm-pin-status { margin-top: 6px; min-height: 1em; opacity: .8; }
</style>
<script>
(function () {
  var MANAGE = ${manageJson};
  var root = document.getElementById("tm-pin");
  var btn = document.getElementById("tm-pin-btn");
  var panel = document.getElementById("tm-pin-panel");
  var linkEl = document.getElementById("tm-pin-link");
  var copyEl = document.getElementById("tm-pin-copy");
  var shareEl = document.getElementById("tm-pin-share");
  var usersEl = document.getElementById("tm-pin-users");
  var unpinEl = document.getElementById("tm-pin-unpin");
  var statusEl = document.getElementById("tm-pin-status");

  var params = new URLSearchParams(location.search);
  var paneId = params.get("paneId");
  var filePath = params.get("path");
  var machineId = params.get("machineId");
  var mux = params.get("mux");

  // MANAGE mode: this is an already-pinned, served page. Only the owner gets
  // controls; a non-owner viewer sees no overlay at all.
  var manageMode = MANAGE && typeof MANAGE === "object";
  if (manageMode && !MANAGE.owned) return;
  // CREATE mode needs a pane/file to pin; without either signal, no overlay.
  if (!manageMode && (!paneId || !filePath)) return;
  root.hidden = false;

  var pinId = manageMode ? MANAGE.id : null;

  function currentShare() {
    var scope = shareEl.value;
    var users = scope === "users"
      ? usersEl.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean)
      : [];
    return { scope: scope, users: users };
  }

  function showShareState(scope, users, link) {
    shareEl.value = scope;
    usersEl.hidden = scope !== "users";
    if (users && users.length) usersEl.value = users.join(", ");
    if (link) linkEl.value = link;
  }

  // ---- MANAGE mode: panel is the whole UI (no "Pin" action) ----
  if (manageMode) {
    btn.textContent = "Manage";
    unpinEl.hidden = false;
    showShareState(MANAGE.share.scope, MANAGE.share.users, location.origin + MANAGE.shareUrl);
    btn.addEventListener("click", function () { panel.hidden = !panel.hidden; });
    unpinEl.addEventListener("click", function () {
      if (!window.confirm("Unpin this artifact? The share link will stop working.")) return;
      statusEl.textContent = "Unpinning…";
      fetch("/api/pins?id=" + encodeURIComponent(pinId), { method: "DELETE" })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          statusEl.textContent = res.ok ? "Unpinned. This link no longer works." : (res.j.error || "Unpin failed.");
        })
        .catch(function (e) { statusEl.textContent = "Unpin failed: " + e.message; });
    });
  } else {
    // ---- CREATE mode: "Pin" button POSTs, then reveals the share controls ----
    function pinsUrl() {
      var p = new URLSearchParams({ paneId: paneId, path: filePath });
      if (machineId) p.set("machineId", machineId);
      if (mux) p.set("mux", mux);
      return "/api/pins?" + p.toString();
    }
    function showPinned(pin, deduped) {
      pinId = pin.id;
      showShareState(pin.share.scope, pin.share.users, location.origin + pin.shareUrl);
      statusEl.textContent = deduped ? "Already pinned (unchanged)." : "Pinned (v" + pin.version + ").";
      btn.textContent = "Pinned ✓";
      unpinEl.hidden = false;
      panel.hidden = false;
    }
    btn.addEventListener("click", function () {
      if (pinId) { panel.hidden = !panel.hidden; return; }
      statusEl.textContent = "Pinning…";
      fetch(pinsUrl(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(machineId ? { "x-machine-id": machineId } : {}),
          ...(mux ? { "x-mux": mux } : {}),
        },
        body: JSON.stringify({ share: currentShare() }),
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (!res.ok) { statusEl.textContent = res.j.error || "Pin failed."; panel.hidden = false; return; }
          showPinned(res.j.pin, res.j.deduped);
        })
        .catch(function (e) { statusEl.textContent = "Pin failed: " + e.message; panel.hidden = false; });
    });
    unpinEl.addEventListener("click", function () {
      if (!pinId) return;
      if (!window.confirm("Unpin this artifact? The share link will stop working.")) return;
      fetch("/api/pins?id=" + encodeURIComponent(pinId), { method: "DELETE" })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (res.ok) { pinId = null; btn.textContent = "Pin"; unpinEl.hidden = true; statusEl.textContent = "Unpinned."; }
          else statusEl.textContent = res.j.error || "Unpin failed.";
        })
        .catch(function (e) { statusEl.textContent = "Unpin failed: " + e.message; });
    });
  }

  copyEl.addEventListener("click", function () {
    linkEl.select();
    (navigator.clipboard ? navigator.clipboard.writeText(linkEl.value) : Promise.reject())
      .then(function () { statusEl.textContent = "Link copied."; })
      .catch(function () { try { document.execCommand("copy"); statusEl.textContent = "Link copied."; } catch (e) {} });
  });

  function applyScope() {
    usersEl.hidden = shareEl.value !== "users";
    if (!pinId) return; // (create mode) scope is applied at pin time until then
    statusEl.textContent = "Updating sharing…";
    fetch("/api/pins?id=" + encodeURIComponent(pinId), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ share: currentShare() }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        statusEl.textContent = res.ok ? "Sharing updated." : (res.j.error || "Update failed.");
      })
      .catch(function (e) { statusEl.textContent = "Update failed: " + e.message; });
  }
  shareEl.addEventListener("change", applyScope);
  usersEl.addEventListener("change", applyScope);
})();
</script>`;
}

// A lightweight viewer-wrapper page for images and standalone HTML, so those
// artifacts can host the Pin overlay too (a raw image/HTML response can't). The
// artifact itself is embedded via the existing /api/file-raw URL (an <img> for
// images, a sandboxed <iframe> for HTML), and the overlay rides on top.
//
// HTML SANDBOX: the artifact is arbitrary, possibly-hostile, agent-authored HTML
// served from THIS origin (which holds the session cookie + authenticated APIs).
// The iframe gets `allow-scripts` so self-contained pages work, but NOT
// `allow-same-origin` — that combination would let the artifact script the app
// origin (read the cookie, call /api/* as the user). Without allow-same-origin
// the iframe is a unique OPAQUE origin: scripts run but can't touch the parent's
// cookie/storage/APIs. The cost is that an artifact needing same-origin (relative
// fetch, ES modules, localStorage) still won't fully work — hence the banner with
// an "Open raw" / "Download" escape hatch. The raw endpoint serves HTML under a
// `Content-Security-Policy: sandbox` so even that top-level tab stays opaque.
function renderArtifactViewerPage(name, kind, rawUrl) {
  const title = escapeHtmlShared(sanitizeFilename(name));
  const safeRaw = escapeHtmlShared(rawUrl);
  const dlUrl = `${rawUrl}${rawUrl.includes("?") ? "&" : "?"}dl=1`;
  const safeDl = escapeHtmlShared(dlUrl);
  if (kind === "image") {
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; height: 100%; background: #0b0b0c; }
  body { display: flex; align-items: center; justify-content: center; }
  img { max-width: 100%; max-height: 100vh; height: auto; }
</style>
</head><body>
<img src="${safeRaw}" alt="${title}" />
${pinOverlayHtml()}
</body></html>`;
  }
  // HTML artifact: sandboxed iframe (opaque origin) + a banner escape hatch.
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; height: 100%; background: #0b0b0c; }
  body { display: flex; flex-direction: column; }
  .tm-art-bar { flex: 0 0 auto; display: flex; gap: 8px; align-items: center;
    padding: 6px 10px; background: #fffdf7; color: #1c1917; font: 12px/1.4
    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    border-bottom: 1px solid rgba(0,0,0,.12); }
  @media (prefers-color-scheme: dark) { .tm-art-bar { background: #2a2622; color: #f5f5f4;
    border-color: rgba(255,255,255,.14); } }
  .tm-art-bar .note { flex: 1; min-width: 0; opacity: .8; }
  .tm-art-bar a { cursor: pointer; text-decoration: none; border: 1px solid rgba(99,102,241,.5);
    color: #6366f1; border-radius: 999px; padding: 3px 12px; font-weight: 600; white-space: nowrap; }
  iframe { border: 0; flex: 1 1 auto; width: 100%; background: #fff; }
</style>
</head><body>
<div class="tm-art-bar">
  <span class="note">This artifact runs in a sandbox (no access to your account). If it needs more, open it raw.</span>
  <a href="${safeRaw}" target="_blank" rel="noopener">Open raw</a>
  <a href="${safeDl}">Download</a>
</div>
<iframe src="${safeRaw}" sandbox="allow-scripts allow-popups allow-forms" title="${title}"></iframe>
${pinOverlayHtml()}
</body></html>`;
}

// Wrap rendered markdown in a minimal, self-contained HTML page for a new tab.
// The <title> is the file name so the tab label and "Save as…" are sensible.
// Styles are inlined (the tab isn't the app) and kept close to the in-app viewer.
// `managePin` (optional) is the manage descriptor from servePin — when present,
// the page hosts the pin-management overlay (owner-only share/unpin controls)
// instead of the create-a-pin overlay.
function renderMarkdownPage(name, markdown, truncated, managePin) {
  const title = escapeHtmlShared(sanitizeFilename(name));
  // Stamp a content-hash data-aid on each block so comments can anchor to it.
  const body = stampAids(renderMarkdown(markdown)).html;
  const note = truncated
    ? '<p class="trunc">Showing the first part of a large file.</p>'
    : "";
  // Lazily upgrade ```mermaid blocks to diagrams — only inject the script when
  // the page actually contains one (mirrors the in-app lazy CDN loader). strict
  // securityLevel so an untrusted diagram can't inject HTML/script.
  const mermaidScript = /class="mermaid-block"/.test(body)
    ? `<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict",
    theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" });
  let n = 0;
  for (const block of document.querySelectorAll('pre.mermaid-block')) {
    try {
      const { svg } = await mermaid.render("md-" + (++n), block.textContent);
      const fig = document.createElement("div"); fig.innerHTML = svg; block.replaceWith(fig);
    } catch (e) { block.title = "Mermaid render failed: " + (e?.message || ""); }
  }
</script>`
    : "";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 820px; margin: 0 auto; padding: 24px 18px 64px;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  h1,h2,h3,h4 { line-height: 1.25; }
  pre { background: rgba(127,127,127,.12); padding: 12px; border-radius: 8px; overflow:auto; }
  code { background: rgba(127,127,127,.14); padding: .1em .35em; border-radius: 4px; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid rgba(127,127,127,.4); padding: 6px 10px; }
  blockquote { margin: .6em 0; padding-left: 12px; border-left: 3px solid rgba(127,127,127,.5); opacity:.85; }
  img { max-width: 100%; height: auto; }
  li.task-item { list-style: none; margin-left: -1.2em; }
  del { opacity: .7; }
  .md-math { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
  .md-math-inline { white-space: nowrap; }
  .md-math-display { display:block; overflow-x:auto; margin: .7em 0; padding:.45em .55em;
    border-left:3px solid rgba(35,131,226,.42); background: rgba(35,131,226,.06);
    line-height:1.7; white-space:nowrap; }
  .md-math-frac { display:inline-grid; grid-template-rows:auto auto; align-items:center;
    vertical-align:middle; text-align:center; line-height:1.05; }
  .md-math-frac > span:first-child { border-bottom: 1px solid currentColor; padding: 0 .18em .08em; }
  .md-math-frac > span:last-child { padding: .08em .18em 0; }
  .md-math-underbrace { display:inline-flex; flex-direction:column; align-items:center;
    vertical-align:middle; line-height:1.05; }
  .trunc { color: #b26b00; font-style: italic; }
  svg { max-width: 100%; height: auto; }
</style>
</head><body>
${note}
${body}
${mermaidScript}
${commentOverlayHtml()}
${pinOverlayHtml(managePin)}
</body></html>`;
}

// Inline, mobile-first comment overlay for a rendered pin. Blocks carry data-aid
// (stampAids). Single TAP on a block toggles an inline panel right BELOW it with
// that block's thread + an input (no right margin — see the agreed mobile UX);
// commented blocks get a left highlight + a 💬n marker; a bottom FAB opens a flat
// list of all comments. Talks to /api/comments?token=… (token from the page URL,
// auth via the session cookie). Self-contained vanilla JS.
function commentOverlayHtml() {
  return `<style>
  [data-aid] { scroll-margin-top: 56px; }
  [data-aid].tmc-has { position: relative; box-shadow: inset 3px 0 0 rgba(35,131,226,.55); }
  [data-aid].tmc-has::after {
    content: "\\1F4AC " attr(data-tmc-count);
    position: absolute; top: 0; right: -2px; transform: translateY(-30%);
    font-size: 11px; line-height: 1; padding: 2px 5px; border-radius: 10px;
    background: rgba(35,131,226,.14); color: #1a6cbd; pointer-events: none;
  }
  [data-aid].tmc-active { box-shadow: inset 3px 0 0 rgba(35,131,226,.9); }
  .tmc-region {
    margin: 8px 0 14px; padding: 10px; border: 1px solid rgba(127,127,127,.32);
    border-radius: 10px; background: rgba(127,127,127,.06); font-size: 14px;
  }
  .tmc-c { padding: 6px 0; border-bottom: 1px solid rgba(127,127,127,.18); }
  .tmc-c:last-of-type { border-bottom: 0; }
  .tmc-c-head { display:flex; gap:6px; align-items:center; font-size:12px; opacity:.75; }
  .tmc-c-text { white-space: pre-wrap; word-break: break-word; margin-top: 2px; }
  .tmc-del { margin-left:auto; cursor:pointer; border:0; background:none; color:#c0392b; font-size:12px; padding:0 4px; }
  .tmc-input { width:100%; box-sizing:border-box; min-height:54px; margin-top:6px; padding:7px 8px;
    border:1px solid rgba(127,127,127,.4); border-radius:8px; font:inherit; resize:vertical; }
  .tmc-actions { display:flex; gap:8px; margin-top:6px; }
  .tmc-send { cursor:pointer; border:1px solid rgba(35,131,226,.5); background:rgba(35,131,226,.12);
    color:#1a6cbd; border-radius:8px; padding:6px 14px; font:inherit; font-weight:600; }
  .tmc-cancel { cursor:pointer; border:1px solid rgba(127,127,127,.4); background:transparent;
    color:inherit; border-radius:8px; padding:6px 12px; font:inherit; }
  .tmc-status { min-height:1em; font-size:12px; opacity:.7; margin-top:4px; }
  .tmc-fab { position:fixed; left:12px; bottom:calc(12px + env(safe-area-inset-bottom)); z-index:2147483000;
    cursor:pointer; border:1px solid rgba(35,131,226,.5); background:#fffdf7; color:#1a6cbd;
    border-radius:999px; padding:8px 14px; font:600 13px -apple-system,system-ui,sans-serif; box-shadow:0 2px 10px rgba(0,0,0,.15); }
  @media (prefers-color-scheme: dark){ .tmc-fab{ background:#2a2622; color:#9ecbff; } }
  .tmc-fab[hidden]{ display:none; }
  .tmc-sheet { position:fixed; inset:0; z-index:2147483001; background:rgba(0,0,0,.35); display:flex; align-items:flex-end; }
  .tmc-sheet[hidden]{ display:none; }
  .tmc-sheet-panel { width:100%; max-height:70vh; overflow:auto; background:var(--bg,#fff); color:inherit;
    border-radius:14px 14px 0 0; padding:14px 14px calc(18px + env(safe-area-inset-bottom)); }
  @media (prefers-color-scheme: dark){ .tmc-sheet-panel{ background:#1c1917; } }
  .tmc-sheet-item { padding:10px 0; border-bottom:1px solid rgba(127,127,127,.18); cursor:pointer; }
  .tmc-sheet-snip { font-size:12px; opacity:.65; }
</style>
<button id="tmc-fab" class="tmc-fab" type="button" hidden>\\1F4AC Comments</button>
<div id="tmc-sheet" class="tmc-sheet" hidden><div class="tmc-sheet-panel" id="tmc-sheet-panel"></div></div>
<script>
(function(){
  var token = new URLSearchParams(location.search).get("token");
  if (!token) return;
  var byAid = {}, openAnchor = null, openRegion = null;
  function esc(s){ var d=document.createElement("div"); d.textContent = s==null?"":String(s); return d.innerHTML; }
  function icon(s){ return s==="applied"||s==="resolved"?"\\u2705":s==="partial"?"\\uD83D\\uDFE1":s==="question"?"\\u2753":""; }
  function call(method, opts){
    opts = opts || {};
    var url = "/api/comments?token=" + encodeURIComponent(token) + (opts.id ? "&id="+encodeURIComponent(opts.id) : "");
    return fetch(url, { method:method, credentials:"same-origin",
      headers: opts.body ? {"content-type":"application/json"} : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||("HTTP "+r.status)); return j; }); });
  }
  function group(list){ byAid={}; (list||[]).forEach(function(c){ (byAid[c.aid]=byAid[c.aid]||[]).push(c); }); }
  function totalCount(){ var n=0; for(var k in byAid) n+=byAid[k].length; return n; }
  function badges(){
    document.querySelectorAll("[data-aid]").forEach(function(el){
      var n=(byAid[el.getAttribute("data-aid")]||[]).length;
      el.classList.toggle("tmc-has", n>0);
      if(n>0) el.setAttribute("data-tmc-count", n); else el.removeAttribute("data-tmc-count");
    });
    var fab=document.getElementById("tmc-fab"); var t=totalCount();
    fab.hidden = t===0; fab.textContent = "\\uD83D\\uDCAC " + t;
  }
  function load(){ return call("GET").then(function(j){ group(j.comments); badges(); }).catch(function(){}); }

  function renderRegion(anchor){
    var aid = anchor.getAttribute("data-aid");
    var region = document.createElement("div");
    region.className = "tmc-region";
    var list = byAid[aid] || [];
    var html = "";
    list.forEach(function(c){
      html += '<div class="tmc-c" data-id="'+esc(c.id)+'">'
        + '<div class="tmc-c-head">'+ (icon(c.status)?('<span>'+icon(c.status)+'</span>'):'')
        + '<span>'+esc(c.authorEmail||"someone")+'</span>'
        + (c.owned?'<button class="tmc-del" type="button" data-del="'+esc(c.id)+'">delete</button>':'')
        + '</div><div class="tmc-c-text">'+esc(c.text)+'</div></div>';
    });
    html += '<textarea class="tmc-input" placeholder="Add a comment\\u2026"></textarea>'
      + '<div class="tmc-actions"><button class="tmc-send" type="button">Send</button>'
      + '<button class="tmc-cancel" type="button">Close</button></div>'
      + '<div class="tmc-status"></div>';
    region.innerHTML = html;
    var ta = region.querySelector(".tmc-input");
    var status = region.querySelector(".tmc-status");
    region.querySelector(".tmc-send").addEventListener("click", function(){
      var text = ta.value.trim(); if(!text) return;
      status.textContent = "Sending\\u2026";
      call("POST", { body:{ aid:aid, text:text } }).then(function(j){
        (byAid[aid]=byAid[aid]||[]).push(j.comment); ta.value="";
        status.textContent=""; badges(); reopen(anchor);
      }).catch(function(e){ status.textContent = e.message || "Failed"; });
    });
    region.querySelector(".tmc-cancel").addEventListener("click", close);
    region.querySelectorAll("[data-del]").forEach(function(btn){
      btn.addEventListener("click", function(){
        var id=btn.getAttribute("data-del");
        call("DELETE", { id:id }).then(function(){
          byAid[aid]=(byAid[aid]||[]).filter(function(c){return c.id!==id;});
          badges(); reopen(anchor);
        }).catch(function(e){ status.textContent=e.message||"Failed"; });
      });
    });
    anchor.insertAdjacentElement("afterend", region);
    openAnchor = anchor; openRegion = region; anchor.classList.add("tmc-active");
    ta.focus();
  }
  function close(){
    if(openRegion){ openRegion.remove(); openRegion=null; }
    if(openAnchor){ openAnchor.classList.remove("tmc-active"); openAnchor=null; }
  }
  function reopen(anchor){ close(); renderRegion(anchor); }
  function toggle(anchor){ if(openAnchor===anchor){ close(); } else { close(); renderRegion(anchor); } }

  document.body.addEventListener("click", function(ev){
    var t = ev.target;
    if (!(t instanceof Element)) return;
    if (t.closest(".tmc-region") || t.closest(".tmc-fab") || t.closest(".tmc-sheet")) return;
    if (t.closest("a,button,input,textarea,select,summary,label")) return;
    var blk = t.closest("[data-aid]");
    if (!blk) return;
    toggle(blk);
  });

  // Bottom FAB → flat list of all comments; tap an item to jump + open its block.
  var sheet=document.getElementById("tmc-sheet"), panel=document.getElementById("tmc-sheet-panel");
  var lastPrompt="";
  function buildPrompt(){
    var lines=["The following review comments were left on this document. Please address each one and reply with what you changed.",""];
    document.querySelectorAll("[data-aid]").forEach(function(el){
      var list=byAid[el.getAttribute("data-aid")]||[]; if(!list.length) return;
      var snip=(el.textContent||"").replace(/\\s+/g," ").trim().slice(0,120);
      lines.push("> "+snip);
      list.forEach(function(c){ lines.push("- "+c.text+(c.status&&c.status!=="open"?(" ["+c.status+"]"):"")); });
      lines.push("");
    });
    return lines.join("\\n");
  }
  document.getElementById("tmc-fab").addEventListener("click", function(){
    var rows="";
    document.querySelectorAll("[data-aid]").forEach(function(el){
      var list=byAid[el.getAttribute("data-aid")]||[]; if(!list.length) return;
      var snip=(el.textContent||"").replace(/\\s+/g," ").trim().slice(0,60);
      list.forEach(function(c){
        rows += '<div class="tmc-sheet-item" data-aid="'+esc(el.getAttribute("data-aid"))+'">'
          + '<div>'+(icon(c.status)?icon(c.status)+" ":"")+esc(c.text)+'</div>'
          + '<div class="tmc-sheet-snip">'+esc(snip)+'</div></div>';
      });
    });
    lastPrompt = buildPrompt();
    var header = totalCount()>0
      ? '<div class="tmc-actions" style="margin-bottom:8px"><button class="tmc-send" type="button" id="tmc-copy-prompt">Copy as prompt</button></div>'
      : '';
    panel.innerHTML = header + (rows || '<div class="tmc-sheet-snip">No comments yet.</div>');
    sheet.hidden=false;
  });
  sheet.addEventListener("click", function(ev){
    if(ev.target.closest("#tmc-copy-prompt")){
      (navigator.clipboard ? navigator.clipboard.writeText(lastPrompt) : Promise.reject())
        .then(function(){ ev.target.textContent="Copied \\u2713"; })
        .catch(function(){ ev.target.textContent="Copy failed"; });
      return;
    }
    var item=ev.target.closest(".tmc-sheet-item");
    if(!item){ if(ev.target===sheet) sheet.hidden=true; return; }
    sheet.hidden=true;
    var el=document.querySelector('[data-aid="'+CSS.escape(item.getAttribute("data-aid"))+'"]');
    if(el){ el.scrollIntoView({block:"center"}); reopen(el); }
  });

  load();
})();
</script>`;
}

// Shared validation + read for the file-serving routes (/api/file, /api/file-raw,
// /api/file-view). Returns { requestedPath, name, kind, contentType, result } on
// success, or null after sending the appropriate error response.
async function readFileForServing(req, res, url) {
  const paneId = requireId(url.searchParams.get("paneId"), "pane");
  const requestedPath = String(url.searchParams.get("path") || "");
  if (!requestedPath) {
    sendJson(res, 400, { error: "path is required" });
    return null;
  }
  const kind = fileKind(requestedPath);
  if (kind === "other") {
    sendJson(res, 415, { error: "Unsupported file type" });
    return null;
  }
  const backend = currentBackend();
  if (typeof backend.supportsOp === "function" && !backend.supportsOp(OP.READFILE)) {
    sendJson(res, 501, {
      error:
        "This machine's connector is out of date — restart it (node server.mjs --register …) to view files.",
    });
    return null;
  }
  const cwd = await getPaneCwd(paneId);
  const isAbsoluteOrHome = path.isAbsolute(requestedPath) || requestedPath.startsWith("~");
  if (!cwd && !isAbsoluteOrHome) {
    sendJson(res, 404, { error: "Pane has no working directory" });
    return null;
  }
  try {
    const result = await backend.readfile(requestedPath, {
      baseDir: cwd,
      maxBytes: kind === "external" ? FILE_EXTERNAL_MAX_BYTES : FILE_VIEWER_MAX_BYTES,
    });
    return {
      requestedPath,
      name: path.basename(requestedPath),
      kind,
      contentType: fileContentType(requestedPath),
      result,
    };
  } catch (error) {
    if (/unknown op/i.test(error.message) || error instanceof TypeError) {
      sendJson(res, 501, {
        error: "This machine's connector is out of date — restart it to view files.",
      });
      return null;
    }
    const status = error.code === "EACCES" ? 403 : 404;
    sendJson(res, status, { error: error.message || "Could not read file" });
    return null;
  }
}

// Sanitize a voice-send prefix (e.g. "/btw "). Allow a leading-slash command
// word plus an optional trailing space — letters/digits/-/_ only — and cap the
// length, so it can't smuggle control sequences or shell into the pasted text.
function sanitizeVoicePrefix(raw) {
  const s = String(raw || "").slice(0, 32);
  const m = s.match(/^(\/[A-Za-z][A-Za-z0-9_-]{0,20})(\s?)$/);
  if (!m) return "";
  return `${m[1]} `; // normalize to exactly one trailing space
}
// Git repo a user clones to run the connector (agent). Shown in the
// "no machine connected" UI; override for forks/mirrors.
const CONNECTOR_CLONE_URL =
  process.env.TMUX_MOBILE_CLONE_URL ||
  "https://github.com/cjzeroxaa/tmux-mobile.git";
const DEFAULT_CONTROLLER_URL =
  process.env.TMUX_MOBILE_CONTROLLER_URL || "https://eng.impo.ai";
const CONNECTOR_UPDATE_SCRIPT_PATH = "scripts/update-connector.mjs";
const CONNECTOR_UPDATE_REF =
  safeUpdateToken(process.env.TMUX_MOBILE_UPDATE_REF) || "main";
const CONNECTOR_EXPECTED_REVISION =
  safeUpdateToken(process.env.TMUX_MOBILE_EXPECTED_REVISION) ||
  safeUpdateToken(APP_REVISION) ||
  "";
const CONNECTOR_UPDATE_SCRIPT_URL =
  process.env.TMUX_MOBILE_UPDATE_SCRIPT_URL ||
  defaultConnectorUpdateScriptUrl(CONNECTOR_CLONE_URL, CONNECTOR_UPDATE_REF);
const WINDOW_BRIEFING_MODEL =
  process.env.OPENAI_WINDOW_BRIEFING_MODEL || "gpt-5.4-mini";
const configuredSubmitNudgeDelayMs = Number(
  process.env.TMUX_SUBMIT_NUDGE_DELAY_MS,
);
const SUBMIT_NUDGE_DELAY_MS =
  Number.isFinite(configuredSubmitNudgeDelayMs) &&
  configuredSubmitNudgeDelayMs >= 0
    ? configuredSubmitNudgeDelayMs
    : 700;
// Gap between finishing a bracketed paste and sending the submit Enter. tmux
// pastes text wrapped in bracketed-paste markers (ESC[200~ … ESC[201~); if the
// Enter is sent immediately it arrives in the SAME terminal read as the paste
// tail, and input-line apps (Claude/Codex CLIs, readline) often consume it as
// part of paste finalization instead of as "submit" — so the line sits unsent.
// A short delay makes the Enter land as its own keypress, reliably submitting.
const PASTE_ENTER_DELAY_MS = parsePositiveInteger(
  process.env.TMUX_PASTE_ENTER_DELAY_MS,
  120,
);
// Delay between keystrokes when driving the AskUserQuestion TUI, so its cursor
// movement / toggles keep up with the input over the WebSocket.
const ASK_KEY_DELAY_MS = parsePositiveInteger(
  process.env.TMUX_ASK_KEY_DELAY_MS,
  140,
);
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
const WINDOW_BRIEFING_LINES = 60;
const REALTIME_WINDOW_BRIEFING_MAX_CAPTURE_LINES = 500;
const REALTIME_WINDOW_BRIEFING_CHUNK_LINES = parsePositiveInteger(
  process.env.OPENAI_REALTIME_WINDOW_BRIEFING_CHUNK_LINES,
  12,
);
const REALTIME_WINDOW_BRIEFING_CHUNK_CHARS = parsePositiveInteger(
  process.env.OPENAI_REALTIME_WINDOW_BRIEFING_CHUNK_CHARS,
  1200,
);
const REALTIME_CLIENT_SECRET_TTL_SECONDS = Math.min(
  Math.max(
    parsePositiveInteger(
      process.env.OPENAI_REALTIME_CLIENT_SECRET_TTL_SECONDS,
      600,
    ),
    10,
  ),
  7200,
);
const WINDOW_BRIEFING_INSTRUCTIONS =
  "You are turning the last visible terminal output into something useful to listen to. The input is the last lines captured from the active pane of a tmux window where a coding agent, shell, editor, or test/build process may be running. Your job is to summarize and restate the actual content in those lines, not to describe the fact that an agent is speaking, explaining, coding, or summarizing. If the output contains an explanation, explain the substance of that explanation. If it contains a plan, report the plan. If it contains code-review findings, report the findings. If it contains command output, report the meaningful results, errors, files, commands, and blockers. Avoid meta phrases such as \"the agent is explaining\", \"the output discusses\", \"it mentions\", or \"the terminal shows\" unless there is no substantive content to report. Ignore ANSI escape sequences, control characters, redraw artifacts, repeated progress-only lines, prompts with no meaningful state, and other terminal noise. Be faithful to the visible output and do not invent missing context. Write a natural spoken summary of 3-7 sentences, no Markdown, no bullets, no code fences. Use Chinese if the terminal output or user task is primarily Chinese; otherwise use English.";
const REALTIME_WINDOW_BRIEFING_INSTRUCTIONS =
  "Read the provided bullets aloud as a brisk, natural spoken summary at a quick but clear pace — faster than a default newsreader. Skip the leading '- '. Connect the bullets into flowing sentences rather than reading them staccato. Do not preface, do not add framing, do not translate. Use the input's language. If the input is one chunk of a longer summary, continue naturally without announcing chunk numbers.";
const REALTIME_WINDOW_BRIEFING_MAX_OUTPUT_TOKENS =
  parseRealtimeOutputTokenLimit(
    process.env.OPENAI_REALTIME_WINDOW_BRIEFING_MAX_OUTPUT_TOKENS,
  );

function parseRealtimeOutputTokenLimit(value) {
  const normalized = String(value || "inf").trim().toLowerCase();
  if (!normalized || normalized === "inf") return "inf";

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return "inf";
  return Math.min(Math.floor(parsed), 4096);
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function defaultConnectorUpdateScriptUrl(cloneUrl, revision) {
  const ref = safeUpdateToken(revision) || "main";
  const repo = githubRepoPath(cloneUrl);
  if (!repo) {
    return `https://raw.githubusercontent.com/cjzeroxaa/tmux-mobile/${ref}/${CONNECTOR_UPDATE_SCRIPT_PATH}`;
  }
  return `https://raw.githubusercontent.com/${repo}/${ref}/${CONNECTOR_UPDATE_SCRIPT_PATH}`;
}

function githubRepoPath(cloneUrl) {
  const url = String(cloneUrl || "").trim();
  const https = url.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (https) return `${https[1]}/${https[2]}`;
  const ssh = url.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  return "";
}

function safeUpdateToken(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9._/-]{1,120}$/.test(text) ? text : "";
}

function safeUpdateUrl(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 512 || /[\0\r\n]/.test(text)) return "";
  try {
    const parsed = new URL(text);
    return /^https?:$/.test(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function loadLocalEnv(filePath) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    const quote = value[0];
    if (
      (quote === '"' || quote === "'") &&
      value.endsWith(quote) &&
      value.length >= 2
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const formats = tmuxFormats;

const allowedKeys = new Set([
  "Enter",
  "q",
  "C-c",
  "C-d",
  "C-u",
  "C-z",
  "Tab",
  "BTab", // Shift+Tab — cycles agent permission mode (Claude + Codex)
  "Escape",
  "BSpace",
  "Up",
  "Down",
  "Left",
  "Right",
]);

function runTmux(args, options = {}) {
  return currentWindowRuntime().tmux(args, options);
}

function isNoServerError(error) {
  return isNoMuxServerError(error);
}

function currentWindowRuntime() {
  return createWindowRuntime(currentBackend(), { mux: currentRequestMux() });
}

function normalizeMuxName(value) {
  const mux = String(value || "").trim().toLowerCase();
  return mux === "tmux" || mux === "rmux" ? mux : "";
}

function currentRequestMux() {
  return muxStore.getStore() || "";
}

function withRequestMux(mux, fn) {
  return muxStore.run(normalizeMuxName(mux), fn);
}

function requestMux(req, url) {
  return normalizeMuxName(req.headers["x-mux"] || url.searchParams.get("mux"));
}

function backendMuxKinds() {
  const backend = currentBackend();
  if (typeof backend.muxKinds === "function") {
    const muxes = backend.muxKinds().map(normalizeMuxName).filter(Boolean);
    if (muxes.length > 0) return [...new Set(muxes)];
  }
  const mux =
    (typeof backend.muxKind === "function" ? normalizeMuxName(backend.muxKind()) : "") ||
    (typeof backend.muxCommand === "function" ? normalizeMuxName(backend.muxCommand()) : "") ||
    "tmux";
  return [mux];
}

function windowRuntimeForMux(mux) {
  return createWindowRuntime(currentBackend(), { mux });
}

function rows(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

function requireTmuxFieldCount(row, minFields, label) {
  if (row.length >= minFields) return;
  const error = new Error(
    `Malformed tmux ${label} row: expected at least ${minFields} tab-separated fields, got ${row.length}`,
  );
  error.status = 500;
  throw error;
}

function requireTmuxNumericField(value, label) {
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const error = new Error(`Malformed tmux row: ${label} must be numeric`);
  error.status = 500;
  throw error;
}

function requireId(value, type) {
  const patterns = {
    session: /^\$\d+$/,
    window: /^@\d+$/,
    pane: /^%\d+$/,
  };
  if (!patterns[type].test(value || "")) {
    const error = new Error(`Invalid ${type} id`);
    error.status = 400;
    throw error;
  }
  return value;
}

function requireSessionName(value) {
  const name = String(value || "").trim();
  if (!name) {
    const error = new Error("Session name is required");
    error.status = 400;
    throw error;
  }
  if (name.length > 80 || /[:\t\r\n]/.test(name)) {
    const error = new Error("Session name cannot include colon, tabs, or newlines");
    error.status = 400;
    throw error;
  }
  return name;
}

function requireDirectoryPath(value) {
  const dirPath = String(value || "").trim();
  if (!dirPath) {
    const error = new Error("Directory path is required");
    error.status = 400;
    throw error;
  }
  if (dirPath.length > 4096 || /[\0\r\n]/.test(dirPath)) {
    const error = new Error("Directory path is invalid");
    error.status = 400;
    throw error;
  }
  return dirPath;
}

function parseLines(value) {
  const lines = Number(value || 500);
  if (!Number.isFinite(lines) || lines < 1) return 500;
  return Math.min(Math.floor(lines), MAX_CAPTURE_LINES);
}

function textExcerpt(text, max = 5000) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} chars]`;
}

function escapeHtmlAttribute(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderIndexHtml(template) {
  return template.replaceAll("__APP_TITLE__", escapeHtmlAttribute(APP_TITLE));
}

function sendWebManifest(res) {
  const body = JSON.stringify({
    name: APP_TITLE,
    short_name: APP_TITLE,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f5f1e8",
    theme_color: "#202124",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  });
  res.writeHead(200, {
    "content-type": "application/manifest+json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function cleanTerminalText(text) {
  const lines = String(text || "")
    .replace(/\x1B\][^\x07]*?(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .split("\n")
    .map((line) => line.trimEnd());

  const kept = [];
  let lastWasBlank = false;
  for (const line of lines) {
    if (isSeparatorLine(line)) continue;
    const blank = line.length === 0;
    if (blank && lastWasBlank) continue;
    kept.push(line);
    lastWasBlank = blank;
  }
  return kept.join("\n").trimEnd();
}

function isSeparatorLine(line) {
  const trimmed = line.trim();
  if (trimmed.length < 6) return false;
  return /^[-=_*~+─-╿]+$/.test(trimmed);
}

// Like cleanTerminalText but keeps SGR (color/style) escape sequences so the
// browser can render them; still strips OSC, cursor/other CSI, and control
// chars, and de-noises blank/separator lines (tested on the SGR-stripped text).
function cleanTerminalTextKeepAnsi(text) {
  const lines = String(text || "")
    .replace(/\x1B\][^\x07]*?(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B[@-Z\\-_]/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-ln-~]/g, "")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""));

  const kept = [];
  let lastWasBlank = false;
  for (const line of lines) {
    const plain = line.replace(/\x1B\[[0-9;:]*m/g, "");
    if (isSeparatorLine(plain)) continue;
    const blank = plain.length === 0;
    if (blank && lastWasBlank) continue;
    kept.push(line);
    lastWasBlank = blank;
  }
  return kept.join("\n").trimEnd();
}

function splitRealtimeBriefingOutput(text) {
  const lines = String(text || "").split("\n");
  const chunks = [];
  let current = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current.join("\n").trim());
    current = [];
    currentChars = 0;
  };

  for (const line of lines) {
    const nextChars = currentChars + line.length + (current.length > 0 ? 1 : 0);
    const overLineLimit = current.length >= REALTIME_WINDOW_BRIEFING_CHUNK_LINES;
    const overCharLimit =
      current.length > 0 && nextChars > REALTIME_WINDOW_BRIEFING_CHUNK_CHARS;
    if (overLineLimit || overCharLimit) {
      flush();
    }
    current.push(line);
    currentChars += line.length + (current.length > 1 ? 1 : 0);
  }
  flush();

  return chunks.filter(Boolean);
}

function oneLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function limitWords(text, maxWords) {
  const words = oneLine(text).split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}.`;
}

function summarizeOutput(text) {
  const allLines = text.split(/\r?\n/);
  const nonEmpty = allLines.map((line) => line.trim()).filter(Boolean);
  const errorPattern =
    /\b(error|failed|failure|exception|traceback|panic|fatal|denied|not found|timeout|segfault)\b/i;
  const errorLines = nonEmpty.filter((line) => errorPattern.test(line)).slice(-8);

  return {
    lineCount: allLines.length,
    nonEmptyCount: nonEmpty.length,
    lastLine: nonEmpty.at(-1) || "",
    recent: nonEmpty.slice(-8),
    errors: errorLines,
  };
}

async function pasteTextToPane(paneId, text) {
  await currentWindowRuntime().pasteTextToSurface({ surfaceId: paneId, text });
}

async function sendTextToPane(paneId, text, { enter = false } = {}) {
  return currentWindowRuntime().sendTextToSurface({
    surfaceId: paneId,
    text,
    enter,
    pasteEnterDelayMs: PASTE_ENTER_DELAY_MS,
  });
}

// Before delivering any input, drop the pane out of the scrollback pager so the
// keystroke lands on the program. Returns true if it had to exit.
async function exitCopyModeIfNeeded(paneId) {
  return currentWindowRuntime().exitSurfaceModeIfNeeded({ surfaceId: paneId });
}

function sendSubmitNudge(paneId) {
  setTimeout(() => {
    currentWindowRuntime().sendKeyToSurface({ surfaceId: paneId, key: "Enter" }).catch((error) => {
      console.error(`submit nudge failed: ${error.message}`);
    });
  }, SUBMIT_NUDGE_DELAY_MS);
}

function requireRmuxRuntime() {
  const runtime = currentWindowRuntime();
  if (runtime.kind !== "rmux") {
    const error = new Error("RMUX web share is only available for RMUX windows");
    error.status = 400;
    throw error;
  }
  return runtime;
}

async function resolveSharePaneId({ paneId, windowId } = {}) {
  if (paneId) return requireId(paneId, "pane");
  const winId = requireId(windowId, "window");
  const panes = await listPanes(winId);
  const pane = panes.find((item) => item.active) || panes[0];
  if (!pane?.id) {
    const error = new Error("Window has no pane to share");
    error.status = 404;
    throw error;
  }
  return requireId(pane.id, "pane");
}

async function createRmuxWebShare({ paneId, windowId, ttlSeconds } = {}) {
  requireRmuxRuntime();
  const backend = currentBackend();
  if (typeof backend.supportsOp === "function" && !backend.supportsOp(OP.RMUX_WEB_SHARE)) {
    const error = new Error(
      "This machine's connector is out of date — restart it to share RMUX terminals.",
    );
    error.status = 501;
    throw error;
  }
  if (typeof backend.rmuxWebShare !== "function") {
    const error = new Error("This connector cannot create RMUX web shares");
    error.status = 501;
    throw error;
  }
  const target = await resolveSharePaneId({ paneId, windowId });
  const ttl = Number(ttlSeconds);
  return backend.rmuxWebShare({
    target,
    ttlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : RMUX_WEB_SHARE_TTL_SECONDS,
    tunnelProvider: RMUX_WEB_SHARE_TUNNEL_PROVIDER,
  });
}

function sessionFromRow(row) {
  requireTmuxFieldCount(row, 5, "session");
  const [id, name, windows, attached, created] = row;
  requireId(id, "session");
  return {
    id,
    name,
    windows: requireTmuxNumericField(windows || 0, "session_windows"),
    attached: attached === "1",
    created,
  };
}

async function createSession(name) {
  return currentWindowRuntime().createSession({ name });
}

const START_AGENT_COMMANDS = {
  codex: { command: "codex", windowName: "codex" },
  claude: { command: "claude", windowName: "claude" },
};

function requireStartAgentKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(START_AGENT_COMMANDS, kind)) return kind;
  const error = new Error("Agent kind must be codex or claude");
  error.status = 400;
  throw error;
}

function sessionSlug(value) {
  const cleaned = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return cleaned || "work";
}

function defaultStartAgentSessionName(kind, cwd) {
  const trimmed = String(cwd || "").replace(/\/+$/, "");
  const base = path.basename(trimmed) || "home";
  return `${kind}-${sessionSlug(base)}-${Date.now().toString(36)}`;
}

async function startAgentSession(options = {}) {
  const runtime = currentWindowRuntime();
  const kind = requireStartAgentKind(options.kind);
  const cwd = requireDirectoryPath(options.cwd);
  const spec = START_AGENT_COMMANDS[kind];
  const sessionName = requireSessionName(
    options.sessionName || defaultStartAgentSessionName(kind, cwd),
  );
  const format = `${formats.sessions}\t#{window_id}\t#{pane_id}`;
  const stdout = await runtime.tmux(
    [
      "new-session",
      "-d",
      "-P",
      "-F",
      format,
      "-s",
      sessionName,
      "-n",
      spec.windowName,
      "-c",
      cwd,
    ],
    { timeout: 5000 },
  );
  const [row] = rows(stdout);
  if (!row) {
    const error = new Error("tmux did not return the new agent session");
    error.status = 500;
    throw error;
  }
  requireTmuxFieldCount(row, 7, "agent session");
  const session = sessionFromRow(row.slice(0, 5));
  const windowId = requireId(row[5], "window");
  const paneId = requireId(row[6], "pane");
  await sendTextToPane(paneId, spec.command, { enter: true });
  return {
    ok: true,
    kind,
    command: spec.command,
    cwd,
    mux: runtime.kind || "tmux",
    muxCommand: runtime.commandName?.() || runtime.kind || "tmux",
    session,
    windowId,
    paneId,
  };
}

async function renameSession(sessionId, name) {
  return currentWindowRuntime().renameSession({ sessionId, name });
}

async function listWindows(sessionId) {
  return currentWindowRuntime().listWindows({ sessionId });
}

// Cold-load batch: one `tmux list-windows -a` returns every window on the
// machine, with session_* fields prepended so we can rebuild both the
// sessions[] list and the windows[] list from a single agent round-trip.
// Replaces /api/sessions + N× /api/windows?sessionId=… on app boot.
async function listTree() {
  return currentWindowRuntime().listTree();
}

async function createWindow(sessionId) {
  return currentWindowRuntime().createWindow({ sessionId });
}

async function startConnectorUpdate(options = {}) {
  const runtime = currentWindowRuntime();
  const repoDir = safeUpdateValue(options.repoDir, 512) || "~/src/tmux-mobile";
  const controllerUrl = safeControllerUrl(options.controllerUrl) || DEFAULT_CONTROLLER_URL;
  const cloneUrl = safeUpdateValue(options.cloneUrl, 512) || CONNECTOR_CLONE_URL;
  const expectedRevision =
    safeUpdateToken(options.expectedRevision) ||
    CONNECTOR_EXPECTED_REVISION ||
    "";
  const targetRef = safeUpdateToken(options.targetRef) || CONNECTOR_UPDATE_REF;
  const nodePath = safeUpdateValue(options.nodePath, 512) || "node";
  const agentMachine = safeUpdateValue(options.agentMachine, 120);
  const machineLabel = safeUpdateValue(options.machineLabel, 120);
  const sessionName = `tmux-mobile-update-${Date.now().toString(36)}`;
  const windowName = "connector-update";
  const scriptUrl = safeUpdateUrl(options.updateScriptUrl) || CONNECTOR_UPDATE_SCRIPT_URL;
  const muxCommand = safeUpdateValue(runtime.commandName?.() || runtime.kind || "tmux", 512);
  const updateMux = safeMuxName(options.mux || runtime.kind || "");
  const updateMuxes = safeMuxList(options.muxes);
  const heredoc = `TMUX_MOBILE_UPDATE_${Date.now().toString(36).toUpperCase()}`;
  const inner = [
    "set -euo pipefail",
    `export TMUX_MOBILE_UPDATE_REPO=${shellQuote(repoDir)}`,
    `export TMUX_MOBILE_UPDATE_CONTROLLER=${shellQuote(controllerUrl)}`,
    `export TMUX_MOBILE_UPDATE_CLONE_URL=${shellQuote(cloneUrl)}`,
    `export TMUX_MOBILE_UPDATE_EXPECTED_REVISION=${shellQuote(expectedRevision)}`,
    `export TMUX_MOBILE_UPDATE_REF=${shellQuote(targetRef)}`,
    `export TMUX_MOBILE_UPDATE_AGENT_MACHINE=${shellQuote(agentMachine)}`,
    `export TMUX_MOBILE_UPDATE_SCRIPT_URL=${shellQuote(scriptUrl)}`,
    `export TMUX_MOBILE_UPDATE_MUX=${shellQuote(updateMux)}`,
    `export TMUX_MOBILE_UPDATE_MUXES=${shellQuote(updateMuxes)}`,
    `MUX_BIN=${shellQuote(muxCommand || "tmux")}`,
    `NODE_BIN=${shellQuote(nodePath)}`,
    `echo "tmux-mobile connector update${machineLabel ? ` for ${machineLabel}` : ""}"`,
    'echo "script: $TMUX_MOBILE_UPDATE_SCRIPT_URL"',
    'if command -v curl >/dev/null 2>&1; then',
    '  curl -fsSL "$TMUX_MOBILE_UPDATE_SCRIPT_URL" | "$NODE_BIN" --input-type=module',
    "else",
    '  "$NODE_BIN" --input-type=module -e \'const r=await fetch(process.env.TMUX_MOBILE_UPDATE_SCRIPT_URL); if(!r.ok) throw new Error(`download failed ${r.status}`); process.stdout.write(await r.text());\' | "$NODE_BIN" --input-type=module',
    "fi",
    'echo "update command finished; closing this mux update session"',
    `if command -v "$MUX_BIN" >/dev/null 2>&1; then "$MUX_BIN" kill-session -t ${shellQuote(sessionName)} >/dev/null 2>&1 || true; fi`,
  ].join("\n");
  const command = `bash <<'${heredoc}'\n${inner}\n${heredoc}`;

  const paneId = (
    await runtime.tmux(
      ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", sessionName, "-n", windowName],
      { timeout: 5000 },
    )
  ).trim();
  if (!paneId) {
    const error = new Error("tmux did not return the update pane");
    error.status = 500;
    throw error;
  }
  await sendTextToPane(paneId, command, { enter: true });
  return {
    ok: true,
    sessionName,
    windowName,
    paneId,
    repoDir,
    controllerUrl,
    expectedRevision,
    targetRef,
    scriptUrl,
    mux: updateMux,
    muxes: updateMuxes,
  };
}

function safeUpdateValue(value, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || /[\0\r\n]/.test(text)) return "";
  return text;
}

function safeControllerUrl(value) {
  const text = safeUpdateValue(value, 512);
  if (!text) return "";
  try {
    const parsed = new URL(text);
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : "";
  } catch {
    return "";
  }
}

function safeMuxName(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "tmux" || text === "rmux" ? text : "";
}

function safeMuxList(value) {
  const muxes = String(value || "")
    .split(",")
    .map(safeMuxName)
    .filter(Boolean);
  return [...new Set(muxes)].join(",");
}

function requestOrigin(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const proto = forwardedProto || (req.socket?.encrypted ? "https" : "http");
  const host = String(
    req.headers["x-forwarded-host"] || req.headers.host || "127.0.0.1:3737",
  )
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

function shellQuote(value) {
  return `'${String(value || "").replaceAll("'", "'\\''")}'`;
}

async function renameWindow(windowId, name) {
  return currentWindowRuntime().renameWindow({ windowId, name });
}

// Duplicate a window: open a new window in the same session, same working
// directory, re-running the command the source window used. cwd comes from the
// active pane; the command prefers pane_start_command (the literal launch
// command, e.g. "sleep 300"), falling back to the running program name
// (pane_current_command) when it's an interactive app rather than a bare shell.
// Suggested values for duplicating a window: the source window's session, name,
// cwd, and the command to re-run. The UI fetches these to pre-fill an editable
// confirmation before the duplicate is actually created. Command prefers
// pane_start_command (the literal launch command, e.g. "sleep 300"), falling
// back to the running program name when it's an interactive app (not a bare
// shell).
async function getDuplicateDefaults(windowId) {
  return currentWindowRuntime().getDuplicateDefaults({ windowId });
}

// Create a new window in the source window's session, same cwd, using the given
// name and command (the UI passes the user-confirmed/adjusted values; both fall
// back to the source defaults when omitted). Empty command -> a plain shell.
async function duplicateWindow(windowId, overrides = {}) {
  return currentWindowRuntime().duplicateWindow({
    windowId,
    name: overrides.name,
    command: overrides.command,
  });
}

// "New branch" quick action for a bare-repo-backed worktree: create a new git
// worktree + branch off the source window's cwd, then open a new tmux window in
// that worktree — running the same command the source window does, like
// Duplicate. The window's cwd is the freshly-created worktree, not the source.
async function newBranchWindow(windowId, { branch, command, name } = {}) {
  requireId(windowId, "window");
  const defaults = await getDuplicateDefaults(windowId);
  if (!defaults.cwd) {
    const error = new Error("source window has no working directory");
    error.status = 400;
    throw error;
  }
  // Create the worktree on the target machine (local or via the agent).
  const created = await currentBackend().worktreeAdd({
    fromDir: defaults.cwd,
    branch: String(branch || ""),
  });
  const finalCommand =
    command !== undefined ? String(command).trim() : defaults.command;
  const finalName =
    name !== undefined && String(name).trim() !== ""
      ? String(name).trim()
      : created.branch; // default the window name to the branch

  const window = await currentWindowRuntime().createWindow({
    sessionId: defaults.sessionId,
    cwd: created.path,
    name: finalName,
    command: finalCommand,
  });
  return {
    ...window,
    branch: created.branch,
    path: created.path,
    command: finalCommand || "",
  };
}

// Store a free-text follow-up note on the WINDOW as the @tm_annotation
// window-scoped user option (set-option -w). Empty/whitespace clears it. Useful
// for tracking the follow-up of a long-running task in a specific window.
async function setWindowAnnotation(windowId, annotation) {
  return currentWindowRuntime().setWindowNote({
    windowId,
    note: annotation,
    maxBytes: MAX_ANNOTATION_BYTES,
  });
}

async function killWindow(windowId) {
  return currentWindowRuntime().closeWindow({ windowId });
}

async function listPanes(windowId) {
  return currentWindowRuntime().listWindowSurfaces({ windowId });
}

async function getPaneCwd(paneId) {
  return currentWindowRuntime().getSurfaceCwd({ surfaceId: paneId });
}

async function listPaneDirectories(paneId) {
  const cwd = await getPaneCwd(paneId);
  return directoriesForCwd(cwd);
}

// Shared by listPaneDirectories and getWindowView: turn an already-known cwd
// into the {cwd, parent, entries} payload by reading the directory once.
async function directoriesForCwd(cwd) {
  if (!cwd) return { cwd: "", parent: "", entries: [] };
  const entries = await currentBackend().readdir(cwd);
  const directories = entries
    .filter((entry) => entry.isDirectory && !entry.name.startsWith("."))
    .map((entry) => ({
      name: entry.name,
      path: path.join(cwd, entry.name),
    }))
    .sort((a, b) => {
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    })
    .slice(0, 80);
  return {
    cwd,
    parent: path.dirname(cwd),
    entries: directories,
  };
}

// Switch-window batch: one HTTP request returns everything the client needs to
// render the new window (pane list + the active pane's captured snapshot + cwd
// directory listing). Replaces the sequential /api/panes → /api/directories →
// /api/capture chain. listPanes is one RPC; capture + readdir then fire in
// parallel, so the agent sees 1 + max(1,1) = 2 round-trips, down from 3.
//
// allSettled, not all: a readdir failure on a deleted/inaccessible cwd
// shouldn't blank the snapshot, and vice versa. Each piece carries its own
// error so the client can show partial state — matching today's behavior
// where the directory navigator can be "unavailable" while the snapshot
// renders fine.
async function getWindowView(windowId, lines) {
  const panes = await listPanes(windowId);
  const active = panes.find((p) => p.active) || panes[0] || null;
  if (!active) {
    return {
      panes: [],
      activePaneId: "",
      capture: { paneId: "", mode: "tail", lines, text: "", error: null },
      directories: { cwd: "", parent: "", entries: [], error: null },
    };
  }
  const [captureResult, dirResult] = await Promise.allSettled([
    capturePane(active.id, "tail", lines, { ansi: true }),
    directoriesForCwd(active.cwd),
  ]);
  const captureText =
    captureResult.status === "fulfilled"
      ? cleanTerminalTextKeepAnsi(captureResult.value)
      : "";
  const captureError =
    captureResult.status === "rejected"
      ? captureResult.reason?.message || "capture failed"
      : null;
  const directories =
    dirResult.status === "fulfilled"
      ? { ...dirResult.value, error: null }
      : {
          cwd: active.cwd || "",
          parent: active.cwd ? path.dirname(active.cwd) : "",
          entries: [],
          error: dirResult.reason?.message || "Directory unavailable",
        };
  return {
    panes,
    activePaneId: active.id,
    capture: {
      paneId: active.id,
      mode: "tail",
      lines,
      text: captureText,
      error: captureError,
    },
    directories,
  };
}

const paneActivitySamples = new Map();
const PANE_ACTIVITY_SAMPLE_CHARS = 100;

async function getSessionWindowActivity(sessionId) {
  const windows = await listWindows(sessionId);
  const result = {};
  for (const win of windows) {
    let active = false;
    try {
      const panes = await listPanes(win.id);
      const pane = panes.find((p) => p.active) || panes[0];
      if (pane) {
        const text = await capturePane(pane.id, "screen");
        const sample = text.slice(-PANE_ACTIVITY_SAMPLE_CHARS);
        const prev = paneActivitySamples.get(pane.id);
        if (prev !== undefined && prev !== sample) active = true;
        paneActivitySamples.set(pane.id, sample);
      }
    } catch {
      // pane likely vanished; treat as inactive
    }
    result[win.id] = active;
  }
  return result;
}

// cwd-keyed TTL cache for expensive window metadata (repo, branch). Lives for
// the process; shared across sessions/windows with the same cwd.
const windowMetadataCache = createMetadataCache();

// Returns per-window metadata for a session:
//   { agentType, repo, git, turn, contentHash }
// Live (agentType) + cwd-scoped (repo, git) come from computeWindowMetadata.
// turn (working/idle, agent-specific) and contentHash (for client "unread"
// detection) need pane content, computed here for windows that have an agent.
async function getSessionWindowMetadata(sessionId) {
  const windows = await listWindows(sessionId);
  const base = await computeWindowMetadata(
    windows,
    currentBackend(),
    windowMetadataCache,
    Date.now(),
  );
  // Enrich with turn + contentHash. We capture the active pane once per window
  // and derive both from it. Only windows with a detected agent get a turn;
  // every window gets a contentHash so the client can flag unread changes.
  await Promise.all(
    windows.map(async (win) => {
      try {
        const panes = await listPanes(win.id);
        const pane = panes.find((p) => p.active) || panes[0];
        if (!pane) return;
        // Surface copy-mode so the UI can warn that the pane's scrollback pager
        // is intercepting input (keystrokes won't reach the program until it's
        // exited). /api/send and /api/key auto-exit it, but a banner makes the
        // state visible when it happens.
        base[win.id].inCopyMode = Boolean(pane.inCopyMode);
        const screen = await capturePane(pane.id, "screen");
        const clean = cleanTerminalText(screen);
        base[win.id].contentHash = createHash("sha1")
          .update(clean)
          .digest("hex")
          .slice(0, 16);
        const agentType = base[win.id].agentType;
        if (agentType) {
          const lines = clean.split("\n");
          // detectTurn returns { state, confidence }. Store the state in `turn`
          // (back-compat wire field) and the confidence separately so the client
          // can rank a low-confidence "unverified" window below confirmed items
          // rather than trusting or dropping it (honest-state, Wave 1).
          const t = detectTurn(agentType, {
            title: pane.title,
            paneTail: lines.slice(-12).join("\n"),
          });
          base[win.id].turn = t ? t.state : "";
          base[win.id].turnConfidence = t ? t.confidence : "";
          // Mode/effort needs a DEEPER tail than turn: the model+effort line and
          // the mode line sit above a growing input box, so with command history
          // they can be ~20+ rows up from the bottom. 28 lines reliably spans the
          // whole footer block without scanning the entire scrollback.
          base[win.id].agentMode = detectAgentMode(agentType, {
            title: pane.title,
            paneTail: lines.slice(-28).join("\n"),
          });
        }
        // Cheap "is this pane blocked on an AskUserQuestion prompt?" check — just
        // the detector's two regex tests over the screen we already captured (NOT
        // the full parse, which stays on-demand via /api/ask-question). This lets
        // the UI flag a window as "waiting for your answer" distinctly from a
        // turn that merely ended.
        // detectAskQuestion returns { waiting, confidence }. A low-confidence
        // "maybe blocked" (ambiguous prompt chrome, mid-redraw) is still surfaced
        // — ranked as unverified by the client — rather than silently dropped.
        const ask = detectAskQuestion(clean);
        base[win.id].waitingForInput = ask.waiting;
        base[win.id].waitingConfidence = ask.confidence;
      } catch {
        // pane vanished / capture failed — leave turn & contentHash unset
      }
    }),
  );
  return base;
}

// Attention descriptors for every window on the CURRENT backend's machine: the
// fields the client needs to decide "needs you" (turn / waitingForInput) plus the
// stable identity (session name + window index) it keys unread state by, and the
// contentHash so the client can apply its own unread comparison. Used by the
// cross-machine /api/attention aggregate. Best-effort: a failing session is
// skipped rather than failing the whole sweep.
async function collectMachineAttention() {
  const muxes = currentRequestMux() ? [currentRequestMux()] : backendMuxKinds();
  const results = await Promise.all(
    muxes.map(async (mux) => {
      const runtime = windowRuntimeForMux(mux);
      try {
        return await collectMachineAttentionForRuntime(runtime);
      } catch (error) {
        if (isNoServerError(error) || muxes.length > 1) return [];
        throw error;
      }
    }),
  );
  return results.flat();
}

async function collectMachineAttentionForRuntime(runtime) {
  let sessions = [];
  try {
    sessions = await runtime.listSessions();
  } catch (error) {
    if (isNoServerError(error)) return [];
    throw error;
  }
  const out = [];
  await Promise.all(
    sessions.map(async (session) => {
      let windows;
      let meta;
      try {
        windows = await runtime.listWindows({ sessionId: session.id });
        meta = await withRequestMux(runtime.kind, () => getSessionWindowMetadata(session.id));
      } catch {
        return; // session vanished mid-sweep
      }
      for (const win of windows) {
        const m = meta[win.id] || {};
        out.push({
          mux: runtime.kind || "tmux",
          sessionName: session.name,
          windowIndex: win.index,
          windowName: win.name,
          agentType: m.agentType || "",
          turn: m.turn || "",
          turnConfidence: m.turnConfidence || "",
          waitingForInput: Boolean(m.waitingForInput),
          waitingConfidence: m.waitingConfidence || "",
          contentHash: m.contentHash || "",
        });
      }
    }),
  );
  return out;
}

// --- AskUserQuestion overlay support (on-demand) ---

// The active pane id for a window (a pane id is also accepted as-is).
async function resolveActivePane(idMaybeWindow) {
  // If it's already a pane id (%N) just use it; if a window id (@N) find its
  // active pane. The client passes the active paneId, so this usually no-ops.
  if (/^%/.test(idMaybeWindow)) return idMaybeWindow;
  const panes = await listPanes(idMaybeWindow);
  const pane = panes.find((p) => p.active) || panes[0];
  return pane ? pane.id : idMaybeWindow;
}

// Parse the current AskUserQuestion state of a pane (null if not showing one).
async function readAskQuestion(paneId) {
  const screen = cleanTerminalText(await capturePane(paneId, "screen"));
  return parseAskQuestion(screen);
}

// A compact signature of the current prompt state, so we can tell when applying
// an answer has actually changed the screen (advanced to the next question /
// reached the review screen / the prompt is gone) vs. still showing the same
// prompt mid-transition. Null parse (no prompt) -> "gone".
function askQuestionSignature(parsed) {
  if (!parsed) return "gone";
  if (parsed.review) return "review";
  // question text + which tabs are answered + checkbox state — enough to detect
  // an advance to the next question or a toggle landing.
  const tabs = (parsed.tabs || []).map((t) => (t.answered ? "1" : "0")).join("");
  const checks = (parsed.options || []).map((o) => (o.checked ? "1" : "0")).join("");
  return `q:${parsed.questionText || ""}|${tabs}|${checks}`;
}

// After sending answer keystrokes the TUI takes a beat to tear down / advance the
// prompt — and over the controller->agent WebSocket each capture round-trips, so
// a single fixed delay races the redraw (the re-parse can still see the OLD
// prompt, making the overlay look stuck). Instead, poll until the prompt state
// SETTLES to something different from `before`, or a timeout. Returns the final
// parsed state (possibly null = prompt gone).
async function settleAskQuestion(paneId, beforeSig, { timeoutMs = 2500 } = {}) {
  const stepMs = ASK_KEY_DELAY_MS; // ~140ms between polls
  const deadline = Date.now() + timeoutMs;
  let parsed = await readAskQuestion(paneId);
  // Keep polling while the state still matches the pre-answer signature (i.e.
  // the redraw hasn't landed yet). As soon as it differs (next question, review,
  // or gone), we're settled.
  while (askQuestionSignature(parsed) === beforeSig && Date.now() < deadline) {
    await delay(stepMs);
    parsed = await readAskQuestion(paneId);
  }
  return parsed;
}

// Send a computed key list to the pane, one key at a time with a small delay so
// the TUI keeps up (same rationale as the paste->Enter delay). A list item that
// is { text } is sent as literal text rather than a key name.
async function sendAskKeys(paneId, keys) {
  for (const k of keys) {
    if (k && typeof k === "object" && typeof k.text === "string") {
      await sendTextToPane(paneId, k.text, { enter: false });
    } else {
      await currentWindowRuntime().sendKeyToSurface({ surfaceId: paneId, key: k });
    }
    await delay(ASK_KEY_DELAY_MS);
  }
}

async function capturePane(paneId, mode, lineCount, { ansi = false } = {}) {
  return currentWindowRuntime().captureSurface({
    surfaceId: paneId,
    mode,
    lines: lineCount,
    ansi,
  });
}

function responseOutputText(data) {
  if (typeof data.output_text === "string") return data.output_text.trim();

  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

async function createTextModelResponse({
  instructions,
  input,
  maxOutputTokens,
  model = WINDOW_BRIEFING_MODEL,
}) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not set");
    error.status = 500;
    throw error;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions,
      input,
      max_output_tokens: maxOutputTokens,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(textExcerpt(text || response.statusText, 1200));
    error.status = 502;
    throw error;
  }

  const data = await response.json();
  const outputText = responseOutputText(data);
  if (!outputText) {
    const error = new Error("Model returned no summary text");
    error.status = 502;
    throw error;
  }
  return outputText;
}

async function getWindowInfo(windowId) {
  return currentWindowRuntime().getWindowInfo({ windowId });
}

async function getPaneContext(paneId) {
  return currentWindowRuntime().getSurfaceContext({ surfaceId: paneId });
}

function commandHasExecutable(command, executable) {
  const escaped = executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[\\s/])${escaped}([\\s]|$)`, "i");
  return pattern.test(String(command || ""));
}

function detectForkableAgent(pane, processes) {
  const commands = [
    pane?.command || "",
    pane?.title || "",
    ...processes.map((processInfo) => processInfo.command || ""),
  ];
  if (commands.some((command) => commandHasExecutable(command, "codex"))) {
    return {
      agent: "codex",
      command: "codex fork --last",
      windowName: "codex-fork",
    };
  }
  if (commands.some((command) => commandHasExecutable(command, "claude"))) {
    return {
      agent: "claude",
      command: "claude --continue --fork-session",
      windowName: "claude-fork",
    };
  }
  return null;
}

async function forkAgentWindow(paneId) {
  requireId(paneId, "pane");
  const { windowInfo, pane } = await getPaneContext(paneId);
  const processes =
    pane.pid && currentBackend().processTree
      ? await currentBackend().processTree(pane.pid)
      : [];
  const forkSpec = detectForkableAgent(pane, processes);
  if (!forkSpec) {
    return { ok: true, forked: false, reason: "not-agent" };
  }

  const window = await currentWindowRuntime().createWindowAfter({
    windowId: windowInfo.windowId,
    cwd: pane.cwd || process.env.HOME || "/",
    name: forkSpec.windowName,
    command: forkSpec.command,
  });
  return {
    ok: true,
    forked: true,
    agent: forkSpec.agent,
    source: windowInfo,
    window,
  };
}

async function buildBriefingInputForPane({ windowInfo, pane, lineCount }) {
  const lines = Math.min(
    parseLines(lineCount || WINDOW_BRIEFING_LINES),
    REALTIME_WINDOW_BRIEFING_MAX_CAPTURE_LINES,
  );

  // Read is only meaningful when we have a structured agent transcript to
  // lift the exact last assistant message from. For any other pane (plain
  // shell, vim, build output, …) the previous capture-pane + LLM-extract
  // path was too unreliable for the productivity payoff, so the button
  // is intentionally a no-op on the UI side and the endpoint refuses
  // server-side as a defense-in-depth.
  const agentInfo = await safeAgentLastResponse(pane);
  if (!agentInfo?.kind) {
    const error = new Error(
      "Read is only available on Codex or Claude windows — this pane isn't running a known agent.",
    );
    error.status = 400;
    error.code = "no_agent";
    throw error;
  }
  if (!agentInfo.text) {
    const error = new Error(
      `${agentInfo.kind} is running but hasn't written an assistant message yet.`,
    );
    error.status = 400;
    error.code = "no_agent_message";
    throw error;
  }

  const readableOutput = agentInfo.text;
  const chunkOutputs = splitRealtimeBriefingOutput(readableOutput);
  const inputChunks = chunkOutputs.length > 0
    ? chunkOutputs
    : [textExcerpt(readableOutput, 10000)];
  return {
    lines: 0,
    input: textExcerpt(readableOutput, 10000),
    inputChunks,
    rawChars: readableOutput.length,
    extractedChars: readableOutput.length,
    extractionModel: `transcript:${agentInfo.kind}`,
    paneId: pane?.id || "",
    windowId: windowInfo.windowId || "",
    agentSession: {
      kind: agentInfo.kind,
      sessionId: agentInfo.sessionId,
      transcriptPath: agentInfo.transcriptPath,
    },
  };
}

// Wrapper that never throws — agent transcript lookup is a best-effort
// optimization, so any failure (lsof missing, file rotated, perms, cloud
// agent doesn't implement the op yet) must drop us back into the
// capture-pane path rather than break Read entirely.
async function safeAgentLastResponse(pane) {
  if (!pane?.pid) return null;
  const backend = currentBackend();
  let exactClaudeSession = null;
  try {
    exactClaudeSession = await findClaudeSessionFromBackend(backend, {
      rootPid: pane.pid,
      cwd: pane.cwd || "",
    });
    const exactTranscript = exactClaudeSession
      ? await readClaudeTranscriptFromSession(backend, exactClaudeSession)
      : null;
    const lastAssistantTurn = exactTranscript?.turns
      ?.slice()
      .reverse()
      .find((turn) => turn.role === "assistant");
    if (lastAssistantTurn) {
      return {
        kind: "claude",
        sessionId: exactClaudeSession.sessionId,
        transcriptPath: exactClaudeSession.transcriptPath,
        text: lastAssistantTurn.text || "",
      };
    }
  } catch {}
  if (typeof backend.agentLastResponse !== "function") return null;
  try {
    // Pass cwd so Claude Code's filesystem fallback can find the right
    // transcript — its CLI doesn't keep the JSONL file open so lsof alone
    // returns nothing.
    const result = await backend.agentLastResponse({
      rootPid: pane.pid,
      cwd: pane.cwd || "",
    });
    if (
      exactClaudeSession &&
      result?.kind === "claude" &&
      result.sessionId !== exactClaudeSession.sessionId
    ) {
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

async function safeAgentTranscript(pane) {
  if (!pane?.pid) return null;
  const backend = currentBackend();
  let exactClaudeSession = null;
  try {
    exactClaudeSession = await findClaudeSessionFromBackend(backend, {
      rootPid: pane.pid,
      cwd: pane.cwd || "",
    });
    const exactTranscript = exactClaudeSession
      ? await readClaudeTranscriptFromSession(backend, exactClaudeSession)
      : null;
    if (exactTranscript) return exactTranscript;
  } catch {}
  const emptyExactClaudeTranscript = () =>
    exactClaudeSession
      ? {
          kind: "claude",
          sessionId: exactClaudeSession.sessionId,
          transcriptPath: exactClaudeSession.transcriptPath,
          turns: [],
          turnsTotal: 0,
        }
      : null;
  if (typeof backend.agentTranscript !== "function") return emptyExactClaudeTranscript();
  try {
    const result = await backend.agentTranscript({
      rootPid: pane.pid,
      cwd: pane.cwd || "",
    });
    if (
      exactClaudeSession &&
      result?.kind === "claude" &&
      result.sessionId !== exactClaudeSession.sessionId
    ) {
      return emptyExactClaudeTranscript();
    }
    return result;
  } catch {
    return emptyExactClaudeTranscript();
  }
}

async function detectCommandCenterAgent(pane) {
  const direct = detectCommandCenterAgentType([
    pane?.command || "",
    pane?.title || "",
  ]);
  if (direct) return direct;
  if (!pane?.pid || typeof currentBackend().processTree !== "function") return "";
  try {
    const processes = await currentBackend().processTree(pane.pid);
    const commands = processes.map((processInfo) => processInfo.command || "");
    return detectCommandCenterAgentType(commands) || "";
  } catch {
    return "";
  }
}

/**
 * Walk every session + window on the host, pick the active pane in each
 * window, and ask agentTranscript whether it's running a Codex or Claude
 * Code session. Drop the panes that aren't agents and return one row per
 * agent with enough structured state to drive the Command Center view:
 *
 *   - which tmux window/session it lives in
 *   - which agent (codex/claude) and which transcript session UUID
 *   - the last user prompt and last assistant response, verbatim from the
 *     JSONL (not an LLM summary — we already have the exact text)
 *   - a status derived from the live pane state, not transcript order. The
 *     transcript can lag or contain injected tool/user records, so "last role"
 *     is only exposed as context, never used as the live Working/Idle label.
 *   - a turn count so the UI can show conversation depth at a glance
 *
 * Per-pane work runs in parallel so even ten windows return in roughly the
 * time of the slowest pane.
 */
const runtimeVersionCache = new Map();

async function runtimeVersion(runtime) {
  const key = `${runtime.kind}:${runtime.commandName?.() || runtime.kind}`;
  if (runtimeVersionCache.has(key)) return runtimeVersionCache.get(key);
  let version = "";
  try {
    version = (await runtime.tmux(["-V"], { timeout: 3000 })).trim();
  } catch {}
  runtimeVersionCache.set(key, version);
  return version;
}

async function listAgentSessions() {
  const muxes = currentRequestMux() ? [currentRequestMux()] : backendMuxKinds();
  const results = await Promise.all(
    muxes.map(async (mux) => {
      const runtime = windowRuntimeForMux(mux);
      try {
        return await listAgentSessionsForRuntime(runtime);
      } catch (error) {
        if (isNoServerError(error) || muxes.length > 1) return { agents: [] };
        throw error;
      }
    }),
  );
  return { agents: results.flatMap((result) => result.agents || []) };
}

async function listAgentSessionsForRuntime(runtime) {
  let sessions = [];
  try {
    sessions = await runtime.listSessions();
  } catch (error) {
    if (isNoServerError(error)) return { agents: [] };
    throw error;
  }
  const mux = runtime.kind || "tmux";
  const muxCommand = runtime.commandName?.() || mux;
  const muxVersion = await runtimeVersion(runtime);

  // Flatten every window into one queue with its session context.
  const queue = [];
  for (const session of sessions) {
    let windows;
    try {
      windows = await runtime.listWindows({ sessionId: session.id });
    } catch {
      continue;
    }
    for (const win of windows) queue.push({ session, win });
  }

  const rows_ = await Promise.all(
    queue.map(async ({ session, win }) => {
      let panes;
      try {
        panes = await runtime.listWindowSurfaces({ windowId: win.id });
      } catch {
        return null;
      }
      const pane = panes.find((p) => p.active) || panes[0];
      if (!pane?.pid) return null;

      let info = await safeAgentTranscript(pane);
      if (!info?.kind) {
        const kind = await detectCommandCenterAgent(pane);
        if (!kind) return null;
        info = {
          kind,
          sessionId: "",
          transcriptPath: "",
          turns: [],
          turnsTotal: 0,
        };
      }

      const turns = Array.isArray(info.turns) ? info.turns : [];
      const lastTurn = turns[turns.length - 1] || null;
      const lastAssistantTurn = [...turns].reverse().find((t) => t.role === "assistant") || null;
      const lastUserTurn = [...turns].reverse().find((t) => t.role === "user") || null;
      let turn = null;
      let waitingForInput = false;
      let waitingConfidence = "";
      try {
        const screen = cleanTerminalText(
          await runtime.captureSurface({ surfaceId: pane.id, mode: "screen" }),
        );
        const lines = screen.split("\n");
        turn = detectTurn(info.kind, {
          title: pane.title,
          paneTail: lines.slice(-12).join("\n"),
        });
        const ask = detectAskQuestion(screen);
        waitingForInput = Boolean(ask.waiting);
        waitingConfidence = ask.confidence || "";
      } catch {
        turn = null;
      }
      const turnState = turn?.state || "unverified";
      const status = waitingForInput
        ? "waiting"
        : turnState === "working"
          ? "running"
          : turnState === "idle"
            ? "idle"
            : "unverified";

      return {
        mux,
        muxCommand,
        muxVersion,
        sessionId: session.id,
        sessionName: session.name,
        windowId: win.id,
        windowIndex: win.index,
        windowName: win.name,
        paneId: pane.id,
        cwd: pane.cwd || "",
        activeCommand: win.activeCommand || pane.command || "",
        kind: info.kind,
        agentSessionId: info.sessionId || "",
        transcriptPath: info.transcriptPath || "",
        lastUserText: lastUserTurn?.text || "",
        lastUserAt: lastUserTurn?.t || null,
        lastAssistantText: lastAssistantTurn?.text || "",
        lastAssistantAt: lastAssistantTurn?.t || null,
        lastRole: lastTurn?.role || "",
        turn: turnState,
        turnConfidence: turn?.confidence || "low",
        waitingForInput,
        waitingConfidence,
        // Prefer the agent's pre-slice total (added with the larger 32 MB tail
        // read). Old agent bundles don't send this — fall back to turns.length
        // so they still render, just pinned at the slice cap as before.
        turnCount: typeof info.turnsTotal === "number" ? info.turnsTotal : turns.length,
        status,
        // ISO timestamp of the most recent turn (when the agent transcript
        // carries one). Drives the "recent activity" sort in the Command
        // Center; null for transcripts that predate per-turn timestamps.
        lastActivityAt: lastTurn?.t || null,
      };
    }),
  );

  return { agents: rows_.filter(Boolean) };
}

async function localCommandCenterMachine(agentCount = 0) {
  const muxes = (
    await Promise.all(
      backendMuxKinds().map(async (mux) => {
        const runtime = windowRuntimeForMux(mux);
        return {
          mux: runtime.kind || mux,
          kind: runtime.kind || mux,
          muxCommand: runtime.commandName?.() || mux,
          version: await runtimeVersion(runtime),
        };
      }),
    )
  ).filter((item) => item.version || backendMuxKinds().length === 1);
  const primary = muxes[0] || {
    mux: "tmux",
    muxCommand: "tmux",
    version: "",
  };
  const ownerId = String(process.env.TMUX_MOBILE_USER || "");
  const hostname = os.hostname();
  return {
    id: "local",
    machineId: "local",
    hostname: machineAliasFor(hostname) || hostname,
    rawHostname: hostname,
    machineAlias: machineAliasFor(hostname),
    ownerId,
    ownerEmail: ownerId,
    ownerHd: "",
    os: process.platform,
    arch: process.arch,
    tmux: primary.version,
    mux: primary.mux,
    muxCommand: primary.muxCommand,
    muxVersion: primary.version,
    muxes,
    agentRevision: APP_REVISION,
    connectorVersion: CONNECTOR_VERSION,
    agentCwd: __dirname,
    homeDir: os.homedir(),
    nodePath: process.execPath,
    expectedRevision: CONNECTOR_EXPECTED_REVISION,
    updateRef: CONNECTOR_UPDATE_REF,
    updateScriptUrl: CONNECTOR_UPDATE_SCRIPT_URL,
    expectedConnectorVersion: CONNECTOR_VERSION,
    online: true,
    lastSeen: Date.now(),
    inventoryStatus: "fresh",
    inventorySource: "local",
    inventoryObservedAt: Date.now(),
    inventoryAgeMs: 0,
    inventoryDurationMs: null,
    inventoryError: "",
    stale: false,
    missingOps: [],
    connectorStatus: "current",
    revisionStatus: "current",
    agentCount,
  };
}

function commandCenterMachineMatches(machine, machineId) {
  const id = String(machineId || "");
  if (!id) return false;
  return (
    machine.id === id ||
    machine.agentId === id ||
    machine.machineId === id ||
    machine.rawMachineId === id ||
    machine.hostname === id ||
    machine.rawHostname === id ||
    machine.machineAlias === id
  );
}

function tagCommandCenterAgents(result, machine) {
  return (result.agents || []).map((agent) => {
    const agentMux = normalizeMuxName(agent.mux) || normalizeMuxName(machine.mux) || "tmux";
    const muxInfo = Array.isArray(machine.muxes)
      ? machine.muxes.find((item) => normalizeMuxName(item?.mux || item?.kind) === agentMux)
      : null;
    return {
      machineId: machine.id,
      machineRawId: machine.machineId || "",
      machineAgentId: machine.agentId || "",
      machineHostname: machine.hostname,
      machineOwnerId: machine.ownerId || "",
      machineOwnerHd: machine.ownerHd || "",
      ...agent,
      mux: agentMux,
      muxCommand: agent.muxCommand || muxInfo?.muxCommand || machine.muxCommand || agentMux,
      muxVersion: agent.muxVersion || muxInfo?.version || machine.muxVersion || machine.tmux || "",
      machineMux: agentMux,
      machineMuxCommand: agent.muxCommand || muxInfo?.muxCommand || machine.muxCommand || agentMux,
      machineMuxVersion: agent.muxVersion || muxInfo?.version || machine.muxVersion || machine.tmux || "",
    };
  });
}

function commandCenterResultFromInventory(inventory) {
  const machine = inventory?.machine;
  if (!machine) return null;
  const agents = tagCommandCenterAgents({ agents: inventory.agents || [] }, machine);
  return {
    machines: [{ ...machine, agentCount: agents.length }],
    agents,
  };
}

function shouldUseCommandCenterInventory(inventory) {
  return Boolean(inventory && (inventory.hasInventory || inventory.supportsInventory));
}

async function liveCommandCenterResult(hub, viewer, machine) {
  try {
    const result = await withBackend(
      hub.backendFor(viewer, machine.id),
      () => listAgentSessions(),
    );
    const agents = tagCommandCenterAgents(result, machine);
    return {
      machines: [
        {
          ...machine,
          inventoryStatus: "fresh",
          inventorySource: "live-rpc",
          inventoryObservedAt: Date.now(),
          inventoryAgeMs: 0,
          inventoryDurationMs: null,
          inventoryError: "",
          agentCount: agents.length,
        },
      ],
      agents,
    };
  } catch (error) {
    return {
      machines: [
        {
          ...machine,
          inventoryStatus: "failed",
          inventorySource: "live-rpc",
          inventoryObservedAt: Date.now(),
          inventoryAgeMs: 0,
          inventoryDurationMs: null,
          inventoryError: error.message || String(error),
          agentCount: 0,
        },
      ],
      agents: [],
    };
  }
}

async function commandCenterResultForMachine(hub, viewer, machine) {
  const inventory =
    typeof hub.commandCenterInventory === "function"
      ? hub.commandCenterInventory(viewer, machine.id)
      : null;
  if (shouldUseCommandCenterInventory(inventory)) {
    return commandCenterResultFromInventory(inventory);
  }
  return liveCommandCenterResult(hub, viewer, machine);
}

function observeCommandCenterAgentsForNtfy(machines, agents) {
  if (!agentRoundNtfyNotifier.enabled) return;
  void agentRoundNtfyNotifier.observeAgents({ machines, agents });
}

function viewerForMachineOwner(machine) {
  const email = String(machine.ownerEmail || machine.ownerId || "").trim();
  const userId = String(machine.ownerId || email).trim();
  return {
    email,
    userId,
    hd: String(machine.ownerHd || "").trim(),
  };
}

async function sweepLocalAgentRoundsForNtfy() {
  const result = await listAgentSessions();
  const machine = await localCommandCenterMachine(result.agents?.length || 0);
  const agents = tagCommandCenterAgents(result, machine);
  await agentRoundNtfyNotifier.observeAgents({
    machines: [{ ...machine, agentCount: agents.length }],
    agents,
  });
}

async function sweepHubAgentRoundsForNtfy(hub) {
  const machines = typeof hub.listAllMachines === "function" ? hub.listAllMachines() : [];
  await Promise.allSettled(
    machines.map(async (machine) => {
      const viewer = viewerForMachineOwner(machine);
      if (!viewer.userId) return;
      const result = await withBackend(
        hub.backendFor(viewer, machine.id),
        () => listAgentSessions(),
      );
      const agents = tagCommandCenterAgents(result, machine);
      await agentRoundNtfyNotifier.observeAgents({
        machines: [{ ...machine, agentCount: agents.length }],
        agents,
      });
    }),
  );
}

function startAgentRoundNtfyWatcher({ hub = null } = {}) {
  if (!agentRoundNtfyNotifier.enabled) return () => {};
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      if (hub) {
        await sweepHubAgentRoundsForNtfy(hub);
      } else {
        await sweepLocalAgentRoundsForNtfy();
      }
    } catch (error) {
      logServerEvent("ntfy_agent_round_sweep_failed", {
        message: error.message || String(error),
      });
    } finally {
      running = false;
    }
  }
  const timer = setInterval(tick, agentRoundNtfyNotifier.pollIntervalMs);
  timer.unref?.();
  const firstTick = setTimeout(tick, 1_000);
  firstTick.unref?.();
  logServerEvent("ntfy_agent_round_watcher_started", {
    intervalMs: agentRoundNtfyNotifier.pollIntervalMs,
    topicMinIntervalMs: agentRoundNtfyNotifier.topicMinIntervalMs,
    baseUrl: agentRoundNtfyNotifier.baseUrl,
    topicPrefix: NTFY_TOPIC_PREFIX,
  });
  return () => {
    clearInterval(timer);
    clearTimeout(firstTick);
  };
}

async function buildWindowBriefingInput(windowId, lineCount) {
  requireId(windowId, "window");
  const [windowInfo, panes] = await Promise.all([
    getWindowInfo(windowId),
    listPanes(windowId),
  ]);
  const pane = panes.find((item) => item.active) || panes[0];
  return buildBriefingInputForPane({ windowInfo, pane, lineCount });
}

async function buildPaneBriefingInput(paneId, lineCount) {
  const { windowInfo, pane } = await getPaneContext(paneId);
  return buildBriefingInputForPane({ windowInfo, pane, lineCount });
}

async function summarizeBriefingForSpeech(briefing) {
  const summary = await createTextModelResponse({
    instructions: WINDOW_BRIEFING_INSTRUCTIONS,
    input: briefing.input,
    maxOutputTokens: 520,
    model: WINDOW_BRIEFING_MODEL,
  });

  return limitWords(summary, 320);
}

async function summarizeWindowForSpeech(windowId, lineCount) {
  const briefing = await buildWindowBriefingInput(windowId, lineCount);
  return {
    summary: await summarizeBriefingForSpeech(briefing),
    paneId: briefing.paneId,
    windowId: briefing.windowId || windowId,
  };
}

async function summarizePaneForSpeech(paneId, lineCount) {
  const briefing = await buildPaneBriefingInput(paneId, lineCount);
  return {
    summary: await summarizeBriefingForSpeech(briefing),
    paneId: briefing.paneId || paneId,
    windowId: briefing.windowId,
  };
}

async function createSpeechAudio(text, overrides = {}) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not set");
    error.status = 500;
    throw error;
  }

  // Default to the user's saved config, but let callers (e.g. the voice
  // preview) pin a specific model/voice without mutating saved settings.
  const config = getVoiceConfig();
  const speechModel = overrides.model || config.speechModel;
  const speechVoice = overrides.voice || config.speechVoice;
  const body = {
    model: speechModel,
    voice: speechVoice,
    input: text,
    response_format: "mp3",
  };

  if (speechModel.startsWith("gpt-4o")) {
    body.instructions =
      "Voice Affect: Clear and composed. Tone: concise and useful. Pacing: steady. Delivery: read as an AI-generated status briefing.";
  }

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(textExcerpt(errorText || response.statusText, 1200));
    error.status = 502;
    throw error;
  }

  return Buffer.from(await response.arrayBuffer()).toString("base64");
}

async function createRealtimeClientSecret() {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not set");
    error.status = 500;
    throw error;
  }

  const { realtimeModel, realtimeVoice } = getVoiceConfig();
  const headers = {
    authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    "content-type": "application/json",
  };
  if (process.env.OPENAI_SAFETY_IDENTIFIER) {
    headers["OpenAI-Safety-Identifier"] = process.env.OPENAI_SAFETY_IDENTIFIER;
  }

  const response = await fetch(
    "https://api.openai.com/v1/realtime/client_secrets",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        expires_after: {
          anchor: "created_at",
          seconds: REALTIME_CLIENT_SECRET_TTL_SECONDS,
        },
        session: {
          type: "realtime",
          model: realtimeModel,
          instructions: REALTIME_WINDOW_BRIEFING_INSTRUCTIONS,
          max_output_tokens: REALTIME_WINDOW_BRIEFING_MAX_OUTPUT_TOKENS,
          output_modalities: ["audio"],
          audio: {
            input: {
              turn_detection: null,
            },
            output: {
              voice: realtimeVoice,
            },
          },
        },
      }),
    },
  );

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    const error = new Error(textExcerpt(text || response.statusText, 1200));
    error.status = 502;
    throw error;
  }

  const secret = data.client_secret || data;
  if (!secret?.value) {
    const error = new Error("Realtime client secret response did not include a token");
    error.status = 502;
    throw error;
  }

  return {
    value: secret.value,
    expiresAt: secret.expires_at || data.expires_at || null,
    sessionId: data.session?.id || "",
  };
}

async function readJsonBody(req) {
  const body = await readRequestBuffer(req, MAX_BODY_BYTES);
  if (body.length === 0) return {};
  return JSON.parse(body.toString("utf8"));
}

async function readRequestBuffer(req, maxBytes) {
  const chunks = [];
  let bytes = 0;

  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      const error = new Error("Request body too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function audioFilename(contentType) {
  if (/mp4/i.test(contentType)) return "voice.mp4";
  if (/mpeg|mp3/i.test(contentType)) return "voice.mp3";
  if (/wav/i.test(contentType)) return "voice.wav";
  if (/webm/i.test(contentType)) return "voice.webm";
  return "voice.webm";
}

// Voice-send idempotency. Successful responses are cached for
// VOICE_SEND_IDEMPOTENCY_TTL_MS so retries on a flaky link don't paste the
// same message into tmux N times. In-flight dedup also folds concurrent
// retries with the same key onto one shared promise — without it, two
// parallel retries that both miss the cache would both run send-keys.
const VOICE_SEND_IDEMPOTENCY_TTL_MS = 120_000;
const voiceSendCache = new Map();
const voiceSendInFlight = new Map();

function pruneExpiredVoiceSendCache(now) {
  for (const [key, entry] of voiceSendCache) {
    if (entry.expiresAt <= now) voiceSendCache.delete(key);
  }
}

async function withVoiceSendIdempotency(key, processFn) {
  if (!key) return processFn();
  const now = Date.now();
  const cached = voiceSendCache.get(key);
  if (cached && cached.expiresAt > now) return cached.response;
  if (cached) voiceSendCache.delete(key);
  const inFlight = voiceSendInFlight.get(key);
  if (inFlight) return inFlight;
  const promise = (async () => {
    try {
      const response = await processFn();
      voiceSendCache.set(key, {
        response,
        expiresAt: Date.now() + VOICE_SEND_IDEMPOTENCY_TTL_MS,
      });
      pruneExpiredVoiceSendCache(Date.now());
      return response;
    } finally {
      voiceSendInFlight.delete(key);
    }
  })();
  voiceSendInFlight.set(key, promise);
  return promise;
}

async function transcribeAudio(buffer, contentType) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not set");
    error.status = 500;
    throw error;
  }

  const form = new FormData();
  form.append("model", getVoiceConfig().transcribeModel);
  form.append(
    "prompt",
    "Transcribe a short voice command intended for a tmux pane. Preserve shell commands, flags, paths, package names, and code identifiers.",
  );
  form.append(
    "file",
    new Blob([buffer], { type: contentType || "audio/webm" }),
    audioFilename(contentType || ""),
  );

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: form,
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(textExcerpt(text || response.statusText, 1200));
    error.status = 502;
    throw error;
  }

  const data = await response.json();
  return String(data.text || "").trim();
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
}

async function serveConnectorArtifact(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  // Clone-free installer: a shell script with the controller origin baked in, so
  // `curl <origin>/connector/install.sh | sh` joins a fresh machine.
  if (url.pathname === CONNECTOR_INSTALL_ROUTE) {
    try {
      const raw = await readFile(path.join(connectorScriptsDir, "install-connector.sh"), "utf8");
      const body = raw.replaceAll("__CONTROLLER__", requestOrigin(req));
      res.writeHead(200, {
        "content-type": "text/x-shellscript; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch (error) {
      sendJson(res, 500, { error: error.message || "Could not read connector installer" });
    }
    return true;
  }

  // Clone-free self-updater: run as `curl <origin>/connector/update.mjs | node
  // --input-type=module`. Pulls the latest bundle and restarts the connector.
  if (url.pathname === CONNECTOR_UPDATE_BUNDLE_ROUTE) {
    try {
      const body = await readFile(
        path.join(connectorScriptsDir, "update-connector-bundle.mjs"),
        "utf8",
      );
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch (error) {
      sendJson(res, 500, { error: error.message || "Could not read connector updater" });
    }
    return true;
  }

  const files = new Map([
    [
      CONNECTOR_BUNDLE_ROUTE,
      {
        path: path.join(connectorDistDir, "tmux-mobile-connector.mjs"),
        type: "text/javascript; charset=utf-8",
      },
    ],
    [
      CONNECTOR_MANIFEST_ROUTE,
      {
        path: path.join(connectorDistDir, "tmux-mobile-connector.json"),
        type: "application/json; charset=utf-8",
      },
    ],
  ]);
  const item = files.get(url.pathname);
  if (!item) return false;
  try {
    const body = await readFile(item.path);
    res.writeHead(200, {
      "content-type": item.type,
      "cache-control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch (error) {
    sendJson(res, error.code === "ENOENT" ? 404 : 500, {
      error:
        error.code === "ENOENT"
          ? "Connector bundle has not been built"
          : error.message || "Could not read connector bundle",
    });
  }
  return true;
}

function safeEqual(actualValue, expectedValue) {
  const actual = Buffer.from(String(actualValue || ""));
  const expected = Buffer.from(String(expectedValue || ""));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const SESSION_COOKIE = "tmux_mobile_session";
const OAUTH_SCOPE = "openid email profile";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const AGENT_TOKEN_TTL_SECONDS = 180 * 24 * 60 * 60;
const oauthStates = new Map();
const deviceSessions = new Map();

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function readMachineAliases(value, defaults = {}) {
  const aliases = { ...defaults };
  const raw = String(value || "").trim();
  if (!raw) return aliases;

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, alias] of Object.entries(parsed)) {
          setMachineAlias(aliases, key, alias);
        }
        return aliases;
      }
    } catch {
      // Fall through to the compact comma format below.
    }
  }

  for (const item of raw.split(",")) {
    const [key, ...rest] = item.split("=");
    setMachineAlias(aliases, key, rest.join("="));
  }
  return aliases;
}

function setMachineAlias(aliases, key, alias) {
  const normalized = normalizeMachineAliasKey(key);
  const value = String(alias || "").trim();
  if (normalized && value) aliases[normalized] = value;
}

function machineAliasFor(machineId) {
  return MACHINE_ALIASES[normalizeMachineAliasKey(machineId)] || "";
}

function normalizeMachineAliasKey(value) {
  return String(value || "").trim().toLowerCase();
}

function base64urlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64urlJson(value) {
  return base64urlEncode(JSON.stringify(value));
}

function signValue(value) {
  return createHmac("sha256", process.env.SESSION_SECRET || "")
    .update(value)
    .digest("base64url");
}

function issueSignedToken(payload, ttlSeconds) {
  const body = base64urlJson({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
  return `${body}.${signValue(body)}`;
}

function verifySignedToken(token, expectedType) {
  const [body, signature] = String(token || "").split(".");
  if (!body || !signature || !safeEqual(signature, signValue(body))) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload.type !== expectedType) return null;
  if (!payload.userId || !payload.email) return null;
  if (!Number.isFinite(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

function parseCookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function originForRequest(req) {
  const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  return `${proto}://${req.headers.host || `${HOST}:${PORT}`}`;
}

function cookieSecure(req) {
  return originForRequest(req).startsWith("https://");
}

function setSessionCookie(req, res, user) {
  const token = issueSignedToken(
    {
      type: "session",
      userId: user.userId,
      email: user.email,
      hd: user.hd || "",
      sub: user.sub,
    },
    SESSION_TTL_SECONDS,
  );
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (cookieSecure(req)) parts.push("Secure");
  res.setHeader("set-cookie", parts.join("; "));
}

function clearSessionCookie(req, res) {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (cookieSecure(req)) parts.push("Secure");
  res.setHeader("set-cookie", parts.join("; "));
}

function authenticateBrowser(req) {
  return verifySignedToken(parseCookies(req)[SESSION_COOKIE], "session");
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" ? token : "";
}

function authenticateAgent(req) {
  const tokenUser = verifySignedToken(bearerToken(req), "agent");
  if (tokenUser) return tokenUser;
  if (process.env.TMUX_MOBILE_ENABLE_LEGACY_AUTH !== "1") return null;

  const legacySecret = process.env.AGENT_SECRET || "";
  if (legacySecret && safeEqual(req.headers["x-agent-secret"], legacySecret)) {
    const userId = String(process.env.TMUX_MOBILE_USER || "default");
    return { userId, email: userId, hd: "" };
  }
  return null;
}

function randomId(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

function sendRedirect(res, location) {
  res.writeHead(302, {
    location,
    "cache-control": "no-store",
  });
  res.end();
}

function readAllowedGoogleConfig() {
  return {
    allowAll: process.env.ALLOW_ALL_GOOGLE_USERS !== "0",
    emails: new Set(splitCsv(process.env.ALLOWED_GOOGLE_EMAILS)),
    domains: new Set(splitCsv(process.env.ALLOWED_GOOGLE_DOMAINS)),
  };
}

function assertGoogleUserAllowed(user) {
  const allowed = readAllowedGoogleConfig();
  if (allowed.allowAll) return;
  const email = String(user.email || "").toLowerCase();
  const domain = email.includes("@") ? email.split("@").pop() : "";
  if (allowed.emails.has(email) || allowed.domains.has(domain)) return;

  const error = new Error("Google account is not allowed for this controller");
  error.status = 403;
  throw error;
}

function googleOAuthEndpoints() {
  return {
    auth: process.env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth",
    token: process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token",
    deviceCode:
      process.env.GOOGLE_DEVICE_CODE_URL || "https://oauth2.googleapis.com/device/code",
    tokenInfo:
      process.env.GOOGLE_TOKENINFO_URL || "https://oauth2.googleapis.com/tokeninfo",
  };
}

function oauthRedirectUri(req) {
  return (
    process.env.GOOGLE_OAUTH_REDIRECT_URI ||
    `${originForRequest(req)}/auth/google/callback`
  );
}

async function googleTokenInfo(idToken, expectedAudience) {
  const endpoints = googleOAuthEndpoints();
  const url = new URL(endpoints.tokenInfo);
  url.searchParams.set("id_token", idToken);
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error_description || data.error || "Google token verification failed");
    error.status = 401;
    throw error;
  }
  if (String(data.aud || "") !== expectedAudience) {
    const error = new Error("Google token audience did not match this controller");
    error.status = 401;
    throw error;
  }
  if (String(data.email_verified) !== "true" && data.email_verified !== true) {
    const error = new Error("Google account email is not verified");
    error.status = 403;
    throw error;
  }
  const email = String(data.email || "").trim().toLowerCase();
  if (!email) {
    const error = new Error("Google token did not include an email");
    error.status = 403;
    throw error;
  }
  const user = {
    userId: email,
    email,
    hd: String(data.hd || "").trim().toLowerCase(),
    sub: String(data.sub || ""),
  };
  assertGoogleUserAllowed(user);
  return user;
}

async function exchangeAuthorizationCode(code, redirectUri) {
  const response = await fetch(googleOAuthEndpoints().token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error_description || data.error || "Google OAuth code exchange failed");
    error.status = 401;
    throw error;
  }
  if (!data.id_token) {
    const error = new Error("Google OAuth response did not include an ID token");
    error.status = 401;
    throw error;
  }
  return data;
}

async function exchangeDeviceCode(deviceCode) {
  const response = await fetch(googleOAuthEndpoints().token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_DEVICE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_DEVICE_CLIENT_SECRET || "",
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (response.ok) return { done: true, data };
  if (data.error === "authorization_pending" || data.error === "slow_down") {
    return { done: false, slowDown: data.error === "slow_down" };
  }
  const error = new Error(data.error_description || data.error || "Google device login failed");
  error.status = 401;
  throw error;
}

async function handleAuthRoute(req, res, url) {
  if (req.method === "GET" && url.pathname === "/auth/me") {
    const user = authenticateBrowser(req);
    if (!user) {
      sendJson(res, 401, { error: "Authentication required" });
      return true;
    }
    sendJson(res, 200, { email: user.email, userId: user.userId, hd: user.hd || "" });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/auth/logout") {
    clearSessionCookie(req, res);
    sendRedirect(res, "/");
    return true;
  }

  if (req.method === "GET" && url.pathname === "/auth/google/login") {
    const state = randomId();
    const returnTo = safeReturnPath(url.searchParams.get("returnTo") || "/");
    const redirectUri = oauthRedirectUri(req);
    oauthStates.set(state, {
      createdAt: Date.now(),
      redirectUri,
      returnTo,
    });
    pruneAuthState();

    const googleUrl = new URL(googleOAuthEndpoints().auth);
    googleUrl.searchParams.set("client_id", process.env.GOOGLE_OAUTH_CLIENT_ID || "");
    googleUrl.searchParams.set("redirect_uri", redirectUri);
    googleUrl.searchParams.set("response_type", "code");
    googleUrl.searchParams.set("scope", OAUTH_SCOPE);
    googleUrl.searchParams.set("state", state);
    googleUrl.searchParams.set("prompt", "select_account");
    const loginHint = url.searchParams.get("loginHint");
    if (loginHint) googleUrl.searchParams.set("login_hint", loginHint);
    sendRedirect(res, googleUrl.toString());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/auth/google/callback") {
    const state = String(url.searchParams.get("state") || "");
    const code = String(url.searchParams.get("code") || "");
    const pending = oauthStates.get(state);
    oauthStates.delete(state);
    if (!pending || !code) {
      sendJson(res, 400, { error: "Invalid OAuth callback" });
      return true;
    }
    const tokenData = await exchangeAuthorizationCode(code, pending.redirectUri);
    const user = await googleTokenInfo(
      tokenData.id_token,
      process.env.GOOGLE_OAUTH_CLIENT_ID || "",
    );
    setSessionCookie(req, res, user);
    sendRedirect(res, pending.returnTo || "/");
    return true;
  }

  if (req.method === "POST" && url.pathname === "/auth/device/start") {
    const response = await fetch(googleOAuthEndpoints().deviceCode, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_DEVICE_CLIENT_ID || "",
        scope: OAUTH_SCOPE,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error_description || data.error || "Google device login start failed");
      error.status = 502;
      throw error;
    }
    const id = randomId();
    const interval = Math.max(Number(data.interval || 5), 1);
    deviceSessions.set(id, {
      deviceCode: data.device_code,
      interval,
      expiresAt: Date.now() + Math.max(Number(data.expires_in || 600), 60) * 1000,
      lastPollAt: 0,
    });
    pruneDeviceSessions();
    sendJson(res, 200, {
      id,
      userCode: data.user_code,
      verificationUrl: data.verification_url || data.verification_uri,
      verificationUrlComplete: data.verification_url_complete,
      expiresIn: Number(data.expires_in || 600),
      interval,
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/auth/device/poll") {
    const body = await readJsonBody(req);
    const id = String(body.id || "");
    const pending = deviceSessions.get(id);
    if (!pending || pending.expiresAt < Date.now()) {
      deviceSessions.delete(id);
      sendJson(res, 410, { error: "Device login expired" });
      return true;
    }
    const elapsedMs = Date.now() - pending.lastPollAt;
    if (pending.lastPollAt && elapsedMs < Math.max(pending.interval - 1, 1) * 1000) {
      sendJson(res, 202, { pending: true, interval: pending.interval });
      return true;
    }
    pending.lastPollAt = Date.now();
    const result = await exchangeDeviceCode(pending.deviceCode);
    if (!result.done) {
      if (result.slowDown) pending.interval += 5;
      sendJson(res, 202, { pending: true, interval: pending.interval });
      return true;
    }
    if (!result.data.id_token) {
      const error = new Error("Google device response did not include an ID token");
      error.status = 401;
      throw error;
    }
    const user = await googleTokenInfo(
      result.data.id_token,
      process.env.GOOGLE_DEVICE_CLIENT_ID || "",
    );
    deviceSessions.delete(id);
    sendJson(res, 200, {
      token: issueSignedToken(
        {
          type: "agent",
          userId: user.userId,
          email: user.email,
          hd: user.hd || "",
          sub: user.sub,
        },
        AGENT_TOKEN_TTL_SECONDS,
      ),
      user: { email: user.email, userId: user.userId, hd: user.hd || "" },
      expiresIn: AGENT_TOKEN_TTL_SECONDS,
    });
    return true;
  }

  return false;
}

function safeReturnPath(value) {
  const pathValue = String(value || "/");
  if (!pathValue.startsWith("/") || pathValue.startsWith("//")) return "/";
  return pathValue;
}

function pruneAuthState() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [state, pending] of oauthStates) {
    if (pending.createdAt < cutoff) oauthStates.delete(state);
  }
}

function pruneDeviceSessions() {
  const now = Date.now();
  for (const [id, pending] of deviceSessions) {
    if (pending.expiresAt < now) deviceSessions.delete(id);
  }
}

function sendAuthChallenge(res) {
  res.writeHead(401, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "www-authenticate": 'Basic realm="tmux-mobile", charset="UTF-8"',
  });
  res.end("Authentication required");
}

function logServerEvent(event, details = {}) {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...details,
    }),
  );
}

const agentRoundNtfyNotifier = createAgentRoundNtfyNotifier({
  ...createNtfyConfig(process.env),
  appBaseUrl:
    process.env.NTFY_APP_BASE_URL ||
    process.env.TMUX_MOBILE_PUBLIC_URL ||
    DEFAULT_CONTROLLER_URL,
}, {
  logEvent: logServerEvent,
});

function logRequestError(req, url, status, error) {
  console.error(
    JSON.stringify({
      at: new Date().toISOString(),
      event: "request_failed",
      method: req.method,
      path: url?.pathname || req.url || "",
      status,
      message: error.message || "Internal server error",
      stack: error.stack || "",
    }),
  );
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      revision: APP_REVISION,
      connectorVersion: CONNECTOR_VERSION,
    });
    return;
  }

  // Local-mode attention sweep (single machine). In hub mode this is handled
  // earlier across all machines; here it returns one "local" machine entry so the
  // client uses the same code path in both modes.
  if (req.method === "GET" && url.pathname === "/api/attention") {
    const windows = await collectMachineAttention();
    sendJson(res, 200, { machines: [{ machineId: "local", hostname: "local", windows }] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    try {
      sendJson(res, 200, await currentWindowRuntime().listSessions());
    } catch (error) {
      if (isNoServerError(error)) {
        sendJson(res, 200, []);
        return;
      }
      throw error;
    }
    return;
  }

  // Cold-load batch (sessions + all windows in one agent round-trip). See
  // listTree() for why this exists.
  if (req.method === "GET" && url.pathname === "/api/tree") {
    try {
      sendJson(res, 200, await listTree());
    } catch (error) {
      if (isNoServerError(error)) {
        sendJson(res, 200, { sessions: [], windows: [] });
        return;
      }
      throw error;
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJsonBody(req);
    sendJson(res, 200, await createSession(body.name));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent-sessions") {
    const body = await readJsonBody(req);
    const requestedMachineId =
      req.headers["x-machine-id"] || url.searchParams.get("machineId") || "";
    logServerEvent("start_agent_session_requested", {
      machineId: requestedMachineId,
      kind: String(body.kind || ""),
      cwd: String(body.cwd || ""),
      sessionName: String(body.sessionName || ""),
      mux: String(body.mux || currentRequestMux() || ""),
    });
    const result = await withRequestMux(body.mux || currentRequestMux(), () =>
      startAgentSession({
        kind: body.kind,
        cwd: body.cwd,
        sessionName: body.sessionName,
      }),
    );
    logServerEvent("start_agent_session_started", {
      machineId: requestedMachineId,
      kind: result.kind,
      cwd: result.cwd,
      sessionName: result.session?.name || "",
      sessionId: result.session?.id || "",
      windowId: result.windowId || "",
      paneId: result.paneId || "",
      mux: result.mux || "",
      muxCommand: result.muxCommand || "",
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/connector-update") {
    const body = await readJsonBody(req);
    sendJson(
      res,
      200,
      await startConnectorUpdate({
        repoDir: body.repoDir,
        controllerUrl: body.controllerUrl || requestOrigin(req),
        cloneUrl: body.cloneUrl || CONNECTOR_CLONE_URL,
        expectedRevision: body.expectedRevision || CONNECTOR_EXPECTED_REVISION,
        targetRef: body.targetRef || CONNECTOR_UPDATE_REF,
        updateScriptUrl: body.updateScriptUrl,
        nodePath: body.nodePath || "node",
        agentMachine: body.agentMachine,
        machineLabel: body.machineLabel,
        mux: body.mux,
        muxes: body.muxes,
      }),
    );
    return;
  }

  if (req.method === "PATCH" && url.pathname === "/api/sessions") {
    const body = await readJsonBody(req);
    const sessionId = requireId(body.sessionId, "session");
    sendJson(res, 200, await renameSession(sessionId, body.name));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/windows") {
    const sessionId = requireId(url.searchParams.get("sessionId"), "session");
    sendJson(res, 200, await listWindows(sessionId));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/window-activity") {
    const sessionId = requireId(url.searchParams.get("sessionId"), "session");
    sendJson(res, 200, await getSessionWindowActivity(sessionId));
    return;
  }

  // Per-window metadata (agentType, repo, git branch/worktree). Replaces the
  // old window-branches endpoint, which is kept as an alias for compatibility.
  if (
    req.method === "GET" &&
    (url.pathname === "/api/window-metadata" || url.pathname === "/api/window-branches")
  ) {
    const sessionId = requireId(url.searchParams.get("sessionId"), "session");
    sendJson(res, 200, await getSessionWindowMetadata(sessionId));
    return;
  }

  // On-demand: parse the active pane's current AskUserQuestion (if any). The
  // user triggers this by tapping "Answer question" — no continuous scanning.
  if (req.method === "GET" && url.pathname === "/api/ask-question") {
    const paneId = await resolveActivePane(requireId(url.searchParams.get("paneId"), "pane"));
    const parsed = await readAskQuestion(paneId);
    sendJson(res, 200, { paneId, active: Boolean(parsed), question: parsed });
    return;
  }

  // Apply an AskUserQuestion answer by driving the TUI with keystrokes. Body:
  //   { paneId, action: "single", optionIndex }
  //   { paneId, action: "multi", checked: number[] }
  //   { paneId, action: "free", text }
  //   { paneId, action: "reviewSubmit" }
  //   { paneId, action: "cancel" }
  // Re-parses the pane first so the keys are computed against the live cursor
  // state, then returns the new parsed state so the overlay can continue
  // (next question / review / done).
  if (req.method === "POST" && url.pathname === "/api/ask-answer") {
    const body = await readJsonBody(req);
    const paneId = await resolveActivePane(requireId(body.paneId, "pane"));
    const parsed = await readAskQuestion(paneId);
    if (!parsed) {
      sendJson(res, 409, { error: "No active question in this pane" });
      return;
    }
    let keys = [];
    switch (body.action) {
      case "single":
        keys = singleSelectKeys(parsed, Number(body.optionIndex));
        break;
      case "multi":
        keys = multiSelectKeys(parsed, new Set((body.checked || []).map(Number)));
        break;
      case "free":
        keys = freeFormKeys(String(body.text || ""));
        break;
      case "reviewSubmit":
        keys = reviewSubmitKeys(parsed);
        break;
      case "cancel":
        keys = cancelKeys();
        break;
      default:
        sendJson(res, 400, { error: `Unknown action: ${body.action}` });
        return;
    }
    const beforeSig = askQuestionSignature(parsed);
    await sendAskKeys(paneId, keys);
    // Poll until the prompt actually changes (advances / review / gone) rather
    // than guessing a fixed delay — robust to a slow redraw and to the extra
    // round-trip latency in controller mode. cancel/free decline the prompt, so
    // their expected end state is "gone".
    const next = await settleAskQuestion(paneId, beforeSig);
    sendJson(res, 200, { paneId, active: Boolean(next), question: next });
    return;
  }

  // Suggested name/command/cwd for duplicating a window — the UI fetches this to
  // pre-fill the editable confirmation before actually creating the duplicate.
  if (req.method === "GET" && url.pathname === "/api/window-duplicate-info") {
    const windowId = requireId(url.searchParams.get("windowId"), "window");
    sendJson(res, 200, await getDuplicateDefaults(windowId));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/windows") {
    const body = await readJsonBody(req);
    // `duplicateFrom` present -> clone that window (same cwd, with the
    // user-confirmed name/command); otherwise create a fresh window.
    if (Object.prototype.hasOwnProperty.call(body, "duplicateFrom")) {
      const windowId = requireId(body.duplicateFrom, "window");
      sendJson(
        res,
        200,
        await duplicateWindow(windowId, { name: body.name, command: body.command }),
      );
    } else {
      const sessionId = requireId(body.sessionId, "session");
      sendJson(res, 200, await createWindow(sessionId));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/fork-agent-window") {
    const body = await readJsonBody(req);
    const paneId = requireId(body.paneId, "pane");
    sendJson(res, 200, await forkAgentWindow(paneId));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/rmux-web-share") {
    const body = await readJsonBody(req);
    sendJson(
      res,
      200,
      await createRmuxWebShare({
        paneId: body.paneId,
        windowId: body.windowId,
        ttlSeconds: body.ttlSeconds,
      }),
    );
    return;
  }

  // "New branch": create a worktree+branch off the window's cwd and open a new
  // window in it (command prefilled like Duplicate). Only meaningful when the
  // source window is a bare-repo-backed worktree; the client gates the action.
  if (req.method === "POST" && url.pathname === "/api/window-new-branch") {
    const body = await readJsonBody(req);
    const windowId = requireId(body.windowId, "window");
    sendJson(
      res,
      200,
      await newBranchWindow(windowId, {
        branch: body.branch,
        command: body.command,
        name: body.name,
      }),
    );
    return;
  }

  // Inspection endpoint: returns {kind, sessionId, transcriptPath, text} for
  // panes running Codex / Claude Code, or {result: null} otherwise. Used by
  // the client to enable/disable the Read buttons (Read only fires on
  // panes with a structured transcript to lift the last response from).
  if (req.method === "GET" && url.pathname === "/api/agent-session") {
    const paneId = requireId(url.searchParams.get("paneId"), "pane");
    const { pane } = await getPaneContext(paneId);
    const result = await safeAgentLastResponse(pane);
    sendJson(res, 200, { result });
    return;
  }

  // Structured transcript: every user/assistant turn from the agent's own
  // JSONL, filtered to clean dialogue (tool calls/results, system
  // reminders, environment context dropped). Capped at the last
  // MAX_TRANSCRIPT_TURNS on the backend so the response stays bounded.
  if (req.method === "GET" && url.pathname === "/api/agent-transcript") {
    const paneId = requireId(url.searchParams.get("paneId"), "pane");
    const { pane } = await getPaneContext(paneId);
    const result = await safeAgentTranscript(pane);
    sendJson(res, 200, { result });
    return;
  }

  // Command Center feed: one row per agent pane across every mux session.
  // See listAgentSessions() for the shape.
  if (req.method === "GET" && url.pathname === "/api/command-center") {
    const result = await listAgentSessions();
    const localMachine = await localCommandCenterMachine(result.agents?.length || 0);
    const agents = tagCommandCenterAgents(result, localMachine);
    observeCommandCenterAgentsForNtfy([localMachine], agents);
    sendJson(res, 200, { machines: [localMachine], agents });
    return;
  }

  if (req.method === "PATCH" && url.pathname === "/api/windows") {
    const body = await readJsonBody(req);
    const windowId = requireId(body.windowId, "window");
    // `annotation` present -> set the follow-up note; otherwise rename.
    if (Object.prototype.hasOwnProperty.call(body, "annotation")) {
      sendJson(res, 200, await setWindowAnnotation(windowId, body.annotation));
    } else {
      sendJson(res, 200, await renameWindow(windowId, body.name));
    }
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/api/windows") {
    const body = await readJsonBody(req);
    const windowId = requireId(body.windowId, "window");
    sendJson(res, 200, await killWindow(windowId));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/panes") {
    const windowId = requireId(url.searchParams.get("windowId"), "window");
    sendJson(res, 200, await listPanes(windowId));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/directories") {
    const explicitPath = url.searchParams.get("path");
    if (explicitPath !== null) {
      sendJson(res, 200, await directoriesForCwd(requireDirectoryPath(explicitPath)));
    } else {
      const paneId = requireId(url.searchParams.get("paneId"), "pane");
      sendJson(res, 200, await listPaneDirectories(paneId));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/capture") {
    const paneId = requireId(url.searchParams.get("paneId"), "pane");
    const mode = url.searchParams.get("mode") || "tail";
    const lines = parseLines(url.searchParams.get("lines"));
    const text = cleanTerminalTextKeepAnsi(await capturePane(paneId, mode, lines, { ansi: true }));
    sendJson(res, 200, { paneId, mode, lines, text });
    return;
  }

  // Switch-window batch (panes + active capture + cwd directories in one
  // request, two parallel agent round-trips total). See getWindowView() above.
  if (req.method === "GET" && url.pathname === "/api/window-view") {
    const windowId = requireId(url.searchParams.get("windowId"), "window");
    const lines = parseLines(url.searchParams.get("lines"));
    sendJson(res, 200, await getWindowView(windowId, lines));
    return;
  }

  // Smart content viewer: read a file referenced in a pane, resolving a relative
  // path against the pane's cwd (absolute/~ paths resolve as given). The only
  // boundary is the OS file permissions of the user the agent runs as — a file
  // that user can read is served; one they can't yields EACCES.
  if (req.method === "GET" && url.pathname === "/api/file") {
    const f = await readFileForServing(req, res, url);
    if (!f) return; // error already sent
    sendJson(res, 200, {
      path: f.requestedPath,
      name: f.name,
      kind: f.kind,
      contentType: f.contentType,
      base64: f.result.base64,
      size: f.result.size,
      truncated: f.result.truncated,
    });
    return;
  }

  // Raw file streaming with a SENSIBLE filename. Used so artifacts open in a new
  // tab as a real URL (not an opaque blob:) and downloads save under the actual
  // file name via Content-Disposition. Routed by machineId (header OR ?machineId)
  // and cookie-authed like every /api route, so a plain tab navigation works.
  // `?dl=1` forces a download (attachment); otherwise the browser shows it inline.
  if (req.method === "GET" && url.pathname === "/api/file-raw") {
    const f = await readFileForServing(req, res, url);
    if (!f) return;
    const bytes = Buffer.from(f.result.base64, "base64");
    const download = url.searchParams.get("dl") === "1";
    res.writeHead(200, {
      "content-type": f.contentType,
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${sanitizeFilename(f.name)}"`,
      "content-length": String(bytes.length),
      "cache-control": "no-store",
      // Sandbox hostile HTML so a top-level "open raw" tab can't script this origin.
      ...rawArtifactSecurityHeaders(f.contentType, { download }),
    });
    res.end(bytes);
    return;
  }

  // Markdown rendered to a standalone HTML page for opening in a new tab — keeps
  // the formatted view (headings, lists, tables) with a real document <title> so
  // the tab and any "Save as" use the file's name, not a blob GUID.
  if (req.method === "GET" && url.pathname === "/api/file-view") {
    const f = await readFileForServing(req, res, url);
    if (!f) return;
    if (f.kind !== "markdown") {
      // Non-markdown has nothing to render; just stream it inline.
      const bytes = Buffer.from(f.result.base64, "base64");
      res.writeHead(200, {
        "content-type": f.contentType,
        "content-disposition": `inline; filename="${sanitizeFilename(f.name)}"`,
        "content-length": String(bytes.length),
        "cache-control": "no-store",
      });
      res.end(bytes);
      return;
    }
    const md = Buffer.from(f.result.base64, "base64").toString("utf8");
    const page = renderMarkdownPage(f.name, md, f.result.truncated);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(page);
    return;
  }

  // Viewer-wrapper page for images and standalone HTML, so those artifacts can
  // host the Pin overlay (a raw image/HTML response can't). The artifact bytes
  // are embedded via the existing /api/file-raw URL (re-using its streaming/auth)
  // and the overlay rides on top. Validation goes through readFileForServing so
  // an unviewable/oversized/denied file is rejected the same way as the viewer.
  // Raw media (video/audio) can't host an overlay; they keep opening file-raw
  // directly and pin from the file chip instead.
  if (req.method === "GET" && url.pathname === "/api/file-page") {
    const f = await readFileForServing(req, res, url);
    if (!f) return;
    const ext = path.extname(f.name).toLowerCase();
    const isHtml = ext === ".html" || ext === ".htm";
    if (f.kind !== "image" && !isHtml) {
      // Not an overlay-capable kind — send the caller to the raw stream.
      sendRedirect(res, `/api/file-raw${url.search}`);
      return;
    }
    const rawUrl = `/api/file-raw${url.search}`;
    const page = renderArtifactViewerPage(f.name, isHtml ? "html" : "image", rawUrl);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(page);
    return;
  }

  // Pin a viewed artifact: snapshot its CURRENT bytes into artifact storage and
  // record a shareable pin. Reuses readFileForServing so pinning inherits the
  // exact same viewable-type gating (415), denylist, cwd resolution, and
  // connector-out-of-date (501) handling as the file viewer — only viewable
  // artifacts can be pinned. The bytes must be complete to hash honestly, so a
  // truncated (too-large) read is rejected. The viewer is read from the
  // withPinViewer() scope established by the request layer.
  if (req.method === "POST" && url.pathname === "/api/pins") {
    // Inline pin: snapshot client-supplied text (e.g. an agent response) into an
    // artifact directly — no file/live-machine read. Becomes a markdown pin, so
    // it renders + supports comments like any other. The machine id is metadata
    // only (provenance/family grouping), so this works even if it's offline.
    if (url.searchParams.get("inline") === "1") {
      const body = await readJsonBody(req).catch(() => ({}));
      const text = String(body.text || "");
      if (!text.trim()) {
        sendJson(res, 400, { error: "text is required" });
        return;
      }
      let name = sanitizeFilename(String(body.name || "response.md"));
      if (!/\.[a-z0-9]+$/i.test(name)) name += ".md";
      const sourceMachineId =
        req.headers["x-machine-id"] || url.searchParams.get("machineId") || body.machineId || "";
      const sourcePath = String(body.sourcePath || `agent-response/${name}`);
      const { pin, deduped, persisted } = await createPin(
        {
          bytes: Buffer.from(text, "utf8"),
          name,
          contentType: "text/markdown; charset=utf-8",
          ext: ".md",
          kind: "markdown",
          sourcePath,
          sourceMachineId,
          share: body && body.share,
        },
        { storage: ARTIFACT_STORAGE },
      );
      sendJson(res, deduped ? 200 : 201, { pin: publicPinView(pin), deduped, persisted });
      return;
    }
    const f = await readFileForServing(req, res, url);
    if (!f) return; // error already sent
    if (f.result.truncated) {
      sendJson(res, 413, {
        error: "File is too large to pin — pinning needs the whole file to hash it.",
      });
      return;
    }
    const body = await readJsonBody(req).catch(() => ({}));
    const sourceMachineId =
      req.headers["x-machine-id"] || url.searchParams.get("machineId") || "";
    const bytes = Buffer.from(f.result.base64, "base64");
    const { pin, deduped, persisted } = await createPin(
      {
        bytes,
        name: f.name,
        contentType: f.contentType,
        ext: path.extname(f.name).toLowerCase(),
        kind: f.kind,
        sourcePath: f.requestedPath,
        sourceMachineId,
        share: body && body.share,
      },
      { storage: ARTIFACT_STORAGE },
    );
    sendJson(res, deduped ? 200 : 201, {
      pin: publicPinView(pin),
      deduped,
      persisted,
    });
    return;
  }

  // Upload a file to a temp directory on the target machine; the client inserts
  // the returned path into the composer. Body is the raw file bytes; the filename
  // is the `name` query param. Routes through the backend seam, so a controller
  // brokers it to the registered agent (file rides as base64 in the frame).
  if (req.method === "POST" && url.pathname === "/api/upload") {
    requireId(url.searchParams.get("paneId"), "pane");
    const backend = currentBackend();
    if (typeof backend.supportsOp === "function" && !backend.supportsOp(OP.WRITEFILE)) {
      sendJson(res, 501, {
        error:
          "This machine's connector is out of date — restart it (node server.mjs --register …) to upload files.",
      });
      return;
    }
    const bytes = await readRequestBuffer(req, MAX_UPLOAD_BYTES);
    if (bytes.length === 0) {
      sendJson(res, 400, { error: "No file received" });
      return;
    }
    const name = url.searchParams.get("name") || "upload";
    let result;
    try {
      result = await backend.writeTempFile(name, bytes.toString("base64"));
    } catch (error) {
      if (/unknown op/i.test(error.message) || error instanceof TypeError) {
        sendJson(res, 501, {
          error: "This machine's connector is out of date — restart it to upload files.",
        });
        return;
      }
      sendJson(res, 500, { error: error.message || "Could not save the file" });
      return;
    }
    sendJson(res, 200, { path: result.path, name: result.name });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/inspect") {
    const paneId = requireId(url.searchParams.get("paneId"), "pane");
    const lines = parseLines(url.searchParams.get("lines"));
    const [{ windowInfo, pane }, captureText] = await Promise.all([
      getPaneContext(paneId),
      capturePane(paneId, "tail", lines),
    ]);
    sendJson(res, 200, {
      paneId,
      session: windowInfo.sessionName,
      windowIndex: windowInfo.windowIndex,
      windowName: windowInfo.windowName,
      paneIndex: pane.index,
      command: pane.command,
      cwd: pane.cwd,
      pid: Number(pane.pid),
      active: pane.active,
      summary: summarizeOutput(captureText),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/send") {
    const body = await readJsonBody(req);
    const paneId = requireId(body.paneId, "pane");
    const text = String(body.text ?? "");
    const sendEnter = body.enter !== false;
    const submitNudge = body.submitNudge === true;

    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
      sendJson(res, 413, { error: "Text is too large" });
      return;
    }

    // If the pane is parked in copy-mode, our input would be swallowed by the
    // scrollback pager — exit it first so the paste/Enter reaches the program.
    await exitCopyModeIfNeeded(paneId);

    let sendResult;
    if (text.length > 0) {
      // Paste + (optionally) Enter in one call so the paste->Enter delay applies
      // and the Enter reliably submits rather than being eaten by the paste.
      sendResult = await sendTextToPane(paneId, text, { enter: sendEnter });
      if (sendEnter && submitNudge) {
        sendSubmitNudge(paneId);
      }
    } else {
      // No text — a bare Enter keypress (e.g. the Enter quick-key). No paste, so
      // no race; send it directly.
      sendResult = { mode: "none", sentEnter: false };
      if (sendEnter) {
        await currentWindowRuntime().sendKeyToSurface({ surfaceId: paneId, key: "Enter" });
      }
    }
    sendJson(res, 200, {
      ok: true,
      sendMode: sendResult.mode,
      submitNudgeDelayMs:
        submitNudge && sendEnter && text.length > 0 ? SUBMIT_NUDGE_DELAY_MS : 0,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/transcribe") {
    const contentType = req.headers["content-type"] || "audio/webm";
    const audio = await readRequestBuffer(req, MAX_AUDIO_BYTES);
    if (audio.length === 0) {
      sendJson(res, 400, { error: "No audio received" });
      return;
    }

    const text = await transcribeAudio(audio, contentType);
    if (!text) {
      sendJson(res, 422, { error: "No speech recognized" });
      return;
    }

    sendJson(res, 200, { text, model: getVoiceConfig().transcribeModel });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/voice-send") {
    const paneId = requireId(url.searchParams.get("paneId"), "pane");
    const sendEnter = url.searchParams.get("enter") !== "0";
    const submitNudge = url.searchParams.get("submitNudge") !== "0";
    // Optional prefix prepended to the transcript before sending — e.g. "/btw "
    // so a voice note becomes a Claude `/btw` side-note slash-command. Validated
    // to a short, safe set of chars so it can't inject arbitrary control input.
    const rawPrefix = url.searchParams.get("prefix") || "";
    const prefix = sanitizeVoicePrefix(rawPrefix);
    const idempotencyKey = String(req.headers["x-idempotency-key"] || "");
    const contentType = req.headers["content-type"] || "audio/webm";
    const audio = await readRequestBuffer(req, MAX_AUDIO_BYTES);

    // Idempotency: voice-send transcribes AND pastes into a tmux pane, so a
    // retried request after a flaky response would otherwise duplicate the
    // user's message into the pane every retry. Client supplies a stable
    // UUID per recording (state.voice.pendingIdempotencyKey); same key
    // collapses to the same response. In-flight dedup also handles two
    // retries fired before the first finishes.
    const response = await withVoiceSendIdempotency(idempotencyKey, async () => {
      if (audio.length === 0) {
        const error = new Error("No audio received");
        error.status = 400;
        throw error;
      }
      const transcript = await transcribeAudio(audio, contentType);
      if (!transcript) {
        const error = new Error("No speech recognized");
        error.status = 422;
        throw error;
      }
      const text = prefix ? `${prefix}${transcript}` : transcript;
      if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
        const error = new Error("Transcribed text is too large");
        error.status = 413;
        throw error;
      }
      // Paste + Enter together so the paste->Enter delay applies and the Enter
      // reliably submits (rather than being consumed by the bracketed paste).
      const sendResult = await sendTextToPane(paneId, text, { enter: sendEnter });
      if (sendEnter && submitNudge) {
        sendSubmitNudge(paneId);
      }
      return {
        ok: true,
        text, // the full sent text (prefix + transcript)
        transcript, // the raw transcript without the prefix
        prefix,
        model: getVoiceConfig().transcribeModel,
        sendMode: sendResult.mode,
        submitNudgeDelayMs:
          submitNudge && sendEnter && text.length > 0 ? SUBMIT_NUDGE_DELAY_MS : 0,
      };
    });
    sendJson(res, 200, response);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/window-audio-summary") {
    const body = await readJsonBody(req);
    const paneId = body.paneId ? requireId(body.paneId, "pane") : "";
    const windowId = body.windowId ? requireId(body.windowId, "window") : "";
    if (!paneId && !windowId) {
      sendJson(res, 400, { error: "paneId or windowId is required" });
      return;
    }
    const lines = Math.min(parseLines(body.lines || WINDOW_BRIEFING_LINES), 100);
    const { speechModel, speechVoice } = getVoiceConfig();
    const startedAt = Date.now();
    logServerEvent("window_audio_summary_started", {
      paneId,
      windowId,
      lines,
      summaryModel: WINDOW_BRIEFING_MODEL,
      speechModel,
      voice: speechVoice,
    });
    const briefing = paneId
      ? await summarizePaneForSpeech(paneId, lines)
      : await summarizeWindowForSpeech(windowId, lines);
    logServerEvent("window_audio_summary_summarized", {
      paneId: briefing.paneId || paneId,
      windowId: briefing.windowId || windowId,
      lines,
      summaryModel: WINDOW_BRIEFING_MODEL,
      summaryChars: briefing.summary.length,
      elapsedMs: Date.now() - startedAt,
    });
    const audioBase64 = await createSpeechAudio(briefing.summary);
    logServerEvent("window_audio_summary_completed", {
      paneId: briefing.paneId || paneId,
      windowId: briefing.windowId || windowId,
      lines,
      summaryModel: WINDOW_BRIEFING_MODEL,
      speechModel,
      audioBase64Chars: audioBase64.length,
      elapsedMs: Date.now() - startedAt,
    });
    sendJson(res, 200, {
      summary: briefing.summary,
      audioBase64,
      mimeType: "audio/mpeg",
      paneId: briefing.paneId || paneId,
      windowId: briefing.windowId || windowId,
      lines,
      summaryModel: WINDOW_BRIEFING_MODEL,
      speechModel,
      voice: speechVoice,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/window-realtime-session") {
    const body = await readJsonBody(req);
    const paneId = body.paneId ? requireId(body.paneId, "pane") : "";
    const windowId = body.windowId ? requireId(body.windowId, "window") : "";
    if (!paneId && !windowId) {
      const error = new Error("Pane or window id is required");
      error.status = 400;
      throw error;
    }
    const lines = Math.min(
      parseLines(body.lines || WINDOW_BRIEFING_LINES),
      REALTIME_WINDOW_BRIEFING_MAX_CAPTURE_LINES,
    );
    const { realtimeModel, realtimeVoice } = getVoiceConfig();
    const startedAt = Date.now();
    logServerEvent("window_realtime_session_started", {
      windowId,
      paneId,
      lines,
      realtimeModel,
      voice: realtimeVoice,
      clientSecretTtlSeconds: REALTIME_CLIENT_SECRET_TTL_SECONDS,
    });
    const briefing = paneId
      ? await buildPaneBriefingInput(paneId, lines)
      : await buildWindowBriefingInput(windowId, lines);
    const clientSecret = await createRealtimeClientSecret();
    logServerEvent("window_realtime_session_ready", {
      windowId: briefing.windowId || windowId,
      paneId: briefing.paneId || paneId,
      lines: briefing.lines,
      realtimeModel,
      voice: realtimeVoice,
      inputChars: briefing.input.length,
      rawChars: briefing.rawChars,
      extractedChars: briefing.extractedChars,
      extractionModel: briefing.extractionModel,
      chunkCount: briefing.inputChunks.length,
      chunkLines: REALTIME_WINDOW_BRIEFING_CHUNK_LINES,
      chunkChars: REALTIME_WINDOW_BRIEFING_CHUNK_CHARS,
      clientSecretExpiresAt: clientSecret.expiresAt,
      realtimeSessionId: clientSecret.sessionId,
      elapsedMs: Date.now() - startedAt,
    });
    sendJson(res, 200, {
      clientSecret: clientSecret.value,
      clientSecretExpiresAt: clientSecret.expiresAt,
      input: briefing.input,
      inputChunks: briefing.inputChunks,
      chunkCount: briefing.inputChunks.length,
      lines: briefing.lines,
      windowId: briefing.windowId || windowId,
      paneId: briefing.paneId || paneId,
      model: realtimeModel,
      voice: realtimeVoice,
      extractionModel: briefing.extractionModel,
      extractedChars: briefing.extractedChars,
      maxOutputTokens: REALTIME_WINDOW_BRIEFING_MAX_OUTPUT_TOKENS,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/client-log") {
    const body = await readJsonBody(req);
    logServerEvent("client_log", {
      clientEvent: String(body.event || "unknown").slice(0, 120),
      details: body.details || {},
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/key") {
    const body = await readJsonBody(req);
    const paneId = requireId(body.paneId, "pane");
    const key = String(body.key || "");
    if (!allowedKeys.has(key)) {
      sendJson(res, 400, { error: "Unsupported key" });
      return;
    }
    // Exit copy-mode first so the key reaches the program, not the pager. (One
    // exception: if the user is deliberately sending a navigation key to drive
    // copy-mode, this would fight them — but the allowed keys here are
    // submit/edit keys for the app's input, not copy-mode navigation.)
    await exitCopyModeIfNeeded(paneId);
    await currentWindowRuntime().sendKeyToSurface({ surfaceId: paneId, key });
    sendJson(res, 200, { ok: true });
    return;
  }

  // Set a Claude agent's effort level by driving its in-TUI `/effort` slider:
  // open the slider, step Left/Right from the current level to the target, then
  // Enter to confirm. The slider levels + command live in the per-agent table;
  // "current" is read live from the pane footer so we step the right distance
  // even if the user moved it by hand. This reuses the same sequenced-key
  // primitive as the AskUserQuestion answer flow (sendAskKeys + a settle poll).
  if (req.method === "POST" && url.pathname === "/api/agent-effort") {
    const body = await readJsonBody(req);
    const paneId = requireId(body.paneId, "pane");
    const agentType = String(body.agentType || "");
    const target = String(body.level || "").toLowerCase();
    const spec = AGENT_MODES[agentType]?.effort;
    if (!spec) {
      sendJson(res, 400, { error: `No effort control for agent "${agentType}"` });
      return;
    }
    const targetIdx = spec.levels.indexOf(target);
    if (targetIdx === -1) {
      sendJson(res, 400, { error: `Unknown effort level "${target}"` });
      return;
    }
    await exitCopyModeIfNeeded(paneId);
    // Open the slider, then drive it DETERMINISTICALLY without parsing the
    // current level (the footer's effort marker is unreliable across levels and
    // widths — e.g. max/ultracode render differently and may not show "/effort").
    // The slider clamps at its ends, so: press Left N times to guarantee we're at
    // the far-left (index 0 = lowest), then Right `targetIdx` times to land on the
    // target. N = levels.length is always enough to reach the left edge.
    await sendTextToPane(paneId, spec.command, { enter: true });
    await delay(ASK_KEY_DELAY_MS * 3); // let the slider render before stepping
    const keys = [];
    for (let i = 0; i < spec.levels.length; i++) keys.push("Left"); // clamp to low
    for (let i = 0; i < targetIdx; i++) keys.push("Right"); // step up to target
    keys.push("Enter");
    await sendAskKeys(paneId, keys);
    sendJson(res, 200, { ok: true, to: target });
    return;
  }

  // Set an agent's permission mode by cycling Shift+Tab until the pane's parsed
  // mode matches the target. We do NOT assume a fixed ring order/membership (it
  // varies with launch flags) — we step one cycle, re-read the REAL mode, and
  // stop when it matches or we've made a full loop without finding it.
  if (req.method === "POST" && url.pathname === "/api/agent-mode") {
    const body = await readJsonBody(req);
    const paneId = requireId(body.paneId, "pane");
    const agentType = String(body.agentType || "");
    const target = String(body.mode || "");
    const cfg = AGENT_MODES[agentType];
    if (!cfg) {
      sendJson(res, 400, { error: `No mode control for agent "${agentType}"` });
      return;
    }
    await exitCopyModeIfNeeded(paneId);
    const readMode = async () => {
      const clean = cleanTerminalText(await capturePane(paneId, "screen"));
      return detectAgentMode(agentType, {
        paneTail: clean.split("\n").slice(-12).join("\n"),
      }).mode;
    };
    let current = await readMode();
    // A whole ring is at most ~6 modes; cap steps generously to avoid spinning.
    const maxSteps = 8;
    let steps = 0;
    while (current !== target && steps < maxSteps) {
      await currentWindowRuntime().sendKeyToSurface({ surfaceId: paneId, key: cfg.cycleKey });
      await delay(ASK_KEY_DELAY_MS * 2); // let the footer redraw before re-reading
      current = await readMode();
      steps++;
    }
    sendJson(res, 200, {
      ok: current === target,
      mode: current,
      steps,
      reached: current === target,
    });
    return;
  }

  // Explicitly drop a pane out of tmux copy-mode (the "Exit scroll mode" banner
  // button). Idempotent: a no-op if it isn't in copy-mode.
  if (req.method === "POST" && url.pathname === "/api/exit-copy-mode") {
    const body = await readJsonBody(req);
    const paneId = requireId(body.paneId, "pane");
    const exited = await exitCopyModeIfNeeded(paneId);
    sendJson(res, 200, { ok: true, exited });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  // .mjs needs an explicit JS MIME — browsers refuse to execute `<script
  // type="module">` over application/octet-stream. The SPA router lives at
  // public/spa-router.mjs.
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".wav", "audio/wav"], // bundled notification chime (public/sounds/notify.wav)
]);

async function serveStatic(req, res, url) {
  let pathname = url.pathname;
  // SPA shell. All four user-facing routes ("/", "/command-center", "/app",
  // and their trailing-slash variants) serve the same spa.html host page;
  // its router (public/spa-router.mjs) decides which view to mount based on
  // pathname and keeps both views alive in one document after the first
  // visit, so flipping between them no longer tears down the JS heap.
  //
  // index.html and command-center.html are still reachable as static files
  // because the router fetches them on first nav to extract each view's
  // body markup. They're never sent as a top-level response anymore.
  if (
    pathname === "/" ||
    pathname === "/command-center" ||
    pathname === "/command-center/" ||
    pathname === "/app" ||
    pathname === "/app/"
  ) {
    pathname = "/spa.html";
  }
  if (pathname === "/manifest.webmanifest") {
    sendWebManifest(res);
    return;
  }

  const relative = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(publicDir, relative.replace(/^\/+/, ""));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    // Every served .html file goes through __APP_TITLE__ substitution: this
    // used to be index.html-only, which made command-center.html ship with
    // a literal "Command Center · __APP_TITLE__" in its title bar. spa.html
    // (the new SPA shell) also uses the placeholder; widening this keeps
    // them in sync.
    const isHtml = path.extname(filePath) === ".html";
    const body = isHtml
      ? renderIndexHtml(await readFile(filePath, "utf8"))
      : await readFile(filePath);
    res.writeHead(200, {
      "content-type":
        contentTypes.get(path.extname(filePath)) || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

// Three modes:
//   default       — local single-machine server (today's everyday usage)
//   --register U  — agent that dials out to a controller over WebSocket
//   --controller  — the public hub (Fargate / Cloud Run) with Google OAuth
// The legacy `--hub` (no-auth public broker) is gone; the controller path
// covers every public-broker use case with proper auth.
function parseMode(args) {
  const registerIndex = args.indexOf("--register");
  if (registerIndex !== -1) {
    return {
      kind: "register",
      hubUrl: args[registerIndex + 1] || process.env.HUB_URL,
      login: args.includes("--login"),
    };
  }
  if (args.includes("--controller")) return { kind: "controller" };
  if (args.includes("--hub")) {
    console.error(
      "--hub mode has been removed; use --controller (Google OAuth) for the public broker.",
    );
    process.exit(2);
  }
  return { kind: "local" };
}

const MODE = parseMode(process.argv.slice(2));
const HOST = process.env.HOST || (MODE.kind === "controller" ? "0.0.0.0" : "127.0.0.1");
// IS_HUB_MODE is now just "is this the public broker", which only the
// controller is. Kept under the old name so the many call sites don't churn.
const IS_HUB_MODE = MODE.kind === "controller";
const REQUIRE_BROWSER_AUTH =
  MODE.kind === "controller" || process.env.TMUX_MOBILE_REQUIRE_AUTH === "1";

// Artifact storage backs the "pin a file" feature: pinning snapshots a viewed
// file's bytes here so it gets a stable, shareable link that survives the origin
// machine going offline. Local-disk by default (zero new infra); GCS/S3 when
// TMUX_MOBILE_ARTIFACT_STORAGE is set. If a cloud driver fails to initialize
// (e.g. its SDK isn't installed), fall back to the local driver so the server
// still boots — pinning degrades to local-only rather than taking the box down.
let ARTIFACT_STORAGE;
try {
  ARTIFACT_STORAGE = await createArtifactStorage();
} catch (error) {
  console.error(
    `Artifact storage init failed (${error.message}); falling back to local disk.`,
  );
  ARTIFACT_STORAGE = createLocalArtifactStorage();
}

// The pin INDEX (mutable metadata records) is a separate concern from the bytes:
// it lives in a pluggable PinIndex backend chosen by TMUX_MOBILE_PIN_INDEX —
// memory (default, zero infra) | file (local JSON) | firestore (durable,
// per-document, concurrent-safe). On Cloud Run the home dir is ephemeral, so a
// file/memory index would reset on every restart; Firestore makes pins durable
// with proper per-record writes (no whole-file rewrite). If the chosen backend
// fails to init (e.g. SDK missing / bad creds), fall back to an in-memory index
// so the server still boots — pinning degrades to ephemeral rather than crashing.
let PIN_INDEX;
try {
  PIN_INDEX = await createPinIndex();
} catch (error) {
  console.error(
    `Pin index init failed (${error.message}); falling back to in-memory.`,
  );
  const { createMemoryPinIndex } = await import("./lib/pin-index.mjs");
  PIN_INDEX = createMemoryPinIndex();
}
setPinIndex(PIN_INDEX);
try {
  await hydratePins();
} catch (error) {
  console.error(`Pin index hydrate failed (${error.message}); starting empty.`);
}

// Comment store — same fall-back-to-memory posture as the pin index so a missing
// SDK / bad creds degrades comments to ephemeral rather than crashing the boot.
try {
  setCommentIndex(await createCommentIndex());
} catch (error) {
  console.error(
    `Comment index init failed (${error.message}); falling back to in-memory.`,
  );
  const { createMemoryCommentStore } = await import("./lib/comment-index.mjs");
  setCommentIndex(createMemoryCommentStore());
}

function validateStartupConfig() {
  if (MODE.kind !== "controller") return;

  const missing = [];
  for (const key of [
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_DEVICE_CLIENT_ID",
    "GOOGLE_DEVICE_CLIENT_SECRET",
    "OPENAI_API_KEY",
    "SESSION_SECRET",
  ]) {
    if (!process.env[key]) missing.push(key);
  }
  if (
    process.env.ALLOW_ALL_GOOGLE_USERS === "0" &&
    !process.env.ALLOWED_GOOGLE_EMAILS &&
    !process.env.ALLOWED_GOOGLE_DOMAINS
  ) {
    missing.push("ALLOWED_GOOGLE_EMAILS or ALLOWED_GOOGLE_DOMAINS");
  }
  if (missing.length > 0) {
    console.error(
      `controller mode requires ${missing.join(", ")} to be set`,
    );
    process.exit(2);
  }
}

validateStartupConfig();

if (MODE.kind === "register") {
  if (!MODE.hubUrl) {
    console.error("usage: node server.mjs --register <hubUrl>");
    process.exit(2);
  }
  const { agentAuthState, loginAgent, runAgent } = await import("./lib/agent.mjs");
  let authState = agentAuthState(MODE.hubUrl);
  const shouldLogin = MODE.login || !authState.hasAuth;
  logServerEvent("agent_starting", {
    controller: new URL(MODE.hubUrl).origin,
    machine: process.env.AGENT_MACHINE || os.hostname(),
    login: shouldLogin,
    authSource: authState.source,
    message: shouldLogin
      ? "No agent token is available, or re-login was requested; starting Google device login before registration."
      : "Starting agent with existing credentials; this machine will register with the controller.",
  });
  if (shouldLogin) {
    await loginAgent(MODE.hubUrl);
    authState = agentAuthState(MODE.hubUrl);
    logServerEvent("agent_login_ready", {
      controller: new URL(MODE.hubUrl).origin,
      machine: process.env.AGENT_MACHINE || os.hostname(),
      authSource: authState.source,
      message: "Agent login is ready; connecting to the controller.",
    });
  }
  runAgent(MODE.hubUrl, localBackend, {
    logEvent: logServerEvent,
    inventoryProvider: listAgentSessions,
  });
} else {
  let hub = null;
  let stopAgentRoundWatcher = () => {};

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url || "/", `http://${req.headers.host || HOST}`);

      if (await handleAuthRoute(req, res, url)) {
        return;
      }

      if (await serveConnectorArtifact(req, res, url)) {
        return;
      }

      if (
        REQUIRE_BROWSER_AUTH &&
        url.pathname !== "/api/health" &&
        !authenticateBrowser(req)
      ) {
        if (url.pathname.startsWith("/api/")) {
          sendJson(res, 401, { error: "Authentication required" });
        } else {
          sendRedirect(
            res,
            `/auth/google/login?returnTo=${encodeURIComponent(url.pathname + url.search)}`,
          );
        }
        return;
      }
      const authenticatedUser = REQUIRE_BROWSER_AUTH ? authenticateBrowser(req) : null;
      const userId = REQUIRE_BROWSER_AUTH
        ? authenticatedUser?.userId
        : String(process.env.TMUX_MOBILE_USER || "default");
      const viewer = REQUIRE_BROWSER_AUTH
        ? authenticatedUser
        : { userId, email: userId, hd: "" };

      if (req.method === "GET" && url.pathname === "/api/runtime") {
        sendJson(res, 200, {
          // Frontend still uses the legacy 'hub' literal to mean "I'm
          // talking to the public broker (vs my own local tmux server)";
          // preserved here so the UI doesn't need to learn 'controller'.
          mode: IS_HUB_MODE ? "hub" : MODE.kind,
          revision: APP_REVISION,
          // Connector repo, shown in the "no machine connected" UI so a user
          // knows what to clone. Overridable via env for forks/mirrors.
          cloneUrl: CONNECTOR_CLONE_URL,
          connectorUpdateRef: CONNECTOR_UPDATE_REF,
          connectorExpectedRevision: CONNECTOR_EXPECTED_REVISION,
          connectorUpdateScriptUrl: CONNECTOR_UPDATE_SCRIPT_URL,
          connectorBundleUrl: CONNECTOR_BUNDLE_ROUTE,
        });
        return;
      }

      // Voice model settings are per-user (each authenticated user has their own
      // transcription / TTS / realtime models), so they're keyed by userId and
      // live above the hub/machine routing rather than per-pane.
      if (url.pathname === "/api/voice-config") {
        if (req.method === "GET") {
          sendJson(res, 200, describeVoiceConfig(userId));
          return;
        }
        if (req.method === "PUT" || req.method === "POST") {
          const body = await readJsonBody(req);
          try {
            updateVoiceConfig(body, userId);
          } catch (error) {
            // updateVoiceConfig throws status 400 on a bad value; a persistence
            // failure (read-only home dir) carries persisted:false but the
            // in-memory override still took effect, so report success with a note.
            if (error.persisted === false) {
              sendJson(res, 200, {
                ...describeVoiceConfig(userId),
                persisted: false,
                note: error.message,
              });
              return;
            }
            sendJson(res, error.status || 400, { error: error.message });
            return;
          }
          sendJson(res, 200, { ...describeVoiceConfig(userId), persisted: true });
          return;
        }
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      // Voice preview: synthesize a short sample phrase in a chosen voice so the
      // user can hear it before saving. Validates the voice against the curated
      // allowlist and never mutates the user's saved config.
      if (req.method === "POST" && url.pathname === "/api/voice-preview") {
        const body = await readJsonBody(req);
        const voice = String(body.voice || "");
        if (!VOICE_OPTIONS.voice.includes(voice)) {
          sendJson(res, 400, {
            error: `Unknown voice: ${voice}. Allowed: ${VOICE_OPTIONS.voice.join(", ")}`,
          });
          return;
        }
        const sample =
          typeof body.text === "string" && body.text.trim()
            ? body.text.trim().slice(0, 200)
            : `Hi, this is the ${voice} voice. Your terminal is ready when you are.`;
        const audioBase64 = await createSpeechAudio(sample, { voice });
        sendJson(res, 200, { audioBase64, mimeType: "audio/mpeg", voice });
        return;
      }

      // Pinned artifacts — listing, sharing, unpinning, and the shareable serve
      // link. These live ABOVE the per-machine /api routing on purpose: a pin's
      // bytes are in artifact storage, not on the origin machine, so the share
      // link and the manage UI must work even when that machine is offline.
      // Creating a pin (POST /api/pins) DOES need the live machine to read the
      // bytes, so it lives inside handleApi instead. Every branch authorizes
      // with the already-computed `viewer`.
      // GET/PATCH/DELETE are machine-independent (they read the pin index, not
      // the origin machine), so they're handled here. POST /api/pins is NOT
      // intercepted — it needs the live machine's bytes and falls through to
      // handleApi below.
      if (url.pathname === "/api/pins" && req.method !== "POST") {
        if (req.method === "GET") {
          sendJson(res, 200, { pins: await listPins(viewer) });
          return;
        }
        const pinId = url.searchParams.get("id") || "";
        if (req.method === "PATCH") {
          const body = await readJsonBody(req);
          try {
            const { pin, persisted } =
              typeof body.name === "string"
                ? await renamePin(pinId, viewer, body.name)
                : await updateShare(pinId, viewer, body.share);
            sendJson(res, 200, { pin: publicPinView(pin), persisted });
          } catch (error) {
            sendJson(res, error.status || 400, { error: error.message });
          }
          return;
        }
        if (req.method === "DELETE") {
          try {
            const result = await deletePin(pinId, viewer, { storage: ARTIFACT_STORAGE });
            sendJson(res, 200, { ok: true, ...result });
          } catch (error) {
            sendJson(res, error.status || 400, { error: error.message });
          }
          return;
        }
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      // Comments on a pin (keyed by the pin's share token). Visibility + write
      // access are inherited from the pin (canSeePin), enforced inside the
      // comments module. Grouped by pin family so they survive new versions.
      if (url.pathname === "/api/comments") {
        const token = url.searchParams.get("token") || "";
        try {
          if (req.method === "GET") {
            sendJson(res, 200, { comments: await listComments(viewer, token) });
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const comment = await addComment(viewer, token, {
              aid: body.aid,
              text: body.text,
              anchor: body.anchor,
            });
            sendJson(res, 200, { comment });
            return;
          }
          if (req.method === "DELETE") {
            const id = url.searchParams.get("id") || "";
            await deleteComment(viewer, token, id);
            sendJson(res, 200, { ok: true });
            return;
          }
          sendJson(res, 405, { error: "Method not allowed" });
        } catch (error) {
          sendJson(res, error.status || 400, { error: error.message });
        }
        return;
      }

      // Shareable serve link. The user-visible path is the short `/pin?token=…`;
      // `/api/pin` is kept as an alias so links shared before the rename still
      // work. Because `/pin` is NOT under `/api/`, an unauthenticated hit is
      // redirected to the login flow by the auth gate above (with returnTo back
      // to the pin) rather than getting a JSON 401.
      //
      // Re-checks the share scope on every request (so a re-scope/unpin takes
      // effect immediately), then serves the artifact. A markdown pin RENDERS to
      // a styled HTML page by default (with the owner's pin-management overlay);
      // `?raw=1` serves the source text and `?dl=1` downloads it. Non-markdown is
      // streamed (local) or 302-redirected to a presigned URL (cloud, presign).
      if (req.method === "GET" && (url.pathname === "/pin" || url.pathname === "/api/pin")) {
        const token = url.searchParams.get("token") || "";
        const result = await servePin(viewer, token, {
          storage: ARTIFACT_STORAGE,
          dl: url.searchParams.get("dl") === "1",
          raw: url.searchParams.get("raw") === "1",
          renderMarkdown: renderMarkdownPage,
        });
        if (result.status === 302) {
          sendRedirect(res, result.redirect);
          return;
        }
        if (result.status !== 200) {
          sendJson(res, result.status, { error: result.error });
          return;
        }
        res.writeHead(200, result.headers);
        res.end(result.body);
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        if (hub) {
          if (req.method === "GET" && url.pathname === "/api/machines") {
            sendJson(res, 200, hub.listMachines(viewer));
            return;
          }
          // Cross-machine attention sweep: per-window turn/waitingForInput/
          // contentHash for every online machine this user can access, so the
          // client's "needs you" pill/title/favicon span the full visible set.
          // One request per poll regardless of machine count. The client applies
          // its own (local) unread comparison against contentHash.
          if (req.method === "GET" && url.pathname === "/api/attention") {
            const online = hub.listMachines(viewer);
            const machines = await Promise.all(
              online.map(async (machine) => {
                let windows = [];
                try {
                  windows = await withBackend(
                    hub.backendFor(viewer, machine.id),
                    () => collectMachineAttention(),
                  );
                } catch {
                  windows = []; // machine hiccup — skip it this tick
                }
                return { machineId: machine.id, hostname: machine.hostname, windows };
              }),
            );
            sendJson(res, 200, { machines });
            return;
          }
          if (url.pathname === "/api/health") {
            sendJson(res, 200, {
              ok: true,
              revision: APP_REVISION,
              connectorVersion: CONNECTOR_VERSION,
            });
            return;
          }
          // Command Center spans every online machine this user can access.
          // New connectors publish cached inventory over their WebSocket, so a
          // browser refresh reads controller state instead of fanning out tmux
          // scans. Older connectors fall back to the old live RPC path, but
          // failures are returned as machine inventory errors rather than
          // pretending that "failed to observe" means "zero agents".
          if (req.method === "GET" && url.pathname === "/api/command-center") {
            const online = hub.listMachines(viewer);
            const requestedMachineId =
              req.headers["x-machine-id"] || url.searchParams.get("machineId");
            if (requestedMachineId) {
              const machine = online.find((item) =>
                commandCenterMachineMatches(item, requestedMachineId),
              );
              if (!machine || !hub.hasMachine(viewer, requestedMachineId)) {
                sendJson(res, 503, { error: `Machine ${requestedMachineId} is offline` });
                return;
              }
              const result = await commandCenterResultForMachine(hub, viewer, machine);
              observeCommandCenterAgentsForNtfy(result.machines, result.agents);
              sendJson(res, 200, result);
              return;
            }
            const results = await Promise.all(
              online.map((machine) => commandCenterResultForMachine(hub, viewer, machine)),
            );
            const machines = results.flatMap((result) => result.machines);
            const agents = results.flatMap((result) => result.agents);
            observeCommandCenterAgentsForNtfy(machines, agents);
            sendJson(res, 200, { machines, agents });
            return;
          }
          const machineId =
            req.headers["x-machine-id"] ||
            url.searchParams.get("machineId") ||
            hub.soleMachineId(viewer);
          if (!machineId) {
            sendJson(res, 400, {
              error: "machineId is required (multiple machines online)",
            });
            return;
          }
          if (!hub.hasMachine(viewer, machineId)) {
            sendJson(res, 503, { error: `Machine ${machineId} is offline` });
            return;
          }
          await withBackend(hub.backendFor(viewer, machineId), () =>
            withRequestMux(requestMux(req, url), () =>
              withPinViewer(viewer, () =>
                withVoiceUser(userId, () => handleApi(req, res, url)),
              ),
            ),
          );
          return;
        }
        await withRequestMux(requestMux(req, url), () =>
          withPinViewer(viewer, () =>
            withVoiceUser(userId, () => handleApi(req, res, url)),
          ),
        );
        return;
      }

      await serveStatic(req, res, url);
    } catch (error) {
      const status = error.status || 500;
      logRequestError(req, url, status, error);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, status, {
        error: error.message || "Internal server error",
      });
    }
  });

  if (IS_HUB_MODE) {
    const { createHub } = await import("./lib/hub.mjs");
    hub = createHub(server, {
      logEvent: logServerEvent,
      authenticateAgent: MODE.kind === "controller"
        ? authenticateAgent
        : () => String(process.env.TMUX_MOBILE_USER || "default"),
      superAdminEmails: splitCsv(process.env.SUPER_ADMIN_EMAILS),
      currentRevision: APP_REVISION,
      expectedRevision: CONNECTOR_EXPECTED_REVISION,
      updateRef: CONNECTOR_UPDATE_REF,
      updateScriptUrl: CONNECTOR_UPDATE_SCRIPT_URL,
      requiredConnectorVersion: CONNECTOR_VERSION,
      machineAliases: MACHINE_ALIASES,
    });
  }
  stopAgentRoundWatcher = startAgentRoundNtfyWatcher({ hub });

  server.listen(PORT, HOST, () => {
    console.log(`tmux ${MODE.kind} listening at http://${HOST}:${PORT}`);
  });

  // Graceful shutdown. Cloud Run sends SIGTERM to an old instance before it is
  // torn down during a revision rollout; closing agent WebSockets here makes
  // each agent reconnect immediately (onto the new revision) instead of staying
  // pinned to this dying instance until its socket eventually dies on its own.
  let shuttingDown = false;
  function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logServerEvent("controller_shutdown", {
      signal,
      revision: APP_REVISION,
      message: "Closing agent connections so agents reconnect to the new revision.",
    });
    stopAgentRoundWatcher();
    try {
      hub?.shutdown();
    } catch {}
    server.close(() => process.exit(0));
    // Don't wait forever for lingering keep-alive sockets to drain.
    setTimeout(() => process.exit(0), 5_000).unref?.();
  }
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

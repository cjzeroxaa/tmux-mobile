// Pinned-artifact metadata store.
//
// A "pin" is a durable snapshot of a viewed file: the bytes are written to
// artifact storage (lib/artifact-storage.mjs) and a small record here records
// who pinned it, what it was, and who it is shared with. The record carries an
// unguessable token used to route the shareable serve URL.
//
// Records live in a pluggable PinIndex backend (lib/pin-index.mjs) — memory
// (default, zero infra), file (local JSON), or firestore (durable, per-document,
// concurrent-safe) — registered once at startup via setPinIndex(). Mutations are
// per-RECORD upserts/deletes rather than whole-file rewrites, so concurrent
// changes touch different documents instead of racing on one blob. Records are
// sanitized on read here (this module owns the record shape), so a malformed
// stored record can't inject anything dangerous.
//
// withPinViewer() (an AsyncLocalStorage scope) lets the deep POST /api/pins call
// site read the authenticated viewer. Pins are keyed by id (not partitioned by
// user) because they are queried ACROSS owners for sharing — visibility is a
// predicate, not a per-user partition.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, randomBytes, createHash } from "node:crypto";

import { contentKey } from "./artifact-storage.mjs";

const SHARE_SCOPES = new Set(["private", "users", "all"]);
const DEFAULT_USER = "default";
const viewerStore = new AsyncLocalStorage();

// Run `fn` with `viewer` as the active pin viewer for everything it (a)waits on.
// The request layer wraps handler invocations in this so createPin() can read
// the authenticated identity at a deep call site (mirrors withVoiceUser).
export function withPinViewer(viewer, fn) {
  return viewerStore.run(normalizeViewer(viewer), fn);
}

function activeViewer(explicit) {
  return explicit ? normalizeViewer(explicit) : viewerStore.getStore() || syntheticViewer();
}

function syntheticViewer() {
  return { userId: DEFAULT_USER, email: DEFAULT_USER, hd: "" };
}

// Lowercase + shape an identity the same way lib/hub.mjs normalizeUser does, so
// the pin visibility model lines up exactly with machine access control.
function normalizeViewer(input) {
  if (!input) return syntheticViewer();
  if (typeof input === "string") {
    const id = input.trim().toLowerCase() || DEFAULT_USER;
    return { userId: id, email: id, hd: "" };
  }
  const email = String(input.email || input.userId || "").trim().toLowerCase();
  const userId = String(input.userId || email || DEFAULT_USER).trim().toLowerCase();
  return {
    userId: userId || DEFAULT_USER,
    email: email || userId || DEFAULT_USER,
    hd: String(input.hd || input.hostedDomain || "").trim().toLowerCase(),
  };
}

// Make a basename safe for display and a Content-Disposition filename: strip
// path bits and quotes/control chars. Mirrors server.mjs sanitizeFilename.
function sanitizeName(name) {
  return (
    String(name || "file")
      .replace(/^.*[/\\]/, "") // basename only
      .replace(/["\r\n]/g, "")
      .replace(/[\x00-\x1f]/g, "")
      .slice(0, 255) || "file"
  );
}

function normalizeShare(input) {
  const scope = SHARE_SCOPES.has(input?.scope) ? input.scope : "private";
  let users = [];
  if (scope === "users" && Array.isArray(input?.users)) {
    users = [
      ...new Set(
        input.users
          .map((u) => String(u || "").trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
  }
  return { scope, users };
}

// A token is unguessable routing for the share link — base64url, no padding.
function isTokenShaped(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,}$/.test(value);
}

// Group key for "the same artifact being re-pinned": owner + source machine +
// source path. Re-pinning the same path keeps the family; changed content within
// the family makes a new version.
function familyKey(ownerId, sourceMachineId, sourcePath) {
  return createHash("sha256")
    .update(`${ownerId}${sourceMachineId || ""}${sourcePath || ""}`)
    .digest("hex")
    .slice(0, 24);
}

// ---------------------------------------------------------------------------
// Index (record-level, pluggable — see lib/pin-index.mjs).
//
// The pin INDEX (mutable metadata records) is kept separate from the artifact
// BYTES (lib/artifact-storage.mjs). Records live in a pluggable PinIndex backend
// — memory (default, zero infra), file (local JSON), or firestore (durable,
// per-document, concurrent-safe) — registered once at startup via setPinIndex().
//
// Every mutation is a per-RECORD put/delete (no whole-file rewrite, so concurrent
// mutations touch different documents instead of racing on one blob). Reads go
// through the index and are sanitized here (defense in depth) before use. Index
// I/O is async, so the read accessors (listPins / getPinById / getPinByToken /
// servePin) are async too.
//
// Writes are best-effort: a failure surfaces as persisted:false and is logged by
// the caller, never crashing the request.
// ---------------------------------------------------------------------------

let pinIndex = null; // registered PinIndex backend

// Register the PinIndex backend. Call once at startup before serving requests.
export function setPinIndex(index) {
  pinIndex = index || null;
}

// Lazily fall back to an in-memory index if none was registered (keeps unit
// tests and any odd call path working without exploding).
function requireIndex() {
  if (!pinIndex) {
    // Local import to avoid a load-order cycle; memory index is sync to build.
    throw new Error("pin index not initialized — call setPinIndex() at startup");
  }
  return pinIndex;
}

// Optional startup warm-up (drivers may no-op). Never throws.
export async function hydratePins() {
  try {
    await requireIndex().load();
  } catch {
    // best-effort warm-up
  }
}

// Drop a record that is missing the fields the serve path needs (id, storageKey,
// sha256, token); coerce share scope to the allowlist; re-basename the name.
function sanitizeRecord(id, record) {
  if (!record || typeof record !== "object") return null;
  const pinId = String(record.id || id || "");
  if (!pinId) return null;
  if (typeof record.storageKey !== "string" || !record.storageKey) return null;
  if (!/^[0-9a-f]{64}$/.test(String(record.sha256 || ""))) return null;
  if (!isTokenShaped(record.token)) return null;
  return {
    id: pinId,
    ownerId: String(record.ownerId || "").toLowerCase(),
    ownerEmail: String(record.ownerEmail || "").toLowerCase(),
    ownerHd: String(record.ownerHd || "").toLowerCase(),
    name: sanitizeName(record.name),
    ext: typeof record.ext === "string" ? record.ext : "",
    contentType:
      typeof record.contentType === "string" && record.contentType
        ? record.contentType
        : "application/octet-stream",
    size: Number.isFinite(record.size) ? record.size : 0,
    sha256: String(record.sha256).toLowerCase(),
    storageKey: String(record.storageKey),
    storageKind: String(record.storageKind || "local"),
    sourcePath: String(record.sourcePath || ""),
    sourceMachineId: String(record.sourceMachineId || ""),
    kind: String(record.kind || "other"),
    share: normalizeShare(record.share),
    token: String(record.token),
    family: String(record.family || ""),
    version: Number.isFinite(record.version) && record.version > 0 ? record.version : 1,
    createdAt: Number.isFinite(record.createdAt) ? record.createdAt : 0,
    updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
  };
}

// Persist one record (upsert) to the index. Best-effort: resolves true on
// success, false on failure (never rejects) so the caller can report
// persisted:false without crashing the request.
async function persistRecord(record) {
  try {
    await requireIndex().put(record);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Visibility — mirrors lib/hub.mjs canAccessMachine.
// ---------------------------------------------------------------------------

export function canSeePin(viewerInput, pin) {
  const viewer = normalizeViewer(viewerInput);
  if (!pin) return false;
  if (viewer.userId && viewer.userId === pin.ownerId) return true; // owner
  switch (pin.share.scope) {
    case "all":
      return true; // any logged-in viewer
    case "users":
      return Boolean(viewer.email && pin.share.users.includes(viewer.email));
    case "private":
    default:
      return false;
  }
}

function isOwner(viewerInput, pin) {
  const viewer = normalizeViewer(viewerInput);
  return Boolean(pin && viewer.userId && viewer.userId === pin.ownerId);
}

// ---------------------------------------------------------------------------
// Public view (what the API returns) + shareable URL.
// ---------------------------------------------------------------------------

// User-visible share link. Short `/pin?token=…` (not `/api/pin`) so it reads
// cleanly AND so an unauthenticated visitor is redirected to login by the auth
// gate (which only JSON-401s `/api/*` paths). `/api/pin` still works as an alias.
export function pinShareUrl(pin) {
  return `/pin?token=${encodeURIComponent(pin.token)}`;
}

// `viewer` is optional; when supplied, the view carries an `owned` flag so the
// client can show owner-only controls (re-scope / unpin) without learning the
// viewer's own identity.
export function publicPinView(pin, viewer) {
  return {
    id: pin.id,
    name: pin.name,
    ext: pin.ext,
    contentType: pin.contentType,
    kind: pin.kind,
    size: pin.size,
    sha256: pin.sha256,
    ownerEmail: pin.ownerEmail,
    owned: viewer ? isOwner(viewer, pin) : undefined,
    sourcePath: pin.sourcePath,
    sourceMachineId: pin.sourceMachineId,
    share: { scope: pin.share.scope, users: [...pin.share.users] },
    family: pin.family,
    version: pin.version,
    createdAt: pin.createdAt,
    updatedAt: pin.updatedAt,
    shareUrl: pinShareUrl(pin),
  };
}

// ---------------------------------------------------------------------------
// Core operations.
// ---------------------------------------------------------------------------

// Read every record from the index, sanitized (drops malformed records). The
// in-memory/file drivers return instantly; firestore does one collection read.
// Callers filter/sort in JS — the pin set is small.
async function allRecords() {
  const raw = await requireIndex().all();
  const clean = [];
  for (const r of raw) {
    const safe = sanitizeRecord(r?.id, r);
    if (safe) clean.push(safe);
  }
  return clean;
}

// Read one record by id, sanitized, or null.
async function recordById(id) {
  const r = await requireIndex().get(String(id || ""));
  return r ? sanitizeRecord(r.id, r) : null;
}

// Create (or dedup to) a pin for `bytes`. Content-addressed: the same bytes
// re-pinned for the same source (family) reuse the existing record; changed
// bytes create a new version. `now` is injectable for deterministic tests.
//
// Returns { pin, deduped, persisted }. `persisted` is false when the index write
// failed (in-memory record still returned) — never throws for that case.
export async function createPin(
  { viewer, bytes, name, contentType, ext, kind, sourcePath, sourceMachineId, share } = {},
  { storage, now = Date.now } = {},
) {
  if (!storage) throw new Error("createPin requires a storage driver");
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const v = activeViewer(viewer);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const family = familyKey(v.userId, sourceMachineId, sourcePath);
  const records = await allRecords();

  // Dedup: an existing pin in the same family with the same content → reuse.
  const existing = records.find(
    (p) => p.family === family && p.sha256 === sha256 && p.ownerId === v.userId,
  );
  if (existing) {
    let persisted = true;
    if (share) {
      existing.share = normalizeShare(share);
      existing.updatedAt = now();
      persisted = await persistRecord(existing);
    }
    return { pin: existing, deduped: true, persisted };
  }

  // New content (or first pin for this source) → write bytes + new version.
  const safeExt = typeof ext === "string" && ext ? ext : "";
  const storageKey = contentKey(sha256, safeExt);
  await storage.put(storageKey, buffer, { contentType });

  const version =
    records.filter((p) => p.family === family).reduce((max, p) => Math.max(max, p.version), 0) + 1;
  const ts = now();
  const pin = sanitizeRecord(randomUUID(), {
    id: randomUUID(),
    ownerId: v.userId,
    ownerEmail: v.email,
    ownerHd: v.hd,
    name: sanitizeName(name),
    ext: safeExt,
    contentType: contentType || "application/octet-stream",
    size: buffer.length,
    sha256,
    storageKey,
    storageKind: storage.kind || "local",
    sourcePath: sourcePath || "",
    sourceMachineId: sourceMachineId || "",
    kind: kind || "other",
    share: normalizeShare(share),
    token: randomBytes(24).toString("base64url"),
    family,
    version,
    createdAt: ts,
    updatedAt: ts,
  });

  const persisted = await persistRecord(pin);
  return { pin, deduped: false, persisted };
}

// All pins the viewer is allowed to see, newest first.
export async function listPins(viewer) {
  const records = await allRecords();
  return records
    .filter((pin) => canSeePin(viewer, pin))
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1))
    .map((pin) => publicPinView(pin, viewer));
}

// Raw record for the serve route to authorize. Token is routing, not authz —
// the caller still checks canSeePin(). A token lookup scans the index (the pin
// set is small); doc-id lookups go straight to get().
export async function getPinByToken(token) {
  if (!isTokenShaped(token)) return null;
  const records = await allRecords();
  return records.find((p) => p.token === token) || null;
}

export async function getPinById(id) {
  return recordById(id);
}

// Owner-only. Validates the scope; normalizes user emails. Throws { status:403 }
// for a non-owner, { status:404 } for unknown, { status:400 } for a bad scope.
export async function updateShare(pinId, viewer, share, { now = Date.now } = {}) {
  const pin = await recordById(pinId);
  if (!pin) {
    const e = new Error("Pin not found");
    e.status = 404;
    throw e;
  }
  if (!isOwner(viewer, pin)) {
    const e = new Error("Only the owner can change sharing");
    e.status = 403;
    throw e;
  }
  if (!share || !SHARE_SCOPES.has(share.scope)) {
    const e = new Error(`Invalid share scope. Allowed: ${[...SHARE_SCOPES].join(", ")}`);
    e.status = 400;
    throw e;
  }
  pin.share = normalizeShare(share);
  pin.updatedAt = now();
  const persisted = await persistRecord(pin);
  return { pin, persisted };
}

// Owner-only. Removes the record (which instantly revokes every share — the
// token is gone) and deletes the stored object ONLY when no other pin/version
// still references that content-addressed key (refcount). Throws like above.
export async function deletePin(pinId, viewer, { storage } = {}) {
  const pin = await recordById(pinId);
  if (!pin) {
    const e = new Error("Pin not found");
    e.status = 404;
    throw e;
  }
  if (!isOwner(viewer, pin)) {
    const e = new Error("Only the owner can unpin");
    e.status = 403;
    throw e;
  }
  const { storageKey } = pin;
  await requireIndex().delete(pin.id);

  // Refcount the content-addressed blob across the remaining records.
  const stillReferenced = (await allRecords()).some((p) => p.storageKey === storageKey);
  if (!stillReferenced && storage) {
    await storage.delete(storageKey);
  }
  return { deleted: true, persisted: true, storageDeleted: !stillReferenced };
}

// Descriptor handed to the markdown renderer so the served page can embed a
// pin-management overlay. `owned` gates the owner-only controls; the renderer
// must NOT show share/unpin controls to a non-owner.
function manageDescriptor(viewer, pin) {
  return {
    id: pin.id,
    token: pin.token,
    name: pin.name,
    owned: isOwner(viewer, pin),
    share: { scope: pin.share.scope, users: [...pin.share.users] },
    shareUrl: pinShareUrl(pin),
  };
}

// Pure serve helper so the HTTP route stays thin and unit-testable. Returns one
// of: { status, body, headers } | { status, redirect } | { status, error }.
//
// Markdown pins RENDER to a styled HTML page by default (so a shared link "just
// works" for the recipient); `raw:true` serves the source text instead, and
// `dl:true` forces a download of the source. `renderMarkdown(name, text,
// truncated, managePin)` receives a manage descriptor so the rendered page can
// host the owner's pin-control overlay (change sharing / unpin / copy link).
export async function servePin(
  viewer,
  token,
  { storage, dl = false, raw = false, ttlSeconds, renderMarkdown } = {},
) {
  const pin = await getPinByToken(token);
  if (!pin) return { status: 404, error: "Pin not found" };
  // Re-check scope on every request so a re-scope/unpin takes effect immediately.
  if (!canSeePin(viewer, pin)) return { status: 403, error: "Not shared with you" };

  const filename = sanitizeName(pin.name);
  // A markdown pin is rendered to HTML unless the caller explicitly wants the
  // raw source (raw=1) or a download (dl=1).
  const renderMd =
    pin.kind === "markdown" && !raw && !dl && typeof renderMarkdown === "function";

  // Cloud driver in presign mode: redirect to a short-lived presigned URL (bytes
  // never touch this process). Rendering markdown forces the proxy path so the
  // renderer can run over the bytes here.
  if (storage && storage.servesDirectly() && !renderMd) {
    const url = await storage.url(pin.storageKey, {
      contentType: pin.contentType,
      filename,
      ttlSeconds,
    });
    if (url) return { status: 302, redirect: url };
    // Fall through to proxy if the driver couldn't sign a URL.
  }

  const got = storage ? await storage.get(pin.storageKey) : null;
  if (!got) return { status: 404, error: "Artifact bytes are gone" };

  if (renderMd) {
    const html = renderMarkdown(
      pin.name,
      got.bytes.toString("utf8"),
      false,
      manageDescriptor(viewer, pin),
    );
    return {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
      },
      body: Buffer.from(html),
    };
  }

  // A pinned HTML artifact is arbitrary, possibly-hostile content served from a
  // cookie-bearing origin. Sandbox it (opaque origin: scripts may run, but it
  // can't read this origin's cookies/storage or call its APIs) unless it's being
  // downloaded as an attachment (which never executes). nosniff stops a non-HTML
  // type being reinterpreted as HTML.
  const isHtml = /^text\/html\b/i.test(pin.contentType || "");
  const headers = {
    "content-type": pin.contentType,
    "content-disposition": `${dl ? "attachment" : "inline"}; filename="${filename}"`,
    "content-length": String(got.bytes.length),
    // private/no-store: scope can change, so never let a shared cache hold a
    // now-private artifact.
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
  if (isHtml && !dl) {
    headers["content-security-policy"] = "sandbox allow-scripts allow-popups allow-forms";
  }
  return { status: 200, headers, body: got.bytes };
}

// Test/reset hook: drop the registered index so a test can re-register a fresh
// backend. (There is no in-process cache anymore — records live in the index.)
export function _resetPinsCache() {
  pinIndex = null;
}

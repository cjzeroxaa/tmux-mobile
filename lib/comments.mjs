// Comments on pinned artifacts. A comment is anchored to a pin FAMILY (so it
// survives new versions) plus a block content hash (aid) within the rendered
// doc. Visibility is inherited from the pin: whoever can see the pin (canSeePin:
// owner / specific users / org / all) can read and add comments. The mutable
// records live in a pluggable store (lib/comment-index.mjs); this module is the
// validation + authorization + public-view seam, mirroring lib/pins.mjs.

import { randomUUID } from "node:crypto";
import { canSeePin, getPinByToken } from "./pins.mjs";

const MAX_TEXT = 4000;

let index = null;
export function setCommentIndex(next) {
  index = next;
}

function err(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function normalizeViewer(input) {
  if (!input) return { userId: "", email: "", hd: "" };
  if (typeof input === "string") {
    const id = input.trim().toLowerCase();
    return { userId: id, email: id, hd: "" };
  }
  const email = String(input.email || input.userId || "").trim().toLowerCase();
  const userId = String(input.userId || email).trim().toLowerCase();
  return {
    userId,
    email,
    hd: String(input.hd || input.hostedDomain || "").trim().toLowerCase(),
  };
}

// Token is routing; canSeePin is the actual authz. Throws 404 (unknown pin) or
// 403 (viewer can't see it).
async function requireVisiblePin(viewer, token) {
  const pin = await getPinByToken(token);
  if (!pin) throw err(404, "Pin not found");
  if (!canSeePin(viewer, pin)) throw err(403, "Not allowed");
  return pin;
}

function sanitize(c) {
  return {
    family: String(c?.family || ""),
    id: String(c?.id || ""),
    aid: String(c?.aid || ""),
    anchor: c?.anchor && typeof c.anchor === "object" ? c.anchor : null,
    text: String(c?.text || ""),
    status: String(c?.status || "open"),
    authorId: String(c?.authorId || "").toLowerCase(),
    authorEmail: String(c?.authorEmail || "").toLowerCase(),
    authorHd: String(c?.authorHd || "").toLowerCase(),
    createdAt: Number(c?.createdAt || 0),
    updatedAt: Number(c?.updatedAt || 0),
  };
}

// What the API returns — drops author internal ids, adds an `owned` flag.
function publicComment(c, viewer) {
  const v = normalizeViewer(viewer);
  return {
    id: c.id,
    aid: c.aid || "",
    anchor: c.anchor || null,
    text: c.text || "",
    status: c.status || "open",
    authorEmail: c.authorEmail || "",
    owned: Boolean(v.userId && v.userId === c.authorId),
    createdAt: c.createdAt || 0,
    updatedAt: c.updatedAt || 0,
  };
}

export async function listComments(viewer, token) {
  if (!index) return [];
  const pin = await requireVisiblePin(viewer, token);
  const list = await index.byFamily(pin.family);
  return list
    .map(sanitize)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .map((c) => publicComment(c, viewer));
}

export async function addComment(
  viewer,
  token,
  { aid = "", text = "", anchor = null } = {},
  { now = Date.now } = {},
) {
  if (!index) throw err(503, "Comments unavailable");
  const v = normalizeViewer(viewer);
  if (!v.userId) throw err(401, "Login required");
  const body = String(text || "").trim();
  if (!body) throw err(400, "Comment text is required");
  if (body.length > MAX_TEXT) throw err(400, `Comment too long (max ${MAX_TEXT} chars)`);
  const pin = await requireVisiblePin(viewer, token);
  const ts = now();
  const record = {
    family: pin.family,
    id: randomUUID(),
    aid: String(aid || ""),
    anchor: anchor && typeof anchor === "object" ? anchor : null,
    text: body,
    status: "open",
    authorId: v.userId,
    authorEmail: v.email,
    authorHd: v.hd,
    createdAt: ts,
    updatedAt: ts,
  };
  await index.put(record);
  return publicComment(record, viewer);
}

// Author can delete their own; the pin owner can delete any on their pin.
export async function deleteComment(viewer, token, commentId) {
  if (!index) throw err(503, "Comments unavailable");
  const v = normalizeViewer(viewer);
  const pin = await requireVisiblePin(viewer, token);
  const existing = await index.get(pin.family, commentId);
  if (!existing) throw err(404, "Comment not found");
  const isAuthor = v.userId && v.userId === String(existing.authorId || "").toLowerCase();
  const isPinOwner = v.userId && v.userId === pin.ownerId;
  if (!isAuthor && !isPinOwner) throw err(403, "Not allowed");
  await index.delete(pin.family, commentId);
  return { ok: true };
}

// Set a comment's status (agent read-back stamps ✅ applied / 🟡 partial / ❓).
// Pin owner only — that's whose agent produced the doc. Used by the connector
// read-back path later.
export async function setCommentStatus(viewer, token, commentId, status, { now = Date.now } = {}) {
  if (!index) throw err(503, "Comments unavailable");
  const v = normalizeViewer(viewer);
  const allowed = new Set(["open", "applied", "partial", "question", "resolved"]);
  if (!allowed.has(status)) throw err(400, "Invalid status");
  const pin = await requireVisiblePin(viewer, token);
  if (!v.userId || v.userId !== pin.ownerId) throw err(403, "Only the pin owner can set status");
  const existing = await index.get(pin.family, commentId);
  if (!existing) throw err(404, "Comment not found");
  const updated = { ...sanitize(existing), status, updatedAt: now() };
  await index.put(updated);
  return publicComment(updated, viewer);
}

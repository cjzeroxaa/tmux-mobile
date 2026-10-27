import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const UPLOAD_TTL_SECONDS = 30 * 60;
export const DOWNLOAD_TTL_SECONDS = 2 * 60 * 60;
export const TEMPORARY_UPLOAD_PREFIX = "temporary-uploads/";
export const MAX_DIRECT_UPLOAD_BYTES = 5 * 1024 ** 3; // S3 single-PUT limit.

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const ownerKey = viewer => {
  if (!viewer?.userId) throw fail(401, "Login required");
  return createHash("sha256").update(viewer.userId).digest("hex");
};

export function createTemporaryUploads({ storage, secret, now = Date.now }) {
  const signingKey = secret && createHmac("sha256", secret).update("tmax-temporary-uploads-v1").digest();
  const available = () => {
    if (!storage?.signUpload || !storage?.stat) throw fail(501, "Direct uploads are unavailable on this server", "direct_upload_unavailable");
    if (!signingKey) throw fail(503, "File upload signing is unavailable");
  };
  const seconds = () => Math.floor(now() / 1000);
  const sign = payload => {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${createHmac("sha256", signingKey).update(body).digest("base64url")}`;
  };
  const verify = (token, kind, allowExpired = false) => {
    if (!signingKey || typeof token !== "string" || token.length > 4096) throw fail(404, "File link is unavailable");
    const parts = token.split(".");
    if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw fail(404, "File link is unavailable");
    const expected = createHmac("sha256", signingKey).update(parts[0]).digest();
    const supplied = Buffer.from(parts[1], "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw fail(404, "File link is unavailable");
    let value;
    try { value = JSON.parse(Buffer.from(parts[0], "base64url").toString()); } catch { throw fail(404, "File link is unavailable"); }
    if (value.kind !== kind || !Number.isSafeInteger(value.exp) ||
        !/^[a-f0-9]{64}$/.test(value.owner) || !/^[a-f0-9-]{36}$/.test(value.id)) throw fail(404, "File link is unavailable");
    if (!allowExpired && value.exp <= seconds()) throw fail(410, kind === "upload" ? "Upload authorization expired. Select the file again." : "This file link has expired.");
    return value;
  };
  const key = value => `${TEMPORARY_UPLOAD_PREFIX}${value.owner}/${value.id}`;

  return {
    async begin(viewer, input) {
      const owner = ownerKey(viewer);
      available();
      const name = String(input?.name || "upload").toWellFormed().normalize("NFC").split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, "").trim();
      const size = input?.size;
      const contentType = String(input?.contentType || "application/octet-stream");
      if (!name || name.length > 240) throw fail(400, "Choose a filename between 1 and 240 characters");
      if (!Number.isSafeInteger(size) || size <= 0) throw fail(400, "The selected file is empty or its size is unavailable");
      if (size > MAX_DIRECT_UPLOAD_BYTES) throw fail(413, "Direct uploads support files up to 5 GiB");
      if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(contentType) || contentType.length > 200) throw fail(400, "Invalid file type");
      const value = { kind: "upload", owner, id: randomUUID(), name, size, contentType, exp: seconds() + UPLOAD_TTL_SECONDS };
      const upload = await storage.signUpload(key(value), { size, contentType, ttlSeconds: UPLOAD_TTL_SECONDS });
      return { upload, ticket: sign(value), uploadExpiresAt: new Date(value.exp * 1000).toISOString() };
    },
    async complete(viewer, ticket, origin) {
      const owner = ownerKey(viewer);
      available();
      // S3 checks upload expiry when PUT starts. A transfer may finish later;
      // finalizing it never issues another upload URL or extends download TTL.
      const value = verify(ticket, "upload", true);
      if (value.owner !== owner) throw fail(403, "This upload belongs to another user");
      const file = await storage.stat(key(value));
      if (!file) throw fail(value.exp <= seconds() ? 410 : 409, value.exp <= seconds()
        ? "Upload authorization expired. Select the file again." : "The file has not finished uploading");
      if (file.size !== value.size || file.contentType !== value.contentType) throw fail(409, "Uploaded file does not match its metadata");
      const uploadedAt = Math.floor(Date.parse(file.modifiedAt) / 1000);
      if (!Number.isFinite(uploadedAt) || uploadedAt > seconds() + 60 || uploadedAt < value.exp - UPLOAD_TTL_SECONDS - 60) throw fail(409, "Invalid upload completion time");
      // If-None-Match makes the object immutable. Its S3 timestamp fixes expiry,
      // so retries and repeated completion calls cannot renew a download link.
      const exp = uploadedAt + DOWNLOAD_TTL_SECONDS;
      if (exp <= seconds()) throw fail(410, "This file link has expired.");
      const token = sign({ ...value, kind: "download", exp });
      return { url: `${origin}/files/${token}/${encodeURIComponent(value.name)}`, name: value.name, size: file.size, expiresAt: new Date(exp * 1000).toISOString() };
    },
    async download(token, method = "GET") {
      const value = verify(token, "download");
      available();
      return storage.url(key(value), {
        filename: value.name, contentType: value.contentType, attachment: true, method,
        ttlSeconds: Math.min(300, value.exp - seconds()),
      });
    },
  };
}

export async function handleTemporaryUploadHttp(req, res, url, { uploads, viewer, origin, readJsonBody, sendJson }) {
  const publicLink = url.pathname.startsWith("/files/");
  if (!publicLink && url.pathname !== "/api/uploads" && url.pathname !== "/api/uploads/complete") return false;
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  try {
    if (publicLink) {
      if (!["GET", "HEAD"].includes(req.method)) throw fail(405, "File links are read-only");
      const match = url.pathname.match(/^\/files\/([A-Za-z0-9_.-]+)\/[^/]+$/);
      if (!match) throw fail(404, "File link is unavailable");
      const location = await uploads.download(match[1], req.method);
      res.writeHead(307, { Location: location });
      res.end();
    } else {
      if (!viewer?.userId) throw fail(401, "Login required");
      if (req.method !== "POST") throw fail(405, "Use POST for file uploads");
      const body = await readJsonBody(req, 8192);
      const result = url.pathname === "/api/uploads"
        ? await uploads.begin(viewer, body)
        : await uploads.complete(viewer, body?.ticket, origin);
      sendJson(res, 200, result);
    }
  } catch (error) {
    const status = error.status || (error instanceof SyntaxError ? 400 : 500);
    sendJson(res, status, { error: error.status ? error.message : status === 400 ? "Invalid upload metadata" : "File storage is unavailable. Try again.", ...(error.code ? { code: error.code } : {}) });
  }
  return true;
}

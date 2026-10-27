import { createHmac, timingSafeEqual } from "node:crypto";

// Accepted only by the ASR upgrade handler. The Worker signs short-lived
// service assertions; neither its CREATE_KEY nor the assertion reaches viewers.
export function authenticateShareAsr(req, secret, now = Date.now()) {
  if (!secret || req.headers.origin) return null;
  const header = req.headers.authorization || "";
  if (typeof header !== "string" || header.length > 2048 || !header.startsWith("TMaxShareASR ")) return null;
  try {
    const [body, signature, extra] = header.slice(13).split(".");
    if (!body || !signature || extra) return null;
    const key = createHmac("sha256", secret).update("tmax-terminal-share-v1").digest("hex");
    const expected = createHmac("sha256", key).update("terminal-share-asr-v1:" + body).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const value = JSON.parse(Buffer.from(body, "base64url").toString());
    if (value.aud !== "terminal-share-asr" || typeof value.userId !== "string" || !value.userId || value.userId.length > 254 || !Number.isFinite(value.exp) || value.exp <= now || value.exp > now + 120_000) return null;
    return { userId: value.userId };
  } catch { return null; }
}

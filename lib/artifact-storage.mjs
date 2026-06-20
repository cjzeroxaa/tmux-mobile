// Pluggable artifact storage for pinned files.
//
// Pinning a viewed file snapshots its bytes into durable storage and hands back
// a stable, shareable link. The default driver writes to a local data dir so the
// "boring" single-process setup (see CLAUDE.md) keeps working with zero new
// infra. Cloud deploys can opt into GCS or S3 via env, which lets a pinned
// artifact be served even when the origin machine is offline.
//
// Selected at startup by TMUX_MOBILE_ARTIFACT_STORAGE: "local" (default) | "gcs"
// | "s3". The cloud SDKs are imported lazily (dynamic import inside the factory
// branch) so a local-only checkout that never `npm install`ed them still starts.
//
// All drivers share one interface:
//   put(key, bytes, { contentType })  -> { key, size }   write-once / idempotent
//   get(key)                          -> { bytes, contentType?, size } | null
//   delete(key)                       -> void            idempotent (ignore missing)
//   url(key, { contentType, filename, ttlSeconds }) -> string | ""
//   servesDirectly()                  -> boolean         true when url() can serve
//
// Keys are CONTENT-ADDRESSED: derived purely from the sha256 of the bytes (plus
// the source extension), never from the user-supplied path. That makes put()
// naturally idempotent — the same bytes always map to the same key — which is the
// dedup primitive the pin store builds on, and it means a key can never traverse
// outside the storage root.

import { mkdir, readFile, writeFile, unlink, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Presigned-URL lifetime for the cloud drivers. Kept short: a presigned URL
// stays valid until it expires even after the pin's share scope changes, so a
// small TTL bounds that window.
export function presignTtlSeconds(env = process.env) {
  const raw = Number(env.TMUX_MOBILE_PRESIGN_TTL_SECONDS);
  return Number.isFinite(raw) && raw >= 30 && raw <= 7 * 24 * 3600 ? raw : 300;
}

// Whether the cloud drivers should serve via a presigned redirect (offloads
// bytes to the object store) vs. PROXY the bytes through this process.
//
// Proxy is the DEFAULT and the robust choice:
//   - no per-request IAM SignBlob round-trip (on Cloud Run the runtime SA has no
//     private key, so V4 presigning calls iamcredentials.signBlob — an extra
//     network hop that fails intermittently with "Premature close" and breaks the
//     share link outright),
//   - scope revocation is immediate (no already-issued URL outliving an unpin),
//   - download needs only storage.objects.get (objectAdmin), not signBlob.
// Presign is opt-in for deployments that specifically want to offload bandwidth
// and have a signer set up (e.g. a SA private key, or a CDN in front).
export function presignEnabled(env = process.env) {
  return env.TMUX_MOBILE_ARTIFACT_PRESIGN === "1";
}

// Build the content-addressed storage key for a blob: "<shard>/<sha256><ext>".
// The two-char shard prefix keeps the local driver from piling every object into
// one giant directory. `ext` is a sanitized, dot-led extension or "".
export function contentKey(sha256, ext = "") {
  const hex = String(sha256 || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error("contentKey requires a sha256 hex digest");
  }
  const safeExt = /^\.[a-z0-9]{1,16}$/i.test(ext) ? ext.toLowerCase() : "";
  return `${hex.slice(0, 2)}/${hex}${safeExt}`;
}

// ---------------------------------------------------------------------------
// Local-disk driver (default)
// ---------------------------------------------------------------------------

function localRoot(env) {
  return (
    env.TMUX_MOBILE_ARTIFACT_DIR ||
    // Data, not config — keep it out of ~/.config (which is for settings).
    path.join(os.homedir(), ".local", "share", "tmux-mobile", "artifacts")
  );
}

function createLocalDriver(env) {
  const root = localRoot(env);
  // Resolve a key to an absolute path, refusing anything that escapes the root
  // (keys are hash-derived so this is belt-and-suspenders against a bad caller).
  function resolveKey(key) {
    const target = path.resolve(root, key);
    const rootResolved = path.resolve(root);
    if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
      throw new Error("Refusing storage key outside the artifact root");
    }
    return target;
  }
  return {
    kind: "local",
    servesDirectly() {
      return false;
    },
    async put(key, bytes, { overwrite = false } = {}) {
      const target = resolveKey(key);
      const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      // Write-once for content-addressed blobs: if the object already exists the
      // bytes are identical, so skip the rewrite (this is what makes blob put()
      // idempotent). The mutable pin index passes overwrite:true since its key is
      // fixed but its contents change.
      if (!overwrite) {
        try {
          const existing = await stat(target);
          if (existing.isFile()) return { key, size: existing.size };
        } catch {
          // ENOENT — fall through and write it.
        }
      }
      await writeFile(target, buffer, { mode: 0o600 });
      return { key, size: buffer.length };
    },
    async get(key) {
      let target;
      try {
        target = resolveKey(key);
      } catch {
        return null;
      }
      try {
        const bytes = await readFile(target);
        return { bytes, size: bytes.length };
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async delete(key) {
      let target;
      try {
        target = resolveKey(key);
      } catch {
        return;
      }
      try {
        await unlink(target);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    },
    async url() {
      // The local driver can't serve bytes without this process; the serve route
      // streams from get() instead.
      return "";
    },
  };
}

// ---------------------------------------------------------------------------
// S3-compatible driver (opt-in) — @aws-sdk/client-s3 + s3-request-presigner
// ---------------------------------------------------------------------------

async function createS3Driver(env) {
  const bucket = env.TMUX_MOBILE_S3_BUCKET;
  if (!bucket) {
    throw new Error("TMUX_MOBILE_S3_BUCKET is required for the s3 artifact driver");
  }
  const prefix = env.TMUX_MOBILE_S3_KEY_PREFIX || "";
  const ttl = presignTtlSeconds(env);
  // Lazy import so a local-only deploy without the SDK installed still boots.
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } =
    await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const client = new S3Client({
    region: env.TMUX_MOBILE_S3_REGION || env.AWS_REGION || "us-east-1",
    // Custom endpoint (R2 / MinIO / GCS XML API). forcePathStyle helps MinIO.
    ...(env.TMUX_MOBILE_S3_ENDPOINT
      ? { endpoint: env.TMUX_MOBILE_S3_ENDPOINT, forcePathStyle: true }
      : {}),
  });
  const objectKey = (key) => `${prefix}${key}`;
  const presign = presignEnabled(env);
  return {
    kind: "s3",
    servesDirectly() {
      return presign;
    },
    async put(key, bytes, { contentType } = {}) {
      const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey(key),
          Body: buffer,
          ContentType: contentType || "application/octet-stream",
        }),
      );
      return { key, size: buffer.length };
    },
    async get(key) {
      try {
        const res = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: objectKey(key) }),
        );
        const bytes = Buffer.from(await res.Body.transformToByteArray());
        return { bytes, size: bytes.length, contentType: res.ContentType };
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NoSuchKey") {
          return null;
        }
        throw error;
      }
    },
    async delete(key) {
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: objectKey(key) }),
      );
    },
    async url(key, { contentType, filename, ttlSeconds } = {}) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: objectKey(key),
          ResponseContentType: contentType || undefined,
          ResponseContentDisposition: filename
            ? `inline; filename="${filename}"`
            : undefined,
        }),
        { expiresIn: ttlSeconds || ttl },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Google Cloud Storage driver (opt-in) — @google-cloud/storage
// ---------------------------------------------------------------------------

async function createGcsDriver(env) {
  const bucketName = env.TMUX_MOBILE_GCS_BUCKET;
  if (!bucketName) {
    throw new Error("TMUX_MOBILE_GCS_BUCKET is required for the gcs artifact driver");
  }
  const prefix = env.TMUX_MOBILE_GCS_KEY_PREFIX || "";
  const ttl = presignTtlSeconds(env);
  const { Storage } = await import("@google-cloud/storage");
  // Auth via ADC / workload identity / GOOGLE_APPLICATION_CREDENTIALS.
  const storage = new Storage();
  const bucket = storage.bucket(bucketName);
  const fileFor = (key) => bucket.file(`${prefix}${key}`);
  const presign = presignEnabled(env);
  return {
    kind: "gcs",
    servesDirectly() {
      return presign;
    },
    async put(key, bytes, { contentType } = {}) {
      const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      await fileFor(key).save(buffer, {
        resumable: false,
        contentType: contentType || "application/octet-stream",
      });
      return { key, size: buffer.length };
    },
    async get(key) {
      try {
        const [bytes] = await fileFor(key).download();
        return { bytes, size: bytes.length };
      } catch (error) {
        if (error?.code === 404) return null;
        throw error;
      }
    },
    async delete(key) {
      try {
        await fileFor(key).delete();
      } catch (error) {
        if (error?.code !== 404) throw error;
      }
    },
    async url(key, { contentType, filename, ttlSeconds } = {}) {
      const [signed] = await fileFor(key).getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + (ttlSeconds || ttl) * 1000,
        responseType: contentType || undefined,
        responseDisposition: filename ? `inline; filename="${filename}"` : undefined,
      });
      return signed;
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// Build the storage driver selected by TMUX_MOBILE_ARTIFACT_STORAGE. Async
// because the cloud drivers lazily import their SDK. The local driver is sync
// internally but returned through the same async contract.
export async function createArtifactStorage(env = process.env) {
  const kind = String(env.TMUX_MOBILE_ARTIFACT_STORAGE || "local").toLowerCase();
  if (kind === "local") return createLocalDriver(env);
  if (kind === "s3") return createS3Driver(env);
  if (kind === "gcs") return createGcsDriver(env);
  throw new Error(
    `Unknown TMUX_MOBILE_ARTIFACT_STORAGE: ${kind} (expected local | gcs | s3)`,
  );
}

// Synchronous local-driver factory for tests and the boring default path.
export function createLocalArtifactStorage(env = process.env) {
  return createLocalDriver(env);
}

import { createHash } from "node:crypto";
import { MAX_TRANSCRIPT_CHUNK_BYTES } from "./protocol.mjs";

// The normal connector target is 256 KiB, but a single valid JSONL record must
// not be split. Leave room for unusually large tool-result rows while staying
// well below the transport's 100 MiB frame ceiling.
export const DEFAULT_MAX_TRANSCRIPT_CHUNK_BYTES = MAX_TRANSCRIPT_CHUNK_BYTES;

/**
 * Durable receiver for raw transcript chunks sent by a connector.
 *
 * The archive deliberately does not parse Claude/Codex JSON. It treats each
 * transcript as an ordered newline-delimited byte stream, stores immutable
 * chunks, and advances a small mutable manifest only after the chunk is
 * durable. A connector retry therefore either appends exactly at the expected
 * cursor or resolves to an idempotent ACK for an object already committed.
 */
export function createTranscriptArchive({
  storage,
  maxChunkBytes = DEFAULT_MAX_TRANSCRIPT_CHUNK_BYTES,
  logEvent = () => {},
  now = () => Date.now(),
  onChunkCommitted = null,
  readTimeoutMs = 25_000,
  maxDuplicateMetadataReads = 64,
} = {}) {
  if (!storage?.put || !storage?.get) {
    throw new Error("Transcript archive requires a storage driver with put/get");
  }
  // A connector may retry a chunk while the original request is still in
  // flight (lost/late ACK), and a following chunk may reach another socket
  // handler immediately afterwards. Serialize every manifest epoch inside this
  // process so an older request can never overwrite a newer cursor. Cloud
  // deployments must additionally keep a single writer per epoch until the
  // storage driver grows a conditional-put/CAS primitive.
  const manifestWriters = new Map();

  // Resume a bounded duplicate-membership walk on the next retry. Each entry
  // is tied to the exact committed manifest, never to an orphan object's name.
  const duplicateProgress = new Map();

  async function commitChunk({ ownerId, machineId, agentId, chunk, signal } = {}) {
    const source = normalizeSource({ ownerId, machineId, agentId, chunk });
    const decoded = decodeAndValidateChunk(chunk, maxChunkBytes);
    const keys = archiveKeys(source, decoded);
    const started = now();
    const deadline = AbortSignal.timeout(readTimeoutMs);
    const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const stats = { gets: 0, queueMs: 0 };
    const reads = { async get(key, options) {
      readSignal.throwIfAborted();
      stats.gets++;
      return abortable(storage.get(key, { ...options, signal: readSignal }), readSignal);
    } };
    let result, failure;
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          result = await serializeManifestWrite(keys.manifestKey, () => {
            readSignal.throwIfAborted();
            stats.queueMs = now() - started;
            return commitChunkUnlocked({ source, decoded, keys, reads, readSignal });
          }, readSignal);
          return result;
        } catch (error) {
          if (error?.code !== "storage_version_conflict" || attempt === 4) throw error;
        }
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      logEvent("transcript_archive_request", {
        machineId: source.machineId, agentId: source.agentId || undefined,
        agentSessionId: source.agentSessionId, sessionKey: keys.sessionKey,
        fileEpoch: source.fileEpoch, startOffset: decoded.startOffset,
        endOffsetExclusive: decoded.endOffsetExclusive,
        duplicate: result?.duplicate ?? null, gets: stats.gets,
        queueMs: stats.queueMs, ackMs: now() - started,
        code: failure?.code || failure?.name || undefined,
        cancelled: readSignal.aborted,
      });
    }
  }

  async function serializeManifestWrite(manifestKey, operation, signal) {
    const previous = manifestWriters.get(manifestKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    manifestWriters.set(manifestKey, current);
    const cleanup = () => {
      if (manifestWriters.get(manifestKey) === current) manifestWriters.delete(manifestKey);
    };
    current.then(cleanup, cleanup);
    // The caller can leave promptly, but an already-started durable commit
    // retains serialization until its writes/CAS actually finish.
    return abortable(current, signal);
  }

  async function commitChunkUnlocked({ source, decoded, keys, reads, readSignal }) {
    const manifestRecord = await readManifest(reads, keys.manifestKey);
    const manifest = manifestRecord.value;
    const expected = manifestCursor(manifest);
    if (manifest && (manifest.sessionKey !== keys.sessionKey || manifest.fileEpoch !== source.fileEpoch ||
        manifest.source?.ownerId !== source.ownerId || manifest.source?.agentKind !== source.agentKind ||
        manifest.source?.agentSessionId !== source.agentSessionId ||
        (manifest.source?.agentId || manifest.source?.machineId) !== (source.agentId || source.machineId))) {
      throw invalidManifestChain("manifest source mismatch");
    }

    // A lost ACK can make any already-committed chunk arrive again, not only
    // the most recent one. Its content-addressed key proves byte identity.
    if (
      decoded.endOffsetExclusive <= expected.committedOffset &&
      decoded.nextLineSeq <= expected.nextLineSeq
    ) {
      const committed = await inspectCommittedMetadata(
        reads, manifest, keys, decoded, duplicateProgress, maxDuplicateMetadataReads,
      );
      if (committed.conflict) {
        throw epochConflict(expected, committed.conflict);
      }
      if (committed.exact) {
        const existing = await reads.get(keys.chunkKey);
        if (!existing?.bytes || sha256(existing.bytes) !== decoded.sha256) {
          throw invalidManifestChain("missing or corrupt raw range");
        }
        return ackResult({
          source,
          decoded,
          keys,
          manifest,
          duplicate: true,
        });
      }
    }

    if (
      decoded.startOffset !== expected.committedOffset ||
      decoded.firstLineSeq !== expected.nextLineSeq
    ) {
      throw cursorMismatch(expected);
    }
    const expectedPreviousSha = String(manifest?.lastChunk?.sha256 || "");
    if (decoded.previousChunkSha256 !== expectedPreviousSha) {
      const error = new Error("Transcript chunk chain does not match the committed manifest");
      error.code = "transcript_chain_mismatch";
      error.expected = { previousChunkSha256: expectedPreviousSha };
      throw error;
    }

    // Before any write we can cancel freely. Once writing starts, finish the
    // raw/range/manifest transaction even if the client loses its connection.
    readSignal.throwIfAborted();
    await storage.put(keys.chunkKey, decoded.bytes, {
      contentType: "application/x-ndjson",
    });

    // Each immutable range points backward to the preceding range. Starting at
    // manifest.lastChunk.metadataKey, a decoder can replay the whole epoch with
    // get-only object storage; it does not need a provider-specific list API.
    const rangeMetadata = {
      version: 1,
      id: keys.chunkId,
      key: keys.chunkKey,
      metadataKey: keys.metadataKey,
      sha256: decoded.sha256,
      startOffset: decoded.startOffset,
      endOffsetExclusive: decoded.endOffsetExclusive,
      firstLineSeq: decoded.firstLineSeq,
      nextLineSeq: decoded.nextLineSeq,
      previousMetadataKey: manifest?.lastChunk?.metadataKey || null,
    };
    await storage.put(
      keys.metadataKey,
      Buffer.from(`${JSON.stringify(rangeMetadata)}\n`),
      { contentType: "application/json" },
    );

    const committedAt = new Date(now()).toISOString();
    const nextManifest = {
      version: 1,
      sessionKey: keys.sessionKey,
      source: {
        ownerId: source.ownerId,
        machineId: source.machineId,
        agentId: source.agentId,
        agentKind: source.agentKind,
        agentSessionId: source.agentSessionId,
      },
      fileEpoch: source.fileEpoch,
      committedOffset: decoded.endOffsetExclusive,
      nextLineSeq: decoded.nextLineSeq,
      lastChunk: {
        id: keys.chunkId,
        key: keys.chunkKey,
        metadataKey: keys.metadataKey,
        sha256: decoded.sha256,
        startOffset: decoded.startOffset,
        endOffsetExclusive: decoded.endOffsetExclusive,
        firstLineSeq: decoded.firstLineSeq,
        nextLineSeq: decoded.nextLineSeq,
      },
      updatedAt: committedAt,
    };
    await storage.put(
      keys.manifestKey,
      Buffer.from(`${JSON.stringify(nextManifest)}\n`),
      {
        contentType: "application/json",
        overwrite: true,
        ...(storage.conditionalWrites
          ? { ifVersion: manifestRecord.version }
          : {}),
      },
    );

    const result = ackResult({
      source,
      decoded,
      keys,
      manifest: nextManifest,
      duplicate: false,
    });
    logEvent("transcript_chunk_committed", {
      machineId: source.machineId,
      agentId: source.agentId || undefined,
      agentKind: source.agentKind,
      sessionKey: keys.sessionKey,
      fileEpoch: source.fileEpoch,
      startOffset: decoded.startOffset,
      endOffsetExclusive: decoded.endOffsetExclusive,
      firstLineSeq: decoded.firstLineSeq,
      nextLineSeq: decoded.nextLineSeq,
      bytes: decoded.bytes.length,
      storage: storage.kind || "unknown",
    });
    if (typeof onChunkCommitted === "function") {
      await onChunkCommitted({ ...result, bytes: decoded.bytes, manifest: nextManifest });
    }
    return result;
  }

  async function readEpoch(manifestKey, { manifest: snapshot, signal } = {}) {
    const manifest = snapshot || (await readManifest(storage, String(manifestKey || ""))).value;
    if (!manifest) return null;
    if (manifest.version !== 1) throw invalidManifestChain("unsupported manifest version");
    manifestCursor(manifest);
    const get = async key => {
      signal?.throwIfAborted();
      const pending = storage.get(key, { signal });
      return signal ? abortable(pending, signal) : pending;
    };
    // Enumerate names once so range metadata can be read concurrently instead
    // of paying one network round trip per link. Only the manifest's committed
    // chain is replayed; orphan uploads and concurrent appends remain excluded.
    const metadataByKey = new Map();
    const rangePrefix = manifestKey.replace(/manifest\.json$/, 'ranges/');
    const readMetadata = async key => {
      const found = await get(key);
      if (!found?.bytes) throw invalidManifestChain("missing range metadata");
      let metadata;
      try { metadata = JSON.parse(found.bytes.toString("utf8")); }
      catch { throw invalidManifestChain("invalid range metadata JSON"); }
      return metadata;
    };
    if (storage.listKeys) {
      signal?.throwIfAborted();
      const listing = storage.listKeys(rangePrefix, { signal });
      const keys = (await (signal ? abortable(listing, signal) : listing)).filter(key => {
        if (!key.startsWith(rangePrefix)) return false;
        const range = /^(\d+)-(\d+)-[a-f0-9]{64}\.json$/.exec(key.slice(rangePrefix.length));
        return range && Number(range[2]) <= manifest.committedOffset;
      });
      await readPool(keys, async key => { metadataByKey.set(key, await readMetadata(key)); });
    }
    const reversed = [];
    const visited = new Set();
    let metadataKey = manifest.lastChunk?.metadataKey || "";
    while (metadataKey) {
      signal?.throwIfAborted();
      if (visited.has(metadataKey)) throw invalidManifestChain("range metadata cycle");
      if (!metadataKey.startsWith(rangePrefix)) throw invalidManifestChain("range outside epoch");
      visited.add(metadataKey);
      const metadata = metadataByKey.get(metadataKey) || await readMetadata(metadataKey);
      validateRangeMetadata(metadata, metadataKey);
      reversed.push(metadata);
      metadataKey = metadata.previousMetadataKey || "";
    }
    const chunks = reversed.reverse();
    validateReplayContinuity(chunks, manifest);
    await readPool(chunks, async metadata => {
      const raw = await get(metadata.key);
      if (!raw?.bytes || sha256(raw.bytes) !== metadata.sha256) {
        throw invalidManifestChain("missing or corrupt raw range");
      }
      metadata.bytes = raw.bytes;
    });
    return { manifest, chunks };
  }

  return { commitChunk, readEpoch };
}

async function inspectCommittedMetadata(storage, manifest, keys, decoded, progress, maxReads) {
  const anchor = sha256(Buffer.from(JSON.stringify(manifest)));
  const progressKey = `${keys.manifestKey}:${keys.chunkId}`;
  const prior = progress.get(progressKey);
  const cursor = manifestCursor(manifest);
  const state = prior?.anchor === anchor ? prior : {
    anchor, metadataKey: manifest?.lastChunk?.metadataKey || "",
    expectedEndOffset: cursor.committedOffset, expectedNextLineSeq: cursor.nextLineSeq,
  };
  progress.delete(progressKey);
  progress.set(progressKey, state);
  while (progress.size > 128) progress.delete(progress.keys().next().value);
  const rangePrefix = keys.manifestKey.replace(/manifest\.json$/, "ranges/");
  let reads = 0;
  while (state.metadataKey) {
    if (reads++ >= maxReads) {
      throw Object.assign(new Error("Duplicate verification will continue on retry"), {
        code: "transcript_duplicate_verification_pending", status: 503,
      });
    }
    const metadataKey = state.metadataKey;
    if (!metadataKey.startsWith(rangePrefix)) throw invalidManifestChain("range outside epoch");
    const found = await storage.get(metadataKey);
    if (!found?.bytes) throw invalidManifestChain("missing range metadata");
    let metadata;
    try { metadata = JSON.parse(found.bytes.toString("utf8")); }
    catch { throw invalidManifestChain("invalid range metadata JSON"); }
    validateRangeMetadata(metadata, metadataKey);
    if (metadata.endOffsetExclusive !== state.expectedEndOffset ||
        metadata.nextLineSeq !== state.expectedNextLineSeq) {
      throw invalidManifestChain("non-contiguous replay range");
    }
    if (metadataKey === manifest.lastChunk?.metadataKey &&
        ["id", "key", "metadataKey", "sha256", "startOffset", "endOffsetExclusive", "firstLineSeq", "nextLineSeq"]
          .some(key => metadata[key] !== manifest.lastChunk[key])) {
      throw invalidManifestChain("manifest last range mismatch");
    }
    // Strictly decreasing, positive ranges make cycles impossible. Validate
    // the origin link locally; replay still validates the entire epoch.
    if ((metadata.startOffset === 0 || metadata.firstLineSeq === 0)
      ? (metadata.startOffset !== 0 || metadata.firstLineSeq !== 0 || metadata.previousMetadataKey !== null)
      : !metadata.previousMetadataKey) {
      throw invalidManifestChain("invalid range origin link");
    }
    const sameCoordinates = metadata.startOffset === decoded.startOffset &&
      metadata.endOffsetExclusive === decoded.endOffsetExclusive &&
      metadata.firstLineSeq === decoded.firstLineSeq && metadata.nextLineSeq === decoded.nextLineSeq;
    if (sameCoordinates) {
      const exact = metadataKey === keys.metadataKey && metadata.id === keys.chunkId &&
        metadata.key === keys.chunkKey && metadata.sha256 === decoded.sha256;
      if (exact && metadata.previousMetadataKey) {
        if (!metadata.previousMetadataKey.startsWith(rangePrefix)) throw invalidManifestChain("range outside epoch");
        const previousRecord = await storage.get(metadata.previousMetadataKey);
        let previous;
        try { previous = JSON.parse(previousRecord?.bytes?.toString("utf8")); }
        catch { throw invalidManifestChain("missing or invalid preceding range"); }
        validateRangeMetadata(previous, metadata.previousMetadataKey);
        if (previous.endOffsetExclusive !== metadata.startOffset ||
            previous.nextLineSeq !== metadata.firstLineSeq || previous.sha256 !== decoded.previousChunkSha256) {
          throw invalidManifestChain("preceding range mismatch");
        }
      }
      // Keep the verified membership prefix. Every retry rereads the matched
      // metadata and hashes its raw bytes; it never ACKs from the cache alone.
      return { exact, conflict: exact ? null : metadata };
    }
    if (metadata.startOffset <= decoded.startOffset) return { exact: false, conflict: null };
    state.expectedEndOffset = metadata.startOffset;
    state.expectedNextLineSeq = metadata.firstLineSeq;
    state.metadataKey = metadata.previousMetadataKey || "";
  }
  return { exact: false, conflict: null };
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function normalizeSource({ ownerId, machineId, agentId, chunk }) {
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
    throw invalidChunk("chunk object is required");
  }
  const source = {
    ownerId: boundedString(ownerId, "ownerId", 512),
    machineId: boundedString(machineId, "machineId", 256),
    agentId: optionalBoundedString(agentId, "agentId", 256),
    agentKind: boundedString(chunk.agentKind, "agentKind", 32).toLowerCase(),
    agentSessionId: boundedString(chunk.agentSessionId, "agentSessionId", 512),
    fileEpoch: boundedString(chunk.fileEpoch, "fileEpoch", 256),
  };
  if (source.agentKind !== "codex" && source.agentKind !== "claude") {
    throw invalidChunk("agentKind must be codex or claude");
  }
  return source;
}

function decodeAndValidateChunk(chunk, maxChunkBytes) {
  const startOffset = nonNegativeInteger(chunk.startOffset, "startOffset");
  const endOffsetExclusive = nonNegativeInteger(
    chunk.endOffsetExclusive,
    "endOffsetExclusive",
  );
  const firstLineSeq = nonNegativeInteger(chunk.firstLineSeq, "firstLineSeq");
  const nextLineSeq = nonNegativeInteger(chunk.nextLineSeq, "nextLineSeq");
  const claimedSha = boundedString(chunk.sha256, "sha256", 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(claimedSha)) {
    throw invalidChunk("sha256 must be 64 lowercase hex characters");
  }
  const bytes = Buffer.isBuffer(chunk.bytes)
    ? chunk.bytes
    : typeof chunk.base64 === "string" && chunk.base64
      ? Buffer.from(chunk.base64, "base64")
      : null;
  if (!bytes) {
    throw invalidChunk("chunk body is required");
  }
  if (bytes.length === 0 || bytes.length > maxChunkBytes) {
    throw invalidChunk(`chunk body must be 1-${maxChunkBytes} bytes`);
  }
  if (endOffsetExclusive - startOffset !== bytes.length) {
    throw invalidChunk("byte range does not match decoded chunk length");
  }
  if (bytes.at(-1) !== 0x0a) {
    throw invalidChunk("chunk must end at a complete newline boundary");
  }
  const newlineCount = countNewlines(bytes);
  if (nextLineSeq - firstLineSeq !== newlineCount || newlineCount < 1) {
    throw invalidChunk("line sequence range does not match newline count");
  }
  const actualSha = sha256(bytes);
  if (actualSha !== claimedSha) {
    throw invalidChunk("chunk sha256 mismatch");
  }
  const requestChunkId = String(chunk.chunkId || "").trim();
  if (requestChunkId && !/^[0-9a-f]{64}$/.test(requestChunkId)) {
    throw invalidChunk("chunkId must be 64 lowercase hex characters");
  }
  const previousChunkSha256 = String(chunk.previousChunkSha256 || "").toLowerCase();
  if (previousChunkSha256 && !/^[0-9a-f]{64}$/.test(previousChunkSha256)) {
    throw invalidChunk("previousChunkSha256 must be empty or 64 lowercase hex characters");
  }
  return {
    bytes,
    sha256: actualSha,
    startOffset,
    endOffsetExclusive,
    firstLineSeq,
    nextLineSeq,
    requestChunkId,
    previousChunkSha256,
  };
}

function archiveKeys(source, decoded) {
  const ownerPart = opaquePart(source.ownerId);
  const machinePart = opaquePart(source.agentId || source.machineId);
  const sessionKey = opaquePart(
    `${source.ownerId}\0${source.agentId || source.machineId}\0${source.agentKind}\0${source.agentSessionId}`,
  );
  const epochPart = opaquePart(source.fileEpoch);
  const base = `v1/${ownerPart}/${machinePart}/${source.agentKind}/${sessionKey}/${epochPart}`;
  const range = `${padOffset(decoded.startOffset)}-${padOffset(decoded.endOffsetExclusive)}`;
  const chunkId = sha256(
    Buffer.from(
      `${sessionKey}\0${source.fileEpoch}\0${range}\0${decoded.sha256}\0${decoded.previousChunkSha256}`,
    ),
  );
  return {
    sessionKey,
    chunkId,
    chunkKey: `${base}/chunks/${range}-${decoded.sha256}.jsonl`,
    metadataKey: `${base}/ranges/${range}-${chunkId}.json`,
    manifestKey: `${base}/manifest.json`,
  };
}

async function readManifest(storage, key) {
  const found = await storage.get(key, { withVersion: true });
  if (!found?.bytes) return { value: null, version: null };
  try {
    const parsed = JSON.parse(found.bytes.toString("utf8"));
    if (parsed?.version !== 1) throw new Error("unsupported version");
    manifestCursor(parsed);
    return { value: parsed, version: found.version ?? null };
  } catch (error) {
    const wrapped = new Error(`Invalid transcript archive manifest: ${error.message}`);
    wrapped.code = "transcript_manifest_invalid";
    throw wrapped;
  }
}

function manifestCursor(manifest) {
  if (!manifest) return { committedOffset: 0, nextLineSeq: 0 };
  return {
    committedOffset: nonNegativeInteger(manifest.committedOffset, "committedOffset"),
    nextLineSeq: nonNegativeInteger(manifest.nextLineSeq, "nextLineSeq"),
  };
}

function validateRangeMetadata(metadata, expectedKey) {
  try {
    if (!metadata || metadata.version !== 1) throw new Error("unsupported version");
    if (metadata.metadataKey !== expectedKey) throw new Error("metadata key mismatch");
    if (typeof metadata.key !== "string" || !metadata.key) throw new Error("missing raw key");
    if (!/^[0-9a-f]{64}$/.test(String(metadata.sha256 || ""))) {
      throw new Error("invalid sha256");
    }
    const startOffset = nonNegativeInteger(metadata.startOffset, "startOffset");
    const endOffsetExclusive = nonNegativeInteger(
      metadata.endOffsetExclusive,
      "endOffsetExclusive",
    );
    const firstLineSeq = nonNegativeInteger(metadata.firstLineSeq, "firstLineSeq");
    const nextLineSeq = nonNegativeInteger(metadata.nextLineSeq, "nextLineSeq");
    if (endOffsetExclusive <= startOffset || nextLineSeq <= firstLineSeq) {
      throw new Error("empty range");
    }
    if (
      metadata.previousMetadataKey !== null &&
      (typeof metadata.previousMetadataKey !== "string" ||
        !metadata.previousMetadataKey)
    ) {
      throw new Error("invalid previous metadata key");
    }
  } catch (error) {
    if (error?.code === "transcript_archive_chain_invalid") throw error;
    throw invalidManifestChain(error.message || "invalid range metadata");
  }
}

function validateReplayContinuity(chunks, manifest) {
  let committedOffset = 0;
  let nextLineSeq = 0;
  for (const chunk of chunks) {
    if (
      chunk.startOffset !== committedOffset ||
      chunk.firstLineSeq !== nextLineSeq
    ) {
      throw invalidManifestChain("non-contiguous replay range");
    }
    committedOffset = chunk.endOffsetExclusive;
    nextLineSeq = chunk.nextLineSeq;
  }
  if (
    committedOffset !== manifest.committedOffset ||
    nextLineSeq !== manifest.nextLineSeq
  ) {
    throw invalidManifestChain("replay range does not reach manifest cursor");
  }
  if (
    chunks.length > 0 &&
    chunks.at(-1).metadataKey !== manifest.lastChunk?.metadataKey
  ) {
    throw invalidManifestChain("manifest last range mismatch");
  }
}

function invalidManifestChain(message) {
  const error = new Error(`Invalid transcript archive chain: ${message}`);
  error.code = "transcript_archive_chain_invalid";
  return error;
}

function ackResult({ source, decoded, keys, manifest, duplicate }) {
  return {
    // Echo the connector's deterministic transport id so it can match this
    // durable ACK. `keys.chunkId` remains the archive's server-side identity.
    chunkId: decoded.requestChunkId || keys.chunkId,
    archiveChunkId: keys.chunkId,
    sessionKey: keys.sessionKey,
    agentKind: source.agentKind,
    agentSessionId: source.agentSessionId,
    fileEpoch: source.fileEpoch,
    committedOffset: manifest.committedOffset,
    nextLineSeq: manifest.nextLineSeq,
    chunkKey: keys.chunkKey,
    metadataKey: keys.metadataKey,
    manifestKey: keys.manifestKey,
    sha256: decoded.sha256,
    duplicate,
  };
}

function cursorMismatch(expected) {
  const error = new Error(
    `Transcript cursor mismatch; expected offset ${expected.committedOffset}, line ${expected.nextLineSeq}`,
  );
  error.code = "transcript_cursor_mismatch";
  error.expected = expected;
  return error;
}

function epochConflict(expected, committedRange) {
  const error = new Error(
    "Transcript epoch contains different committed bytes for the same range",
  );
  error.code = "transcript_epoch_conflict";
  error.expected = {
    ...expected,
    conflictingRange: {
      startOffset: committedRange.startOffset,
      endOffsetExclusive: committedRange.endOffsetExclusive,
      firstLineSeq: committedRange.firstLineSeq,
      nextLineSeq: committedRange.nextLineSeq,
      sha256: committedRange.sha256,
    },
  };
  return error;
}

function invalidChunk(message) {
  const error = new Error(`Invalid transcript chunk: ${message}`);
  error.code = "invalid_transcript_chunk";
  return error;
}

function boundedString(value, name, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || /[\0\r\n]/.test(text)) {
    throw invalidChunk(`${name} is required and must be at most ${maxLength} characters`);
  }
  return text;
}

function optionalBoundedString(value, name, maxLength) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length > maxLength || /[\0\r\n]/.test(text)) {
    throw invalidChunk(`${name} must be at most ${maxLength} characters`);
  }
  return text;
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw invalidChunk(`${name} must be a non-negative safe integer`);
  }
  return number;
}

function countNewlines(buffer) {
  let count = 0;
  for (const byte of buffer) if (byte === 0x0a) count += 1;
  return count;
}

function opaquePart(value) {
  return sha256(Buffer.from(String(value))).slice(0, 32);
}

function padOffset(value) {
  return String(value).padStart(20, "0");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Workers refill as each read completes; a slow object does not stall a batch.
async function readPool(items, read) {
  let cursor = 0;
  let failed;
  await Promise.all(Array.from({ length: Math.min(16, items.length) }, async () => {
    while (cursor < items.length && !failed) {
      const item = items[cursor++];
      try { await read(item); } catch (error) { failed = error; }
    }
  }));
  if (failed) throw failed;
}

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

  async function commitChunk({ ownerId, machineId, agentId, chunk } = {}) {
    const source = normalizeSource({ ownerId, machineId, agentId, chunk });
    const decoded = decodeAndValidateChunk(chunk, maxChunkBytes);
    const keys = archiveKeys(source, decoded);
    // Object stores expose optimistic conditional writes. A rolling controller
    // deploy can briefly have two archive instances, so retry a stale manifest
    // generation instead of letting an older request roll the cursor backward.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await serializeManifestWrite(keys.manifestKey, () =>
          commitChunkUnlocked({ source, decoded, keys }),
        );
      } catch (error) {
        if (error?.code !== "storage_version_conflict" || attempt === 4) throw error;
      }
    }
    throw new Error("unreachable transcript manifest retry state");
  }

  async function serializeManifestWrite(manifestKey, operation) {
    const previous = manifestWriters.get(manifestKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    manifestWriters.set(manifestKey, current);
    try {
      return await current;
    } finally {
      if (manifestWriters.get(manifestKey) === current) {
        manifestWriters.delete(manifestKey);
      }
    }
  }

  async function commitChunkUnlocked({ source, decoded, keys }) {
    const manifestRecord = await readManifest(storage, keys.manifestKey);
    const manifest = manifestRecord.value;
    const expected = manifestCursor(manifest);

    // A lost ACK can make any already-committed chunk arrive again, not only
    // the most recent one. Its content-addressed key proves byte identity.
    if (
      decoded.endOffsetExclusive <= expected.committedOffset &&
      decoded.nextLineSeq <= expected.nextLineSeq
    ) {
      const committed = await inspectCommittedMetadata(
        storage,
        manifest,
        keys,
        decoded,
      );
      if (committed.conflict) {
        throw epochConflict(expected, committed.conflict);
      }
      if (committed.exact) {
        const existing = await storage.get(keys.chunkKey);
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

  async function readEpoch(manifestKey) {
    const manifestRecord = await readManifest(storage, String(manifestKey || ""));
    if (!manifestRecord.value) return null;
    const manifest = manifestRecord.value;
    const reversed = [];
    const visited = new Set();
    let metadataKey = manifest.lastChunk?.metadataKey || "";
    while (metadataKey) {
      if (visited.has(metadataKey)) {
        throw invalidManifestChain("range metadata cycle");
      }
      visited.add(metadataKey);
      const found = await storage.get(metadataKey);
      if (!found?.bytes) throw invalidManifestChain("missing range metadata");
      let metadata;
      try {
        metadata = JSON.parse(found.bytes.toString("utf8"));
      } catch {
        throw invalidManifestChain("invalid range metadata JSON");
      }
      validateRangeMetadata(metadata, metadataKey);
      const raw = await storage.get(metadata.key);
      if (!raw?.bytes || sha256(raw.bytes) !== metadata.sha256) {
        throw invalidManifestChain("missing or corrupt raw range");
      }
      reversed.push({ ...metadata, bytes: raw.bytes });
      metadataKey = metadata.previousMetadataKey || "";
    }
    const chunks = reversed.reverse();
    validateReplayContinuity(chunks, manifest);
    return { manifest, chunks };
  }

  return { commitChunk, readEpoch };
}

async function inspectCommittedMetadata(storage, manifest, keys, decoded) {
  let metadataKey = manifest?.lastChunk?.metadataKey || "";
  const visited = new Set();
  let expectedEndOffset = manifestCursor(manifest).committedOffset;
  let expectedNextLineSeq = manifestCursor(manifest).nextLineSeq;
  let exact = false;
  let conflict = null;
  while (metadataKey) {
    if (visited.has(metadataKey)) throw invalidManifestChain("range metadata cycle");
    visited.add(metadataKey);
    const found = await storage.get(metadataKey);
    if (!found?.bytes) throw invalidManifestChain("missing range metadata");
    let metadata;
    try {
      metadata = JSON.parse(found.bytes.toString("utf8"));
    } catch {
      throw invalidManifestChain("invalid range metadata JSON");
    }
    validateRangeMetadata(metadata, metadataKey);
    if (
      metadata.endOffsetExclusive !== expectedEndOffset ||
      metadata.nextLineSeq !== expectedNextLineSeq
    ) {
      throw invalidManifestChain("non-contiguous replay range");
    }
    const sameCoordinates =
      metadata.startOffset === decoded.startOffset &&
      metadata.endOffsetExclusive === decoded.endOffsetExclusive &&
      metadata.firstLineSeq === decoded.firstLineSeq &&
      metadata.nextLineSeq === decoded.nextLineSeq;
    if (sameCoordinates) {
      const sameIdentity =
        metadataKey === keys.metadataKey &&
        metadata.id === keys.chunkId &&
        metadata.key === keys.chunkKey &&
        metadata.sha256 === decoded.sha256;
      if (sameIdentity) exact = true;
      else conflict = metadata;
    }
    expectedEndOffset = metadata.startOffset;
    expectedNextLineSeq = metadata.firstLineSeq;
    metadataKey = metadata.previousMetadataKey || "";
  }
  if (expectedEndOffset !== 0 || expectedNextLineSeq !== 0) {
    throw invalidManifestChain("replay range does not start at epoch origin");
  }
  return { exact, conflict };
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
  if (typeof chunk.base64 !== "string" || !chunk.base64) {
    throw invalidChunk("base64 chunk body is required");
  }
  const bytes = Buffer.from(chunk.base64, "base64");
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

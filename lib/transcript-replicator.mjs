// Incremental, transport-only replication for agent transcript JSONL files.
//
// This module deliberately knows nothing about Codex/Claude record shapes. It
// treats a transcript as an append-only byte stream, assigns physical line
// sequence numbers, and only offers newline-terminated chunks to the injected
// uploader. The state store is also injected so Connector integration can make
// the cursor/file epoch durable without coupling this module to a particular
// config format.

import { createHash, randomUUID } from "node:crypto";
import { open, stat as statFile } from "node:fs/promises";
import { MAX_TRANSCRIPT_CHUNK_BYTES } from "./protocol.mjs";

const STATE_VERSION = 1;
const DEFAULT_CHUNK_BYTES = 256 * 1024;
const DEFAULT_BOUNDARY_BYTES = 4096;
const DEFAULT_MAX_CHUNKS_PER_SYNC = 32;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function chunkPrefix(parts, totalBytes, length) {
  const combined =
    parts.length === 1 ? parts[0] : Buffer.concat(parts, totalBytes);
  return Buffer.from(combined.subarray(0, length));
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function positiveInteger(value, fallback, label) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return number;
}

function sourceIdentity(info) {
  return {
    dev: String(info.dev ?? ""),
    ino: String(info.ino ?? ""),
  };
}

function sameIdentity(left, right) {
  return Boolean(
    left &&
      right &&
      left.dev !== "" &&
      left.ino !== "" &&
      left.dev === right.dev &&
      left.ino === right.ino,
  );
}

async function defaultReadRange(filePath, startOffset, endOffsetExclusive) {
  const length = endOffsetExclusive - startOffset;
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(filePath, "r");
  try {
    const bytes = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const result = await handle.read(bytes, read, length - read, startOffset + read);
      if (result.bytesRead === 0) break;
      read += result.bytesRead;
    }
    return bytes.subarray(0, read);
  } finally {
    await handle.close();
  }
}

function freshState({ sessionKey, filePath, identity, fileEpoch, reason, previousEpoch }) {
  return {
    version: STATE_VERSION,
    sessionKey,
    filePath,
    fileEpoch,
    previousEpoch: previousEpoch || "",
    epochReason: reason,
    sourceIdentity: identity,
    cursor: {
      byteOffset: 0,
      lineSeq: 0,
    },
    boundary: null,
    lastChunkSha256: "",
    pending: null,
    quarantine: null,
  };
}

function pendingChunkForUpload(pending) {
  return {
    ...pending.metadata,
    bytes: Buffer.from(pending.bytesBase64, "base64"),
  };
}

function isAcknowledged(response) {
  return response === true || response?.ack === true;
}

function assertStateStore(stateStore) {
  if (!stateStore || typeof stateStore.load !== "function" || typeof stateStore.save !== "function") {
    throw new TypeError("stateStore must provide async load(sessionKey) and save(sessionKey, state)");
  }
}

/**
 * A small JSON-compatible state store useful for tests and ephemeral callers.
 * Production Connector integration should inject an atomic durable store.
 */
export function createMemoryTranscriptStateStore(initialEntries = []) {
  const states = new Map(initialEntries.map(([key, value]) => [String(key), cloneJson(value)]));
  return {
    async load(sessionKey) {
      return cloneJson(states.get(String(sessionKey)) ?? null);
    },
    async save(sessionKey, state) {
      states.set(String(sessionKey), cloneJson(state));
    },
    async delete(sessionKey) {
      states.delete(String(sessionKey));
    },
  };
}

/**
 * Build a transcript replicator.
 *
 * uploadChunk receives metadata plus a Buffer in `bytes` and must return
 * `{ack: true}` (or `true`) only after the remote chunk is durable. A missing
 * ACK leaves the cursor unchanged. The exact pending bytes and metadata are
 * saved before the first upload attempt, so a retry after a crash is identical.
 */
export function createTranscriptReplicator({
  stateStore,
  uploadChunk,
  stat = statFile,
  readRange = defaultReadRange,
  createFileEpoch = () => randomUUID(),
  chunkBytes = DEFAULT_CHUNK_BYTES,
  boundaryBytes = DEFAULT_BOUNDARY_BYTES,
  maxChunksPerSync = DEFAULT_MAX_CHUNKS_PER_SYNC,
  maxChunkBytes = MAX_TRANSCRIPT_CHUNK_BYTES,
} = {}) {
  assertStateStore(stateStore);
  if (typeof uploadChunk !== "function") {
    throw new TypeError("uploadChunk must be a function");
  }
  if (typeof stat !== "function" || typeof readRange !== "function") {
    throw new TypeError("stat and readRange must be functions");
  }
  if (typeof createFileEpoch !== "function") {
    throw new TypeError("createFileEpoch must be a function");
  }

  const targetChunkBytes = positiveInteger(chunkBytes, DEFAULT_CHUNK_BYTES, "chunkBytes");
  const anchorBytes = positiveInteger(boundaryBytes, DEFAULT_BOUNDARY_BYTES, "boundaryBytes");
  const chunkLimit = positiveInteger(
    maxChunksPerSync,
    DEFAULT_MAX_CHUNKS_PER_SYNC,
    "maxChunksPerSync",
  );
  const hardChunkBytes = positiveInteger(
    maxChunkBytes,
    MAX_TRANSCRIPT_CHUNK_BYTES,
    "maxChunkBytes",
  );
  const locks = new Map();

  async function save(sessionKey, state) {
    await stateStore.save(sessionKey, cloneJson(state));
  }

  async function boundaryMatches(state, filePath) {
    if (state.cursor.byteOffset === 0) return true;
    const boundary = state.boundary;
    if (!boundary || boundary.endOffset !== state.cursor.byteOffset) return false;
    const bytes = await readRange(filePath, boundary.startOffset, boundary.endOffset);
    return bytes.length === boundary.endOffset - boundary.startOffset && sha256(bytes) === boundary.sha256;
  }

  async function beginEpoch(sessionKey, filePath, info, previousState, reason) {
    const identity = sourceIdentity(info);
    const fileEpoch = String(
      await createFileEpoch({
        sessionKey,
        filePath,
        identity,
        reason,
        previousEpoch: previousState?.fileEpoch || "",
      }),
    );
    if (!fileEpoch) throw new Error("createFileEpoch returned an empty epoch");
    const state = freshState({
      sessionKey,
      filePath,
      identity,
      fileEpoch,
      reason,
      previousEpoch: previousState?.fileEpoch || "",
    });
    await save(sessionKey, state);
    return state;
  }

  async function ensureCurrentEpoch(sessionKey, filePath, state) {
    const info = await stat(filePath);
    if (typeof info.isFile === "function" && !info.isFile()) {
      throw new Error(`Transcript is not a regular file: ${filePath}`);
    }
    if (!Number.isSafeInteger(Number(info.size)) || Number(info.size) < 0) {
      throw new Error(`Invalid transcript size for ${filePath}`);
    }
    const identity = sourceIdentity(info);

    if (!state) {
      return {
        state: await beginEpoch(sessionKey, filePath, info, null, "initial"),
        info,
        epochChanged: true,
        epochReason: "initial",
      };
    }
    if (state.version !== STATE_VERSION || state.sessionKey !== sessionKey) {
      return {
        state: await beginEpoch(sessionKey, filePath, info, state, "state-mismatch"),
        info,
        epochChanged: true,
        epochReason: "state-mismatch",
      };
    }
    if (!sameIdentity(state.sourceIdentity, identity)) {
      return {
        state: await beginEpoch(sessionKey, filePath, info, state, "file-identity-changed"),
        info,
        epochChanged: true,
        epochReason: "file-identity-changed",
      };
    }
    if (Number(info.size) < state.cursor.byteOffset) {
      return {
        state: await beginEpoch(sessionKey, filePath, info, state, "file-shrank"),
        info,
        epochChanged: true,
        epochReason: "file-shrank",
      };
    }
    if (!(await boundaryMatches(state, filePath))) {
      return {
        state: await beginEpoch(sessionKey, filePath, info, state, "boundary-mismatch"),
        info,
        epochChanged: true,
        epochReason: "boundary-mismatch",
      };
    }

    if (state.filePath !== filePath) {
      state.filePath = filePath;
      await save(sessionKey, state);
    }
    return { state, info, epochChanged: false, epochReason: "" };
  }

  // Return at least one whole line. `chunkBytes` is a target, while the shared
  // protocol max is a hard ceiling. Scan each byte once and concatenate only
  // after choosing a newline; repeated Buffer.concat here would turn a large
  // tool-result row into quadratic memory copying.
  async function readCompleteChunk(filePath, startOffset, observedSize) {
    if (startOffset >= observedSize) return null;
    let scanOffset = startOffset;
    const parts = [];
    let total = 0;
    const targetBytes = Math.min(targetChunkBytes, hardChunkBytes);
    let lastNewlineAtOrBeforeTarget = -1;
    let firstNewlineAfterTarget = -1;
    let lastNewline = -1;

    while (scanOffset < observedSize && total < hardChunkBytes) {
      const scanEnd = Math.min(
        observedSize,
        scanOffset + targetChunkBytes,
        startOffset + hardChunkBytes,
      );
      const part = await readRange(filePath, scanOffset, scanEnd);
      if (part.length !== scanEnd - scanOffset) return null;
      parts.push(part);
      let index = part.indexOf(0x0a);
      while (index >= 0) {
        const relative = total + index;
        lastNewline = relative;
        if (relative < targetBytes) {
          lastNewlineAtOrBeforeTarget = relative;
        } else if (firstNewlineAfterTarget < 0) {
          firstNewlineAfterTarget = relative;
        }
        index = part.indexOf(0x0a, index + 1);
      }
      total += part.length;

      scanOffset = scanEnd;
      if (total >= targetBytes) {
        const chosen =
          lastNewlineAtOrBeforeTarget >= 0
            ? lastNewlineAtOrBeforeTarget
            : firstNewlineAfterTarget;
        if (chosen >= 0) return chunkPrefix(parts, total, chosen + 1);
      }
    }

    if (lastNewline >= 0) return chunkPrefix(parts, total, lastNewline + 1);
    if (total >= hardChunkBytes) {
      const error = new Error(
        `Transcript JSONL record exceeds the ${hardChunkBytes}-byte archive limit`,
      );
      error.code = "transcript_record_too_large";
      error.limit = hardChunkBytes;
      throw error;
    }
    return null;
  }

  async function makePending(state, filePath, observedSize) {
    const startOffset = state.cursor.byteOffset;
    const bytes = await readCompleteChunk(filePath, startOffset, observedSize);
    if (!bytes) return null;

    const endOffsetExclusive = startOffset + bytes.length;
    const lineCount = bytes.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0);
    const bodySha256 = sha256(bytes);
    const firstLineSeq = state.cursor.lineSeq;
    const nextLineSeq = firstLineSeq + lineCount;
    const chunkId = sha256(
      Buffer.from(
        JSON.stringify([
          state.sessionKey,
          state.fileEpoch,
          startOffset,
          endOffsetExclusive,
          firstLineSeq,
          nextLineSeq,
          bodySha256,
        ]),
      ),
    );
    // Derive the post-ACK boundary from the exact bytes that are persisted as
    // pending and uploaded. Re-reading the path here could race an in-place
    // rewrite and accidentally pair old chunk bytes with a new-file boundary.
    const boundaryStart = Math.max(startOffset, endOffsetExclusive - anchorBytes);
    const boundaryAfter = bytes.subarray(boundaryStart - startOffset);

    return {
      metadata: {
        version: STATE_VERSION,
        chunkId,
        sessionKey: state.sessionKey,
        fileEpoch: state.fileEpoch,
        startOffset,
        endOffsetExclusive,
        firstLineSeq,
        nextLineSeq,
        lineCount,
        byteLength: bytes.length,
        bodySha256,
        previousChunkSha256: state.lastChunkSha256 || "",
      },
      bytesBase64: bytes.toString("base64"),
      boundaryAfter: {
        startOffset: boundaryStart,
        endOffset: endOffsetExclusive,
        sha256: sha256(boundaryAfter),
      },
    };
  }

  async function tryPending(sessionKey, state) {
    if (!state.pending) return { acknowledged: false, response: null };
    const chunk = pendingChunkForUpload(state.pending);
    const response = await uploadChunk(chunk);
    if (!isAcknowledged(response)) {
      return { acknowledged: false, response, chunk };
    }
    if (response && typeof response === "object" && response.chunkId && response.chunkId !== chunk.chunkId) {
      throw new Error(`Upload ACK chunkId mismatch for ${chunk.chunkId}`);
    }

    const pending = state.pending;
    state.cursor = {
      byteOffset: pending.metadata.endOffsetExclusive,
      lineSeq: pending.metadata.nextLineSeq,
    };
    state.boundary = pending.boundaryAfter;
    state.lastChunkSha256 = pending.metadata.bodySha256;
    state.pending = null;
    await save(sessionKey, state);
    return { acknowledged: true, response, chunk };
  }

  async function syncUnlocked({ sessionKey, filePath }) {
    const key = String(sessionKey || "").trim();
    const sourcePath = String(filePath || "").trim();
    if (!key) throw new TypeError("sessionKey is required");
    if (!sourcePath) throw new TypeError("filePath is required");

    let state = cloneJson(await stateStore.load(key));
    const uploaded = [];
    let epochChanged = false;
    let epochReason = "";
    let recoveredRemoteConflict = false;

    function quarantineResult() {
      return {
        uploaded,
        pending: Boolean(state?.pending),
        quarantined: cloneJson(state?.quarantine),
        epochChanged,
        epochReason,
        state: cloneJson(state),
      };
    }

    async function quarantinePending(remoteError, reason) {
      state.quarantine = {
        code: "transcript_pending_source_changed",
        reason,
        remoteCode: remoteError.code,
        fileEpoch: state.fileEpoch,
        chunkId: state.pending?.metadata?.chunkId || "",
      };
      await save(key, state);
      return false;
    }

    async function recoverRemoteConflict(error) {
      if (!isRemoteCursorConflict(error) || recoveredRemoteConflict) throw error;
      if (state?.pending) {
        let info;
        try {
          info = await stat(sourcePath);
        } catch {
          return quarantinePending(error, "source-unavailable");
        }
        const pending = state.pending.metadata;
        const identityStillMatches = sameIdentity(
          state.sourceIdentity,
          sourceIdentity(info),
        );
        const sizeCanReconstruct = Number(info.size) >= pending.endOffsetExclusive;
        let pendingStillMatches = false;
        let prefixStillMatches = false;
        if (identityStillMatches && sizeCanReconstruct) {
          const currentPendingBytes = await readRange(
            sourcePath,
            pending.startOffset,
            pending.endOffsetExclusive,
          );
          pendingStillMatches =
            currentPendingBytes.length === pending.byteLength &&
            sha256(currentPendingBytes) === pending.bodySha256;
          prefixStillMatches = await boundaryMatches(state, sourcePath);
        }
        if (!identityStillMatches || !sizeCanReconstruct) {
          return quarantinePending(error, "source-identity-or-size-changed");
        }
        if (!pendingStillMatches || !prefixStillMatches) {
          return quarantinePending(error, "source-bytes-changed");
        }
      }
      const info = await stat(sourcePath);
      const reason = `remote-${error.code}`;
      state = await beginEpoch(key, sourcePath, info, state, reason);
      recoveredRemoteConflict = true;
      epochChanged = true;
      epochReason = reason;
      return true;
    }

    if (state?.pending && state?.quarantine) return quarantineResult();

    // A pending chunk belongs to the old file epoch and owns its bytes. Retry it
    // before inspecting the current path, which may already have rotated.
    if (state?.pending) {
      try {
        const attempt = await tryPending(key, state);
        if (!attempt.acknowledged) {
          return { uploaded, pending: true, response: attempt.response, state: cloneJson(state) };
        }
        uploaded.push(attempt.chunk);
      } catch (error) {
        // The controller can legitimately lose or replace an archive namespace
        // (bucket/prefix migration, repaired manifest). A cursor/chain NACK is
        // permanent for the existing pending bytes, so start a fresh epoch and
        // safely replay the current file from byte zero instead of retrying the
        // same impossible request forever.
        if (!(await recoverRemoteConflict(error))) return quarantineResult();
      }
    }

    for (let count = uploaded.length; count < chunkLimit; count++) {
      const current = await ensureCurrentEpoch(key, sourcePath, state);
      state = current.state;
      epochChanged ||= current.epochChanged;
      if (current.epochChanged) epochReason = current.epochReason;

      if (state.quarantine) {
        return {
          uploaded,
          pending: false,
          quarantined: cloneJson(state.quarantine),
          epochChanged,
          epochReason,
          state: cloneJson(state),
        };
      }

      let pending;
      try {
        pending = await makePending(state, sourcePath, Number(current.info.size));
      } catch (error) {
        if (error?.code !== "transcript_record_too_large") throw error;
        state.quarantine = {
          code: error.code,
          byteOffset: state.cursor.byteOffset,
          observedSize: Number(current.info.size),
          limit: error.limit,
        };
        await save(key, state);
        return {
          uploaded,
          pending: false,
          quarantined: cloneJson(state.quarantine),
          epochChanged,
          epochReason,
          state: cloneJson(state),
        };
      }
      if (!pending) break;
      state.pending = pending;
      // Persist exact bytes before attempting the upload. Cursor remains at the
      // previous acknowledged boundary in this saved state.
      await save(key, state);

      let attempt;
      try {
        attempt = await tryPending(key, state);
      } catch (error) {
        if (!(await recoverRemoteConflict(error))) return quarantineResult();
        count -= 1;
        continue;
      }
      if (!attempt.acknowledged) {
        return {
          uploaded,
          pending: true,
          response: attempt.response,
          epochChanged,
          epochReason,
          state: cloneJson(state),
        };
      }
      uploaded.push(attempt.chunk);
    }

    return {
      uploaded,
      pending: Boolean(state?.pending),
      epochChanged,
      epochReason,
      state: cloneJson(state),
    };
  }

  async function syncSession(args) {
    const sessionKey = String(args?.sessionKey || "").trim();
    if (!sessionKey) throw new TypeError("sessionKey is required");

    const previous = locks.get(sessionKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => syncUnlocked(args));
    locks.set(sessionKey, current);
    try {
      return await current;
    } finally {
      if (locks.get(sessionKey) === current) locks.delete(sessionKey);
    }
  }

  return {
    syncSession,
    async state(sessionKey) {
      return cloneJson(await stateStore.load(String(sessionKey)));
    },
  };
}

function isRemoteCursorConflict(error) {
  return (
    error?.code === "transcript_cursor_mismatch" ||
    error?.code === "transcript_chain_mismatch"
  );
}

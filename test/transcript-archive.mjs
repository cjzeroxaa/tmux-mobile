import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createTranscriptArchive } from "../lib/transcript-archive.mjs";

function memoryStorage() {
  const objects = new Map();
  return {
    kind: "memory",
    objects,
    async put(key, bytes) {
      objects.set(key, Buffer.from(bytes));
      return { key, size: bytes.length };
    },
    async get(key) {
      const bytes = objects.get(key);
      return bytes ? { bytes: Buffer.from(bytes), size: bytes.length } : null;
    },
  };
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const storage = memoryStorage();
const committed = [];
const archive = createTranscriptArchive({
  storage,
  now: () => Date.parse("2026-07-12T00:00:00Z"),
  onChunkCommitted: async (item) => committed.push(item),
});
const source = {
  ownerId: "owner@example.com",
  machineId: "mac-mini",
  agentId: "00000000-0000-4000-8000-000000000001",
};

function chunk(bytes, overrides = {}) {
  const body = Buffer.from(bytes);
  return {
    agentKind: "codex",
    agentSessionId: "11111111-1111-4111-8111-111111111111",
    fileEpoch: "22222222-2222-4222-8222-222222222222",
    startOffset: 0,
    endOffsetExclusive: body.length,
    firstLineSeq: 0,
    nextLineSeq: body.toString().split("\n").length - 1,
    sha256: sha256(body),
    base64: body.toString("base64"),
    ...overrides,
  };
}

const firstBody = '{"type":"one"}\n{"type":"two"}\n';
const first = await archive.commitChunk({ ...source, chunk: chunk(firstBody) });
assert.equal(first.committedOffset, Buffer.byteLength(firstBody));
assert.equal(first.nextLineSeq, 2);
assert.equal(first.duplicate, false);
assert.equal(committed.length, 1);
assert.ok(storage.objects.has(first.chunkKey));
assert.ok(storage.objects.has(first.manifestKey));

const retried = await archive.commitChunk({ ...source, chunk: chunk(firstBody) });
assert.equal(retried.chunkId, first.chunkId);
assert.equal(retried.duplicate, true, "lost ACK retry is idempotent");
assert.equal(committed.length, 1, "duplicate does not re-run downstream indexer");

const secondBody = '{"type":"three"}\n';
const secondStart = first.committedOffset;
const second = await archive.commitChunk({
  ...source,
  chunk: chunk(secondBody, {
    startOffset: secondStart,
    endOffsetExclusive: secondStart + Buffer.byteLength(secondBody),
    firstLineSeq: 2,
    nextLineSeq: 3,
    previousChunkSha256: first.sha256,
  }),
});
assert.equal(second.committedOffset, secondStart + Buffer.byteLength(secondBody));
assert.equal(second.nextLineSeq, 3);
assert.equal(committed.length, 2);
const replayed = await archive.readEpoch(second.manifestKey);
assert.deepEqual(
  replayed.chunks.map((item) => item.bytes.toString()),
  [firstBody, secondBody],
  "manifest-linked immutable range metadata replays the complete epoch",
);
assert.equal(replayed.manifest.committedOffset, second.committedOffset);

await assert.rejects(
  archive.commitChunk({
    ...source,
    chunk: chunk('{"type":"gap"}\n', {
      startOffset: second.committedOffset + 5,
      endOffsetExclusive: second.committedOffset + 5 + Buffer.byteLength('{"type":"gap"}\n'),
      firstLineSeq: 3,
      nextLineSeq: 4,
      previousChunkSha256: second.sha256,
    }),
  }),
  (error) =>
    error.code === "transcript_cursor_mismatch" &&
    error.expected.committedOffset === second.committedOffset,
);

await assert.rejects(
  archive.commitChunk({
    ...source,
    chunk: chunk('{"type":"bad-chain"}\n', {
      startOffset: second.committedOffset,
      endOffsetExclusive:
        second.committedOffset + Buffer.byteLength('{"type":"bad-chain"}\n'),
      firstLineSeq: 3,
      nextLineSeq: 4,
      previousChunkSha256: "f".repeat(64),
    }),
  }),
  (error) => error.code === "transcript_chain_mismatch",
);

await assert.rejects(
  archive.commitChunk({
    ...source,
    chunk: chunk("partial", {
      startOffset: second.committedOffset,
      endOffsetExclusive: second.committedOffset + 7,
      firstLineSeq: 3,
      nextLineSeq: 3,
    }),
  }),
  (error) => error.code === "invalid_transcript_chunk" && /newline/.test(error.message),
);

await assert.rejects(
  archive.commitChunk({
    ...source,
    chunk: { ...chunk('{"type":"bad-hash"}\n'), sha256: "0".repeat(64) },
  }),
  (error) => error.code === "invalid_transcript_chunk" && /sha256 mismatch/.test(error.message),
);

const newEpochBody = '{"type":"new-epoch"}\n';
const newEpoch = await archive.commitChunk({
  ...source,
  chunk: chunk(newEpochBody, {
    fileEpoch: "33333333-3333-4333-8333-333333333333",
  }),
});
assert.equal(newEpoch.committedOffset, Buffer.byteLength(newEpochBody));
assert.equal(newEpoch.nextLineSeq, 1);
assert.notEqual(newEpoch.manifestKey, first.manifestKey);

// A retry can overlap the original request when its ACK is delayed. Requests
// for one manifest epoch must be serialized or the slow original write can
// roll the cursor back after a newer chunk has already been ACKed.
const serializedObjects = new Map();
let manifestGets = 0;
let releaseFirstManifestRead;
const firstManifestReadStarted = new Promise((resolve) => {
  releaseFirstManifestRead = { resolveStarted: resolve, release: null };
});
const firstManifestReadGate = new Promise((resolve) => {
  releaseFirstManifestRead.release = resolve;
});
const serializedStorage = {
  kind: "memory",
  async put(key, bytes) {
    serializedObjects.set(key, Buffer.from(bytes));
    return { key, size: bytes.length };
  },
  async get(key) {
    if (key.endsWith("/manifest.json")) {
      manifestGets += 1;
      if (manifestGets === 1) {
        releaseFirstManifestRead.resolveStarted();
        await firstManifestReadGate;
      }
    }
    const bytes = serializedObjects.get(key);
    return bytes ? { bytes: Buffer.from(bytes), size: bytes.length } : null;
  },
};
const serializedArchive = createTranscriptArchive({ storage: serializedStorage });
const serializedFirstBody = '{"type":"serialized-one"}\n';
const serializedFirstChunk = chunk(serializedFirstBody, {
  fileEpoch: "44444444-4444-4444-8444-444444444444",
});
const serializedFirstPromise = serializedArchive.commitChunk({
  ...source,
  chunk: serializedFirstChunk,
});
await firstManifestReadStarted;
const serializedRetryPromise = serializedArchive.commitChunk({
  ...source,
  chunk: serializedFirstChunk,
});
const serializedSecondBody = '{"type":"serialized-two"}\n';
const serializedSecondPromise = serializedArchive.commitChunk({
  ...source,
  chunk: chunk(serializedSecondBody, {
    fileEpoch: serializedFirstChunk.fileEpoch,
    startOffset: Buffer.byteLength(serializedFirstBody),
    endOffsetExclusive:
      Buffer.byteLength(serializedFirstBody) + Buffer.byteLength(serializedSecondBody),
    firstLineSeq: 1,
    nextLineSeq: 2,
    previousChunkSha256: serializedFirstChunk.sha256,
  }),
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(manifestGets, 1, "overlapping writes for one epoch wait behind the first");
releaseFirstManifestRead.release();
const [serializedFirst, serializedRetry, serializedSecond] = await Promise.all([
  serializedFirstPromise,
  serializedRetryPromise,
  serializedSecondPromise,
]);
assert.equal(serializedRetry.duplicate, true);
assert.equal(
  serializedSecond.committedOffset,
  Buffer.byteLength(serializedFirstBody) + Buffer.byteLength(serializedSecondBody),
);
const serializedManifest = JSON.parse(
  serializedObjects.get(serializedSecond.manifestKey).toString("utf8"),
);
assert.equal(serializedManifest.committedOffset, serializedSecond.committedOffset);
assert.equal(serializedManifest.nextLineSeq, 2);

// Two controller tasks can overlap during a rolling deploy. Cloud-driver
// generation/ETag preconditions force the stale task to re-read and retry
// instead of overwriting a manifest that the newer task already advanced.
const casObjects = new Map();
const casVersions = new Map();
let releaseSlowManifest;
let signalSlowManifest;
const slowManifestStarted = new Promise((resolve) => {
  signalSlowManifest = resolve;
});
const slowManifestGate = new Promise((resolve) => {
  releaseSlowManifest = resolve;
});
let delayFirstManifestPut = true;
const casStorage = {
  kind: "versioned-memory",
  conditionalWrites: true,
  objects: casObjects,
  async put(key, bytes, { ifVersion } = {}) {
    if (key.endsWith("/manifest.json") && delayFirstManifestPut) {
      delayFirstManifestPut = false;
      signalSlowManifest();
      await slowManifestGate;
    }
    const currentVersion = casVersions.has(key) ? String(casVersions.get(key)) : null;
    if (
      ifVersion !== undefined &&
      ((ifVersion === null && currentVersion !== null) ||
        (ifVersion !== null && String(ifVersion) !== currentVersion))
    ) {
      const error = new Error("conditional write conflict");
      error.code = "storage_version_conflict";
      throw error;
    }
    const nextVersion = Number(currentVersion || 0) + 1;
    casObjects.set(key, Buffer.from(bytes));
    casVersions.set(key, nextVersion);
    return { key, size: bytes.length, version: String(nextVersion) };
  },
  async get(key) {
    const bytes = casObjects.get(key);
    return bytes
      ? {
          bytes: Buffer.from(bytes),
          size: bytes.length,
          version: String(casVersions.get(key)),
        }
      : null;
  },
};
const oldControllerArchive = createTranscriptArchive({ storage: casStorage });
const newControllerArchive = createTranscriptArchive({ storage: casStorage });
const casEpoch = "55555555-5555-4555-8555-555555555555";
const casFirstBody = '{"type":"cas-one"}\n';
const casFirstChunk = chunk(casFirstBody, { fileEpoch: casEpoch });
const slowOldCommit = oldControllerArchive.commitChunk({
  ...source,
  chunk: casFirstChunk,
});
await slowManifestStarted;
const newFirst = await newControllerArchive.commitChunk({
  ...source,
  chunk: casFirstChunk,
});
const casSecondBody = '{"type":"cas-two"}\n';
const newSecond = await newControllerArchive.commitChunk({
  ...source,
  chunk: chunk(casSecondBody, {
    fileEpoch: casEpoch,
    startOffset: newFirst.committedOffset,
    endOffsetExclusive: newFirst.committedOffset + Buffer.byteLength(casSecondBody),
    firstLineSeq: 1,
    nextLineSeq: 2,
    previousChunkSha256: casFirstChunk.sha256,
  }),
});
releaseSlowManifest();
const retriedOldCommit = await slowOldCommit;
assert.equal(retriedOldCommit.duplicate, true);
const finalCasManifest = JSON.parse(
  casObjects.get(newSecond.manifestKey).toString("utf8"),
);
assert.equal(finalCasManifest.committedOffset, newSecond.committedOffset);
assert.equal(finalCasManifest.nextLineSeq, 2);

// A raw object written by a CAS loser is not proof that its range was
// committed. Only membership in the winning manifest's metadata chain earns an
// idempotent ACK; conflicting bytes at the same range are rejected.
const conflictEpoch = "66666666-6666-4666-8666-666666666666";
const rejectingManifestStorage = {
  ...casStorage,
  async put(key, bytes, options) {
    if (key.endsWith("/manifest.json")) {
      const error = new Error("forced manifest CAS loss");
      error.code = "storage_version_conflict";
      throw error;
    }
    return casStorage.put(key, bytes, options);
  },
};
const losingArchive = createTranscriptArchive({ storage: rejectingManifestStorage });
const conflictA = chunk('{"value":"A"}\n', { fileEpoch: conflictEpoch });
const conflictB = chunk('{"value":"B"}\n', { fileEpoch: conflictEpoch });
await assert.rejects(
  losingArchive.commitChunk({ ...source, chunk: conflictA }),
  (error) => error.code === "storage_version_conflict",
);
await newControllerArchive.commitChunk({ ...source, chunk: conflictB });
await assert.rejects(
  losingArchive.commitChunk({ ...source, chunk: conflictA }),
  (error) => error.code === "transcript_cursor_mismatch",
);

console.log("transcript archive tests passed");

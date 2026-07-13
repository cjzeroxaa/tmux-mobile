import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createMemoryTranscriptStateStore,
  createTranscriptReplicator,
} from "../lib/transcript-replicator.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const dir = await mkdtemp(path.join(os.tmpdir(), "tmux-mobile-transcript-replicator-"));

function epochFactory(prefix = "epoch") {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

try {
  // Only complete newline-terminated records move the cursor. A partial tail is
  // picked up verbatim once its newline arrives.
  {
    const filePath = path.join(dir, "partial.jsonl");
    await writeFile(filePath, "one\npartial");
    const uploads = [];
    const store = createMemoryTranscriptStateStore();
    const replicator = createTranscriptReplicator({
      stateStore: store,
      createFileEpoch: epochFactory("partial"),
      uploadChunk: async (chunk) => {
        uploads.push(chunk);
        return { ack: true, chunkId: chunk.chunkId };
      },
    });

    let result = await replicator.syncSession({ sessionKey: "partial", filePath });
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].bytes.toString(), "one\n");
    assert.deepEqual(
      {
        start: uploads[0].startOffset,
        end: uploads[0].endOffsetExclusive,
        first: uploads[0].firstLineSeq,
        next: uploads[0].nextLineSeq,
        lines: uploads[0].lineCount,
      },
      { start: 0, end: 4, first: 0, next: 1, lines: 1 },
    );
    assert.equal(uploads[0].bodySha256, sha256(Buffer.from("one\n")));
    assert.equal(result.state.cursor.byteOffset, 4);
    assert.equal(result.state.cursor.lineSeq, 1);

    result = await replicator.syncSession({ sessionKey: "partial", filePath });
    assert.equal(uploads.length, 1, "unchanged partial tail is not uploaded");
    assert.equal(result.state.cursor.byteOffset, 4);

    await appendFile(filePath, " tail\n");
    result = await replicator.syncSession({ sessionKey: "partial", filePath });
    assert.equal(uploads.length, 2);
    assert.equal(uploads[1].bytes.toString(), "partial tail\n");
    assert.equal(uploads[1].startOffset, 4);
    assert.equal(uploads[1].firstLineSeq, 1);
    assert.equal(uploads[1].nextLineSeq, 2);
    assert.equal(result.state.cursor.byteOffset, Buffer.byteLength("one\npartial tail\n"));
  }

  // The pending payload is durable before upload, a missing ACK cannot advance
  // the cursor, and a new replicator instance retries the identical chunk.
  {
    const filePath = path.join(dir, "retry.jsonl");
    await writeFile(filePath, "alpha\nbeta\n");
    const store = createMemoryTranscriptStateStore();
    let firstAttempt;
    const first = createTranscriptReplicator({
      stateStore: store,
      createFileEpoch: epochFactory("retry"),
      uploadChunk: async (chunk) => {
        firstAttempt = chunk;
        return { ack: false };
      },
    });
    const unacked = await first.syncSession({ sessionKey: "retry", filePath });
    assert.equal(unacked.pending, true);
    assert.equal(unacked.state.cursor.byteOffset, 0, "cursor waits for ACK");
    assert.ok(unacked.state.pending, "exact pending payload is persisted");

    let retried;
    const second = createTranscriptReplicator({
      stateStore: store,
      createFileEpoch: () => {
        throw new Error("pending retry must keep its existing epoch");
      },
      uploadChunk: async (chunk) => {
        retried = chunk;
        return { ack: true, chunkId: chunk.chunkId };
      },
    });
    const acknowledged = await second.syncSession({ sessionKey: "retry", filePath });
    assert.equal(retried.chunkId, firstAttempt.chunkId);
    assert.equal(retried.bodySha256, firstAttempt.bodySha256);
    assert.ok(retried.bytes.equals(firstAttempt.bytes));
    assert.equal(acknowledged.state.cursor.byteOffset, Buffer.byteLength("alpha\nbeta\n"));
    assert.equal(acknowledged.state.pending, null);
  }

  // A record larger than the target chunk size is not split; scanning extends
  // to its newline and line sequence remains physical-line based.
  {
    const filePath = path.join(dir, "large-line.jsonl");
    await writeFile(filePath, "123456789\nxy\n");
    const uploads = [];
    const replicator = createTranscriptReplicator({
      stateStore: createMemoryTranscriptStateStore(),
      createFileEpoch: epochFactory("large"),
      chunkBytes: 4,
      uploadChunk: async (chunk) => {
        uploads.push(chunk);
        return true;
      },
    });
    await replicator.syncSession({ sessionKey: "large", filePath });
    assert.deepEqual(uploads.map((item) => item.bytes.toString()), ["123456789\n", "xy\n"]);
    assert.deepEqual(uploads.map((item) => [item.firstLineSeq, item.nextLineSeq]), [[0, 1], [1, 2]]);
  }

  // Replacing/loss of the controller archive namespace produces a permanent
  // cursor or chain NACK for the old epoch. The connector opens a fresh epoch
  // and safely replays from byte zero instead of retrying forever.
  {
    const filePath = path.join(dir, "remote-reset.jsonl");
    await writeFile(filePath, "replay-me\n");
    const attempts = [];
    const replicator = createTranscriptReplicator({
      stateStore: createMemoryTranscriptStateStore(),
      createFileEpoch: epochFactory("remote-reset"),
      uploadChunk: async (chunk) => {
        attempts.push(chunk);
        if (attempts.length === 1) {
          const error = new Error("remote manifest was replaced");
          error.code = "transcript_cursor_mismatch";
          error.expected = { committedOffset: 0, nextLineSeq: 0 };
          throw error;
        }
        return { ack: true, chunkId: chunk.chunkId };
      },
    });
    const reset = await replicator.syncSession({
      sessionKey: "remote-reset",
      filePath,
    });
    assert.equal(attempts.length, 2);
    assert.notEqual(attempts[0].fileEpoch, attempts[1].fileEpoch);
    assert.equal(attempts[1].startOffset, 0);
    assert.equal(attempts[1].bytes.toString(), "replay-me\n");
    assert.equal(reset.epochReason, "remote-transcript_cursor_mismatch");
    assert.equal(reset.state.cursor.byteOffset, Buffer.byteLength("replay-me\n"));
    assert.equal(reset.pending, false);
  }

  // A zero-based pending chunk is a complete replayable prefix. Even if the path
  // rotates during the NACK, recovery re-keys the exact persisted old bytes,
  // ACKs them in a fresh epoch, and only then starts the replacement file.
  {
    const filePath = path.join(dir, "remote-reset-rotated.jsonl");
    const oldPath = path.join(dir, "remote-reset-rotated.old.jsonl");
    await writeFile(filePath, "old-pending\n");
    const attempts = [];
    const replicator = createTranscriptReplicator({
      stateStore: createMemoryTranscriptStateStore(),
      createFileEpoch: epochFactory("remote-reset-rotated"),
      uploadChunk: async (chunk) => {
        attempts.push(chunk);
        if (attempts.length === 1) {
          await rename(filePath, oldPath);
          await writeFile(filePath, "new-file\n");
          const error = new Error("remote manifest was replaced during rotation");
          error.code = "transcript_cursor_mismatch";
          throw error;
        }
        return { ack: true, chunkId: chunk.chunkId };
      },
    });
    const recovered = await replicator.syncSession({
      sessionKey: "remote-reset-rotated",
      filePath,
    });
    assert.equal(attempts.length, 3);
    assert.equal(attempts[0].bytes.toString(), "old-pending\n");
    assert.equal(attempts[1].bytes.toString(), "old-pending\n");
    assert.notEqual(attempts[1].fileEpoch, attempts[0].fileEpoch);
    assert.equal(attempts[2].bytes.toString(), "new-file\n");
    assert.notEqual(attempts[2].fileEpoch, attempts[1].fileEpoch);
    assert.equal(recovered.pending, false);
    assert.equal(recovered.state.quarantine, null);
  }

  // A later pending chunk does not contain its already-ACKed prefix. If the
  // controller NACKs that old epoch and the path rotates, preserve the exact
  // old pending bytes and block: resetting onto the new inode would lose data.
  {
    const filePath = path.join(dir, "remote-reset-late-rotated.jsonl");
    const oldPath = path.join(dir, "remote-reset-late-rotated.old.jsonl");
    await writeFile(filePath, "one\nold-pending\n");
    const attempts = [];
    const stateStore = createMemoryTranscriptStateStore();
    const replicator = createTranscriptReplicator({
      stateStore,
      createFileEpoch: epochFactory("remote-reset-late-rotated"),
      chunkBytes: 4,
      uploadChunk: async (chunk) => {
        attempts.push(chunk);
        if (attempts.length === 1) return { ack: true, chunkId: chunk.chunkId };
        await rename(filePath, oldPath);
        await writeFile(filePath, "new-file\n");
        const error = new Error("remote manifest was replaced after an earlier ACK");
        error.code = "transcript_cursor_mismatch";
        throw error;
      },
    });
    const quarantined = await replicator.syncSession({
      sessionKey: "remote-reset-late-rotated",
      filePath,
    });
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].bytes.toString(), "one\n");
    assert.equal(attempts[1].bytes.toString(), "old-pending\n");
    assert.equal(quarantined.pending, true);
    assert.equal(quarantined.state.cursor.byteOffset, Buffer.byteLength("one\n"));
    assert.equal(quarantined.quarantined.code, "transcript_pending_source_changed");
    assert.equal(quarantined.quarantined.reason, "pending-prefix-not-spooled");
    assert.equal(
      Buffer.from(quarantined.state.pending.bytesBase64, "base64").toString(),
      "old-pending\n",
    );
    const restarted = createTranscriptReplicator({
      stateStore,
      createFileEpoch: () => {
        throw new Error("quarantined restart must not create an epoch");
      },
      uploadChunk: async (chunk) => {
        attempts.push(chunk);
        return { ack: true, chunkId: chunk.chunkId };
      },
    });
    const stillQuarantined = await restarted.syncSession({
      sessionKey: "remote-reset-late-rotated",
      filePath,
    });
    assert.equal(stillQuarantined.pending, true);
    assert.equal(attempts.length, 2, "quarantine prevents repeated impossible upload");
  }

  // A JSONL record at the shared hard limit is valid; one with no newline by
  // that boundary is quarantined locally without base64/state-file blowup or a
  // permanently rejected network pending chunk.
  {
    const exactPath = path.join(dir, "exact-limit.jsonl");
    await writeFile(exactPath, "1234567\n");
    const exactUploads = [];
    const exact = createTranscriptReplicator({
      stateStore: createMemoryTranscriptStateStore(),
      createFileEpoch: epochFactory("exact-limit"),
      chunkBytes: 4,
      maxChunkBytes: 8,
      uploadChunk: async (item) => {
        exactUploads.push(item);
        return true;
      },
    });
    const exactResult = await exact.syncSession({
      sessionKey: "exact-limit",
      filePath: exactPath,
    });
    assert.equal(exactUploads[0].bytes.toString(), "1234567\n");
    assert.equal(exactResult.quarantined, undefined);

    const tooLargePath = path.join(dir, "too-large.jsonl");
    await writeFile(tooLargePath, "12345678more-without-newline");
    const tooLargeUploads = [];
    const tooLarge = createTranscriptReplicator({
      stateStore: createMemoryTranscriptStateStore(),
      createFileEpoch: epochFactory("too-large"),
      chunkBytes: 4,
      maxChunkBytes: 8,
      uploadChunk: async (item) => {
        tooLargeUploads.push(item);
        return true;
      },
    });
    const quarantined = await tooLarge.syncSession({
      sessionKey: "too-large",
      filePath: tooLargePath,
    });
    assert.equal(tooLargeUploads.length, 0);
    assert.equal(quarantined.pending, false);
    assert.equal(quarantined.quarantined.code, "transcript_record_too_large");
    assert.equal(quarantined.quarantined.limit, 8);
    assert.equal(quarantined.state.pending, null);
    const stillQuarantined = await tooLarge.syncSession({
      sessionKey: "too-large",
      filePath: tooLargePath,
    });
    assert.equal(stillQuarantined.quarantined.code, "transcript_record_too_large");
    assert.equal(tooLargeUploads.length, 0);
  }

  // Replacing the path with a different inode opens a new epoch and starts its
  // byte/line coordinates at zero.
  {
    const filePath = path.join(dir, "rotated.jsonl");
    const oldPath = path.join(dir, "rotated.old.jsonl");
    await writeFile(filePath, "old\n");
    const uploads = [];
    const replicator = createTranscriptReplicator({
      stateStore: createMemoryTranscriptStateStore(),
      createFileEpoch: epochFactory("rotate"),
      uploadChunk: async (chunk) => {
        uploads.push(chunk);
        return true;
      },
    });
    const initial = await replicator.syncSession({ sessionKey: "rotate", filePath });
    await rename(filePath, oldPath);
    await writeFile(filePath, "new\n");
    const rotated = await replicator.syncSession({ sessionKey: "rotate", filePath });
    assert.notEqual(rotated.state.fileEpoch, initial.state.fileEpoch);
    assert.equal(rotated.epochReason, "file-identity-changed");
    assert.equal(uploads[1].startOffset, 0);
    assert.equal(uploads[1].firstLineSeq, 0);
    assert.equal(uploads[1].bytes.toString(), "new\n");
  }

  // Truncating the same inode below the ACKed cursor opens a new epoch.
  {
    const filePath = path.join(dir, "shrink.jsonl");
    await writeFile(filePath, "first\nsecond\n");
    const uploads = [];
    const replicator = createTranscriptReplicator({
      stateStore: createMemoryTranscriptStateStore(),
      createFileEpoch: epochFactory("shrink"),
      uploadChunk: async (chunk) => {
        uploads.push(chunk);
        return true;
      },
    });
    const initial = await replicator.syncSession({ sessionKey: "shrink", filePath });
    await truncate(filePath, 0);
    await appendFile(filePath, "x\n");
    const shrunk = await replicator.syncSession({ sessionKey: "shrink", filePath });
    assert.notEqual(shrunk.state.fileEpoch, initial.state.fileEpoch);
    assert.equal(shrunk.epochReason, "file-shrank");
    assert.equal(uploads[1].startOffset, 0);
    assert.equal(uploads[1].bytes.toString(), "x\n");
  }

  // An in-place rewrite that keeps the inode and size but changes the ACKed
  // boundary is also a new epoch.
  {
    const filePath = path.join(dir, "boundary.jsonl");
    await writeFile(filePath, "alpha\nbeta\n");
    const uploads = [];
    const replicator = createTranscriptReplicator({
      stateStore: createMemoryTranscriptStateStore(),
      createFileEpoch: epochFactory("boundary"),
      boundaryBytes: 64,
      uploadChunk: async (chunk) => {
        uploads.push(chunk);
        return true;
      },
    });
    const initial = await replicator.syncSession({ sessionKey: "boundary", filePath });
    await writeFile(filePath, "ALPHA\nbeta\n");
    const rewritten = await replicator.syncSession({ sessionKey: "boundary", filePath });
    assert.notEqual(rewritten.state.fileEpoch, initial.state.fileEpoch);
    assert.equal(rewritten.epochReason, "boundary-mismatch");
    assert.equal(uploads[1].startOffset, 0);
    assert.equal(uploads[1].firstLineSeq, 0);
    assert.equal(uploads[1].bytes.toString(), "ALPHA\nbeta\n");
  }

  console.log("transcript-replicator unit tests passed");
} finally {
  await rm(dir, { recursive: true, force: true });
}

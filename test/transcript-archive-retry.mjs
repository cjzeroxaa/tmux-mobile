import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createTranscriptArchive } from '../lib/transcript-archive.mjs';
const source = { ownerId: 'test', machineId: 'machine', agentId: 'agent' };
const objects = new Map();
let gets = 0, puts = 0;
const storage = {
  async get(key) { gets++; const bytes = objects.get(key); return bytes ? { bytes } : null; },
  async put(key, bytes) { puts++; objects.set(key, Buffer.from(bytes)); },
};
const chunks = [];
let offset = 0, previous = '';
const writer = createTranscriptArchive({ storage });
for (let i = 0; i < 5000; i++) {
  const bytes = Buffer.from(`${i}\n`);
  const chunk = { agentKind: 'codex', agentSessionId: 'session', fileEpoch: 'epoch',
    startOffset: offset, endOffsetExclusive: offset + bytes.length, firstLineSeq: i, nextLineSeq: i + 1,
    previousChunkSha256: previous, sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
  await writer.commitChunk({ ...source, chunk });
  chunks.push(chunk); offset += bytes.length; previous = chunk.sha256;
}
// A fresh controller has no cached history. Lost latest ACK costs four GETs.
const events = [];
const archive = createTranscriptArchive({ storage, logEvent: (event, data) => events.push({ event, ...data }) });
gets = puts = 0;
const latest = await archive.commitChunk({ ...source, chunk: chunks.at(-1) });
assert.equal(latest.duplicate, true);
assert.equal(gets, 4);
assert.equal(puts, 0);
assert.equal(events.at(-1).gets, 4);
// Deep historical retries make bounded forward progress, then remain cheap.
let attempts = 0, old;
do {
  gets = puts = 0; attempts++;
  try { old = await archive.commitChunk({ ...source, chunk: chunks[0] }); }
  catch (error) { assert.equal(error.code, 'transcript_duplicate_verification_pending'); }
  assert.ok(gets <= 67, `unbounded duplicate scan: ${gets}`);
  assert.equal(puts, 0);
  assert.ok(attempts <= 80);
} while (!old);
assert.equal(old.duplicate, true);
gets = 0;
await archive.commitChunk({ ...source, chunk: chunks[0] });
assert.equal(gets, 3);
// Cached membership must not bypass actual raw-byte validation.
const saved = objects.get(old.chunkKey);
objects.set(old.chunkKey, Buffer.from('corrupt\n'));
await assert.rejects(archive.commitChunk({ ...source, chunk: chunks[0] }), { code: 'transcript_archive_chain_invalid' });
objects.set(old.chunkKey, saved);
// Nor may the fast path trust a manifest belonging to another source.
const originalManifest = objects.get(latest.manifestKey);
const altered = JSON.parse(originalManifest);
altered.source.ownerId = 'someone-else';
objects.set(latest.manifestKey, Buffer.from(JSON.stringify(altered)));
await assert.rejects(archive.commitChunk({ ...source, chunk: chunks.at(-1) }), { code: 'transcript_archive_chain_invalid' });
objects.set(latest.manifestKey, originalManifest);

function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
// Even a driver ignoring cancellation cannot resume reads/writes after a late GET.
const blocked = gate(), started = gate();
let slowGets = 0, slowPuts = 0;
const slowArchive = createTranscriptArchive({ storage: {
  async get() { slowGets++; started.release(); await blocked.promise; return null; },
  async put() { slowPuts++; },
} });
const cancel = new AbortController();
const pending = slowArchive.commitChunk({ ...source, chunk: chunks[0], signal: cancel.signal });
await started.promise;
const queuedCancel = new AbortController();
const queued = slowArchive.commitChunk({ ...source, chunk: chunks[0], signal: queuedCancel.signal });
queuedCancel.abort();
await assert.rejects(queued, { name: 'AbortError' });
cancel.abort();
await assert.rejects(pending, { name: 'AbortError' });
blocked.release();
await delay(10);
assert.equal(slowGets, 1);
assert.equal(slowPuts, 0);
// A server deadline also bounds work when the client stays connected.
const deadlineArchive = createTranscriptArchive({ readTimeoutMs: 20, storage: {
  async get() { await delay(60); return null; }, async put() { assert.fail('write after timeout'); },
} });
await assert.rejects(deadlineArchive.commitChunk({ ...source, chunk: chunks[0] }), { name: 'TimeoutError' });
await delay(65);
// Once durable writes start, disconnecting does not abandon the transaction
// or let another request overtake it and roll back the manifest.
const writeGate = gate(), writeStarted = gate();
const durableObjects = new Map();
let writeCount = 0;
const durable = createTranscriptArchive({ storage: {
  async get(key) { const bytes = durableObjects.get(key); return bytes ? { bytes } : null; },
  async put(key, bytes) {
    if (++writeCount === 1) { writeStarted.release(); await writeGate.promise; }
    durableObjects.set(key, Buffer.from(bytes));
  },
} });
const disconnect = new AbortController();
const commit = durable.commitChunk({ ...source, chunk: chunks[0], signal: disconnect.signal });
await writeStarted.promise;
disconnect.abort();
await assert.rejects(commit, { name: 'AbortError' });
const retry = durable.commitChunk({ ...source, chunk: chunks[0] });
writeGate.release();
assert.equal((await retry).duplicate, true);
assert.equal(writeCount, 3);
console.log(`transcript archive retry tests passed (5000 ranges, latest 4 GETs, historical ${attempts} bounded attempts)`);

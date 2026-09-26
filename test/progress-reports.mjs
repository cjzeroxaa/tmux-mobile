import assert from 'node:assert/strict';
import { createProgressReports, createGeminiSummarizer, reportId } from '../lib/progress-reports.mjs';
const H = 3_600_000;
const base = Date.parse('2026-09-27T00:00:00Z');
let clock = base;
function store() {
  const data = new Map(); let version = 0;
  return { data, gets: 0, puts: 0, conditionalWrites: true,
    async get(k) { this.gets++; return data.get(k) || null; },
    async put(k, bytes, options = {}) {
      if (options.ifVersion !== undefined && options.ifVersion !== (data.get(k)?.version || null)) throw Object.assign(new Error('conflict'), { code: 'storage_version_conflict' });
      this.puts++; data.set(k, { bytes: Buffer.from(bytes), version: String(++version) });
    }, async listKeys(prefix) { return [...data.keys()].filter(k => k.startsWith(prefix)); },
  };
}
const storage = store(); let calls = [];
const summarize = async (sessions, kind) => { calls.push({ sessions, kind }); return sessions.filter(s => s.evidence.includes('Implemented')).map(s => ({ ...s, evidence: undefined, bullets: ['已实现并验证新的功能。'] })); };
const make = options => createProgressReports({ storage, summarize, now: () => clock, collectingSince: base, flushMs: 1e9, ...options });
const record = (reporter, { machine = 'machine-a', session = 'session-a', text = 'Implemented and verified feature', timestamp = clock, role = 'assistant' } = {}) => reporter.record({
  manifest: { source: { ownerId: 'owner@example.com', machineId: machine, agentKind: 'codex', agentSessionId: session } },
  bytes: Buffer.from(JSON.stringify({ type: 'response_item', timestamp: new Date(timestamp).toISOString(), payload: { type: 'message', role, phase: role === 'assistant' ? 'final_answer' : undefined, content: [{ type: 'output_text', text }] } }) + '\n'),
});
const first = make(); first.start();
record(first); record(first); // duplicate content dedupes even across archive epochs
record(first, { session: 'idle', text: 'Still waiting' });
record(first, { session: 'prompt-only', text: 'Implemented?', role: 'user' });
record(first, { session: 'old', timestamp: base - 2 * 24 * H });
record(first, { machine: 'machine-b' });
assert.equal(storage.gets + storage.puts, 0, 'ingestion never calls storage or model in the ACK path');
clock = base + H + 180_000;
await Promise.all(Array.from({ length: 100 }, () => first.tick()));
assert.equal(calls.length, 2, '100 overlapping ticks create one chain; machines are isolated in model calls');
assert.ok(calls.every(c => new Set(c.sessions.map(s => s.machineId)).size === 1));
assert.equal(calls.flatMap(c => c.sessions).find(s => s.sessionId === 'session-a').evidence.match(/Implemented/g).length, 1);
let report = await first.read(reportId('hourly', base), () => true);
assert.equal(report.sessions.length, 2);
assert.equal((await first.read(report.id, () => false)).sessions.length, 0, 'no report content leaks to another viewer');
assert.equal((await first.read(report.id, id => id.endsWith(Buffer.from('machine-a').toString('base64url')))).sessions.length, 1);
await first.tick(); assert.equal(calls.length, 2, 'viewing/ticking saved reports does not call model again');
await first.stop();
const restarted = make(); restarted.start(); await restarted.tick(); assert.equal(calls.length, 2, 'restart reuses durable report');
await restarted.stop();
// A flushed journal survives a restart before its hour is summarized.
clock = base + 2 * H;
const collecting = make(); collecting.start(); record(collecting, { session: 'survives' }); await collecting.stop();
clock += H + 180_000;
const afterRestart = make(); afterRestart.start(); await afterRestart.tick();
assert.equal((await afterRestart.read(reportId('hourly', base + 2 * H), () => true)).sessions[0].sessionId, 'survives');
await afterRestart.stop();
// Daily generation consumes saved hourly summaries, rather than raw archive objects.
clock = Date.parse('2026-09-28T00:03:00+08:00');
const daily = make(); daily.start(); await daily.tick();
assert.ok(calls.some(c => c.kind === 'daily'));
assert.ok(calls.filter(c => c.kind === 'daily').every(c => c.sessions.every(s => s.evidence.includes('已实现'))));
assert.ok([...storage.data.keys()].every(k => k.startsWith('reports-v1/')), 'no full archive scans');
await daily.stop();
// Failing models retry at most 3 times, never once per UI request/timer tick.
clock = base;
const failingStore = store(); let failures = 0;
const fail = createProgressReports({ storage: failingStore, now: () => clock, collectingSince: base, flushMs: 1e9,
  summarize: async () => { failures++; throw new Error('test failure'); } });
fail.start(); record(fail); clock = base + H + 180_000;
await fail.tick(); await fail.tick(); assert.equal(failures, 1);
for (let i = 0; i < 5; i++) { clock += 16 * 60_000; await fail.tick(); }
assert.equal(failures, 3);
assert.equal((await fail.read(reportId('hourly', base), () => true)).status, 'failed');
await fail.stop();
// Invalid / fabricated model IDs and truncated generations fail closed.
const model = body => createGeminiSummarizer({ apiKey: 'test-only', fetchImpl: async () => ({ ok: true, json: async () => body }) });
await assert.rejects(model({ candidates: [{ finishReason: 'MAX_TOKENS' }] })([], 'hourly'), /did not complete/);
await assert.rejects(model({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"sessions":[{"id":"foreign","bullets":["leak"]}]}' }] } }] })([], 'hourly'), /invalid session/);
console.log('progress reports: scheduling, persistence, deduplication, access filtering, machine isolation, daily rollup and bounded retries passed');

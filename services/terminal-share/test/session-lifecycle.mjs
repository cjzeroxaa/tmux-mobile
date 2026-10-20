import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

// Exercise the actual DO state machine with persisted records and socket
// attachments; only the Cloudflare runtime boundary is replaced.
const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const protocolURL = moduleURL(stripTypeScriptTypes(await readFile(new URL('../src/protocol.ts', import.meta.url), 'utf8')));
const source = stripTypeScriptTypes((await readFile(new URL('../src/session-do.ts', import.meta.url), 'utf8'))
  .replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx) { this.ctx = ctx; } }')
  .replace('"./protocol"', JSON.stringify(protocolURL)));
const { TTYSession } = await import(moduleURL(source));
const frame = (type, payload = {}) => JSON.stringify({ type, payload });
function socket(attachment) {
  return {
    readyState: WebSocket.OPEN, messages: [], closed: null,
    deserializeAttachment: () => attachment,
    serializeAttachment(value) { attachment = value; },
    send(data) { this.messages.push(data); },
    close(code, reason) { this.closed = { code, reason }; },
  };
}
async function fixture(record) {
  const host = socket({ role: 'host' });
  const viewer = socket({ role: 'viewer', viewerId: 'viewer-1', viewerToken: 'token-1', snapshotRequestId: 'connection-1' });
  const store = new Map(record ? [['session', record]] : []);
  let initialized;
  const ctx = {
    blockConcurrencyWhile(fn) { initialized = fn(); },
    getWebSockets: () => [host, viewer],
    storage: {
      async get(key) { return structuredClone(store.get(key)); },
      async put(key, value) { store.set(key, structuredClone(value)); },
      async setAlarm(value) { store.set('alarm', value); },
      async deleteAlarm() { store.delete('alarm'); },
    },
  };
  const session = new TTYSession(ctx, {});
  await initialized;
  return { session, host, viewer, store };
}

test('explicit host exit ends this sharing run and keeps viewers connected to the pairing code', async () => {
  const { session, host, viewer, store } = await fixture();
  await session.webSocketMessage(host, frame('session.end'));
  const record = store.get('session');
  assert.equal(record.state, 'ended');
  assert.equal(record.endReason, 'host ended');
  assert.equal(record.hostDisconnectDeadline, null);
  assert(host.messages.some(data => JSON.parse(data).type === 'session.ended'));
  assert(viewer.messages.some(data => JSON.parse(data).payload?.state === 'ended'));
  assert.equal(viewer.closed, null);
  assert.equal(store.has('alarm'), true);
  session.record.sessionExpiresAt = Date.now() - 1;
  await session.alarm();
  const response = await session.fetch(new Request('https://session.internal/connect/host'));
  assert.equal(response.status, 410);
});

test('unexpected disconnect grants 180 seconds and clears pending and active control', async () => {
  const { session, host, viewer, store } = await fixture();
  session.record.currentControllerId = 'viewer-1';
  session.record.controlLeaseExpiresAt = Date.now() + 600_000;
  session.record.pendingRequest = { viewerId: 'viewer-1', leaseSeconds: 60 };
  session.record.pendingRequestExpiresAt = Date.now() + 30_000;
  const before = Date.now();
  await session.webSocketClose(host);
  const record = store.get('session');
  assert(record.hostDisconnectDeadline >= before + 180_000);
  assert(record.hostDisconnectDeadline <= Date.now() + 180_000);
  assert.equal(record.currentControllerId, null);
  assert.equal(record.pendingRequest, null);
  assert.equal(viewer.closed, null);
  const status = JSON.parse(viewer.messages.at(-1)).payload;
  assert.equal(status.hostState, 'reconnecting');
  assert.equal(status.canWrite, false);
  session.record.hostDisconnectDeadline = Date.now() - 1;
  await session.alarm();
  assert.equal(store.get('session').endReason, 'host disconnected');
  assert.equal(viewer.closed, null);
  assert.equal(store.get('session').state, 'ended');
});

test('hibernation cannot resurrect a closed session', async () => {
  const initial = await fixture();
  await initial.session.webSocketMessage(initial.host, frame('session.end'));
  initial.session.record.sessionExpiresAt = Date.now() - 1;
  await initial.session.alarm();
  const { session, viewer } = await fixture(initial.store.get('session'));
  assert.equal(session.record.state, 'closed');
  assert.equal(session.hostConnected, false);
  assert.equal(viewer.closed.code, 4000);
});

test('stale host cannot end or write into the current session', async () => {
  const { session, viewer } = await fixture();
  const stale = socket({ role: 'host' });
  await session.webSocketMessage(stale, frame('session.end'));
  await session.webSocketMessage(stale, Uint8Array.of(1, 65).buffer);
  assert.equal(session.record.state, 'active');
  assert.equal(viewer.messages.length, 0);
});

test('snapshot routing survives hibernation and rejects replaced connection replies', async () => {
  const { session, host, viewer } = await fixture();
  await session.webSocketMessage(host, frame('terminal.snapshot', { requestId: 'old-connection', data: 'old' }));
  assert.equal(viewer.messages.length, 0);
  await session.webSocketMessage(host, frame('terminal.snapshot', { requestId: 'connection-1', data: 'prompt $ ' }));
  assert.equal(JSON.parse(viewer.messages[0]).payload.data, 'prompt $ ');
});

test('history selection gets a fresh request id and rejects the old snapshot', async () => {
  const { session, host, viewer } = await fixture();
  await session.webSocketMessage(viewer, frame('terminal.snapshot.request', { lines: 2000 }));
  const request = JSON.parse(host.messages.at(-1));
  assert.equal(request.payload.lines, 2000);
  assert.notEqual(request.payload.requestId, 'connection-1');
  await session.webSocketMessage(host, frame('terminal.snapshot', { requestId: 'connection-1', data: 'stale' }));
  assert.equal(viewer.messages.length, 0);
  await session.webSocketMessage(host, frame('terminal.snapshot', { requestId: request.payload.requestId, data: 'history' }));
  assert.equal(JSON.parse(viewer.messages.at(-1)).payload.data, 'history');
});

test('uploads require current control, bind sender identity, and stop after revocation', async () => {
  const { session, host, viewer } = await fixture();
  const upload = frame('upload.start', { requestId: 'r1', id: 'file', size: 3, viewerId: 'spoofed' });
  host.messages.length = 0;
  await session.webSocketMessage(viewer, upload);
  assert.equal(host.messages.length, 0);
  assert.match(JSON.parse(viewer.messages.at(-1)).payload.error, /Take control/);
  session.record.allowControl = true;
  session.record.currentControllerId = 'viewer-1';
  session.record.controlLeaseExpiresAt = Date.now() + 60000;
  await session.webSocketMessage(viewer, upload);
  assert.equal(JSON.parse(host.messages.at(-1)).payload.viewerId, 'viewer-1');
  await session.webSocketMessage(host, frame('upload.result', { requestId: 'r1', viewerId: 'viewer-1', path: '/tmp/file' }));
  assert.equal(JSON.parse(viewer.messages.at(-1)).payload.path, '/tmp/file');
  await session.webSocketMessage(viewer, frame('control.release'));
  host.messages.length = 0;
  await session.webSocketMessage(viewer, frame('upload.chunk', { requestId: 'r2', id: 'file', data: 'YQ==', offset: 0 }));
  assert.equal(host.messages.length, 0);
});


test('hibernation preserves ended pairing codes and does not restart the grace countdown', async () => {
  const initial = await fixture();
  await initial.session.webSocketMessage(initial.host, frame('session.end'));
  const { session, viewer } = await fixture(initial.store.get('session'));
  await session.fetch(new Request('https://session.internal/status'));
  assert.equal(session.record.state, 'ended');
  assert.equal(session.record.hostDisconnectDeadline, null);
  assert.equal(viewer.closed, null);
});

test('closed records remain closed even when the end reason is a host exit', async () => {
  const initial = await fixture();
  const record = { ...initial.session.record, state: 'closed', endReason: 'host ended' };
  const { session } = await fixture(record);
  assert.equal(session.record.state, 'closed');
  const response = await session.fetch(new Request('https://session.internal/connect/host'));
  assert.equal(response.status, 410);
});

test('controller can release input permission while keeping the shared shell connected', async () => {
  const { session, host, viewer, store } = await fixture();
  session.record.currentControllerId = 'viewer-1';
  session.record.controlLeaseExpiresAt = Date.now() + 60_000;
  await session.webSocketMessage(viewer, frame('control.release'));
  assert.equal(store.get('session').currentControllerId, null);
  assert.equal(session.record.controlLeaseExpiresAt, null);
  assert.equal(session.record.state, 'active');
  assert.equal(session.hostConnected, true);
  assert.equal(host.closed, null);
  assert.equal(viewer.closed, null);
  assert.equal(JSON.parse(viewer.messages.at(-1)).payload.canWrite, false);
  host.messages.length = 0;
  await session.webSocketMessage(viewer, Uint8Array.of(2, 65).buffer);
  assert.equal(host.messages.length, 0);
});

test('read-only viewers cannot release another viewer’s control; the host can revoke it', async () => {
  const { session, host, viewer } = await fixture();
  session.record.currentControllerId = 'another-viewer';
  session.record.controlLeaseExpiresAt = Date.now() + 60_000;
  await session.webSocketMessage(viewer, frame('control.release'));
  assert.equal(session.record.currentControllerId, 'another-viewer');
  await session.webSocketMessage(host, frame('control.revoke'));
  assert.equal(session.record.currentControllerId, null);
  assert.equal(session.record.state, 'active');
  assert.equal(host.closed, null);
});

test('view-only share rejects control requests and binary input', async () => {
  const { session, host, viewer, store } = await fixture();
  session.record.allowControl = false;
  await session.webSocketMessage(viewer, frame('control.request'));
  assert.equal(session.record.pendingRequest, null);
  host.messages.length = 0;
  await session.webSocketMessage(viewer, new Uint8Array([2, 65]).buffer);
  assert.equal(host.messages.length, 0);
});

test('owner-enabled control grants one viewer, releases on disconnect, and cannot survive stop', async () => {
  const { session, host, viewer } = await fixture();
  session.record.allowControl = true;
  await session.webSocketMessage(viewer, frame('control.request'));
  assert.equal(session.record.pendingRequest.viewerId, 'viewer-1');
  await session.webSocketMessage(host, frame('control.approve', { viewerId: 'viewer-1' }));
  await session.webSocketMessage(viewer, new Uint8Array([2, 65]).buffer);
  assert(host.messages.some(value => value instanceof ArrayBuffer));
  await session.webSocketClose(viewer);
  assert.equal(session.record.currentControllerId, null);
  await session.fetch(new Request('https://session.internal/end', { method: 'POST' }));
  const response = await session.fetch(new Request('https://session.internal/connect/host'));
  assert.equal(response.status, 410);
});

for (const days of [600 / 86400, 1, 5, 7]) test(`${days}-day expiry survives hibernation and ends exactly at its deadline`, async () => {
  const { session, store } = await fixture();
  session.record.state = 'idle';
  const expiresAt = Date.now() + days * 86400000;
  const response = await session.fetch(new Request('https://session.internal/init', { method: 'POST', body: JSON.stringify({ allowControl: true, expiresAt }) }));
  assert.equal(response.status, 200);
  assert.equal(store.get('session').maxExpiresAt, expiresAt);
  const restored = await fixture(store.get('session'));
  assert.equal(restored.session.record.sessionExpiresAt, expiresAt);
  const now = Date.now;
  try {
    Date.now = () => expiresAt - 1;
    await restored.session.alarm();
    assert.notEqual(restored.session.record.state, 'closed');
    Date.now = () => expiresAt;
    await restored.session.alarm();
    assert.equal(restored.session.record.state, 'closed');
  } finally { Date.now = now; }
});
test('DO refuses expired and over-limit shares', async () => {
  for (const expiresAt of [Date.now() - 1, Date.now() + 8 * 86400000]) {
    const { session } = await fixture(); session.record.state = 'idle';
    assert.equal((await session.fetch(new Request('https://session.internal/init', { method: 'POST', body: JSON.stringify({ expiresAt }) }))).status, 400);
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const source = stripTypeScriptTypes(await readFile(new URL('../src/input-control.ts', import.meta.url), 'utf8'));
const { InputControl } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const available = { allowControl: true, hostConnected: true, state: 'active', canWrite: false };
const granted = { ...available, canWrite: true, controllerViewerId: 'me' };
function fixture() {
  const sent = [], control = new InputControl(type => sent.push(type));
  return { sent, control };
}

test('permitted links request once on open and enable input only after the grant', () => {
  const { control, sent } = fixture();
  control.update(available);
  control.update(available); // Repeated status/resize before acknowledgment.
  assert.deepEqual(sent, ['control.request']);
  assert.equal(control.writable, false);
  control.update({ ...available, hasPendingControlRequest: true, pendingControlRequest: { viewerId: 'me' } });
  control.update(granted);
  assert.equal(control.writable, true);
  assert.equal(control.locked, false);
  assert.deepEqual(sent, ['control.request']);
});

test('read-only, disconnected, ended and closed links never request or enable input', () => {
  for (const patch of [{ allowControl: false }, { hostConnected: false }, { state: 'ended' }, { state: 'closed' }]) {
    const { control, sent } = fixture();
    control.update({ ...available, ...patch });
    assert.deepEqual(sent, []);
    control.update({ ...granted, ...patch });
    assert.equal(control.writable, false);
  }
  const { control, sent } = fixture();
  control.update({ ...available, allowControl: false });
  control.toggle();
  assert.equal(control.locked, false);
  assert.deepEqual(sent, []);
});

test('Lock blocks input immediately and stays locked through statuses and reconnect', () => {
  const { control, sent } = fixture();
  control.update(granted);
  control.toggle();
  assert.equal(control.writable, false);
  assert.deepEqual(sent, ['control.release']);
  control.update(granted); // Stale grant while the release is in flight.
  control.update(available);
  control.reset();
  control.update(available);
  assert.equal(control.locked, true);
  assert.equal(control.writable, false);
  assert.deepEqual(sent, ['control.release']);
  control.toggle();
  assert.deepEqual(sent, ['control.release', 'control.request']);
  control.update(granted);
  assert.equal(control.writable, true);
});

test('reconnect and lease expiry recover control automatically when unlocked', () => {
  const { control, sent } = fixture();
  control.update(granted);
  control.reset();
  assert.equal(control.writable, false);
  control.update(available);
  control.update(granted);
  control.update(available); // Expired lease.
  control.update(granted);
  assert.equal(control.writable, true);
  assert.deepEqual(sent, ['control.request', 'control.request']);
});

test('another viewer or pending request is respected; a free terminal is acquired', () => {
  for (const busy of [{ controllerViewerId: 'other' }, { hasPendingControlRequest: true }]) {
    const { control, sent } = fixture();
    control.update({ ...available, ...busy });
    assert.deepEqual(sent, []);
    assert.equal(control.writable, false);
    control.update(available);
    assert.deepEqual(sent, ['control.request']);
  }
});

test('Lock during automatic acquisition releases a late grant without allowing input', () => {
  const { control, sent } = fixture();
  control.update(available);
  control.toggle();
  control.update(granted);
  assert.equal(control.writable, false);
  control.update(granted);
  control.update(available);
  assert.deepEqual(sent, ['control.request', 'control.release']);
});

test('rapid Lock then Unlock waits for release acknowledgment before reacquiring', () => {
  const { control, sent } = fixture();
  control.update(granted);
  control.toggle();
  control.toggle();
  assert.equal(control.writable, false);
  control.update(available);
  assert.deepEqual(sent, ['control.release', 'control.request']);
  control.update(granted);
  assert.equal(control.writable, true);
});

test('a rejected request does not spin; reconnect or explicit unlock can retry', () => {
  const { control, sent } = fixture();
  control.update(available);
  control.update({ ...available, hasPendingControlRequest: true, pendingControlRequest: { viewerId: 'me' } });
  control.update(available);
  control.update(available);
  assert.deepEqual(sent, ['control.request']);
  control.toggle(); control.toggle();
  assert.deepEqual(sent, ['control.request', 'control.request']);
});

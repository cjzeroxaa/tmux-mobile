import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createReadScope, createRefreshLoop } from '../public/view-work.mjs';

// The former metadata-loop leak is covered at the shared refresh scheduler now.
mock.timers.enable({ apis: ['setTimeout'] });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function harness(period = 3000) {
  let active = true, calls = 0, inflight = 0, maximum = 0;
  const pending = [];
  const loop = createRefreshLoop({
    active: () => active,
    interval: () => period,
    refresh: async () => {
      calls++; maximum = Math.max(maximum, ++inflight);
      await new Promise(resolve => pending.push(resolve));
      inflight--;
    },
  });
  return { loop, pending, calls: () => calls, maximum: () => maximum,
    stop() { active = false; loop.stop(); },
    start() { active = true; return loop.refresh(); },
  };
}
// 100 slow restarts: the current request must settle before ONE fresh request.
{
  const h = harness(); h.start(); await flush();
  for (let i = 0; i < 100; i++) { h.stop(); h.start(); }
  await flush(); assert.equal(h.calls(), 1);
  h.pending.shift()(); await flush(); assert.equal(h.calls(), 2);
  h.pending.shift()(); await flush();
  mock.timers.tick(3000); await flush(); assert.equal(h.calls(), 3);
  assert.equal(h.maximum(), 1);
  h.stop(); h.pending.shift()(); await flush();
  mock.timers.tick(600000); await flush(); assert.equal(h.calls(), 3);
}
// List refresh is an event, never a recurring task (ten minutes virtual time).
{
  const h = harness(0); h.start(); await flush();
  for (let i = 0; i < 100; i++) h.loop.refresh();
  assert.equal(h.calls(), 1); h.pending.shift()(); await flush();
  mock.timers.tick(600000); await flush(); assert.equal(h.calls(), 1);
  h.stop(); h.start(); await flush(); assert.equal(h.calls(), 2);
  h.pending.shift()(); await flush(); h.stop();
}
// A successful write can request one trailing read, even with auto-refresh off.
{
  const h = harness(0); h.start(); await flush();
  for (let i = 0; i < 100; i++) h.loop.refresh({ after: true });
  h.pending.shift()(); await flush(); assert.equal(h.calls(), 2);
  h.pending.shift()(); await flush();
  mock.timers.tick(600000); await flush(); assert.equal(h.calls(), 2);
  h.stop();
}
// Transport deliberately ignores abort: old responses still cannot be applied.
{
  let resolve, key = 'machine-a:tmux:@1', reloads = 0;
  globalThis.window = { location: { reload() { reloads++; } } };
  const scope = createReadScope(() => key); scope.activate();
  globalThis.fetch = () => new Promise(r => { resolve = r; });
  let written = false;
  const old = scope.json('/api/window-view').then(() => { written = true; }, e => assert.equal(e.silent, true));
  scope.stop(); scope.activate(); key = 'machine-b:rmux:@1';
  resolve({ ok: true, json: async () => ({ text: 'old target' }) }); await old;
  assert.equal(written, false);
  let delayed = 0; scope.delay(() => delayed++, 100); scope.stop(); scope.activate();
  mock.timers.tick(1000); assert.equal(delayed, 0);
  // 403 stays local; 401 stops all scopes and requests a login document once.
  globalThis.fetch = async () => ({ status: 403, ok: false, json: async () => ({ error: 'Forbidden' }) });
  await assert.rejects(scope.json('/api/window-view'), { status: 403 }); assert.equal(scope.active, true);
  const other = createReadScope(); other.activate();
  globalThis.fetch = async () => ({ status: 401, ok: false });
  await assert.rejects(scope.json('/api/window-view'), { silent: true });
  assert.equal(scope.active, false); assert.equal(other.active, false); assert.equal(reloads, 1);
  await assert.rejects(other.json('/api/machines'), { silent: true });
}
mock.timers.reset();
console.log('view refresh: 100 slow restarts, single flight, stop, 10min list idle, write refresh, stale target, 401/403 passed');

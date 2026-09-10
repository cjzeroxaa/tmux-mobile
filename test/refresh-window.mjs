import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createRefreshWindow, TERMINAL_REFRESH_WINDOW_MS } from '../public/refresh-window.mjs';
import { createReadScope, createRefreshLoop } from '../public/view-work.mjs';

mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
assert.equal(TERMINAL_REFRESH_WINDOW_MS, 300000);
let expirations = 0;
const budget = createRefreshWindow({ onExpire() { expirations++; } });
budget.renew();
mock.timers.tick(299999);
assert.equal(budget.expired, false);
budget.renew(); // focus renews the deadline, not a counter affected by latency
mock.timers.tick(299999);
assert.equal(budget.expired, false);
mock.timers.tick(1);
assert.equal(budget.expired, true);
assert.equal(expirations, 1);
mock.timers.tick(60 * 24 * 60 * 60 * 1000);
assert.equal(expirations, 1, 'idle for two months must not repeat work');
budget.renew(); budget.stop();
mock.timers.tick(300000);
assert.equal(expirations, 1, 'leaving the view cancels the deadline');

// Same scheduler/scope integration as the terminal. A transport ignoring abort
// must neither apply a stale response nor resume after the deadline expires.
let calls = 0, inFlight = 0, maximum = 0, applied = 0;
const requests = [];
globalThis.fetch = () => {
  calls++; maximum = Math.max(maximum, ++inFlight);
  return new Promise(resolve => requests.push(() => {
    inFlight--;
    resolve({ ok: true, json: async () => ({ text: 'output' }) });
  }));
};
const scope = createReadScope(); scope.activate();
const window = createRefreshWindow({ onExpire() { loop.stop(); scope.invalidate(); } });
const loop = createRefreshLoop({
  active: () => scope.active && !window.expired,
  interval: () => 3000,
  refresh: async () => { await scope.json('/api/window-view'); applied++; },
});
window.renew(); loop.refresh(); await flush();
mock.timers.tick(300000);
requests.shift()(); await flush();
assert.equal(applied, 0);
mock.timers.tick(300000); await flush();
assert.equal(calls, 1);
assert.equal(window.expired, true);

// Resume once, then 100 focus renewals during a slow read: one request/chain.
window.renew(); loop.refresh(); await flush();
for (let i = 0; i < 100; i++) { window.renew(); loop.refresh(); }
assert.equal(calls, 2);
requests.shift()(); await flush();
mock.timers.tick(3000); await flush();
assert.equal(calls, 3); assert.equal(maximum, 1);
requests.shift()(); await flush();
// Target switch renews while old deadline is nearly exhausted.
mock.timers.tick(296000); await flush();
scope.invalidate(); loop.stop(); window.renew(); loop.refresh();
requests.shift()?.(); await flush(); requests.shift()?.(); await flush();
mock.timers.tick(1000); await flush();
assert.equal(window.expired, false);
scope.stop(); loop.stop(); window.stop();
requests.shift()?.(); await flush();
const stoppedCalls = calls;
mock.timers.tick(600000); await flush();
assert.equal(calls, stoppedCalls);
mock.timers.reset();
console.log('Terminal refresh window: 5min expiry, focus/target renewal, 100 slow restarts, late responses, two months idle and stop passed');

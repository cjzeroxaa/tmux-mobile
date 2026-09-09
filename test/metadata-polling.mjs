import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the browser's actual timer lifecycle without network or a DOM.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('let metadataPollGeneration ='), source.indexOf('// When the tab is hidden'));
function harness() {
  let id = 0, calls = 0;
  const timers = new Map(), pending = [];
  const state = { runtimeMode: 'hub', machines: [{}], sessions: [{}], metadataTimer: null };
  const context = vm.createContext({
    state,
    window: {
      setTimeout(fn) { timers.set(++id, fn); return id; },
      clearTimeout(key) { timers.delete(key); },
    },
    metadataPollInterval: () => 5000,
    metadataPollTick() { calls++; return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
  });
  vm.runInContext(code, context);
  return { context, state, timers, pending, calls: () => calls,
    fire() { const [key, fn] = timers.entries().next().value; timers.delete(key); return fn(); },
  };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

// Repeated refreshTree/visibility starts during a slow request must not fan out.
{
  const h = harness();
  for (let i = 0; i < 100; i++) h.context.startMetadataPolling();
  assert.equal(h.calls(), 1);
  h.pending.shift().resolve(); await flush();
  assert.equal(h.timers.size, 1);
  // Restart exactly while a periodic callback is awaiting the network.
  const tick = h.fire();
  for (let i = 0; i < 100; i++) h.context.startMetadataPolling();
  assert.equal(h.calls(), 2);
  h.pending.shift().resolve(); await tick; await flush();
  assert.equal(h.timers.size, 1, 'old callback must not resurrect another polling chain');
}
// Stopping while awaiting must stay stopped after the old request resolves.
{
  const h = harness(); h.context.startMetadataPolling(); h.context.stopMetadataPolling();
  h.pending.shift().resolve(); await flush();
  assert.equal(h.timers.size, 0);
}
// A failed request can recover, and disconnected state cannot re-arm old work.
{
  const h = harness(); h.context.startMetadataPolling();
  h.pending.shift().reject(new Error('network failed')); await flush();
  assert.equal(h.timers.size, 1);
  const tick = h.fire(); h.state.machines = []; h.context.startMetadataPolling();
  h.pending.shift().resolve(); await tick; await flush();
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls(), 2);
}
console.log('metadata polling: slow restart, stop, failure, disconnect passed');

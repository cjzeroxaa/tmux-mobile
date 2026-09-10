import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../public/spa-router.mjs', import.meta.url), 'utf8');
// Keep the actual router, replacing only HTML/module I/O with deferred loads.
const start = source.indexOf('async function loadView(route)');
const end = source.indexOf('async function mount(', start);
const code = source.slice(0, start) + source.slice(end);
const waiting = new Map(), records = new Map();
const location = { pathname: '/', search: '' };
let syntheticEvents = 0;
const context = vm.createContext({
  console,
  history: { pushState() {} },
  window: { location, addEventListener() {}, dispatchEvent() { syntheticEvents++; } },
  document: { title: '', getElementById() { return {}; }, addEventListener() {} },
  loadView(route) {
    return new Promise(resolve => waiting.set(route, () => {
      const record = { active: 0, stopped: 0, wrapper: { hidden: true } };
      records.set(route, record);
      resolve({ wrapper: record.wrapper, title: route, module: {
        activateView() { record.active++; }, deactivateView() { record.stopped++; },
      } });
    }));
  },
});
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
vm.runInContext(code, context);
vm.runInContext('navigate("/app", "?windowId=@1"); navigate("/", "");', context);
waiting.get('app')(); await flush();
assert.equal(records.get('app').active, 0, 'stale import must never activate');
assert.equal(records.get('app').wrapper.hidden, true);
waiting.get('command-center')(); await flush();
assert.equal(records.get('command-center').active, 1, 'initial load only activates once');
for (let i = 0; i < 100; i++) vm.runInContext('navigate("/app", ""); navigate("/", "");', context);
await flush();
assert.equal(records.get('app').wrapper.hidden, true);
assert.equal(records.get('app').active, 0);
assert.equal(records.get('command-center').wrapper.hidden, false);
assert.equal(records.get('command-center').active, 2);
assert.equal(syntheticEvents, 0, 'popstate must not recursively refresh views');
await vm.runInContext('navigate("/app", "");', context);
assert.equal(records.get('command-center').wrapper.hidden, true);
assert.equal(records.get('app').active, 1);
console.log('SPA lifecycle: late imports, first activation, 100 rapid switches, pause and popstate passed');

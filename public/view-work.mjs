// Keep a view's DOM alive while stopping its network work when it is hidden.
let authExpired = false;
const scopes = new Set();

function cancelled() {
  return Object.assign(new Error("View request cancelled"), { name: "AbortError", silent: true });
}

export function createReadScope(target = () => "") {
  let active = false, generation = 0;
  let controller = new AbortController();
  const timers = new Set();
  const scope = {
    get active() { return active && !authExpired; },
    get generation() { return generation; },
    activate() { active = true; },
    invalidate() {
      generation++;
      controller.abort();
      controller = new AbortController();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
    stop() { active = false; scope.invalidate(); },
    delay(callback, ms) {
      if (!scope.active) return;
      const version = generation, key = target();
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (scope.active && version === generation && key === target()) callback();
      }, ms);
      timers.add(timer);
      return timer;
    },
    async json(path, options = {}) {
      const read = ["GET", "HEAD"].includes(String(options.method || "GET").toUpperCase());
      if (authExpired || (read && !scope.active)) throw cancelled();
      const version = generation, key = target();
      const valid = () => !read || (scope.active && version === generation && key === target());
      try {
        const response = await fetch(path, {
          cache: "no-store", ...options,
          ...(read ? { signal: controller.signal } : {}),
        });
        if (!valid()) throw cancelled();
        if (response.status === 401) {
          authExpired = true;
          for (const item of scopes) item.stop();
          // A document navigation returns the existing login screen and clears
          // all old timers, including work in the other SPA view.
          window.location.reload();
          throw cancelled();
        }
        let json = {};
        try { json = await response.json(); } catch {}
        if (!valid()) throw cancelled();
        if (!response.ok) throw Object.assign(new Error(json.error || `HTTP ${response.status}`), { status: response.status });
        return json;
      } catch (error) {
        if (!valid() || error.name === "AbortError") throw cancelled();
        throw error;
      }
    },
  };
  scopes.add(scope);
  return scope;
}

// One in-flight refresh and at most one timer. A stop/restart retains the
// in-flight promise until it settles, even if the transport ignores abort.
export function createRefreshLoop({ refresh, active, interval = () => 0 }) {
  let timer = null, pending = null, generation = 0, trailing = false;
  function stop() {
    generation++;
    trailing = false;
    clearTimeout(timer);
    timer = null;
  }
  function schedule() {
    clearTimeout(timer);
    timer = null;
    const ms = interval();
    if (active() && ms > 0) timer = setTimeout(() => { timer = null; void run(); }, ms);
  }
  function run({ after = false } = {}) {
    if (!active()) return Promise.resolve();
    clearTimeout(timer);
    timer = null;
    if (pending) {
      trailing ||= after || pending.generation !== generation;
      return pending.promise;
    }
    const entry = { generation, promise: null };
    pending = entry;
    entry.promise = Promise.resolve().then(() => {
      if (active() && entry.generation === generation) return refresh();
    }).catch((error) => {
      if (!error.silent) console.error("View refresh failed", error);
    }).finally(() => {
      pending = null;
      if (!active()) return;
      if (trailing) { trailing = false; void run(); }
      else if (entry.generation === generation) schedule();
    });
    return entry.promise;
  }
  return { refresh: run, stop, schedule };
}

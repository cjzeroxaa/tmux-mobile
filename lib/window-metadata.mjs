// Per-window metadata extraction (design-first, extensible).
//
// Each metadata field is a descriptor in WINDOW_METADATA. Two kinds:
//
//   - live:    cheap, derived synchronously from the tmux window row (which the
//              window list already fetched). Recomputed every refresh, e.g.
//              agentType from the running command. `compute(win) -> value`.
//
//   - cwdScoped: derived from the working directory via an async resolver that
//              hits the agent (git, etc.). Cached by (key, cwd) with a TTL, so
//              it only re-resolves when the cwd changes or the entry goes stale.
//              `resolve(cwd, backend) -> value`, `ttlMs`.
//
// Adding a new metadata field = adding one descriptor here. Consumers call
// computeWindowMetadata(windows, backend) and get { [windowId]: {...fields} }.
//
// Note: `now` is injected (not Date.now()) so callers/tests stay deterministic;
// server.mjs passes Date.now().

// Known AI agent types. Extend as new agents appear.
const AGENT_NAMES = ["claude", "codex", "gemini"];
const AGENT_BY_COMMAND = new Map(AGENT_NAMES.map((n) => [n, n]));

// Interpreters that may launch an agent as a script — when the foreground
// command is one of these, the agent name only shows up in the full argv (e.g.
// `node /usr/bin/codex`), so we look deeper via the full command line.
const INTERPRETERS = new Set([
  "node",
  "node.js",
  "nodejs",
  "bun",
  "deno",
  "python",
  "python3",
  "ruby",
  "npx",
]);

export function isInterpreter(command) {
  if (!command) return false;
  return INTERPRETERS.has(String(command).trim().toLowerCase());
}

// Detect an agent from the bare foreground command name (pane_current_command).
// Returns null when it's not directly an agent (it may still be one launched via
// an interpreter — see detectAgentFromCommandLine).
export function detectAgentType(command) {
  if (!command) return null;
  const base = String(command).trim().toLowerCase();
  return AGENT_BY_COMMAND.get(base) || null;
}

// Detect an agent from a full command line, e.g. "node /usr/bin/codex --yolo".
// Looks for an agent name as a path basename of any whitespace-separated token,
// so it matches /usr/bin/codex, codex.js, ./gemini, etc. — but not arbitrary
// substrings (a flag like --codex-mode won't false-match because it's not a
// path basename equal to the agent name… we still guard with word boundaries).
//
// Fallback: the modern npm install runs the agent as `node <pkg>/…/cli.js`,
// where the basename is `cli` and the agent name only survives as a PACKAGE
// DIRECTORY segment (e.g. node …/@openai/codex/dist/cli.js). Without matching
// the path segment, such a session is mislabeled as plain "node" — which broke
// the window title and the Codex-specific UI (Answer question). So after the
// basename pass, check whether any token contains `/<agent>/` as a full path
// segment. Bounded by slashes, so `codex-cli/` or `codextools/` don't match.
export function detectAgentFromCommandLine(commandLine) {
  if (!commandLine) return null;
  const tokens = String(commandLine).trim().split(/\s+/);
  for (const token of tokens) {
    // basename without directory or .js/.mjs extension
    const base = token
      .replace(/^.*[/\\]/, "")
      .replace(/\.(c?js|mjs|ts)$/i, "")
      .toLowerCase();
    if (AGENT_BY_COMMAND.has(base)) return AGENT_BY_COMMAND.get(base);
  }
  for (const token of tokens) {
    const lower = token.toLowerCase();
    for (const name of AGENT_NAMES) {
      // `/<name>/` — a whole path segment (leading slash so a bare arg can't
      // match, trailing slash so it's a directory, not `<name>-something`).
      if (lower.includes(`/${name}/`)) return name;
    }
  }
  return null;
}

export function detectCommandCenterAgentType(commands = []) {
  for (const command of commands) {
    const kind = detectAgentType(command) || detectAgentFromCommandLine(command);
    if (kind === "codex" || kind === "claude") return kind;
  }
  return null;
}

// How long to cache a tty's resolved foreground command line (the `ps` lookup
// for interpreter-launched agents). Short — the running program can change.
const PANECMD_TTL_MS = 15 * 1000;

export const WINDOW_METADATA = [
  {
    // agentType is special: the cheap pane_current_command check is done inline
    // in computeWindowMetadata, with a `ps`-based fallback for interpreters.
    key: "agentType",
    live: true,
    compute: (win) => detectAgentType(win.activeCommand),
  },
  {
    key: "repo",
    cwdScoped: true,
    ttlMs: 10 * 60 * 1000, // 10 min; accuracy is not critical, staleness is fine
    resolve: async (cwd, backend) => {
      const r = await backend.repo(cwd);
      // Normalize to null when there's no usable repo so the client can treat it
      // as "no repo" rather than an empty-fields object.
      return r && r.owner && r.name ? r : null;
    },
  },
  {
    key: "git",
    cwdScoped: true,
    ttlMs: 30 * 1000, // branch changes more often than the repo; short TTL
    resolve: async (cwd, backend) => backend.branch(cwd),
  },
];

// A simple (key, cwd) -> { value, expires } cache. One instance per server.
export function createMetadataCache() {
  const store = new Map();
  const cacheKey = (key, cwd) => `${key}\0${cwd}`;
  return {
    get(key, cwd, now) {
      const hit = store.get(cacheKey(key, cwd));
      if (hit && hit.expires > now) return hit;
      return null;
    },
    set(key, cwd, value, expires) {
      store.set(cacheKey(key, cwd), { value, expires });
    },
    // Drop expired entries (best-effort housekeeping). Cheap; called opportunistically.
    prune(now) {
      for (const [k, v] of store) if (v.expires <= now) store.delete(k);
    },
  };
}

// Compute metadata for a list of windows. `windows` are the objects from
// listWindows() (need .id and .cwd and .activeCommand). `backend` is the
// current Backend (local or per-machine remote). `cache` from
// createMetadataCache(); `now` is the current epoch ms.
export async function computeWindowMetadata(windows, backend, cache, now) {
  const result = {};
  for (const win of windows) result[win.id] = {};

  // Live fields: synchronous, no I/O.
  for (const desc of WINDOW_METADATA) {
    if (!desc.live) continue;
    for (const win of windows) {
      result[win.id][desc.key] = desc.compute(win);
    }
  }

  // agentType fallback: for windows whose foreground command is an interpreter
  // (node/python/...) and didn't match an agent name directly, look at the full
  // command line via `ps` so e.g. `node /usr/bin/codex` is recognized as codex.
  // Cached by tty (short TTL) to avoid running ps every refresh; only the
  // interpreter windows pay the cost.
  if (backend && typeof backend.paneCommand === "function") {
    const needsLookup = windows.filter(
      (w) => !result[w.id].agentType && w.tty && isInterpreter(w.activeCommand),
    );
    const uniqueTtys = [...new Set(needsLookup.map((w) => w.tty))];
    const agentByTty = new Map();
    await Promise.all(
      uniqueTtys.map(async (tty) => {
        const cached = cache.get("paneAgent", tty, now);
        if (cached) {
          agentByTty.set(tty, cached.value);
          return;
        }
        let agent = null;
        try {
          const { command } = await backend.paneCommand(tty);
          agent = detectAgentFromCommandLine(command);
        } catch {
          agent = null;
        }
        cache.set("paneAgent", tty, agent, now + PANECMD_TTL_MS);
        agentByTty.set(tty, agent);
      }),
    );
    for (const win of needsLookup) {
      const agent = agentByTty.get(win.tty);
      if (agent) result[win.id].agentType = agent;
    }
  }

  // cwd-scoped fields: resolve per UNIQUE cwd (windows sharing a cwd reuse the
  // same lookup + cache entry), honoring the TTL cache.
  const cwdScoped = WINDOW_METADATA.filter((d) => d.cwdScoped);
  await Promise.all(
    cwdScoped.map(async (desc) => {
      const uniqueCwds = [...new Set(windows.map((w) => w.cwd).filter(Boolean))];
      const valueByCwd = new Map();
      await Promise.all(
        uniqueCwds.map(async (cwd) => {
          const cached = cache.get(desc.key, cwd, now);
          if (cached) {
            valueByCwd.set(cwd, cached.value);
            return;
          }
          let value = null;
          try {
            value = await desc.resolve(cwd, backend);
          } catch {
            value = null; // a failed resolver yields no metadata, never an error
          }
          cache.set(desc.key, cwd, value, now + desc.ttlMs);
          valueByCwd.set(cwd, value);
        }),
      );
      for (const win of windows) {
        result[win.id][desc.key] = win.cwd ? valueByCwd.get(win.cwd) ?? null : null;
      }
    }),
  );

  cache.prune(now);
  return result;
}

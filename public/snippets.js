export const DEFAULT_SNIPPETS = Object.freeze([
  Object.freeze({ text: "yes" }),
  Object.freeze({ text: "continue" }),
  Object.freeze({ text: "/clear" }),
  Object.freeze({ text: "/btw " }),
  Object.freeze({ text: "claude" }),
  Object.freeze({ text: "codex" }),
  Object.freeze({ text: "/goal " }),
]);

const SNIPPETS_KEY = "tmux-mobile-snippets";
const MIGRATED_KEY = "tmux-mobile-snippets-server-migrated-v1";
const DIRTY_KEY = "tmux-mobile-snippets-server-dirty-v1";
const MAX_SNIPPETS = 100;
const MAX_SNIPPET_CHARS = 2000;

const listeners = new Set();
let items = readLocalSnippets().items;
let initPromise = null;

function cloneDefaults() {
  return DEFAULT_SNIPPETS.map((item) => ({ ...item }));
}

function sanitizeSnippets(input, fallback = cloneDefaults()) {
  if (!Array.isArray(input)) return fallback.map((item) => ({ ...item }));
  const clean = [];
  for (const item of input.slice(0, MAX_SNIPPETS)) {
    const raw = typeof item === "string" ? item : item?.text;
    if (typeof raw !== "string") continue;
    const text = raw.slice(0, MAX_SNIPPET_CHARS);
    if (text.trim()) clean.push({ text });
  }
  return clean;
}

function sameSnippets(a, b) {
  const aa = sanitizeSnippets(a, []);
  const bb = sanitizeSnippets(b, []);
  return JSON.stringify(aa) === JSON.stringify(bb);
}

function readLocalSnippets() {
  try {
    const raw = localStorage.getItem(SNIPPETS_KEY);
    if (!raw) return { exists: false, items: cloneDefaults() };
    const parsed = JSON.parse(raw);
    return { exists: true, items: sanitizeSnippets(parsed?.items) };
  } catch {
    return { exists: false, items: cloneDefaults() };
  }
}

function writeLocalSnippets(next) {
  try {
    localStorage.setItem(SNIPPETS_KEY, JSON.stringify({ items: sanitizeSnippets(next) }));
  } catch {}
}

function markMigrated() {
  try {
    localStorage.setItem(MIGRATED_KEY, "1");
  } catch {}
}

function markDirty() {
  try {
    localStorage.setItem(DIRTY_KEY, "1");
  } catch {}
}

function clearDirty() {
  try {
    localStorage.removeItem(DIRTY_KEY);
  } catch {}
}

function hasMigrated() {
  try {
    return localStorage.getItem(MIGRATED_KEY) === "1";
  } catch {
    return true;
  }
}

function hasDirty() {
  try {
    return localStorage.getItem(DIRTY_KEY) === "1";
  } catch {
    return false;
  }
}

function notify() {
  for (const listener of listeners) {
    try {
      listener(getSnippets());
    } catch {}
  }
}

async function fetchServerSnippets() {
  const response = await fetch("/api/snippets", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`snippets load failed: ${response.status}`);
  return response.json();
}

async function persistServerSnippets(next) {
  const response = await fetch("/api/snippets", {
    method: "PUT",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ items: sanitizeSnippets(next, []) }),
  });
  if (!response.ok) throw new Error(`snippets save failed: ${response.status}`);
  return response.json();
}

export function getSnippets() {
  return sanitizeSnippets(items);
}

export function setSnippets(next) {
  items = sanitizeSnippets(next, []);
  writeLocalSnippets(items);
  notify();
  persistServerSnippets(items)
    .then(() => {
      markMigrated();
      clearDirty();
    })
    .catch(() => {
      // localStorage remains the immediate fallback; a later page load retries.
      markDirty();
    });
}

export function onSnippetsChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function initSnippets() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const local = readLocalSnippets();
    try {
      const remote = await fetchServerSnippets();
      const remoteItems = sanitizeSnippets(remote?.items);
      const shouldMigrateLocal =
        !hasMigrated() &&
        local.exists &&
        remote?.customized === false &&
        !sameSnippets(local.items, remoteItems);
      const shouldPushLocal = hasDirty() || shouldMigrateLocal;

      if (shouldPushLocal && local.exists) {
        items = sanitizeSnippets(local.items);
        writeLocalSnippets(items);
        notify();
        const saved = await persistServerSnippets(items);
        items = sanitizeSnippets(saved?.items, items);
        clearDirty();
      } else {
        items = remoteItems;
      }
      writeLocalSnippets(items);
      markMigrated();
      notify();
    } catch {
      items = sanitizeSnippets(local.items);
      notify();
    }
  })();
  return initPromise;
}

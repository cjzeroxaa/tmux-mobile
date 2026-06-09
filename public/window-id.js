// Pure helpers for a window's stable, copy-pasteable identity. Kept
// dependency-free (no DOM, no app state) so they can be unit-tested in node and
// imported by app.js in the browser — same cross-env pattern as linkify.js.
//
// The "stable id" is "host/session:index", built from the same
// [machine, session, index] tuple the attention layer keys on (windowRecentKey).
// Unlike the live tmux pane id, it survives tmux restarts, so it's the right
// thing to quote in a bug report or to switch back to a window later.

// Stable identity key for a window, used to line up "unread/seen" content
// hashes and attention descriptors across machines. Both the live-window side
// (windowRecentKey) and the cross-machine attention side (attentionKey) MUST
// build the key the same way — route both through this one function so they
// can never drift. The unit-separator (U+001F) join keeps segments unambiguous
// even if a session name contains other punctuation.
//
// fields: { machineId, sessionName, index }
export function windowKey({ machineId, sessionName, index } = {}) {
  return [machineId || "local", sessionName ?? "", index].join("");
}

// MRU insert into a recents list: drop any existing entry with the same key,
// put the new one at the front, cap the length. Pure so the global-recents
// store logic is unit-testable. entries/entry are {key, ...} objects.
export function mergeRecent(entries, entry, max) {
  const rest = (entries || []).filter((e) => e.key !== entry.key);
  return [entry, ...rest].slice(0, max);
}

// Drop closed windows from a cross-machine recents list. We only have ground
// truth for ONE machine at a time (myMachine + the set of its live window
// keys), so an entry is removed only when it belongs to that machine AND its
// key is no longer live. Entries for other machines are kept (unverifiable from
// here). Pure; entries are {key, machineId, ...}.
export function pruneRecent(entries, myMachine, liveKeys) {
  const my = myMachine || "";
  const live = liveKeys instanceof Set ? liveKeys : new Set(liveKeys || []);
  return (entries || []).filter((e) => {
    const onThisMachine = (e.machineId || "") === my;
    return !onThisMachine || live.has(e.key);
  });
}

// Collapse a /home/<user> or /Users/<user> or /root prefix to "~". Mirrors
// app.js abbrevHome so the descriptor's path matches what the topbar shows.
export function abbrevHome(value) {
  return String(value || "")
    .replace(/^\/(?:Users|home)\/[^/]+/, "~")
    .replace(/^\/root(?=\/|$)/, "~");
}

// fields:
//   host        resolved hostname (machine hostname → machine id → page host)
//   sessionName tmux session name (falls back to session id upstream)
//   index       tmux window index
export function windowStableId({ host, sessionName, index } = {}) {
  const h = host || "local";
  const s = sessionName == null ? "" : String(sessionName);
  return `${h}/${s}:${index}`;
}

// The top-left window TITLE text: "[machine · ] index:name[ · cwd][ ⎇ branch]".
// Shared so the recents menu items render identically to the title. Plain text
// (no HTML) — callers escape if they inject as innerHTML.
//
// fields: { machine, index, name, cwd, branch }
//   machine: optional host/label to prefix (the title only passes this in hub
//   mode; the recents popup always passes it, since it's cross-machine).
export function windowTitleText(fields = {}) {
  const machinePart = fields.machine ? `${fields.machine} · ` : "";
  const cwdAbbr = abbrevHome(fields.cwd) || "";
  const cwdPart = cwdAbbr ? ` · ${cwdAbbr}` : "";
  const branchPart = fields.branch ? ` ⎇ ${fields.branch}` : "";
  return `${machinePart}${fields.index}:${fields.name}${cwdPart}${branchPart}`;
}

// Hover tooltip for a recents menu item: the title line, then the captured
// note / agent type / activity state (each on its own line, omitted when
// absent). Plain multi-line text for a native title= tooltip.
//
// fields: windowTitleText fields + { note, agentType, turn, live }
export function windowHoverDetail(fields = {}) {
  const lines = [windowTitleText(fields)];
  const activity = fields.live
    ? `active${fields.turn ? ` · ${fields.turn}` : ""}`
    : fields.turn || "idle";
  if (fields.agentType) lines.push(`agent: ${fields.agentType} (${activity})`);
  else lines.push(`activity: ${activity}`);
  if (fields.note) lines.push(`note: ${fields.note}`);
  return lines.join("\n");
}

// Full one-line descriptor for clipboard / hover: the stable id plus human
// context (window name, cwd, branch, worktree). Pasteable into a bug report and
// recognizable at a glance.
//
// fields: { host, sessionName, index, name, cwd, branch, worktree }
// opts.worktree: set false to omit the "· worktree" flag (the recents menu does
//   this — the flag is noise there; copy/title still include it).
export function windowDescriptor(fields = {}, opts = {}) {
  const showWorktree = opts.worktree !== false;
  const id = windowStableId(fields);
  const cwdAbbr = abbrevHome(fields.cwd) || "";
  let tail = "";
  if (cwdAbbr) tail += ` · ${cwdAbbr}`;
  if (fields.branch) tail += ` ⎇ ${fields.branch}`;
  if (showWorktree && fields.worktree) tail += " · worktree";
  return `${id} (${fields.index}:${fields.name}${tail})`;
}

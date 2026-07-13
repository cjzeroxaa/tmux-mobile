import { escapeHtml, filePathFromLocalHref, linkifyEscaped } from "./linkify.js";
import { playNotifySound, shouldChime } from "./notify-sound.js";
import { closeRealtimeReadAudio, playRealtimeRead } from "./realtime-read.js";
import { openViewerUrl } from "./viewer-navigation.js";
import {
  getSnippets as getStoredSnippets,
  initSnippets,
  onSnippetsChanged,
  setSnippets as setStoredSnippets,
} from "./snippets.js";
import { windowKey, windowStableId, windowDescriptor, windowTitleText, windowHoverDetail, mergeRecent, pruneRecent } from "./window-id.js";

const SNAPSHOT_BOTTOM_SLOP_PX = 8;
const MAX_WAVEFORM_SAMPLES = 40;
const WAVEFORM_SAMPLE_INTERVAL_MS = 200;

let screenWakeLock = null;

function createPersistedAtom(key, defaultValue) {
  let value = defaultValue;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") value = { ...defaultValue, ...parsed };
    }
  } catch {}
  return {
    get: () => value,
    set: (next) => {
      value = { ...value, ...next };
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {}
    },
  };
}

// "kami" = Japanese washi-paper light theme (default), "dark" = original,
// "auto" = follow the OS prefers-color-scheme.
const themeAtom = createPersistedAtom("tmux-mobile-theme", { theme: "kami" });
const THEME_ORDER = ["kami", "dark", "auto"];

function systemPrefersDark() {
  return !!(
    window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

// Resolve a theme choice to the concrete light/dark applied to the document.
function themeIsDark(theme) {
  if (theme === "dark") return true;
  if (theme === "auto") return systemPrefersDark();
  return false; // kami / default
}

// Notification sound: play a chime (the bundled Ubuntu notification sound) when a
// window NEWLY needs an answer / finishes. enabled (default OFF — opt-in via
// settings). Rate-limited to once per NOTIFY_SOUND_MIN_INTERVAL_MS regardless of
// how many windows fire at once.
const notifySoundAtom = createPersistedAtom("tmux-mobile-notify-sound", {
  enabled: false,
});
const NOTIFY_SOUND_MIN_INTERVAL_MS = 10_000;

function getSnippets() {
  return getStoredSnippets();
}

function setSnippets(items) {
  setStoredSnippets(items);
}

// Text-composer send history, oldest-first, persisted in localStorage so it
// survives reloads and is recallable via the composer's history picker. Shared
// across windows (it's about what you've typed, useful everywhere). Bounded.
const COMPOSER_HISTORY_MAX = 100;
const composerHistoryAtom = createPersistedAtom("tmux-mobile-composer-history", {
  items: [],
});

// Dismissed "connector out of date" warnings, keyed by machine id + the exact set
// of missing ops. Dismissing hides the banner for that specific skew; if the
// connector later goes stale in a NEW way (different missing ops) the warning
// returns, and once it's restarted onto current code it's no longer stale at all.
const staleDismissAtom = createPersistedAtom("tmux-mobile-stale-dismissed", {
  keys: [],
});

function staleDismissKey(machine) {
  const ops = [...(machine.missingOps || [])].sort().join(",");
  const connector = [
    machine.connectorVersion || "",
    machine.expectedConnectorVersion || "",
    machine.connectorStatus || machine.revisionStatus || "",
  ].join(">");
  return `${machine.id}|${ops}|${connector}`;
}

function isStaleDismissed(machine) {
  return staleDismissAtom.get().keys.includes(staleDismissKey(machine));
}

function dismissStale(machine) {
  const key = staleDismissKey(machine);
  const keys = staleDismissAtom.get().keys.filter((k) => k !== key);
  keys.push(key);
  // Bound it so it can't grow forever.
  staleDismissAtom.set({ keys: keys.slice(-50) });
}

function getComposerHistory() {
  const items = composerHistoryAtom.get().items;
  return Array.isArray(items) ? items : [];
}

// Append a sent message. Skips blanks and collapses an immediate repeat of the
// most-recent entry (re-sending "yes" twice shouldn't bloat the list); a repeat
// that isn't the latest moves to the end (most-recent) instead of duplicating.
function pushComposerHistory(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return;
  const items = getComposerHistory().filter((t) => t !== trimmed);
  items.push(trimmed);
  if (items.length > COMPOSER_HISTORY_MAX) {
    items.splice(0, items.length - COMPOSER_HISTORY_MAX);
  }
  composerHistoryAtom.set({ items });
}

// "Unread" tracking: the pane content hash each window had when we last visited
// it. A window is "unread" (worth revisiting) when its current contentHash
// differs from this; unchanged since the last visit -> nothing new. Keyed by the
// stable window identity (machine+session+index), persisted so it survives
// reloads. Bounded so it can't grow forever.
const SEEN_HASHES_MAX = 200;
const seenHashesAtom = createPersistedAtom("tmux-mobile-seen-hashes", {
  byKey: {},
});

function markWindowVisited(win) {
  const key = windowRecentKey(win);
  const hash = state.windowMetadata[win.id]?.contentHash;
  if (!key || !hash) return;
  const byKey = { ...seenHashesAtom.get().byKey, [key]: hash };
  // Trim oldest-ish entries if we exceed the cap (object insertion order).
  const keys = Object.keys(byKey);
  if (keys.length > SEEN_HASHES_MAX) {
    for (const k of keys.slice(0, keys.length - SEEN_HASHES_MAX)) delete byKey[k];
  }
  seenHashesAtom.set({ byKey });
}

// Unread = we've visited this window before AND its content changed since. A
// never-visited window is not "unread" (we don't nag about windows you've never
// opened); a window with no contentHash yet is treated as not-unread.
function isWindowUnread(win) {
  const key = windowRecentKey(win);
  const current = state.windowMetadata[win.id]?.contentHash;
  if (!key || !current) return false;
  const seen = seenHashesAtom.get().byKey[key];
  if (seen === undefined) return false; // never visited -> not flagged
  return seen !== current;
}

function windowRecentKey(win) {
  if (!win) return "";
  const session = state.sessions.find((s) => s.id === win.sessionId);
  const sessionName = session?.name ?? win.sessionId;
  return windowKey({
    machineId: scopedMachineId(state.machineId, state.mux),
    sessionName,
    index: win.index,
  });
}

function scopedMachineId(machineId, mux) {
  const normalizedMux = normalizeMux(mux);
  return `${machineId || "local"}${normalizedMux ? `#${normalizedMux}` : ""}`;
}

// Stable identity key for a cross-machine attention descriptor. Goes through
// the SAME windowKey() as windowRecentKey so the two always produce identical
// strings — earlier these used different join separators, which silently broke
// "is the active window the one needing attention?" and jump-to-window from the
// Needs-you pill (the keys never matched, so it fell back to opening the picker).
function attentionKey(d) {
  return windowKey({
    machineId: scopedMachineId(d.machineId, d.mux),
    sessionName: d.sessionName,
    index: d.windowIndex,
  });
}

// The stable key of the window the user is currently looking at (so it never
// counts as "needs you" — they're already there).
function activeWindowKey() {
  const win = selectedWindow();
  return win ? windowRecentKey(win) : "";
}

// Does this attention descriptor need the user? Reasons, strongest first:
//   "question"   — agent confidently blocked on an AskUserQuestion / exit-plan.
//   "finished"   — turn confidently ended (idle) AND content changed (unread).
//   "unverified" — HONEST STATE (Wave 1): detection is UNCERTAIN. Either a
//                  low-confidence "maybe blocked" prompt, or an unverified turn
//                  whose content changed since last visit. We never hide it and
//                  never show false confidence — it's surfaced, ranked LAST.
// The currently-viewed window is excluded. Unread is computed client-side against
// the local seen-hashes baseline, so it works for every machine.
//
// Back-compat: a descriptor from an older agent has no *Confidence fields. A
// missing waitingConfidence on a waitingForInput=true descriptor is treated as
// "high" (the old behavior — it only ever set waitingForInput when isAskQuestion
// fired strictly), so we don't regress confident questions to unverified.
function descriptorNeedsAttention(d, activeKey) {
  const key = attentionKey(d);
  if (key === activeKey) return null;
  if (d.waitingForInput) {
    // Low-confidence "maybe blocked" → unverified, not a confident question.
    return d.waitingConfidence === "low" ? "unverified" : "question";
  }
  const seen = seenHashesAtom.get().byKey[key];
  const unread = seen !== undefined && d.contentHash && seen !== d.contentHash;
  if (d.turn === "idle" && unread) return "finished";
  // Turn couldn't be confirmed but the content changed: we can't claim it
  // finished, but something happened we haven't seen — surface as unverified.
  if (d.turn === "unverified" && unread) return "unverified";
  return null;
}

// Rank order for attention reasons (lower = more urgent). Drives which window the
// pill jumps to and how the pill summarizes the set. "unverified" is always last:
// honest hedge, never ranked above a confirmed need.
const ATTENTION_RANK = { question: 0, finished: 1, unverified: 2 };

// All windows (across ALL machines) currently needing attention, with reason —
// drives the topbar pill, the tab-title/favicon badge, and the jump-on-tap.
function windowsNeedingAttention() {
  const activeKey = activeWindowKey();
  const out = [];
  for (const d of state.attention) {
    const reason = descriptorNeedsAttention(d, activeKey);
    if (reason) out.push({ descriptor: d, reason });
  }
  return out;
}

// Is the window the user is CURRENTLY VIEWING confidently blocked on a question
// (AskUserQuestion / exit-plan)? windowsNeedingAttention() deliberately excludes
// the active window — the topbar pill shouldn't tell you to jump to where you
// already are. But that's exactly the window where "Answer question" is the
// relevant action, so we surface it on the More button instead. Mirrors the
// "question" branch of descriptorNeedsAttention without the active-key exclusion.
function activeWindowHasQuestion() {
  const activeKey = activeWindowKey();
  if (!activeKey) return false;
  const d = state.attention.find((x) => attentionKey(x) === activeKey);
  // waitingConfidence "low" is an unverified hedge, not a confident question —
  // don't light the affordance on a maybe.
  return Boolean(d && d.waitingForInput && d.waitingConfidence !== "low");
}

// Global cross-machine window list for the quick-switch popup. Stores the full
// descriptor fields for each window we've visited — keyed by the stable
// (machine+session+index) identity — so the popup can list, label, and switch
// to windows on OTHER machines too, even while we're not on them (the ephemeral
// tmux window id can't do this). MRU, deduped by stable key, capped at 20.
const GLOBAL_RECENTS_MAX = 20;
const globalRecentsAtom = createPersistedAtom("tmux-mobile-global-recents", {
  entries: [], // [{ key, machineId, mux, host, sessionName, index, name, cwd, branch, worktree }]
});

// Record the just-visited window into the global list (MRU, deduped, capped).
// Builds the same field bag the descriptor/id helpers consume.
function recordGlobalRecent(win) {
  const fields = windowIdFields(win);
  if (!fields) return;
  const key = windowKey({
    machineId: scopedMachineId(state.machineId, state.mux),
    sessionName: fields.sessionName,
    index: fields.index,
  });
  if (!key) return;
  const entry = { key, machineId: state.machineId || "", ...fields };
  globalRecentsAtom.set({
    entries: mergeRecent(globalRecentsAtom.get().entries, entry, GLOBAL_RECENTS_MAX),
  });
}

// The global list for display, newest first, excluding the active window.
function globalRecents() {
  const activeKey = activeWindowKey();
  return globalRecentsAtom
    .get()
    .entries.filter((e) => e.key !== activeKey);
}

// Drop closed windows from the global recents. We only have ground truth for
// the CURRENT machine (state.windows holds its live windows), so we prune only
// entries belonging to this machine whose stable key is no longer live —
// entries for OTHER machines are left alone (their windows may well be alive; we
// just can't see them from here). Runs on every window-list refresh, so a
// window closed by us, by another client, or directly in tmux all get cleaned
// up the next time we load this machine's windows.
function pruneGlobalRecents() {
  const liveKeys = new Set(state.windows.map((win) => windowRecentKey(win)));
  const kept = pruneRecent(
    globalRecentsAtom.get().entries,
    state.machineId,
    liveKeys,
  );
  globalRecentsAtom.set({ entries: kept });
}

// Snapshot tail depth (lines shown in the terminal pane). Persisted so the
// user's preferred depth carries across reloads. Validated against the
// allowed set so a stale/bogus value can't bork the picker.
const LINE_OPTIONS = [50, 120, 250, 500, 1000];
const DEFAULT_LINES = 500;
const linesAtom = createPersistedAtom("tmux-mobile-lines", { lines: DEFAULT_LINES });
function readPersistedLines() {
  const value = Number(linesAtom.get().lines);
  return LINE_OPTIONS.includes(value) ? value : DEFAULT_LINES;
}

// Snapshot font size (px). Adjusted live from the More menu's A−/A+ pair.
// Clamped to [SNAPSHOT_FONT_MIN, SNAPSHOT_FONT_MAX] so a bogus localStorage
// value can't make the terminal pane unreadable.
const SNAPSHOT_FONT_MIN = 10;
const SNAPSHOT_FONT_MAX = 22;
const SNAPSHOT_FONT_DEFAULT = 13;
const snapshotFontAtom = createPersistedAtom("tmux-mobile-snapshot-font-size", {
  px: SNAPSHOT_FONT_DEFAULT,
});
function clampSnapshotFont(px) {
  const value = Number(px);
  if (!Number.isFinite(value)) return SNAPSHOT_FONT_DEFAULT;
  return Math.max(SNAPSHOT_FONT_MIN, Math.min(SNAPSHOT_FONT_MAX, Math.round(value)));
}
function readPersistedSnapshotFont() {
  return clampSnapshotFont(snapshotFontAtom.get().px);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = themeIsDark(theme) ? "" : "kami";
}

const initialUrlTarget = readUrlTarget();

const state = {
  runtimeMode: "local",
  serverRevision: "",
  cloneUrl: "https://github.com/cjzeroxaa/tmux-mobile.git",
  machines: [],
  machineId: initialUrlTarget.machineId || "",
  mux: initialUrlTarget.mux || "",
  sessions: [],
  windows: [],
  windowActivity: {},
  windowMetadata: {}, // { [windowId]: { agentType, repo, git: {branch, worktree} } }
  attention: [], // cross-machine: [{ machineId, sessionName, windowIndex, windowName, agentType, turn, waitingForInput, contentHash }]
  activityTimer: null,
  metadataTimer: null, // background "needs you" metadata poll (cross-machine)
  autoRefreshInFlight: false, // back-pressure flag for setAutoRefresh — skip the
                              // next tick if the previous one's network hasn't
                              // returned yet (see setAutoRefresh).
  panes: [],
  sessionId: "",
  windowId: "",
  paneId: "",
  // "codex" | "claude" | null. null = current pane is not running a known
  // agent, so the Read buttons stay disabled (Read only does anything when
  // there's a structured transcript to lift the last response from).
  currentAgentKind: null,
  // Reconnect grace: when the focused machine momentarily drops (deploy, wifi
  // blip, agent restart), we keep the current window on screen and retry fast
  // for a grace window before falling back to the "no machine" reset.
  reconnectUntil: 0, // ms epoch deadline; 0 = not in grace
  reconnectMachineId: "", // the machine we're waiting to come back
  reconnectTimer: null, // fast-retry timer during grace
  // route id -> last-known hostname. The route id (machine.id, "m:base64:base64")
  // is what state.machineId holds, but it's an INTERNAL key — never show it. When
  // a machine drops it leaves state.machines, so we remember its friendly name
  // here to label the "Waiting for <host>" message instead of leaking the id.
  knownHostnames: {},
  lines: readPersistedLines(),
  autoRefreshTimer: null,
  chat: [],
  targetPickerOpen: false,
  directoryPickerOpen: false,
  actionsOpen: false,
  snapshotFullscreen: false,
  snapshotPinnedToBottom: true,
  pendingSnapshotText: null,
  snapshotText: null,
  viewLoadGeneration: 0,
  treeLoadGeneration: 0,
  targetLoadingMessage: "",
  pendingUrlTarget: initialUrlTarget,
  directories: {
    cwd: "",
    parent: "",
    entries: [],
    loading: false,
    error: "",
  },
  voice: {
    analyser: null,
    audioContext: null,
    chunks: [],
    cancelRequested: false,
    mediaRecorder: null,
    pendingAudio: null,
    pendingError: "",
    pendingMimeType: "",
    pendingTranscript: "",
    pendingIdempotencyKey: "",
    sendAfterTranscribe: false,
    sampleTimer: null,
    stream: null,
    status: "idle",
    waveform: [],
  },
  audio: {
    abortController: null,
    audioElement: null,
    context: null,
    dataChannel: null,
    peerConnection: null,
    remoteStream: null,
    remoteTrack: null,
    readId: 0,
    source: null,
    busy: false,
    stopRequested: false,
  },
};

function readUrlTarget() {
  const params = new URLSearchParams(window.location.search);
  return {
    machineId: params.get("machineId") || "",
    mux: normalizeMux(params.get("mux")),
    windowId: params.get("windowId") || "",
    session: params.get("session") || params.get("sessionName") || "",
    windowIndex: params.get("window") || params.get("windowIndex") || "",
    windowName: params.get("windowName") || "",
  };
}

function hasUrlTarget(target = readUrlTarget()) {
  return Boolean(target.machineId || target.mux || target.windowId || target.session || target.windowIndex || target.windowName);
}

function normalizeMux(value) {
  const mux = String(value || "").trim().toLowerCase();
  return mux === "tmux" || mux === "rmux" ? mux : "";
}

function updateTargetUrl() {
  const session = selectedSession();
  const win = selectedWindow();
  const target = {
    machineId: state.runtimeMode === "hub" ? state.machineId || "" : "",
    mux: state.mux || "",
    windowId: win?.id || "",
    session: session?.name || "",
    windowIndex: win ? String(win.index) : "",
    windowName: win?.name || "",
  };
  const params = new URLSearchParams();
  if (target.machineId) params.set("machineId", target.machineId);
  if (target.mux) params.set("mux", target.mux);
  if (target.windowId) params.set("windowId", target.windowId);
  if (target.session) params.set("session", target.session);
  if (target.windowIndex) params.set("window", target.windowIndex);
  if (target.windowName) params.set("windowName", target.windowName);

  const next = new URL(window.location.href);
  next.search = params.toString();
  window.history.replaceState({}, "", next);
}

const els = {
  mobileConnectionStatus: document.querySelector("#mobileConnectionStatus"),
  sessionNameInput: document.querySelector("#sessionNameInput"),
  createSession: document.querySelector("#createSession"),
  mobileWindows: document.querySelector("#mobileWindows"),
  mobileTargetLabel: document.querySelector("#mobileTargetLabel"),
  needsAttention: document.querySelector("#needsAttention"),
  copyModeBanner: document.querySelector("#copyModeBanner"),
  reconnectBanner: document.querySelector("#reconnectBanner"),
  reconnectBannerText: document.querySelector("#reconnectBannerText"),
  exitCopyMode: document.querySelector("#exitCopyMode"),
  snapshot: document.querySelector("#snapshot"),
  connectorHelp: document.querySelector("#connectorHelp"),
  connectorClone: document.querySelector("#connectorClone"),
  connectorRun: document.querySelector("#connectorRun"),
  chat: document.querySelector("#chat"),
  mobileRefreshTree: document.querySelector("#mobileRefreshTree"),
  mobileRefresh: document.querySelector("#mobileRefresh"),
  machinePicker: document.querySelector("#machinePicker"),
  machineSelect: document.querySelector("#machineSelect"),
  staleAgentBanner: document.querySelector("#staleAgentBanner"),
  staleAgentDetail: document.querySelector("#staleAgentDetail"),
  staleAgentCmd: document.querySelector("#staleAgentCmd"),
  staleAgentDismiss: document.querySelector("#staleAgentDismiss"),
  themeToggle: document.querySelector("#themeToggle"),
  moreActionsToggle: document.querySelector("#moreActionsToggle"),
  moreActionsMenu: document.querySelector("#moreActionsMenu"),
  openNotifySettings: document.querySelector("#openNotifySettings"),
  notifySettingsSheet: document.querySelector("#notifySettingsSheet"),
  notifySettingsBackdrop: document.querySelector("#notifySettingsBackdrop"),
  closeNotifySettings: document.querySelector("#closeNotifySettings"),
  saveNotifySettings: document.querySelector("#saveNotifySettings"),
  notifySettingsStatus: document.querySelector("#notifySettingsStatus"),
  notifySoundEnabled: document.querySelector("#notifySoundEnabled"),
  previewNotifySound: document.querySelector("#previewNotifySound"),
  openVoiceSettings: document.querySelector("#openVoiceSettings"),
  voiceSettingsSheet: document.querySelector("#voiceSettingsSheet"),
  voiceSettingsBackdrop: document.querySelector("#voiceSettingsBackdrop"),
  closeVoiceSettings: document.querySelector("#closeVoiceSettings"),
  saveVoiceSettings: document.querySelector("#saveVoiceSettings"),
  voiceSettingsStatus: document.querySelector("#voiceSettingsStatus"),
  voiceTranscribeModel: document.querySelector("#voiceTranscribeModel"),
  voiceSpeechModel: document.querySelector("#voiceSpeechModel"),
  voiceSpeechVoice: document.querySelector("#voiceSpeechVoice"),
  voiceRealtimeModel: document.querySelector("#voiceRealtimeModel"),
  voiceRealtimeVoice: document.querySelector("#voiceRealtimeVoice"),
  previewSpeechVoice: document.querySelector("#previewSpeechVoice"),
  previewRealtimeVoice: document.querySelector("#previewRealtimeVoice"),
  fontSizeDecrease: document.querySelector("#fontSizeDecrease"),
  fontSizeIncrease: document.querySelector("#fontSizeIncrease"),
  fontSizeValue: document.querySelector("#fontSizeValue"),
  showTranscript: document.querySelector("#showTranscript"),
  agentTranscriptSheet: document.querySelector("#agentTranscriptSheet"),
  agentTranscriptBackdrop: document.querySelector("#agentTranscriptBackdrop"),
  closeAgentTranscript: document.querySelector("#closeAgentTranscript"),
  agentTranscriptTitle: document.querySelector("#agentTranscriptTitle"),
  agentTranscriptMeta: document.querySelector("#agentTranscriptMeta"),
  agentTranscriptBody: document.querySelector("#agentTranscriptBody"),
  refreshSnapshot: document.querySelector("#refreshSnapshot"),
  fullscreenSnapshot: document.querySelector("#fullscreenSnapshot"),
  exitSnapshotFullscreen: document.querySelector("#exitSnapshotFullscreen"),
  renameWindow: document.querySelector("#renameWindow"),
  answerQuestion: document.querySelector("#answerQuestion"),
  askSheet: document.querySelector("#askSheet"),
  askBackdrop: document.querySelector("#askBackdrop"),
  closeAsk: document.querySelector("#closeAsk"),
  askTabs: document.querySelector("#askTabs"),
  askBody: document.querySelector("#askBody"),
  askStatus: document.querySelector("#askStatus"),
  newWindow: document.querySelector("#newWindow"),
  duplicateWindow: document.querySelector("#duplicateWindow"),
  closeWindow: document.querySelector("#closeWindow"),
  duplicateSheet: document.querySelector("#duplicateSheet"),
  duplicateBackdrop: document.querySelector("#duplicateBackdrop"),
  closeDuplicate: document.querySelector("#closeDuplicate"),
  duplicateName: document.querySelector("#duplicateName"),
  duplicateCommand: document.querySelector("#duplicateCommand"),
  duplicateCwd: document.querySelector("#duplicateCwd"),
  duplicateStatus: document.querySelector("#duplicateStatus"),
  confirmDuplicate: document.querySelector("#confirmDuplicate"),
  newBranchWindow: document.querySelector("#newBranchWindow"),
  newBranchSheet: document.querySelector("#newBranchSheet"),
  newBranchBackdrop: document.querySelector("#newBranchBackdrop"),
  closeNewBranch: document.querySelector("#closeNewBranch"),
  newBranchFrom: document.querySelector("#newBranchFrom"),
  newBranchName: document.querySelector("#newBranchName"),
  newBranchCommand: document.querySelector("#newBranchCommand"),
  newBranchStatus: document.querySelector("#newBranchStatus"),
  confirmNewBranch: document.querySelector("#confirmNewBranch"),
  lineCount: document.querySelector("#lineCount"),
  snapshotNote: document.querySelector("#snapshotNote"),
  autoRefresh: document.querySelector("#autoRefresh"),
  snapshotStaleIcon: document.querySelector("#snapshotStaleIcon"),
  inputArea: document.querySelector("#inputArea"),
  attachButton: document.querySelector("#attachButton"),
  fileInput: document.querySelector("#fileInput"),
  voiceButton: document.querySelector("#voiceButton"),
  voiceTitle: document.querySelector("#voiceTitle"),
  voiceSubtitle: document.querySelector("#voiceSubtitle"),
  voiceStatus: document.querySelector("#voiceStatus"),
  voiceStatusRow: document.querySelector("#voiceStatusRow"),
  snippetBar: document.querySelector("#snippetBar"),
  snippetChips: document.querySelector("#snippetChips"),
  manageSnippets: document.querySelector("#manageSnippets"),
  snippetSheet: document.querySelector("#snippetSheet"),
  snippetBackdrop: document.querySelector("#snippetBackdrop"),
  closeSnippets: document.querySelector("#closeSnippets"),
  snippetList: document.querySelector("#snippetList"),
  snippetNewText: document.querySelector("#snippetNewText"),
  snippetAdd: document.querySelector("#snippetAdd"),
  historyList: document.querySelector("#historyList"),
  modeBar: document.querySelector("#modeBar"),
  modeCycle: document.querySelector("#modeCycle"),
  modeLabel: document.querySelector("#modeLabel"),
  modeEffort: document.querySelector("#modeEffort"),
  modeMore: document.querySelector("#modeMore"),
  modeSheet: document.querySelector("#modeSheet"),
  modeBackdrop: document.querySelector("#modeBackdrop"),
  closeMode: document.querySelector("#closeMode"),
  modeSheetHint: document.querySelector("#modeSheetHint"),
  modeOptions: document.querySelector("#modeOptions"),
  effortSection: document.querySelector("#effortSection"),
  effortOptions: document.querySelector("#effortOptions"),
  modeStatus: document.querySelector("#modeStatus"),
  textInput: document.querySelector("#textInput"),
  directKeysToggle: document.querySelector("#directKeysToggle"),
  directKeysMenu: document.querySelector("#directKeysMenu"),
  clearText: document.querySelector("#clearText"),
  submitText: document.querySelector("#submitText"),
  voiceWaveform: document.querySelector("#voiceWaveform"),
  submitVoice: document.querySelector("#submitVoice"),
  cancelVoice: document.querySelector("#cancelVoice"),
  retryVoice: document.querySelector("#retryVoice"),
  directoryNavigator: document.querySelector("#directoryNavigator"),
  directoryPath: document.querySelector("#directoryPath"),
  directoryList: document.querySelector("#directoryList"),
  openDirectoryPicker: document.querySelector("#openDirectoryPicker"),
  closeDirectoryPicker: document.querySelector("#closeDirectoryPicker"),
  refreshDirectoryPicker: document.querySelector("#refreshDirectoryPicker"),
  directoryBackdrop: document.querySelector("#directoryBackdrop"),
  directorySheet: document.querySelector("#directorySheet"),
  openPinsSheet: document.querySelector("#openPinsSheet"),
  closePinsSheet: document.querySelector("#closePinsSheet"),
  refreshPins: document.querySelector("#refreshPins"),
  pinsBackdrop: document.querySelector("#pinsBackdrop"),
  pinsSheet: document.querySelector("#pinsSheet"),
  pinsList: document.querySelector("#pinsList"),
  openTargetPicker: document.querySelector("#openTargetPicker"),
  copyWindowId: document.querySelector("#copyWindowId"),
  globalRecentsToggle: document.querySelector("#globalRecentsToggle"),
  globalRecentsMenu: document.querySelector("#globalRecentsMenu"),
  closeTargetPicker: document.querySelector("#closeTargetPicker"),
  targetBackdrop: document.querySelector("#targetBackdrop"),
  targetSheet: document.querySelector("#targetSheet"),
  speakWindow: document.querySelector("#speakWindow"),
};

async function api(path, options = {}) {
  const { machineId: _machineId, mux, ...requestOptions } = options;
  const headers = { ...(requestOptions.headers || {}) };
  const hasBody = requestOptions.body !== undefined && requestOptions.body !== null;
  const isRawBody =
    typeof Blob !== "undefined" && requestOptions.body instanceof Blob;
  if (hasBody && !isRawBody && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  if (state.machineId && shouldAttachMachineHeader(path, requestOptions.method)) {
    headers["x-machine-id"] = state.machineId;
  }
  const requestMux = normalizeMux(mux) || state.mux;
  if (requestMux && shouldAttachMachineHeader(path)) {
    headers["x-mux"] = requestMux;
  }

  const response = await fetch(path, {
    cache: "no-store",
    ...requestOptions,
    headers,
  });
  const json = await response.json();
  if (!response.ok) {
    const error = new Error(json.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return json;
}

function shouldAttachMachineHeader(path, method) {
  const pathname = new URL(path, window.location.origin).pathname;
  // The pin serve link and pin listing/sharing/unpinning are machine-independent
  // (the bytes live in artifact storage, not on a machine). POST /api/pins is the
  // exception: it reads the file off the live machine, so it keeps the header.
  if (pathname === "/pin" || pathname === "/api/pin") return false;
  if (pathname === "/api/pins") return String(method || "GET").toUpperCase() === "POST";
  return (
    pathname.startsWith("/api/") &&
    pathname !== "/api/runtime" &&
    pathname !== "/api/machines" &&
    pathname !== "/api/health" &&
    pathname !== "/api/voice-config" &&
    pathname !== "/api/voice-preview" &&
    pathname !== "/api/attention" // spans all machines; not machine-scoped
  );
}

function logClientEvent(event, details = {}) {
  const headers = { "content-type": "application/json" };
  if (state.machineId) headers["x-machine-id"] = state.machineId;
  fetch("/api/client-log", {
    method: "POST",
    headers,
    body: JSON.stringify({ event, details }),
  }).catch(() => {});
}

function selectedSession() {
  return state.sessions.find((item) => item.id === state.sessionId);
}

function selectedWindow() {
  return state.windows.find((item) => item.id === state.windowId);
}

// Did the currently-selected window land on the given (session-name, index)
// target? Used after a cross-machine hop to verify the switch succeeded by its
// OUTCOME, rather than re-deriving a stable key (which can mismatch on machineId
// representation and wrongly trigger the picker fallback).
function selectedMatchesTarget(sessionName, index) {
  const sel = selectedWindow();
  if (!sel) return false;
  const selSession = state.sessions.find((s) => s.id === sel.sessionId)?.name ?? "";
  return String(sel.index) === String(index) && selSession === sessionName;
}

function selectedMachine() {
  return state.machines.find((item) => item.id === state.machineId);
}

function shellPath(value) {
  const path = String(value || "").trim() || "~/src/tmux-mobile";
  if (path === "~" || path.startsWith("~/")) return path;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function connectorUpdatePrompt(machine) {
  const host = machine?.hostname || machine?.machineId || machine?.id || "this machine";
  const cwd = shellPath(machine?.agentCwd || "~/src/tmux-mobile");
  const current = machine?.connectorVersion || "unknown";
  const expected = machine?.expectedConnectorVersion || "current";
  const currentRevision = machine?.agentRevision || "unknown";
  const expectedRevision = machine?.expectedRevision || state.serverRevision || "current";
  const controller = window.location.origin;
  return [
    `Update the tmux-mobile connector on ${host}.`,
    "",
    "Do not print or expose tokens, cookies, or other secrets.",
    "Do not stop unrelated local processes.",
    `Only restart the connector process registered with ${controller}.`,
    "",
    `Current connector version shown by the controller: ${current}`,
    `Expected connector version: ${expected}`,
    `Current code revision shown by the controller: ${currentRevision}`,
    `Target code revision: ${expectedRevision}`,
    "",
    "Steps:",
    `1. cd ${cwd}`,
    "2. git fetch --all --prune",
    "3. git pull --ff-only",
    "4. npm install",
    `5. Stop the old tmux-mobile --register connector for ${controller}, if it is still running.`,
    `6. Start it again with: node server.mjs --register ${controller}`,
    "7. Confirm the machine reconnects and no longer shows as out of date.",
  ].join("\n");
}

function resolveMachineRouteId(machineId) {
  const id = String(machineId || "");
  if (!id) return "";
  if (state.machines.some((machine) => machine.id === id)) return id;
  const matches = state.machines.filter(
    (machine) =>
      machine.agentId === id ||
      machine.machineId === id ||
      machine.rawMachineId === id ||
      machine.hostname === id ||
      machine.rawHostname === id ||
      machine.machineAlias === id,
  );
  return matches.length === 1 ? matches[0].id : id;
}

function selectedMachineOnline() {
  return Boolean(selectedMachine());
}

function paneChatKey() {
  return state.paneId ? `tmux-chat-web:${state.machineId || "local"}:${state.paneId}` : "";
}

function loadChat() {
  if (!state.paneId) {
    state.chat = [];
    return;
  }
  try {
    state.chat = JSON.parse(localStorage.getItem(paneChatKey()) || "[]");
  } catch {
    state.chat = [];
  }
}

function saveChat() {
  if (!state.paneId) return;
  localStorage.setItem(paneChatKey(), JSON.stringify(state.chat.slice(-80)));
}

function nowLabel() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function setStatus(text, ok = true) {
  if (!els.mobileConnectionStatus) return;
  els.mobileConnectionStatus.textContent = text;
  els.mobileConnectionStatus.style.color = ok ? "" : "#a73535";
}

function resetTmuxState(message = "Select a window.") {
  stopMetadataPolling();
  // Any full reset means we're no longer holding a window through a blip.
  setReconnectingBanner(false);
  state.targetLoadingMessage = "";
  state.sessions = [];
  state.windows = [];
  state.windowActivity = {};
  state.windowMetadata = {};
  state.panes = [];
  state.sessionId = "";
  state.windowId = "";
  state.paneId = "";
  renderMachinePicker();
  renderWindows();
  renderTargetLabels();
  renderModeBar();
  updateAttentionIndicators(); // clears title/favicon/pill
  resetDirectoryNavigator();
  updateSnapshotText(message, { forceScrollBottom: true });
}

async function loadRuntimeAndMachines() {
  const runtime = await api("/api/runtime");
  if (runtime.revision && state.serverRevision && runtime.revision !== state.serverRevision) {
    window.location.reload();
    const error = new Error("Reloading after server update");
    error.silent = true;
    throw error;
  }
  state.serverRevision = runtime.revision || state.serverRevision;
  state.runtimeMode = runtime.mode || "local";
  if (runtime.cloneUrl) state.cloneUrl = runtime.cloneUrl;
  if (state.runtimeMode !== "hub") {
    state.machines = [];
    state.machineId = "";
    renderMachinePicker();
    return;
  }

  state.machines = await api("/api/machines");
  // Remember each machine's friendly name keyed by its route id, so we can label
  // it after it drops (and leaves state.machines).
  for (const m of state.machines) {
    const label = m.hostname || m.machineId;
    if (m.id && label) state.knownHostnames[m.id] = label;
  }
  if (state.machineId) {
    state.machineId = resolveMachineRouteId(state.machineId);
  }
  if (!state.machineId) {
    state.machineId = state.machines.length === 1 ? state.machines[0].id : "";
  }
  renderMachinePicker();
}

// Show the "connector out of date" banner when the connected machine's agent is
// running older code than this controller (it advertises fewer ops than the
// controller knows — see hub.listMachines `stale`). Newer features (e.g. agent
// detection via PANECMD) silently fail until the connector restarts. Only
// meaningful in hub/controller mode; local mode has no separate agent.
function staleSelectedMachine() {
  if (state.runtimeMode !== "hub") return null;
  // The machine we're talking to: the explicitly-selected one, else the sole one.
  const machine =
    selectedMachine() ||
    (state.machines.length === 1 ? state.machines[0] : null);
  return machine?.stale ? machine : null;
}

function updateStaleAgentBanner() {
  if (!els.staleAgentBanner) return;
  const machine = staleSelectedMachine();
  // Hidden when not stale, or when the user dismissed this specific skew.
  if (!machine || isStaleDismissed(machine)) {
    els.staleAgentBanner.hidden = true;
    els.staleAgentBanner.dataset.machineKey = "";
    if (els.staleAgentCmd) els.staleAgentCmd.dataset.copyText = "";
    return;
  }
  els.staleAgentBanner.hidden = false;
  els.staleAgentBanner.dataset.machineKey = staleDismissKey(machine);
  if (els.staleAgentDetail) {
    const connectorStatus = machine.connectorStatus || machine.revisionStatus || "";
    const connectorText =
      connectorStatus === "outdated"
        ? ` It reports connector version ${machine.connectorVersion || "unknown"}, expected ${machine.expectedConnectorVersion || "current"}.`
        : connectorStatus === "missing"
          ? " It does not report a connector version."
          : "";
    els.staleAgentDetail.textContent =
      "Some features are disabled until you restart the connector on " +
      `${machine.hostname || machine.id}.${connectorText}`;
  }
  if (els.staleAgentCmd) {
    const expected = machine.expectedConnectorVersion || "current";
    els.staleAgentCmd.textContent =
      `update ${machine.hostname || machine.id}: connector ${machine.connectorVersion || "unknown"} -> ${expected}`;
    els.staleAgentCmd.dataset.copyText = connectorUpdatePrompt(machine);
  }
}

function renderMachinePicker() {
  renderConnectorHelp();
  updateStaleAgentBanner();
  if (!els.machinePicker || !els.machineSelect) return;
  const show = state.runtimeMode === "hub";
  els.machinePicker.hidden = !show;
  if (!show) return;

  els.machineSelect.replaceChildren();
  const selectedOnline = selectedMachineOnline();
  if (state.machines.length !== 1 || (state.machineId && !selectedOnline)) {
    const option = document.createElement("option");
    option.value = state.machineId && !selectedOnline ? state.machineId : "";
    option.textContent =
      state.machineId && !selectedOnline
        ? `Waiting for ${machineLabelFor(state.machineId)}`
        : state.machines.length === 0
          ? "No machines online"
          : "Select a machine";
    els.machineSelect.append(option);
  }
  for (const machine of state.machines) {
    const option = document.createElement("option");
    option.value = machine.id;
    option.textContent = machineLabel(machine);
    els.machineSelect.append(option);
  }
  els.machineSelect.value = state.machineId;
  els.machineSelect.disabled = state.machines.length === 0 && !state.machineId;
}

// Show clone+connector instructions only in hub mode with no machine online.
// The controller URL is the page's own origin (so it's correct on whatever
// domain the user reached, e.g. https://example.ts.net); the clone URL comes
// from /api/runtime. Hidden in every other state.
function renderConnectorHelp() {
  if (!els.connectorHelp) return;
  const showHelp =
    state.runtimeMode === "hub" && state.machines.length === 0;
  els.connectorHelp.hidden = !showHelp;
  els.snapshot.classList.toggle("dimmed", showHelp);
  if (!showHelp) return;
  const controllerUrl = window.location.origin;
  els.connectorClone.textContent = `git clone ${state.cloneUrl} && cd tmux-mobile && npm install`;
  els.connectorRun.textContent = `node server.mjs --register ${controllerUrl}`;
}

function machineLabel(machine) {
  // Just the machine name — the os/arch (e.g. "linux/x64") is noise in the picker.
  return machine.hostname || machine.id;
}

// Friendly label for a machine by its route id (state.machineId is a route id,
// "m:base64:base64" — an internal key we must never show the user). Prefers the
// live machine's hostname, then the last-known hostname (for a dropped machine),
// and only falls back to the raw id if we've genuinely never seen a name.
function machineLabelFor(routeId) {
  if (!routeId) return "";
  const live = state.machines.find((m) => m.id === routeId);
  if (live) return live.hostname || live.machineId || routeId;
  return state.knownHostnames[routeId] || routeId;
}

// `target` optionally names a specific window to land on after the switch
// ({ session, windowIndex }) — used by cross-machine quick-switch so the hop
// goes straight to the intended window instead of the machine's default.
async function selectMachine(machineId, target = null) {
  if (machineId === state.machineId && !target) return;
  state.treeLoadGeneration += 1;
  state.machineId = machineId;
  state.mux = target ? normalizeMux(target.mux) : "";
  resetTmuxState(machineId ? "Loading machine..." : "Select a machine.");
  updateTargetUrl();
  if (!machineId) {
    setStatus("Select a machine", false);
    return;
  }
  await refreshTree({
    urlTarget: {
      machineId,
      mux: state.mux,
      session: target?.session || "",
      windowIndex: target?.windowIndex != null ? String(target.windowIndex) : "",
      windowName: "",
    },
    forceUrlTarget: true,
    syncUrl: true,
  });
}

function empty(container, text) {
  container.innerHTML = `<div class="empty">${escapeHtml(text)}</div>`;
}

// Brand-ish icon for an agent type, drawn in `currentColor` so the per-agent CSS
// tint applies. Kept simple/recognizable rather than pixel-exact logos.
const AGENT_ICONS = {
  // Claude — Anthropic's radial "sunburst" mark.
  claude:
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M12 2l1.5 6L18 4.8l-2.3 4.4 6.3-.7-5.7 2.7 5.7 2.7-6.3-.7L18 19.2 13.5 16 12 22l-1.5-6L6 19.2l2.3-4.4-6.3.7L7.7 12 2 9.3l6.3.7L6 4.8 10.5 8 12 2z"/></svg>',
  // Codex / OpenAI — the interlocking "knot" mark, stroked.
  codex:
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 5.2a3.4 3.4 0 0 1 5.9 1.9 3.4 3.4 0 0 1 0 5.8 3.4 3.4 0 0 1-5.9 5.9 3.4 3.4 0 0 1-5.9-1.9 3.4 3.4 0 0 1 0-5.8A3.4 3.4 0 0 1 12 5.2z"/><path d="M12 8.4v7.2M8.9 10.2l6.2 3.6M15.1 10.2l-6.2 3.6"/></svg>',
  // Gemini — a four-point sparkle.
  gemini:
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M12 2c.5 5 2.9 7.5 8 8-5.1.5-7.5 3-8 8-.5-5-2.9-7.5-8-8 5.1-.5 7.5-3 8-8z"/></svg>',
};

const RMUX_SHARE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 0 20"/><path d="M12 2a15.3 15.3 0 0 0 0 20"/></svg>';
const RMUX_SHARE_DONE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

function agentIcon(type) {
  return AGENT_ICONS[type] || escapeHtml(type);
}

function itemButton({
  active,
  title,
  meta,
  badge,
  badgeGreen,
  onClick,
  className,
  metaClassName = "",
  cwd = "",
  branch = "",
  worktree = false,
  agentType = "",
  turn = "",
  unread = false,
  waitingForInput = false,
  waitingConfidence = "",
}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `${className || "item"}${active ? " active" : ""}${unread ? " unread" : ""}`;
  // Small chip showing the AI agent running in the window as a brand ICON
  // (claude/codex/gemini) to save horizontal space, tinted by turn state:
  // "working" pulses, "idle" is muted (turn ended). A window blocked on an
  // AskUserQuestion prompt gets a distinct "❓ ask" state — the strongest
  // "needs you" signal. The turn glyph trails the icon.
  //
  // HONEST STATE (Wave 1): a low-confidence "maybe blocked" (waitingConfidence
  // low) or an unverified turn renders as a distinct "unverified" chip with a
  // "?" hedge — never the confident ❓/✓, so the chip can't claim certainty the
  // detector doesn't have.
  const lowConfidenceWaiting = waitingForInput && waitingConfidence === "low";
  const confidentWaiting = waitingForInput && !lowConfidenceWaiting;
  const turnState = confidentWaiting
    ? "ask"
    : lowConfidenceWaiting || turn === "unverified"
      ? "unverified"
      : turn || "unknown";
  const turnSuffix = confidentWaiting
    ? " ❓"
    : lowConfidenceWaiting || turn === "unverified"
      ? " ?"
      : turn === "working"
        ? " ●"
        : turn === "idle"
          ? " ✓"
          : "";
  const chipLabel = turnState === "unverified" ? `${agentType} (unverified)` : agentType;
  const agentChip = agentType
    ? `<span class="agent-chip agent-${escapeHtml(agentType)} turn-${escapeHtml(turnState)}" title="${escapeHtml(chipLabel)}" aria-label="${escapeHtml(chipLabel)}">${agentIcon(agentType)}${turnSuffix}</span>`
    : "";
  // Unread dot: this window changed since you last visited it. A left-rail dot so
  // the column scans vertically.
  const unreadDot = unread ? `<span class="unread-dot" title="New since last visit" aria-label="unread">●</span>` : "";
  // Compact inline identity metadata (branch + worktree chip + cwd), all on the
  // header row so it doesn't cost three stacked lines. The ↳wt chip only shows
  // for a linked git worktree; cwd only when it differs from the branch (the
  // caller already decides that).
  const worktreeChip = worktree ? `<span class="item-wt">↳ wt</span>` : "";
  const branchBit = branch
    ? `<span class="item-branch" title="${escapeHtml(branch)}${worktree ? " (linked worktree)" : ""}">⎇ ${escapeHtml(branch)}</span>`
    : "";
  const cwdBit = cwd
    ? `<span class="item-cwd" title="${escapeHtml(cwd)}">${escapeHtml(cwd)}</span>`
    : "";
  // Identity line: name is the prominent title; branch/wt/cwd are compact meta
  // after it; agent icon + live badge sit at the right.
  button.innerHTML = `
    <div class="item-head">
      ${unreadDot}
      <span class="item-name">${escapeHtml(title)}</span>
      ${branchBit}
      ${worktreeChip}
      ${cwdBit}
      <span class="item-head-spacer"></span>
      ${agentChip}
      ${badge ? `<span class="badge ${badgeGreen ? "green" : ""}">${escapeHtml(badge)}</span>` : ""}
    </div>
    ${meta ? `<div class="item-meta ${escapeHtml(metaClassName)}">${escapeHtml(meta)}</div>` : ""}
  `;
  button.addEventListener("click", onClick);
  return button;
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) throw new Error("copy command failed");
  } finally {
    textarea.remove();
  }
}

function openRmuxShareUrl(url) {
  if (!url) return false;
  const opened = window.open(url, "_blank");
  if (opened) opened.opener = null;
  return Boolean(opened);
}

async function shareRmuxWindow(win, button) {
  if (!win || state.mux !== "rmux") return;
  const originalHtml = button.innerHTML;
  const originalTitle = button.title;
  button.disabled = true;
  button.classList.add("is-busy");
  setStatus("sharing RMUX terminal...");
  try {
    const data = await api("/api/rmux-web-share", {
      method: "POST",
      mux: "rmux",
      body: JSON.stringify({ windowId: win.id }),
    });
    let copied = false;
    if (data.code) {
      try {
        await copyTextToClipboard(data.code);
        copied = true;
      } catch {}
    }
    const opened = openRmuxShareUrl(data.operatorUrl);
    if (!opened && data.operatorUrl) {
      window.prompt(copied ? "RMUX operator link (PIN copied)" : "RMUX operator link", data.operatorUrl);
    }
    button.classList.remove("is-busy");
    button.classList.add("is-copied");
    button.innerHTML = RMUX_SHARE_DONE_ICON;
    button.title = copied ? "PIN copied" : "Share ready";
    setStatus(copied ? "RMUX share ready. PIN copied." : "RMUX share ready.");
    window.setTimeout(() => {
      button.classList.remove("is-copied");
      button.innerHTML = originalHtml;
      button.title = originalTitle;
      button.disabled = false;
    }, 1400);
  } catch (error) {
    button.classList.remove("is-busy");
    button.disabled = false;
    setStatus(error.message || "Could not share RMUX terminal", false);
  }
}

function rmuxShareWindowButton(win) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "window-share-button";
  button.title = "Share RMUX terminal";
  button.setAttribute("aria-label", `Share RMUX terminal ${win.index}: ${win.name}`);
  button.innerHTML = RMUX_SHARE_ICON;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    shareRmuxWindow(win, button);
  });
  return button;
}

function windowsForSession(sessionId) {
  return state.windows.filter((win) => win.sessionId === sessionId);
}

// A per-window annotation row, shown right under a window's button in the list:
// a free-text follow-up note (e.g. "waiting on CI #4567") useful for tracking a
// long-running task in that window. Click to edit; stored server-side on the
// tmux window so it follows the window across devices/restarts.
function windowAnnotationRow(win) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "window-annotation";
  const note = (win.annotation || "").trim();
  if (note) {
    row.classList.add("has-note");
    const icon = document.createElement("span");
    icon.className = "window-annotation-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "📝";
    const text = document.createElement("span");
    text.className = "window-annotation-text";
    text.textContent = note;
    row.append(icon, text);
    row.title = "Edit note";
    row.setAttribute("aria-label", `Window note: ${note}. Tap to edit.`);
  } else {
    row.textContent = "+ add note";
    row.title = "Add a follow-up note";
    row.setAttribute("aria-label", "Add a window note");
  }
  row.addEventListener("click", () => editWindowAnnotation(win));
  return row;
}

async function editWindowAnnotation(win) {
  const current = win.annotation || "";
  const next = window.prompt(`Note for window "${win.index}: ${win.name}":`, current);
  if (next === null) return; // cancelled
  try {
    const updated = await api("/api/windows", {
      method: "PATCH",
      body: JSON.stringify({ windowId: win.id, annotation: next }),
    });
    // Reflect the new value locally and re-render so it shows immediately, in
    // both the window list and the snapshot toolbar note.
    const w = state.windows.find((item) => item.id === win.id);
    if (w) w.annotation = updated.annotation || "";
    renderWindows();
    renderSnapshotNote();
  } catch (error) {
    setStatus(error.message || "Could not save note", false);
  }
}

// The current window's note, shown in the snapshot toolbar right after the Lines
// picker. Click to edit (reuses editWindowAnnotation). Mirrors the window-list
// annotation but for the window you're viewing — so a note is visible and
// editable without opening the picker.
function renderSnapshotNote() {
  const el = els.snapshotNote;
  if (!el) return;
  const win = selectedWindow();
  if (!win) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const note = (win.annotation || "").trim();
  if (note) {
    el.classList.add("has-note");
    el.textContent = `📝 ${note}`;
    el.title = "Edit note";
    el.setAttribute("aria-label", `Window note: ${note}. Tap to edit.`);
  } else {
    el.classList.remove("has-note");
    el.textContent = "+ note";
    el.title = "Add a follow-up note for this window";
    el.setAttribute("aria-label", "Add a window note");
  }
  el.onclick = () => editWindowAnnotation(win);
}

// One flat list of every window, grouped under a session header — no session
// dropdown, so any window is one tap away — with a Recent section on top for
// quick switching back to where you just were.
function renderWindows() {
  els.mobileWindows.innerHTML = "";

  if (state.windows.length === 0) {
    empty(els.mobileWindows, "No windows");
    return;
  }

  // The picker is now solely the full, all-windows browser (grouped by session)
  // — no Recent section. Quick-switch-to-recent lives in the dedicated global
  // recents popup in the topbar, so it isn't duplicated here.
  for (const session of state.sessions) {
    const wins = windowsForSession(session.id);
    if (wins.length === 0) continue;

    const header = document.createElement("div");
    header.className = "window-group-header";
    header.innerHTML = `
      <span>${escapeHtml(session.name)}</span>
      <span class="window-group-count">${wins.length} win${wins.length === 1 ? "" : "s"}${session.attached ? " · attached" : ""}</span>
    `;
    els.mobileWindows.append(header);

    for (const win of wins) {
      const live = Boolean(state.windowActivity[win.id]);
      const meta = state.windowMetadata[win.id] || {};
      const branch = meta.git?.branch || "";
      const worktree = Boolean(meta.git?.worktree);
      const agentType = meta.agentType || "";
      const turn = meta.turn || "";
      const waitingForInput = Boolean(meta.waitingForInput) && win.id !== state.windowId;
      const waitingConfidence = meta.waitingConfidence || "";
      const unread = isWindowUnread(win) && win.id !== state.windowId;
      // Show the cwd's basename only when it carries new info — i.e. when it
      // differs from the branch name. With `git worktree add ../foo foo` the
      // dir and branch usually share a name, in which case the cwd row would
      // just be visual noise.
      const dirBasename = pathLabel(win.cwd) || "";
      const cwdLabel = branch && dirBasename === branch ? "" : dirBasename;
      const windowButton = itemButton({
        active: win.id === state.windowId,
        title: `${win.index}: ${win.name}`,
        meta: win.activeCommand || win.id,
        badge: live ? "live" : "",
        badgeGreen: live,
        onClick: () => selectWindow(win.id),
        className: state.mux === "rmux" ? "item window-item-main" : "",
        cwd: cwdLabel,
        branch,
        worktree,
        agentType,
        turn,
        unread,
        waitingForInput,
        waitingConfidence,
      });
      if (state.mux === "rmux") {
        const row = document.createElement("div");
        row.className = "window-item-row";
        row.append(windowButton, rmuxShareWindowButton(win));
        els.mobileWindows.append(row);
      } else {
        els.mobileWindows.append(windowButton);
      }
      els.mobileWindows.append(windowAnnotationRow(win));
    }
  }
}

// Gather the plain fields the pure window-id helpers need from app state. The
// hostname falls back to the machine id, then the page host; session falls back
// to its id. See public/window-id.js.
function windowIdFields(win) {
  if (!win) return null;
  const session = state.sessions.find((s) => s.id === win.sessionId);
  const meta = state.windowMetadata[win.id] || {};
  return {
    host:
      selectedMachine()?.hostname || state.machineId || location.hostname || "local",
    mux: state.mux || "",
    sessionName: session?.name ?? win.sessionId ?? "",
    index: win.index,
    name: win.name,
    cwd: win.cwd,
    branch: meta.git?.branch || "",
    worktree: Boolean(meta.git?.worktree),
    // Captured at visit time (we're on this machine then, so these are
    // available even for entries we later view from another machine): the
    // window note, the agent type, and the activity/turn state — surfaced in
    // the recents hover tooltip.
    note: (win.annotation || "").trim(),
    agentType: meta.agentType || "",
    turn: meta.turn || "",
    live: Boolean(state.windowActivity[win.id]),
  };
}

function renderTargetLabels() {
  renderMachinePicker();
  updateDocumentTitle();
  const win = selectedWindow();
  if (!win) {
    if (state.targetLoadingMessage) {
      els.mobileTargetLabel.textContent =
        state.runtimeMode === "hub" && state.machineId
          ? `${selectedMachine()?.hostname || state.machineId || "Machine"} · ${state.targetLoadingMessage}`
          : state.targetLoadingMessage;
      return;
    }
    if (state.runtimeMode === "hub" && !state.machineId) {
      els.mobileTargetLabel.textContent = "Select a machine";
    } else {
      els.mobileTargetLabel.textContent = state.runtimeMode === "hub"
        ? `${selectedMachine()?.hostname || state.machineId || "Machine"} · No window selected`
        : "No window selected";
    }
    els.openTargetPicker?.removeAttribute("title");
    renderSnapshotNote();
    updateNewBranchAffordance();
    return;
  }
  // The title text is built by the shared windowTitleText() so the recents menu
  // items render in the EXACT same format. The session name is intentionally
  // not shown (host + index disambiguate), and the WT chip is gone — the cwd
  // already says where you are; worktree status lives in the hover tooltip /
  // copied descriptor. The machine prefix only shows in hub mode (the recents
  // popup always passes it, since it's cross-machine).
  const machine =
    state.runtimeMode === "hub"
      ? selectedMachine()?.hostname || state.machineId || "Machine"
      : "";
  const branch = (state.windowMetadata[win.id] || {}).git?.branch || "";
  const titleText = windowTitleText({
    machine,
    index: win.index,
    name: win.name,
    cwd: win.cwd,
    branch,
  });
  // innerHTML for ellipsis behaviour on the <strong>; escape since the text can
  // contain a window name / branch / path with HTML-special chars.
  els.mobileTargetLabel.innerHTML = escapeHtml(titleText);
  // Richer detail on hover (desktop) — the full descriptor including the stable
  // id and worktree status that we no longer show inline. (Copy lives in the
  // More menu now; its item label carries the action text.)
  const fields = windowIdFields(win);
  els.openTargetPicker?.setAttribute("title", windowDescriptor(fields));
  renderSnapshotNote();
  updateNewBranchAffordance();
}

// Show the "New branch" More-menu item only when the current window is a
// bare-repo-backed git worktree (the layout where spinning up a new branch as a
// sibling worktree makes sense). Gated on meta.git.bare.
function updateNewBranchAffordance() {
  if (!els.newBranchWindow) return;
  const win = selectedWindow();
  const bare = Boolean(win && (state.windowMetadata[win.id] || {}).git?.bare);
  els.newBranchWindow.hidden = !bare;
}

function abbrevHome(value) {
  return String(value || "")
    .replace(/^\/(?:Users|home)\/[^/]+/, "~")
    .replace(/^\/root(?=\/|$)/, "~");
}

function pathLabel(value) {
  const text = String(value || "");
  const trimmed = text.replace(/\/+$/, "");
  if (!trimmed) return text || "/";
  return trimmed.split("/").pop() || trimmed || "/";
}

function shellQuote(value) {
  return "'" + String(value || "").replaceAll("'", "'\\''") + "'";
}

function resetDirectoryNavigator(message = "No window selected") {
  state.directories = {
    cwd: "",
    parent: "",
    entries: [],
    loading: false,
    error: message,
  };
  renderDirectoryNavigator();
}

function clearPaneViewForWindowSwitch(message = "Loading window...") {
  state.viewLoadGeneration += 1;
  state.panes = [];
  state.paneId = "";
  state.chat = [];
  state.currentAgentKind = null;
  state.pendingSnapshotText = null;
  setSnapshotStale(false);
  resetDirectoryNavigator("Loading directories...");
  renderTargetLabels();
  renderChat();
  renderReadButtonsEnabled();
  updateSnapshotText(message, { forceScrollBottom: true });
}

function clearTargetViewForUrlNavigation(urlTarget, message = "Loading window...") {
  state.treeLoadGeneration += 1;
  if (urlTarget?.machineId) state.machineId = urlTarget.machineId;
  if (urlTarget?.mux !== undefined) state.mux = normalizeMux(urlTarget.mux);
  state.targetLoadingMessage = message;
  state.sessions = [];
  state.windows = [];
  state.windowActivity = {};
  state.windowMetadata = {};
  state.sessionId = "";
  state.windowId = "";
  clearPaneViewForWindowSwitch(message);
  renderWindows();
  renderTargetLabels();
}

function directoryButton(label, targetPath, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `directory-button ${className}`.trim();
  button.textContent = label;
  button.title = targetPath;
  button.dataset.cwdPath = targetPath;
  return button;
}

function renderDirectoryNavigator() {
  const { cwd, parent, entries, loading, error } = state.directories;
  const visibleEntries = entries.filter((entry) => !entry.hidden && !entry.name.startsWith("."));
  els.directoryPath.textContent = cwd || error || "No window selected";
  els.directoryNavigator.classList.toggle("loading", loading);
  els.directoryList.replaceChildren();

  if (!state.paneId) {
    els.directoryList.append(directoryStatus("Select a window."));
    return;
  }
  if (loading && entries.length === 0) {
    els.directoryList.append(directoryStatus("Loading directories..."));
    return;
  }
  if (error && entries.length === 0) {
    els.directoryList.append(directoryStatus(error));
    return;
  }

  if (parent && parent !== cwd) {
    els.directoryList.append(directoryButton("..", parent, "parent"));
  }
  for (const entry of visibleEntries) {
    els.directoryList.append(directoryButton(entry.name, entry.path));
  }
  if (visibleEntries.length === 0 && !(parent && parent !== cwd)) {
    els.directoryList.append(directoryStatus("No child directories."));
  }
}

function directoryStatus(text) {
  const item = document.createElement("span");
  item.className = "directory-status";
  item.textContent = text;
  return item;
}

function syncSheetOpenClass() {
  document.body.classList.toggle(
    "sheet-open",
    state.targetPickerOpen || state.directoryPickerOpen || state.pinsSheetOpen,
  );
}

function showTargetPicker() {
  closeDirectoryPicker();
  // The full window list and the recents quick-switch popup are two views of
  // the same "switch window" intent — don't show both at once. Opening the
  // picker dismisses the recents popup.
  setGlobalRecentsOpen(false);
  state.targetPickerOpen = true;
  els.targetSheet.hidden = false;
  syncSheetOpenClass();
}

function openTargetPicker() {
  showTargetPicker();
  refreshTree().then(() => {
    startActivityPolling();
    loadWindowMetadata();
  });
}

function closeTargetPicker() {
  state.targetPickerOpen = false;
  els.targetSheet.hidden = true;
  syncSheetOpenClass();
  stopActivityPolling();
}

function openDirectoryPicker() {
  closeTargetPicker();
  state.directoryPickerOpen = true;
  els.directorySheet.hidden = false;
  syncSheetOpenClass();
  loadDirectories({ clear: false }).catch((error) => {
    addChat("system", error.message, "directory error");
  });
}

function closeDirectoryPicker() {
  state.directoryPickerOpen = false;
  els.directorySheet.hidden = true;
  syncSheetOpenClass();
}

// ---- Pinned artifacts management sheet ----------------------------------

function openPinsSheet() {
  closeTargetPicker();
  closeDirectoryPicker();
  setGlobalRecentsOpen(false);
  state.pinsSheetOpen = true;
  els.pinsSheet.hidden = false;
  syncSheetOpenClass();
  loadPins();
}

function closePinsSheet() {
  state.pinsSheetOpen = false;
  els.pinsSheet.hidden = true;
  syncSheetOpenClass();
}

const PIN_SCOPE_LABELS = {
  private: "Only me",
  users: "Specific people",
  org: "My organization",
  all: "All logged-in users",
};

function formatPinAge(ts) {
  if (!ts) return "";
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatPinSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadPins() {
  if (!els.pinsList) return;
  els.pinsList.innerHTML = "";
  const loading = document.createElement("div");
  loading.className = "pins-empty";
  loading.textContent = "Loading…";
  els.pinsList.append(loading);
  try {
    const { pins } = await api("/api/pins");
    renderPins(pins || []);
  } catch (error) {
    els.pinsList.innerHTML = "";
    const err = document.createElement("div");
    err.className = "pins-empty";
    err.textContent = error.message || "Failed to load pins.";
    els.pinsList.append(err);
  }
}

function renderPins(pins) {
  els.pinsList.innerHTML = "";
  if (!pins.length) {
    const empty = document.createElement("div");
    empty.className = "pins-empty";
    empty.textContent = "No pinned artifacts yet. Open a file and tap Pin.";
    els.pinsList.append(empty);
    return;
  }
  for (const pin of pins) {
    els.pinsList.append(renderPinRow(pin));
  }
}

function renderPinRow(pin) {
  const row = document.createElement("div");
  row.className = "pin-row";

  const head = document.createElement("div");
  head.className = "pin-row-head";
  const name = document.createElement("strong");
  name.className = "pin-name";
  name.textContent = pin.name;
  head.append(name);
  if (pin.version > 1) {
    const ver = document.createElement("span");
    ver.className = "pin-chip";
    ver.textContent = `v${pin.version}`;
    head.append(ver);
  }
  row.append(head);

  const meta = document.createElement("div");
  meta.className = "pin-meta";
  const bits = [
    formatPinSize(pin.size),
    formatPinAge(pin.createdAt),
    PIN_SCOPE_LABELS[pin.share.scope] || pin.share.scope,
  ].filter(Boolean);
  if (!pin.owned && pin.ownerEmail) bits.push(`by ${pin.ownerEmail}`);
  meta.textContent = bits.join(" · ");
  row.append(meta);

  const pinSub =
    pin.preview ||
    (pin.sourcePath && !pin.sourcePath.startsWith("agent-response/") ? pin.sourcePath : "");
  if (pinSub) {
    const src = document.createElement("div");
    src.className = "pin-source";
    src.textContent = pinSub;
    row.append(src);
  }

  const actions = document.createElement("div");
  actions.className = "pin-actions";

  const open = document.createElement("button");
  open.className = "small-button";
  open.type = "button";
  open.textContent = "Open";
  open.addEventListener("click", () => {
    // Markdown renders by default on the share link now; no &view needed.
    openViewerUrl(pin.shareUrl);
  });
  actions.append(open);

  const copy = document.createElement("button");
  copy.className = "small-button";
  copy.type = "button";
  copy.textContent = "Copy link";
  copy.addEventListener("click", async () => {
    const link = `${window.location.origin}${pin.shareUrl}`;
    try {
      await navigator.clipboard?.writeText(link);
      setStatus("Link copied", true);
    } catch {
      setStatus(link, true);
    }
  });
  actions.append(copy);

  // Owner-only: change sharing scope + unpin.
  if (pin.owned) {
    const scope = document.createElement("select");
    scope.className = "pin-scope-select";
    for (const value of ["private", "users", "org", "all"]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = PIN_SCOPE_LABELS[value];
      if (value === pin.share.scope) opt.selected = true;
      scope.append(opt);
    }
    const usersInput = document.createElement("input");
    usersInput.className = "pin-users-input";
    usersInput.placeholder = "emails, comma-separated";
    usersInput.value = (pin.share.users || []).join(", ");
    usersInput.hidden = pin.share.scope !== "users";

    const applyScope = async () => {
      usersInput.hidden = scope.value !== "users";
      const share = {
        scope: scope.value,
        users:
          scope.value === "users"
            ? usersInput.value.split(",").map((s) => s.trim()).filter(Boolean)
            : [],
      };
      try {
        await api(`/api/pins?id=${encodeURIComponent(pin.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ share }),
        });
        setStatus("Sharing updated", true);
      } catch (error) {
        setStatus(error.message || "Update failed", false);
      }
    };
    scope.addEventListener("change", applyScope);
    usersInput.addEventListener("change", applyScope);
    actions.append(scope);

    const unpin = document.createElement("button");
    unpin.className = "small-button danger";
    unpin.type = "button";
    unpin.textContent = "Unpin";
    unpin.addEventListener("click", async () => {
      if (!window.confirm(`Unpin "${pin.name}"? The share link will stop working.`)) {
        return;
      }
      try {
        await api(`/api/pins?id=${encodeURIComponent(pin.id)}`, { method: "DELETE" });
        setStatus("Unpinned", true);
        loadPins();
      } catch (error) {
        setStatus(error.message || "Unpin failed", false);
      }
    });
    actions.append(unpin);

    row.append(actions);
    row.append(usersInput);
  } else {
    row.append(actions);
  }

  return row;
}

// The text composer uses Lexical, loaded from a CDN since the app has no build
// step (app.js is an ES module). If Lexical fails to load, the element is still
// a contenteditable, so input keeps working. Plain text for now; rich features
// can be layered on later.
const LEXICAL_VERSION = "0.44.0";
let composerEditor = null;

async function initComposerEditor() {
  try {
    const [lexical, plainText] = await Promise.all([
      import(`https://esm.sh/lexical@${LEXICAL_VERSION}`),
      import(`https://esm.sh/@lexical/plain-text@${LEXICAL_VERSION}?deps=lexical@${LEXICAL_VERSION}`),
    ]);
    const editor = lexical.createEditor({
      namespace: "tmux-mobile-composer",
      onError: (error) => console.error("Lexical error", error),
    });
    editor.setRootElement(els.textInput);
    plainText.registerPlainText(editor);
    editor.registerCommand(
      lexical.KEY_ENTER_COMMAND,
      (event) => {
        if (event?.shiftKey) return false; // Shift+Enter inserts a newline
        event?.preventDefault();
        if (state.voice.status === "recording") {
          submitVoiceRecording({ sendAfterTranscribe: true });
          return true;
        }
        submitTextComposer();
        return true;
      },
      lexical.COMMAND_PRIORITY_HIGH,
    );
    editor.update(() => {
      const root = lexical.$getRoot();
      if (root.getFirstChild() === null) {
        root.append(lexical.$createParagraphNode());
      }
    });
    editor.registerUpdateListener(({ editorState }) => {
      const empty = editorState.read(
        () => lexical.$getRoot().getTextContent().length === 0,
      );
      els.textInput.classList.toggle("empty", empty);
    });
    composerEditor = { editor, lexical };
  } catch (error) {
    console.error("Lexical failed to load; using plain contenteditable", error);
    composerEditor = null;
  }
}

function composerGetText() {
  if (composerEditor) {
    return composerEditor.editor
      .getEditorState()
      .read(() => composerEditor.lexical.$getRoot().getTextContent());
  }
  return els.textInput.innerText;
}

function composerClear() {
  if (composerEditor) {
    composerEditor.editor.update(() => {
      const { $getRoot, $createParagraphNode } = composerEditor.lexical;
      const root = $getRoot();
      root.clear();
      root.append($createParagraphNode());
    });
  } else {
    els.textInput.textContent = "";
  }
  els.textInput.classList.add("empty");
}

// Place the caret at the END of a contenteditable (the non-Lexical fallback).
// A plain focus() drops the caret at the start, so inserting a snippet/dictation
// and focusing left the caret in front of the inserted text.
function placeCaretAtEnd(el) {
  if (!el) return;
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false); // collapse to the end
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {}
}

function composerFocus() {
  if (composerEditor) {
    // Lexical: focus AND anchor the selection at the document end.
    composerEditor.editor.focus(undefined, { defaultSelection: "rootEnd" });
  } else {
    els.textInput.focus();
    placeCaretAtEnd(els.textInput);
  }
}

// Drop focus from the editor so the mobile virtual keyboard retracts. Lexical
// reconciles asynchronously and re-asserts DOM focus while it still holds a
// selection, so clearing the selection first (inside an update) is what actually
// lets the blur stick; then blur the contenteditable element directly.
function composerBlur() {
  const node = els.textInput;
  if (!node) return;
  if (composerEditor) {
    const { editor, lexical } = composerEditor;
    editor.update(() => {
      lexical.$setSelection(null);
    });
    editor.blur();
  }
  node.blur();
}

// Set the composer's contents to `text` (replace) with the caret at the end.
function composerSetText(text) {
  const value = String(text || "");
  if (composerEditor) {
    const { editor, lexical } = composerEditor;
    editor.update(() => {
      const root = lexical.$getRoot();
      root.clear();
      // Preserve newlines: one paragraph per line.
      const lines = value.split("\n");
      for (const line of lines) {
        const p = lexical.$createParagraphNode();
        if (line) p.append(lexical.$createTextNode(line));
        root.append(p);
      }
      root.selectEnd();
    });
  } else {
    els.textInput.textContent = value;
  }
  els.textInput.classList.toggle("empty", value.length === 0);
}

// Append `text` to whatever's already in the box (with a separating space if the
// box is non-empty and not already ending in whitespace), caret to end, focus.
// This is how snippets, dictation, and recall all land in the box.
function composerAppendText(text) {
  const add = String(text || "");
  if (!add) return;
  const current = composerGetText();
  const sep = current && !/\s$/.test(current) ? " " : "";
  composerSetText(current + sep + add);
  requestAnimationFrame(() => composerFocus());
}

// Upload the selected file(s) to a temp dir on the target machine and insert
// each returned absolute path into the message box. Files go to /api/upload as
// raw bytes; the server writes them via the backend seam (local or brokered to
// the agent) and returns the path.
async function uploadFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (!state.paneId) {
    addChat("system", "Select a window first.", "system");
    return;
  }
  if (els.attachButton) els.attachButton.disabled = true;
  setStatus(files.length === 1 ? "Uploading…" : `Uploading ${files.length} files…`);
  try {
    for (const file of files) {
      const params = new URLSearchParams({ paneId: state.paneId, name: file.name });
      const data = await api(`/api/upload?${params}`, {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
      });
      if (data.path) composerAppendText(data.path);
    }
    setStatus("file uploaded");
  } catch (error) {
    addChat("system", error.message || "Upload failed", "upload error");
    setStatus(error.message || "Upload failed", false);
  } finally {
    if (els.attachButton) els.attachButton.disabled = false;
  }
}

// The composer has one state toggle now: idle ↔ listening (recording). Drive the
// listening treatment + control visibility from the voice status.
function renderComposerMode() {
  const listening = state.voice.status === "recording";
  const busy = state.voice.status === "transcribing" || state.voice.status === "sending";
  els.inputArea?.classList.toggle("listening", listening);
  els.inputArea?.classList.toggle("busy", busy);
}

function visibleVoiceStatus(title, subtitle, status) {
  if (state.voice.pendingAudio && state.voice.pendingError && status === "idle") {
    return "Send failed - Audio saved for retry";
  }
  if (status === "idle") {
    return "Ready";
  }
  if (subtitle && status !== "idle") {
    return `${title} - ${subtitle}`;
  }
  return title;
}

function renderVoiceRetry() {
  const hasPendingAudio = Boolean(state.voice.pendingAudio);
  const canRetry = hasPendingAudio && state.voice.status === "idle";
  els.retryVoice.hidden = !canRetry;
  els.retryVoice.disabled = !canRetry;
  const failed = canRetry && Boolean(state.voice.pendingError);
  els.voiceStatus.dataset.state = failed ? "failed" : state.voice.status;
  // Toggle the whole row so its grid track collapses when there's nothing to show.
  const statusVisible =
    els.voiceStatus.dataset.state !== "idle" &&
    els.voiceStatus.dataset.state !== "recording";
  els.voiceStatusRow.hidden = !statusVisible && !canRetry;
}

function newRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function rememberPendingVoiceAudio(blob) {
  state.voice.pendingAudio = blob;
  state.voice.pendingMimeType = blob.type || "audio/webm";
  state.voice.pendingTranscript = "";
  state.voice.pendingError = "";
  // Stable per-recording idempotency key, reused across every retry so the
  // server can dedupe — without it, a flaky link makes /api/voice-send paste
  // the same message into tmux once per retry.
  state.voice.pendingIdempotencyKey = newRequestId();
  renderVoiceRetry();
}

function clearPendingVoiceAudio() {
  state.voice.pendingAudio = null;
  state.voice.pendingMimeType = "";
  state.voice.pendingTranscript = "";
  state.voice.pendingError = "";
  state.voice.pendingIdempotencyKey = "";
  state.voice.sendAfterTranscribe = false;
  renderVoiceRetry();
}

async function submitTextComposer(event, { keepFocus = true } = {}) {
  event?.preventDefault();
  const text = composerGetText();
  if (!text.trim()) {
    composerFocus();
    return;
  }
  if (!state.paneId) {
    addChat("system", "Select a window first.", "system");
    return;
  }

  // Clear the box. Enter-to-send keeps focus (you're mid-flow typing); tapping
  // the Send button is an explicit "done" → blur so the virtual keyboard hides.
  composerClear();
  if (keepFocus) composerFocus();
  else composerBlur();
  els.submitText.disabled = true;
  // Remember what was sent so it shows under "Recent" in the Insert picker.
  pushComposerHistory(text);
  try {
    await sendMessage(text, true);
  } catch (error) {
    // Optimistic clear is great on the happy path, but if the send actually
    // failed the user has lost their text. Put it back in the composer so
    // they can fix-and-retry without re-typing, and re-focus so the keyboard
    // pops back up on mobile. The error chat row + box-still-has-the-text
    // is the unambiguous "submit didn't go through" signal.
    composerSetText(text);
    composerFocus();
    addChat("system", `Send failed: ${error.message}`, "send error");
  } finally {
    els.submitText.disabled = false;
  }
}

// Render the auto-collected history (newest first) as tap-to-insert rows in the
// "Recent" section of the unified Insert picker.
function renderHistoryList() {
  const list = els.historyList;
  if (!list) return;
  list.innerHTML = "";
  const items = getComposerHistory().slice().reverse();
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "No recent messages yet.";
    list.append(empty);
    return;
  }
  for (const text of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "history-item";
    btn.textContent = text;
    btn.title = text;
    btn.addEventListener("click", () => {
      closeSnippetManager();
      composerAppendText(text);
    });
    list.append(btn);
  }
}

async function requestScreenWakeLock() {
  if (!("wakeLock" in navigator) || screenWakeLock) return;
  try {
    screenWakeLock = await navigator.wakeLock.request("screen");
    screenWakeLock.addEventListener("release", () => {
      screenWakeLock = null;
    });
  } catch {
    screenWakeLock = null;
  }
}

function releaseScreenWakeLock() {
  if (!screenWakeLock) return;
  const lock = screenWakeLock;
  screenWakeLock = null;
  lock.release().catch(() => {});
}

function shouldHoldScreenAwake() {
  return state.voice.status !== "idle" || state.audio.busy;
}

function syncScreenWakeLock() {
  if (shouldHoldScreenAwake()) {
    requestScreenWakeLock();
  } else {
    releaseScreenWakeLock();
  }
}

function setVoiceStatus(status, title, subtitle) {
  state.voice.status = status;
  syncScreenWakeLock();
  els.voiceTitle.textContent = title;
  els.voiceSubtitle.textContent = subtitle;
  // Topbar status is a single icon (state via data-state + CSS); full text lives
  // in the tooltip/aria-label only.
  els.voiceStatus.title = visibleVoiceStatus(title, subtitle, status);
  els.voiceStatus.setAttribute("aria-label", els.voiceStatus.title);
  const buttonLabel = status === "idle" ? "Dictate" : title;
  els.voiceButton.title = buttonLabel;
  els.voiceButton.setAttribute("aria-label", buttonLabel);
  // Listening controls (Keep ✓ / Discard X) are only active while recording.
  els.submitVoice.disabled = status !== "recording";
  els.cancelVoice.disabled = status !== "recording";
  els.voiceButton.classList.toggle("recording", status === "recording");
  els.voiceButton.classList.toggle(
    "busy",
    status === "transcribing" || status === "sending",
  );
  // The mic is disabled while transcribing; usable when idle (and hidden via CSS
  // while recording, where Keep/Discard take over).
  els.voiceButton.disabled = status !== "idle";
  renderVoiceRetry();
  renderComposerMode();
}

function chooseAudioMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/mpeg",
  ];
  if (!window.MediaRecorder?.isTypeSupported) return "";
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function renderVoiceWaveform() {
  if (els.voiceWaveform.children.length !== MAX_WAVEFORM_SAMPLES) {
    els.voiceWaveform.replaceChildren(
      ...Array.from({ length: MAX_WAVEFORM_SAMPLES }, () =>
        document.createElement("span"),
      ),
    );
  }

  const padded = [
    ...Array(Math.max(0, MAX_WAVEFORM_SAMPLES - state.voice.waveform.length)).fill(0),
    ...state.voice.waveform.slice(-MAX_WAVEFORM_SAMPLES),
  ];

  [...els.voiceWaveform.children].forEach((bar, index) => {
    const level = padded[index] || 0;
    const pct = level > 0.02 ? 0.15 + level * 0.85 : 0.08;
    bar.style.height = `${Math.max(3, Math.round(pct * 28))}px`;
  });
}

function sampleVoiceAmplitude() {
  const analyser = state.voice.analyser;
  if (!analyser) return;

  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(data);

  let sum = 0;
  for (let index = 0; index < data.length; index += 1) {
    const value = (data[index] - 128) / 128;
    sum += value * value;
  }

  const rms = Math.sqrt(sum / data.length);
  const amplitude = Math.min(1, rms * 3);
  state.voice.waveform = [...state.voice.waveform, amplitude].slice(
    -MAX_WAVEFORM_SAMPLES,
  );
  renderVoiceWaveform();
}

function stopVoiceAnalysis({ clearWaveform = true } = {}) {
  if (state.voice.sampleTimer) {
    window.clearInterval(state.voice.sampleTimer);
    state.voice.sampleTimer = null;
  }

  if (state.voice.audioContext) {
    state.voice.audioContext.close().catch(() => {});
    state.voice.audioContext = null;
  }

  state.voice.analyser = null;
  if (clearWaveform) {
    state.voice.waveform = [];
    renderVoiceWaveform();
  }
}

function startVoiceAnalysis(stream) {
  stopVoiceAnalysis({ clearWaveform: true });
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return;

  const audioContext = new AudioContextCtor();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  state.voice.audioContext = audioContext;
  state.voice.analyser = analyser;
  state.voice.sampleTimer = window.setInterval(
    sampleVoiceAmplitude,
    WAVEFORM_SAMPLE_INTERVAL_MS,
  );
  sampleVoiceAmplitude();
}

function stopVoiceStream() {
  if (state.voice.stream) {
    for (const track of state.voice.stream.getTracks()) {
      track.stop();
    }
  }
  state.voice.stream = null;
}

async function startVoiceRecording() {
  if (!state.paneId) {
    addChat("system", "Select a window first.", "system");
    return;
  }
  if (!window.isSecureContext) {
    setVoiceStatus(
      "idle",
      "Dictate",
      "Microphone needs HTTPS or localhost",
    );
    addChat("system", "Microphone access needs HTTPS or localhost.", "system");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    addChat("system", "This browser does not support recording.", "system");
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
  startVoiceAnalysis(stream);
  const mimeType = chooseAudioMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  state.voice.chunks = [];
  state.voice.cancelRequested = false;
  state.voice.stream = stream;
  state.voice.mediaRecorder = recorder;

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data?.size > 0) {
      state.voice.chunks.push(event.data);
    }
  });
  recorder.addEventListener("stop", () => {
    if (state.voice.cancelRequested) {
      discardVoiceRecording();
      return;
    }

    finishVoiceRecording().catch((error) => {
      handleVoiceSendError(error);
    });
  });

  recorder.start(1000);
  setVoiceStatus("recording", "Listening", "Keep (✓) to transcribe, or discard (✕)");
}

// "Keep" stops recording, transcribes, and appends the text to the box. The
// keyboard shortcut path can also send immediately after transcription.
function submitVoiceRecording(options = {}) {
  const recorder = state.voice.mediaRecorder;
  if (!recorder || recorder.state !== "recording") return;
  state.voice.sendAfterTranscribe = Boolean(options?.sendAfterTranscribe);
  state.voice.cancelRequested = false;
  stopVoiceAnalysis({ clearWaveform: false });
  setVoiceStatus("transcribing", "Transcribing", "Converting speech to text");
  recorder.stop();
}

function discardVoiceRecording() {
  stopVoiceAnalysis({ clearWaveform: true });
  stopVoiceStream();
  state.voice.chunks = [];
  state.voice.cancelRequested = false;
  state.voice.mediaRecorder = null;
  state.voice.sendAfterTranscribe = false;
  setVoiceStatus("idle", "Dictate", "Tap to dictate into the message box");
}

function cancelVoiceRecording() {
  const recorder = state.voice.mediaRecorder;
  state.voice.sendAfterTranscribe = false;
  state.voice.cancelRequested = true;
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    return;
  }
  discardVoiceRecording();
}

async function finishVoiceRecording() {
  const sendAfterTranscribe = state.voice.sendAfterTranscribe;
  try {
    const mimeType = state.voice.mediaRecorder?.mimeType || "audio/webm";
    stopVoiceAnalysis({ clearWaveform: false });
    stopVoiceStream();
    const blob = new Blob(state.voice.chunks, { type: mimeType });
    state.voice.chunks = [];
    state.voice.cancelRequested = false;
    state.voice.mediaRecorder = null;

    if (blob.size === 0) {
      throw new Error("No audio captured");
    }

    rememberPendingVoiceAudio(blob);
    await transcribePendingVoiceWithRetry();
    if (sendAfterTranscribe) {
      await submitTextComposer(null, { keepFocus: true });
    }
  } finally {
    state.voice.sendAfterTranscribe = false;
  }
}

// Transcribe the pending audio and APPEND the text to the message box (no send).
// The user reviews/edits, then taps Send. This is the dictate-into-the-box model.
async function transcribePendingVoiceRecording() {
  const blob = state.voice.pendingAudio;
  if (!blob) return;

  state.voice.pendingError = "";
  renderVoiceRetry();

  setVoiceStatus("transcribing", "Transcribing", "Converting speech to text");
  const data = await api("/api/transcribe", {
    method: "POST",
    headers: {
      "content-type": state.voice.pendingMimeType || "audio/webm",
      // Same key on every retry of the same recording, so the server can
      // collapse duplicates to one tmux send-keys.
      "x-idempotency-key": state.voice.pendingIdempotencyKey || "",
    },
    body: blob,
  });
  const text = String(data.text || "").trim();
  if (!text) {
    throw new Error("No speech detected");
  }
  composerAppendText(text);
  clearPendingVoiceAudio();
  setVoiceStatus("idle", "Ready", "Tap mic to dictate");
  stopVoiceAnalysis({ clearWaveform: true });
}

const VOICE_TRANSCRIBE_MAX_ATTEMPTS = 3;
const VOICE_TRANSCRIBE_RETRY_DELAY_MS = 1200;

// These fail the same way on every attempt, so retrying is pointless.
function isRetryableVoiceError(error) {
  const message = (error?.message || "").toLowerCase();
  return !(
    message.includes("no speech") ||
    message.includes("too large") ||
    message.includes("no speech recognized")
  );
}

// Transcription can fail on transient network hiccups; auto-retry a few times
// before surfacing failure (the audio is kept for a manual retry).
async function transcribePendingVoiceWithRetry() {
  for (let attempt = 1; attempt <= VOICE_TRANSCRIBE_MAX_ATTEMPTS; attempt += 1) {
    try {
      await transcribePendingVoiceRecording();
      return;
    } catch (error) {
      if (!isRetryableVoiceError(error) || attempt >= VOICE_TRANSCRIBE_MAX_ATTEMPTS) {
        throw error;
      }
      setVoiceStatus(
        "transcribing",
        "Retrying",
        `Transcribe failed, retry ${attempt + 1}/${VOICE_TRANSCRIBE_MAX_ATTEMPTS}`,
      );
      await new Promise((resolve) => setTimeout(resolve, VOICE_TRANSCRIBE_RETRY_DELAY_MS));
    }
  }
}

function handleVoiceSendError(error) {
  const message = error.message || "Transcription failed";
  addChat("system", message, "voice error");
  stopVoiceAnalysis({ clearWaveform: true });
  stopVoiceStream();
  state.voice.cancelRequested = false;
  state.voice.mediaRecorder = null;
  state.voice.chunks = [];
  state.voice.sendAfterTranscribe = false;
  if (state.voice.pendingAudio) {
    state.voice.pendingError = message;
    setVoiceStatus("idle", "Transcribe failed", "Audio saved for retry");
    return;
  }
  setVoiceStatus("idle", "Ready", "Tap mic to dictate");
}

async function retryVoiceRecording() {
  if (state.voice.status !== "idle" || !state.voice.pendingAudio) return;
  try {
    await transcribePendingVoiceWithRetry();
  } catch (error) {
    handleVoiceSendError(error);
  }
}

async function toggleVoiceRecording() {
  try {
    if (state.voice.status !== "idle") return;
    state.voice.sendAfterTranscribe = false;
    await startVoiceRecording();
  } catch (error) {
    stopVoiceAnalysis({ clearWaveform: true });
    stopVoiceStream();
    state.voice.cancelRequested = false;
    state.voice.mediaRecorder = null;
    state.voice.sendAfterTranscribe = false;
    setVoiceStatus(
      "idle",
      "Dictate",
      "Tap to dictate into the message box",
    );
    addChat("system", error.message, "voice error");
  }
}

function isNonComposerEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  if (els.textInput?.contains(target)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function isEditableShortcutTarget(target) {
  return target instanceof Element
    && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function handleComposerFocusShortcut(event) {
  if (event.defaultPrevented || event.isComposing) return;
  if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
  if (isEditableShortcutTarget(event.target)) return;
  event.preventDefault();
  composerFocus();
}

function handleComposerVoiceShortcut(event) {
  if (event.defaultPrevented || event.isComposing) return;
  const plainEnter =
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey;

  if (plainEnter && state.voice.status === "recording") {
    event.preventDefault();
    event.stopPropagation();
    submitVoiceRecording({ sendAfterTranscribe: true });
    return;
  }

  if (
    event.key === "," &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !isNonComposerEditableTarget(event.target)
  ) {
    event.preventDefault();
    event.stopPropagation();
    toggleVoiceRecording();
  }
}

async function ensureAudioContext() {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return null;
  if (!state.audio.context) {
    state.audio.context = new AudioContextCtor();
  }
  if (state.audio.context.state === "suspended") {
    await state.audio.context.resume();
  }
  return state.audio.context;
}

function audioBytesFromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function setSpeakWindowBusy(busy) {
  state.audio.busy = busy;
  syncScreenWakeLock();
  renderReadButtonsEnabled();
  const stopping = busy && state.audio.stopRequested;
  els.speakWindow.title = stopping
    ? "Stopping reading"
    : busy
      ? "Stop reading"
      : els.speakWindow.disabled
        ? "Read is only available on Codex or Claude windows"
        : "Read current window";
  els.speakWindow.setAttribute(
    "aria-label",
    stopping
      ? "Stopping reading current window"
      : busy
        ? "Stop reading current window"
        : "Read current window",
  );
  els.speakWindow.classList.toggle("reading", busy);
  els.speakWindow.classList.toggle("stopping", stopping);
}

// Read is only meaningful on Codex or Claude panes, where there's a structured
// transcript to lift the last response out of. While reading is in progress
// (`state.audio.busy`) the button MUST stay enabled so the user can hit Stop.
function renderReadButtonsEnabled() {
  const allowed = state.audio.busy || Boolean(state.currentAgentKind);
  els.speakWindow.disabled = !allowed;
}

// Detect the running agent (if any) in the current pane and stash it on
// state so the Read buttons can render their enabled state. Best-effort:
// any error keeps the buttons disabled, which is the conservative default.
async function refreshAgentDetection() {
  if (!state.paneId) {
    state.currentAgentKind = null;
    renderReadButtonsEnabled();
    return;
  }
  try {
    const data = await api(
      `/api/agent-session?paneId=${encodeURIComponent(state.paneId)}`,
    );
    state.currentAgentKind = data?.result?.kind || null;
  } catch {
    state.currentAgentKind = null;
  }
  renderReadButtonsEnabled();
}

function isCurrentAudioRead(readId) {
  return state.audio.readId === readId;
}

function closeRealtimeAudio() {
  closeRealtimeReadAudio(state.audio);
}

function stopWindowSummary() {
  if (!state.audio.busy) return;
  state.audio.stopRequested = true;
  state.audio.readId += 1;
  logClientEvent("realtime_read_stop_requested");
  setStatus("realtime: stopped");
  closeRealtimeAudio();
  setSpeakWindowBusy(false);
}

async function playWindowSummaryRealtime({ readId, windowId, paneId }) {
  return playRealtimeRead({
    audioState: state.audio,
    api,
    readId,
    windowId,
    paneId,
    mux: state.mux,
    logClientEvent,
    setStatus,
    onPlaybackBlocked: (error) => {
      addChat("system", error.message, "audio error");
    },
  });
}

async function playAudioBase64(base64, mimeType) {
  const bytes = audioBytesFromBase64(base64);
  let context = null;
  try {
    context = await ensureAudioContext();
  } catch (error) {
    console.warn(
      "AudioContext is unavailable; falling back to audio element.",
      error,
    );
  }

  if (context) {
    try {
      if (state.audio.source) {
        try {
          state.audio.source.stop();
        } catch {
          // The previous source may already have ended.
        }
      }
      const buffer = await context.decodeAudioData(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      );
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.addEventListener("ended", () => {
        if (state.audio.source === source) {
          state.audio.source = null;
        }
      });
      state.audio.source = source;
      source.start();
      return;
    } catch (error) {
      state.audio.source = null;
      console.warn(
        "AudioContext playback failed; falling back to audio element.",
        error,
      );
    }
  }

  const blob = new Blob([bytes], { type: mimeType || "audio/mpeg" });
  const audioUrl = URL.createObjectURL(blob);
  const audio = new Audio(audioUrl);
  const revokeAudioUrl = () => URL.revokeObjectURL(audioUrl);
  audio.addEventListener("ended", revokeAudioUrl, { once: true });
  audio.addEventListener("error", revokeAudioUrl, { once: true });
  try {
    await audio.play();
  } catch (error) {
    revokeAudioUrl();
    throw error;
  }
}

async function speakWindowSummary() {
  if (!state.paneId) {
    addChat("system", "Select a window first.", "system");
    return;
  }

  const readId = state.audio.readId + 1;
  const paneId = state.paneId;
  const windowId = state.windowId;
  state.audio.readId = readId;
  state.audio.stopRequested = false;
  setSpeakWindowBusy(true);
  addChat("system", "Connecting Realtime audio stream.", "audio");

  try {
    const data = await playWindowSummaryRealtime({ readId, windowId, paneId });
    if (isCurrentAudioRead(readId) && data.transcript.trim()) {
      addChat("system", data.transcript.trim(), "Realtime audio summary");
    }
    if (isCurrentAudioRead(readId)) {
      setStatus(`realtime: ${data.model}`);
    }
  } catch (error) {
    if (
      !isCurrentAudioRead(readId) ||
      state.audio.stopRequested ||
      error.name === "AbortError" ||
      error.message === "Realtime read stopped"
    ) {
      logClientEvent("realtime_read_stopped");
      if (isCurrentAudioRead(readId)) {
        setStatus("realtime: stopped");
      }
      return;
    }
    logClientEvent("realtime_read_failed", {
      message: error.message,
    });
    closeRealtimeAudio();
    throw error;
  } finally {
    if (isCurrentAudioRead(readId)) {
      state.audio.stopRequested = false;
      setSpeakWindowBusy(false);
    }
  }
}

function renderChat() {
  els.chat.innerHTML = "";
  if (!state.paneId) {
    empty(els.chat, "Select a window");
    return;
  }
  if (state.chat.length === 0) {
    empty(els.chat, "No messages for this window");
    return;
  }

  for (const message of state.chat) {
    const row = document.createElement("div");
    row.className = `message ${message.role}`;
    row.innerHTML = `
      <div class="message-meta">${escapeHtml(message.label || message.role)} - ${escapeHtml(message.time || "")}</div>
      <pre>${escapeHtml(message.text)}</pre>
    `;
    els.chat.append(row);
  }
  els.chat.scrollTop = els.chat.scrollHeight;
}

function addChat(role, text, label) {
  state.chat.push({
    role,
    text,
    label,
    time: nowLabel(),
  });
  state.chat = state.chat.slice(-80);
  saveChat();
  renderChat();
}

function excerptForChat(text) {
  const trimmed = stripAnsi(text).trimEnd();
  if (trimmed.length <= 4500) return trimmed || "[no visible output]";
  return `${trimmed.slice(-4500)}\n\n[showing last 4500 chars]`;
}

function scrollSnapshotToBottom() {
  requestAnimationFrame(() => {
    els.snapshot.scrollTop = els.snapshot.scrollHeight;
    state.snapshotPinnedToBottom = true;
  });
}

function isSnapshotAtBottom() {
  const distanceFromBottom =
    els.snapshot.scrollHeight - els.snapshot.scrollTop - els.snapshot.clientHeight;
  return distanceFromBottom <= SNAPSHOT_BOTTOM_SLOP_PX;
}

// Tango-ish 16-color palette (0-7 normal, 8-15 bright), reads well on the dark
// snapshot background.
const ANSI_PALETTE = [
  "#1b1d1e", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
];
// Darker, saturated variants that stay readable on the Kami light terminal.
const ANSI_PALETTE_LIGHT = [
  "#26282a", "#b22222", "#2e7d32", "#9a6a00", "#1f5b8f", "#7b3fa0", "#0a7383", "#4a4f52",
  "#3c4042", "#a8201a", "#256921", "#7a5300", "#1a4d7a", "#6a2f8c", "#0a6370", "#1b1d1e",
];

function ansiKami() {
  return document.documentElement.dataset.theme === "kami";
}

function ansiPalette() {
  return ansiKami() ? ANSI_PALETTE_LIGHT : ANSI_PALETTE;
}

// Relative luminance (WCAG) of an sRGB 0-255 color.
function srgbLin(c) {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function relLum(r, g, b) {
  return 0.2126 * srgbLin(r) + 0.7152 * srgbLin(g) + 0.0722 * srgbLin(b);
}

// On the light terminal, darken raw RGB (cube / grayscale / truecolor) for contrast.
// A flat multiply leaves pale colors (Claude Code's steel-blue, purple, etc.) too
// light on the #faf6ec Kami terminal bg. Instead clamp any color whose luminance
// exceeds a cap, scaling it toward black while preserving hue — this guarantees a
// readable contrast ratio (>= ~4.5:1) regardless of how light the source color is.
const KAMI_LUM_CAP = 0.14;
function ansiRgb(r, g, b) {
  if (ansiKami()) {
    const lum = relLum(r, g, b);
    if (lum > KAMI_LUM_CAP) {
      const k = Math.pow(KAMI_LUM_CAP / lum, 1 / 2.4);
      r *= k;
      g *= k;
      b *= k;
    }
    r = Math.round(r);
    g = Math.round(g);
    b = Math.round(b);
  }
  return `rgb(${r},${g},${b})`;
}

function ansi256(n) {
  if (n < 16) return ansiPalette()[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return ansiRgb(v, v, v);
  }
  const i = n - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  return ansiRgb(steps[Math.floor(i / 36) % 6], steps[Math.floor(i / 6) % 6], steps[i % 6]);
}

function freshAnsiState() {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false };
}

function applyAnsiSgr(state, paramStr) {
  const codes = paramStr === "" ? [0] : paramStr.split(";").map((x) => Number(x) || 0);
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) Object.assign(state, freshAnsiState());
    else if (c === 1) state.bold = true;
    else if (c === 2) state.dim = true;
    else if (c === 3) state.italic = true;
    else if (c === 4) state.underline = true;
    else if (c === 7) state.inverse = true;
    else if (c === 9) state.strike = true;
    else if (c === 22) { state.bold = false; state.dim = false; }
    else if (c === 23) state.italic = false;
    else if (c === 24) state.underline = false;
    else if (c === 27) state.inverse = false;
    else if (c === 29) state.strike = false;
    else if (c >= 30 && c <= 37) state.fg = ansiPalette()[c - 30];
    else if (c >= 40 && c <= 47) state.bg = ansiPalette()[c - 40];
    else if (c >= 90 && c <= 97) state.fg = ansiPalette()[8 + c - 90];
    else if (c >= 100 && c <= 107) state.bg = ansiPalette()[8 + c - 100];
    else if (c === 39) state.fg = null;
    else if (c === 49) state.bg = null;
    else if (c === 38 || c === 48) {
      const target = c === 38 ? "fg" : "bg";
      if (codes[i + 1] === 5) { state[target] = ansi256(codes[i + 2] || 0); i += 2; }
      else if (codes[i + 1] === 2) { state[target] = ansiRgb(codes[i + 2] || 0, codes[i + 3] || 0, codes[i + 4] || 0); i += 4; }
    }
  }
}

function ansiStyle(state) {
  let fg = state.fg;
  let bg = state.bg;
  if (state.inverse) {
    fg = state.bg || "var(--code-bg)";
    bg = state.fg || "var(--code-ink)";
  }
  const parts = [];
  if (fg) parts.push(`color:${fg}`);
  if (bg) parts.push(`background:${bg}`);
  if (state.bold) parts.push("font-weight:700");
  if (state.dim) parts.push("opacity:.65");
  if (state.italic) parts.push("font-style:italic");
  const deco = [];
  if (state.underline) deco.push("underline");
  if (state.strike) deco.push("line-through");
  if (deco.length) parts.push(`text-decoration:${deco.join(" ")}`);
  return parts.join(";");
}

// The active window's GitHub repo (for PR-reference linking), or null. Read
// before ansiToHtml's local `state` shadow so it sees the real app state.
function activeWindowRepo() {
  return state.windowMetadata?.[state.windowId]?.repo || null;
}

// Convert capture-pane -e output (text with SGR color/style codes) to safe HTML.
function ansiToHtml(text) {
  const input = String(text || "");
  const repo = activeWindowRepo(); // captured before the local `state` shadow below
  const sgr = /\x1B\[([0-9;:]*)m/g;
  const state = freshAnsiState();
  let html = "";
  let last = 0;
  let m;
  // Emit escaped, styled chunks WITHOUT linkifying — linkification runs once over
  // the whole assembled string below, so a path/URL that spans an SGR chunk
  // boundary (e.g. a file path the agent printed across a line wrap) is still
  // detected as one. (Per-chunk linkify would only see fragments.)
  const emit = (chunk) => {
    if (!chunk) return;
    const style = ansiStyle(state);
    const body = escapeHtml(chunk);
    html += style ? `<span style="${style}">${body}</span>` : body;
  };
  while ((m = sgr.exec(input)) !== null) {
    emit(input.slice(last, m.index));
    applyAnsiSgr(state, m[1].replace(/:/g, ";"));
    last = sgr.lastIndex;
  }
  emit(input.slice(last));
  // Single linkify pass over the whole styled HTML so URLs/file-paths that span
  // SGR chunk boundaries are detected as one. The matchers exclude '<' so they
  // can't run into or corrupt the <span style> tags.
  return linkifyEscaped(html, { repo });
}

function stripAnsi(text) {
  return String(text || "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-9;:]*m/g, "");
}

// True when the user currently has a non-collapsed text selection inside the
// snapshot. Used to avoid clobbering an in-progress selection (and the "Copy"
// menu) when the auto-refresh would otherwise replace the snapshot's innerHTML.
function hasSnapshotSelection() {
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const node = sel.anchorNode;
  return Boolean(node && els.snapshot.contains(node));
}

function updateSnapshotText(text, { forceScrollBottom = false } = {}) {
  // Remember the raw text so a later metadata change (e.g. the active window's
  // repo resolving) can re-render to linkify PR refs without a re-fetch.
  state.snapshotText = text;
  // Don't destroy a selection the user is actively making — refreshing
  // innerHTML mid-selection makes the text effectively uncopyable on mobile
  // (the next ~auto-refresh wipes the highlight before they can hit Copy). Defer
  // this update; a later refresh (after they copy / tap away) will apply it.
  if (!forceScrollBottom && hasSnapshotSelection()) {
    state.pendingSnapshotText = text;
    return;
  }
  state.pendingSnapshotText = null;

  const shouldScrollToBottom =
    forceScrollBottom || state.snapshotPinnedToBottom || isSnapshotAtBottom();
  const previousScrollTop = els.snapshot.scrollTop;

  els.snapshot.innerHTML = ansiToHtml(text);

  requestAnimationFrame(() => {
    if (shouldScrollToBottom) {
      els.snapshot.scrollTop = els.snapshot.scrollHeight;
      state.snapshotPinnedToBottom = true;
      return;
    }

    const maxScrollTop = Math.max(
      0,
      els.snapshot.scrollHeight - els.snapshot.clientHeight,
    );
    els.snapshot.scrollTop = Math.min(previousScrollTop, maxScrollTop);
    state.snapshotPinnedToBottom = isSnapshotAtBottom();
  });
}

function setSnapshotFullscreen(enabled) {
  state.snapshotFullscreen = enabled;
  document.body.classList.toggle("snapshot-fullscreen", enabled);
  els.fullscreenSnapshot.setAttribute("aria-pressed", String(enabled));
  els.textInput.dataset.placeholder = enabled
    ? "Message…"
    : "Message, dictate, or tap a snippet…";
  scrollSnapshotToBottom();
  window.setTimeout(() => {
    const target = enabled
      ? els.exitSnapshotFullscreen
      : els.fullscreenSnapshot;
    target.focus({ preventScroll: true });
  }, 0);
}

let paneSnapshotRefreshTimer = null;
function schedulePaneSnapshotRefresh() {
  if (paneSnapshotRefreshTimer) return;
  paneSnapshotRefreshTimer = window.setTimeout(() => {
    paneSnapshotRefreshTimer = null;
    refreshSnapshot(true);
  }, 200);
}

// How long to keep the current window on screen and retry before giving up and
// showing the "no machine" reset. Covers a clean deploy (~1-2s agent re-register)
// and most of the crash/revision-poll path (~13-16s).
const RECONNECT_GRACE_MS = 12000;
// How fast to retry while in the grace window (snappier than the 3s poll so we
// recover the instant the machine is back).
const RECONNECT_RETRY_MS = 1000;

// Show/hide the non-destructive "Reconnecting…" banner over the current view.
function setReconnectingBanner(show, machineId = "") {
  if (!els.reconnectBanner) return;
  if (show && els.reconnectBannerText) {
    els.reconnectBannerText.textContent = machineId
      ? `Reconnecting to ${machineLabelFor(machineId)}…`
      : "Reconnecting…";
  }
  els.reconnectBanner.hidden = !show;
}

// True while we're holding the current window during a momentary machine drop.
function inReconnectGrace() {
  return state.reconnectUntil > Date.now();
}

// Clear grace state (machine is back, or we've given up). Stops the fast retry.
function clearReconnectGrace() {
  state.reconnectUntil = 0;
  state.reconnectMachineId = "";
  if (state.reconnectTimer) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  setReconnectingBanner(false);
}

// Enter (or extend the deadline of) the grace window for `machineId`, show the
// non-destructive "Reconnecting…" banner, and schedule one fast retry. The
// current window/snapshot stay on screen untouched.
function enterReconnectGrace(machineId) {
  if (!inReconnectGrace() || state.reconnectMachineId !== machineId) {
    // Fresh drop (or a different machine): start a new grace deadline.
    state.reconnectUntil = Date.now() + RECONNECT_GRACE_MS;
    state.reconnectMachineId = machineId;
  }
  setReconnectingBanner(true, machineId);
  if (!state.reconnectTimer) {
    state.reconnectTimer = window.setTimeout(() => {
      state.reconnectTimer = null;
      refreshTree();
    }, RECONNECT_RETRY_MS);
  }
}

async function refreshTree({
  urlTarget = state.pendingUrlTarget || readUrlTarget(),
  forceUrlTarget = false,
  syncUrl = false,
} = {}) {
  const treeLoadGeneration = state.treeLoadGeneration;
  if (urlTarget.machineId && urlTarget.machineId !== state.machineId) {
    state.machineId = urlTarget.machineId;
  }
  if (urlTarget.mux !== undefined) {
    state.mux = normalizeMux(urlTarget.mux);
  }
  // Remember whether we were actively viewing a machine's window BEFORE this
  // refresh — so a momentary drop (deploy/wifi/agent restart) can be held in a
  // grace window instead of instantly wiping to "no machine".
  const wasLive = Boolean(state.windowId);
  const priorMachineId = state.machineId || state.reconnectMachineId;
  try {
    await loadRuntimeAndMachines();
    if (state.treeLoadGeneration !== treeLoadGeneration) return;
    if (state.runtimeMode === "hub" && (!state.machineId || !selectedMachineOnline())) {
      // Was the focused machine just here and now momentarily gone? Hold the
      // current window and retry, rather than resetting — but only if we were
      // actually live on it (not the genuine "user hasn't picked a machine yet"
      // case). The grace also covers `machineId` getting auto-cleared to "" when
      // /api/machines briefly returns empty during a controller revision swap.
      const droppedMachine = priorMachineId &&
        !state.machines.some((m) => m.id === priorMachineId);
      if (droppedMachine) {
        if (inReconnectGrace()) {
          // Still within the grace window — keep the current window, retry soon.
          enterReconnectGrace(priorMachineId);
          return;
        }
        if (state.reconnectMachineId) {
          // We were in a grace cycle for this machine and it just EXPIRED — give
          // up and fall through to the hard reset below.
          clearReconnectGrace();
        } else if (wasLive) {
          // First detection of the drop on a live machine — start the grace
          // window (don't wipe yet).
          enterReconnectGrace(priorMachineId);
          return;
        }
      }
      const message = !state.machineId
        ? state.machines.length === 0
          ? "No machines online."
          : "Select a machine."
        : `Waiting for ${machineLabelFor(state.machineId)} to reconnect.`;
      resetTmuxState(
        message,
      );
      setStatus(message.replace(/\.$/, ""), false);
      // No machine focused, but others may be online and need you — keep the
      // cross-machine attention poll running so the pill/badge still works.
      startMetadataPolling();
      if (!state.machineId && state.machines.length > 1) showTargetPicker();
      return;
    }
    // Machine is present/online — if we were in a grace window, we've recovered.
    if (inReconnectGrace()) clearReconnectGrace();
    // One batched fetch instead of /api/sessions + N× /api/windows. The agent
    // runs a single `tmux list-windows -a` and the server reconstructs both
    // lists from the same rows. See server.mjs::listTree.
    const tree = await api("/api/tree");
    if (state.treeLoadGeneration !== treeLoadGeneration) return;
    state.sessions = tree.sessions || [];
    state.windows = (tree.windows || []).map((w) => ({ ...w })); // defensive copy
    await applyTreeAndSelectWindow({ urlTarget, forceUrlTarget });
    if (state.treeLoadGeneration !== treeLoadGeneration) return;
    if (state.targetPickerOpen) {
      startActivityPolling();
    }
    // Keep "needs you" indicators live in the background (picker closed too).
    startMetadataPolling();
    if (syncUrl) {
      updateTargetUrl();
    }
    state.pendingUrlTarget = null;
    setStatus(
      state.runtimeMode === "hub"
        ? selectedMachine()?.hostname || state.machineId || "machine"
        : "localhost",
    );
  } catch (error) {
    if (error.silent) return;
    if (state.treeLoadGeneration !== treeLoadGeneration) return;
    // The runtime/machines fetch itself failed (controller HTTP blip during a
    // revision swap, or a network hiccup). If we were live, hold the current
    // window in the grace window and retry rather than surfacing a raw error.
    if ((wasLive || inReconnectGrace()) && priorMachineId) {
      enterReconnectGrace(priorMachineId);
      return;
    }
    setStatus(error.message, false);
  }
}

function sessionNameInputValue() {
  return els.sessionNameInput.value.trim();
}

async function createTmuxSession() {
  const name = sessionNameInputValue();
  if (!name) {
    setStatus("Enter a session name", false);
    els.sessionNameInput.focus();
    return;
  }

  els.createSession.disabled = true;
  setStatus("creating session...");
  try {
    const session = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    els.sessionNameInput.value = "";
    await refreshTree();
    setStatus(`new session: ${session.name}`);
  } catch (error) {
    setStatus(error.message, false);
  } finally {
    els.createSession.disabled = false;
  }
}

// Load windows for every session and flatten into one tagged list.
// Renamed from loadWindows: window data now arrives via /api/tree (see
// refreshTree above), so this function does no network — it picks which
// window the user lands on from the already-loaded state.windows, then
// delegates to loadPanes for that window's panes/capture/directories.
async function applyTreeAndSelectWindow({
  urlTarget = readUrlTarget(),
  forceUrlTarget = false,
} = {}) {
  const previousWindowId = state.windowId;
  state.panes = [];
  if (state.sessions.length === 0) {
    state.windows = [];
    state.sessionId = "";
    state.windowId = "";
    state.targetLoadingMessage = "";
    renderWindows();
    renderTargetLabels();
    return;
  }
  // refreshTree only calls this after /api/tree succeeds, so the current
  // machine's window list is trustworthy enough to drop closed recents.
  pruneGlobalRecents();

  const currentWindowExists = state.windows.some((item) => item.id === state.windowId);
  if (forceUrlTarget || !currentWindowExists) {
    let target = null;
    if (urlTarget.windowId) {
      target = state.windows.find((win) => win.id === urlTarget.windowId) || null;
    }
    if (!target && urlTarget.session && (urlTarget.windowIndex || urlTarget.windowName)) {
      const session = state.sessions.find((item) => item.name === urlTarget.session);
      if (session) {
        const sessionWindows = state.windows.filter((win) => win.sessionId === session.id);
        target = urlTarget.windowIndex
          ? sessionWindows.find((win) => String(win.index) === urlTarget.windowIndex)
          : null;
        if (!target && urlTarget.windowName) {
          target = sessionWindows.find((win) => win.name === urlTarget.windowName) || null;
        }
      }
    }
    const chosen = target || state.windows.find((win) => win.active) || state.windows[0] || null;
    state.windowId = chosen?.id || "";
    state.sessionId = chosen?.sessionId || "";
  } else {
    state.sessionId =
      state.windows.find((win) => win.id === state.windowId)?.sessionId || state.sessionId;
  }

  state.targetLoadingMessage = "";
  renderWindows();
  renderTargetLabels();
  if (state.windowId && state.windowId !== previousWindowId) {
    clearPaneViewForWindowSwitch();
  }
  await loadPanes();
}

// --- "Needs you" attention indicators (tab title/favicon + topbar pill) ---

// The original document title, captured once so the badge can be added/removed
// without losing it.
const DEFAULT_DOCUMENT_TITLE = document.title;
let badgedFaviconUrl = null; // cached data: URL for the badged favicon
let originalFaviconHref = null;

function appDocumentTitleBase() {
  const name = String(selectedWindow()?.name || readUrlTarget().windowName || "").trim();
  return name || DEFAULT_DOCUMENT_TITLE;
}

function updateDocumentTitle(count = windowsNeedingAttention().length) {
  const base = appDocumentTitleBase();
  document.title = count > 0 ? `(${count}) ${base}` : base;
}

function faviconLink() {
  return document.querySelector('link[rel="icon"][type="image/png"]')
    || document.querySelector('link[rel="icon"]');
}

// Draw a small red dot in the corner of the app icon and return a data URL. Done
// once and cached. If the icon can't be loaded (e.g. taints the canvas), returns
// null and we fall back to a title-only badge.
function buildBadgedFavicon() {
  return new Promise((resolve) => {
    const link = faviconLink();
    const href = link?.href || "/icon-192.png";
    const img = new Image();
    img.onload = () => {
      try {
        const size = 64;
        const c = document.createElement("canvas");
        c.width = size;
        c.height = size;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, size, size);
        const r = size * 0.26;
        ctx.beginPath();
        ctx.arc(size - r, r, r, 0, Math.PI * 2);
        ctx.fillStyle = "#e5484d";
        ctx.fill();
        ctx.lineWidth = size * 0.06;
        ctx.strokeStyle = "#fff";
        ctx.stroke();
        resolve(c.toDataURL("image/png"));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = href;
  });
}

async function setFaviconBadged(badged) {
  const link = faviconLink();
  if (!link) return;
  if (originalFaviconHref === null) originalFaviconHref = link.href;
  if (badged) {
    if (badgedFaviconUrl === null) badgedFaviconUrl = await buildBadgedFavicon();
    if (badgedFaviconUrl) link.href = badgedFaviconUrl;
  } else if (originalFaviconHref) {
    link.href = originalFaviconHref;
  }
}

// Reflect the current "needs you" set into: the tab title + favicon (so a
// backgrounded tab/PWA shows a count), and the always-visible topbar pill.
// Attention keys that needed attention on the PREVIOUS tick, so we can detect a
// RISING EDGE (a window newly entering a needs-you state) and chime only then —
// not every poll while it stays waiting. Keyed by attentionKey + reason so a
// window escalating finished -> question also chimes.
let chimeState = { keys: new Set(), lastAt: null };

// Play the notification chime when a window NEWLY needs attention, if enabled and
// not within the rate-limit window. The decision is the pure shouldChime() (unit-
// tested); here we just supply live config/time and persist the returned state.
function maybeChimeForAttention(pending) {
  const cfg = notifySoundAtom.get();
  const items = pending.map((p) => ({ key: attentionKey(p.descriptor), reason: p.reason }));
  const result = shouldChime(chimeState, items, {
    enabled: cfg.enabled === true, // opt-in: off unless explicitly enabled
    now: Date.now(),
    minIntervalMs: NOTIFY_SOUND_MIN_INTERVAL_MS,
  });
  chimeState = { keys: result.keys, lastAt: result.lastAt };
  if (result.chime) playNotifySound();
}

function updateAttentionIndicators() {
  const pending = windowsNeedingAttention();
  const count = pending.length;
  const anyQuestion = pending.some((p) => p.reason === "question");
  maybeChimeForAttention(pending);
  // HONEST STATE (Wave 1): split confident needs from unverified hedges. The pill
  // headline must not claim certainty the detector lacks, so the label is driven
  // by the CONFIRMED count, with unverified shown as a separate "+N unverified"
  // suffix. They still count toward the badge so nothing that might need you is
  // hidden — they're just never misrepresented as confirmed.
  const unverifiedCount = pending.filter((p) => p.reason === "unverified").length;
  const confirmedCount = count - unverifiedCount;

  // Tab title + favicon badge.
  updateDocumentTitle(count);
  setFaviconBadged(count > 0);

  // Topbar pill.
  if (els.needsAttention) {
    if (count > 0) {
      // Only-unverified set: a pure hedge — neutral copy, no false "needs answer".
      const onlyUnverified = confirmedCount === 0;
      const icon = anyQuestion ? "❓" : onlyUnverified ? "?" : "●";
      const noun = onlyUnverified
        ? unverifiedCount === 1
          ? "unverified"
          : "unverified"
        : anyQuestion
          ? "needs answer"
          : "waiting";
      const headline = onlyUnverified ? unverifiedCount : confirmedCount;
      const suffix = !onlyUnverified && unverifiedCount > 0 ? ` +${unverifiedCount} unverified` : "";
      els.needsAttention.hidden = false;
      els.needsAttention.classList.toggle("question", anyQuestion);
      els.needsAttention.classList.toggle("unverified", onlyUnverified);
      els.needsAttention.innerHTML = `<span class="needs-dot" aria-hidden="true">${icon}</span>${headline} ${noun}${suffix}`;
      els.needsAttention.setAttribute(
        "aria-label",
        onlyUnverified
          ? `${unverifiedCount} window${unverifiedCount === 1 ? "" : "s"} with unverified state — open to check`
          : `${confirmedCount} window${confirmedCount === 1 ? "" : "s"} ${anyQuestion ? "waiting for an answer" : "finished and unread"}${unverifiedCount > 0 ? `, plus ${unverifiedCount} unverified` : ""}`,
      );
    } else {
      els.needsAttention.hidden = true;
    }
  }

  updateAnswerAffordance();
}

// Light up the path to the answer overlay when the window you're LOOKING AT is
// waiting on a question. The two-finger pane gesture is a hidden power shortcut;
// this makes the obvious button signal exactly when it's the thing to tap, so
// nobody has to know the gesture exists. A dot on the More button (always
// visible) plus a highlight on the "Answer question" item inside the menu.
function updateAnswerAffordance() {
  const pending = activeWindowHasQuestion();
  if (els.moreActionsToggle) {
    els.moreActionsToggle.classList.toggle("has-question", pending);
    els.moreActionsToggle.setAttribute(
      "aria-label",
      pending ? "More actions — a question is waiting" : "More actions",
    );
  }
  if (els.answerQuestion) {
    els.answerQuestion.classList.toggle("has-question", pending);
  }
}

// Show the "scroll mode is on" banner only when the viewed pane has been parked
// in tmux copy-mode for longer than a short grace period. A quick scroll-up to
// read is intentional (and sends auto-exit copy-mode anyway), so we don't nag
// instantly — but a genuinely stuck window should get its explanation + Exit
// button promptly, so the grace is brief.
const COPY_MODE_GRACE_MS = 2000;
// When the active window first entered copy-mode (ms epoch), or 0 if it isn't.
let copyModeSince = 0;
let copyModeGraceTimer = null;

function updateCopyModeBanner() {
  if (!els.copyModeBanner) return;
  const meta = state.windowId ? state.windowMetadata[state.windowId] : null;
  const inCopyMode = Boolean(meta?.inCopyMode);

  if (!inCopyMode) {
    copyModeSince = 0;
    if (copyModeGraceTimer) {
      window.clearTimeout(copyModeGraceTimer);
      copyModeGraceTimer = null;
    }
    els.copyModeBanner.hidden = true;
    return;
  }

  // Just entered copy-mode — start the grace clock.
  if (!copyModeSince) copyModeSince = Date.now();
  const elapsed = Date.now() - copyModeSince;

  if (elapsed >= COPY_MODE_GRACE_MS) {
    els.copyModeBanner.hidden = false;
    return;
  }

  // Still within the grace window: keep it hidden, but schedule a re-check so the
  // banner appears even if no further metadata poll lands before grace elapses.
  els.copyModeBanner.hidden = true;
  if (!copyModeGraceTimer) {
    copyModeGraceTimer = window.setTimeout(() => {
      copyModeGraceTimer = null;
      updateCopyModeBanner();
    }, COPY_MODE_GRACE_MS - elapsed);
  }
}

async function exitCopyModeNow() {
  if (!state.paneId) return;
  try {
    await api("/api/exit-copy-mode", {
      method: "POST",
      body: JSON.stringify({ paneId: state.paneId }),
    });
    if (state.windowId && state.windowMetadata[state.windowId]) {
      state.windowMetadata[state.windowId].inCopyMode = false;
    }
    updateCopyModeBanner();
    refreshSnapshot(true);
  } catch (error) {
    setStatus(error.message || "Could not exit scroll mode", false);
  }
}

// Jump to the first window that needs attention (tapping the pill) — across ALL
// machines. Questions first; switch machines if the target is elsewhere, then
// select the window by its stable identity and open the answer overlay for a
// question.
async function jumpToFirstAttention() {
  const pending = windowsNeedingAttention();
  if (!pending.length) return;
  // Rank: question → finished → unverified (honest hedge, jumped to last).
  pending.sort(
    (a, b) => (ATTENTION_RANK[a.reason] ?? 9) - (ATTENTION_RANK[b.reason] ?? 9),
  );
  const { descriptor, reason } = pending[0];
  const targetKey = attentionKey(descriptor);
  const descriptorMux = normalizeMux(descriptor.mux);

  if (
    state.runtimeMode === "hub" &&
    descriptor.machineId &&
    (descriptor.machineId !== state.machineId || descriptorMux !== state.mux)
  ) {
    // Hop to the other machine AND land directly on the window in one step —
    // pass the target so refreshTree's urlTarget resolution selects it once the
    // new machine's windows load (avoids a switch-then-find race where the
    // window list isn't ready yet and we'd fall back to the picker).
    await selectMachine(descriptor.machineId, {
      mux: descriptorMux,
      session: descriptor.sessionName,
      windowIndex: descriptor.windowIndex,
    });
    // Verify by outcome (see selectedMatchesTarget). If we didn't land, let the
    // user find it in the picker; if we did, make sure it's closed.
    if (selectedMatchesTarget(descriptor.sessionName, descriptor.windowIndex)) {
      closeTargetPicker();
    } else {
      showTargetPicker();
      return;
    }
  } else {
    // Same machine: resolve the descriptor's stable key to a live window.
    const win = state.windows.find((w) => windowRecentKey(w) === targetKey);
    if (win) {
      await selectWindow(win.id);
    } else {
      // Couldn't resolve (windows not loaded yet / vanished) — open the picker
      // so the user can pick it; the attention chip on that machine guides them.
      showTargetPicker();
      return;
    }
  }
  if (reason === "question") {
    window.setTimeout(() => openAskOverlay(), 400);
  }
}

// Coalesce concurrent loadWindowMetadata() calls. The poll tick, the target
// picker, and several post-action handlers all call this; each call fans out one
// /api/window-metadata request PER SESSION, and those are slow (brokered to the
// agent). Without a guard, overlapping calls multiply into a burst that saturates
// the single controller instance and gets 429'd. So: if a load is already in
// flight, callers await the SAME promise; a request that arrives mid-flight sets
// a "rerun" flag so exactly one more load runs after the current one settles
// (capturing any state that changed during it), then collapses again.
let metadataLoadInFlight = null;
let metadataRerunQueued = false;

function loadWindowMetadata() {
  if (metadataLoadInFlight) {
    metadataRerunQueued = true;
    return metadataLoadInFlight;
  }
  metadataLoadInFlight = loadWindowMetadataOnce().finally(() => {
    metadataLoadInFlight = null;
    if (metadataRerunQueued) {
      metadataRerunQueued = false;
      loadWindowMetadata();
    }
  });
  return metadataLoadInFlight;
}

async function loadWindowMetadataOnce() {
  if (state.windows.length === 0) return;
  try {
    const prevRepo = JSON.stringify(activeWindowRepo());
    const lists = await Promise.all(
      state.sessions.map((session) =>
        api(`/api/window-metadata?sessionId=${encodeURIComponent(session.id)}`).catch(() => ({})),
      ),
    );
    state.windowMetadata = Object.assign({}, ...lists);
    // Keep the currently-viewed window's seen-hash current — while you're
    // looking at it, its changes aren't "unread". (Other windows accumulate
    // unread state against their last-visit baseline.)
    const activeWin = selectedWindow();
    if (activeWin) markWindowVisited(activeWin);
    renderWindows();
    renderTargetLabels();
    renderModeBar();
    updateCopyModeBanner();
    // If the active window's repo just became known (or changed), re-render the
    // snapshot so PR references in the visible output get linkified.
    if (JSON.stringify(activeWindowRepo()) !== prevRepo && state.snapshotText != null) {
      updateSnapshotText(state.snapshotText);
    }
  } catch {
    // ignore transient failures
  }
}

// Cross-machine attention sweep: ask the controller for every online machine's
// per-window turn/waitingForInput/contentHash in one request, flatten into
// descriptors, and refresh the "needs you" indicators (pill/title/favicon span
// all machines). Also keep the active window's seen-hash current so it doesn't
// flag itself as unread.
async function loadAttention() {
  try {
    const data = await api("/api/attention");
    const descriptors = [];
    for (const machine of data.machines || []) {
      for (const w of machine.windows || []) {
        descriptors.push({ machineId: machine.machineId, ...w });
      }
    }
    state.attention = descriptors;
    const activeWin = selectedWindow();
    if (activeWin) markWindowVisited(activeWin);
    updateAttentionIndicators();
  } catch {
    // transient failure — keep the last known attention
  }
}

async function pollWindowActivity() {
  if (state.sessions.length === 0) return;
  try {
    const results = await Promise.all(
      state.sessions.map((session) =>
        api(`/api/window-activity?sessionId=${encodeURIComponent(session.id)}`).catch(() => ({})),
      ),
    );
    state.windowActivity = Object.assign({}, ...results);
    renderWindows();
  } catch {
    // ignore transient failures
  }
}

function startActivityPolling() {
  stopActivityPolling();
  if (state.sessions.length === 0) return;
  // setTimeout-after-await pattern (same shape as startMetadataPolling).
  // setInterval would queue overlapping ticks under slow network; with the
  // chained-setTimeout pattern each tick only fires after the previous one's
  // awaits complete, so the cadence naturally backs off when responses are
  // slow.
  const tick = async () => {
    await pollWindowActivity();
    if (state.activityTimer !== null) {
      state.activityTimer = window.setTimeout(tick, 3000);
    }
  };
  state.activityTimer = 0; // non-null sentinel so the first tick's re-arm runs
  tick();
}

function stopActivityPolling() {
  if (state.activityTimer !== null) {
    window.clearTimeout(state.activityTimer);
    state.activityTimer = null;
  }
}

// Background metadata poll so turn / unread / waiting state (and the "needs you"
// indicators) stay fresh even when the target picker is closed — including while
// the tab is backgrounded, which is exactly when the tab-title/favicon badge
// earns its keep. Throttled when hidden to keep it cheap. (The picker also calls
// loadWindowMetadata() directly for an immediate refresh on open.)
const METADATA_POLL_VISIBLE_MS = 5000;
const METADATA_POLL_HIDDEN_MS = 12000;

function metadataPollInterval() {
  return document.hidden ? METADATA_POLL_HIDDEN_MS : METADATA_POLL_VISIBLE_MS;
}

// One poll tick: refresh the cross-machine attention sweep (always — it spans all
// machines, even when none is focused), plus the focused machine's picker
// metadata when there is one.
async function metadataPollTick() {
  await loadAttention();
  if (state.sessions.length > 0) await loadWindowMetadata();
}

function startMetadataPolling() {
  stopMetadataPolling();
  // Only meaningful once connected: hub mode (>=1 machine) or local with sessions.
  if (state.runtimeMode === "hub" ? state.machines.length === 0 : state.sessions.length === 0) {
    return;
  }
  metadataPollTick(); // immediate first read
  state.metadataTimer = window.setTimeout(
    async function tick() {
      await metadataPollTick();
      state.metadataTimer = window.setTimeout(tick, metadataPollInterval());
    },
    metadataPollInterval(),
  );
}

function stopMetadataPolling() {
  if (state.metadataTimer) {
    window.clearTimeout(state.metadataTimer);
    state.metadataTimer = null;
  }
}

// When the tab is hidden the in-flight timer keeps its (longer) cadence; on
// becoming visible again, refresh right away so the badge clears promptly.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.sessions.length > 0) {
    startMetadataPolling();
  }
});

async function selectWindow(windowId) {
  const win = state.windows.find((item) => item.id === windowId);
  const previousWindowId = state.windowId;
  // Record the window we're switching to as most-recent, so it surfaces in the
  // global quick-switch popup next time (MRU order).
  if (win) recordGlobalRecent(win);
  state.windowId = windowId;
  state.sessionId = win?.sessionId || state.sessionId;
  state.paneId = "";
  state.targetLoadingMessage = "";
  // Visiting a window clears its "unread" flag: record the content we're now
  // looking at as the seen baseline.
  if (win) markWindowVisited(win);
  copyModeSince = 0; // restart the grace clock for the newly-viewed window
  updateCopyModeBanner(); // reflect the new window's state (or hide until known)
  renderWindows();
  updateTargetUrl();
  if (windowId !== previousWindowId) {
    clearPaneViewForWindowSwitch();
  }
  // Dismiss the picker instantly — don't make the user stare at a half-
  // open sheet while panes load over a flaky link. The actual switch
  // continues in the background and the snapshot updates when it lands.
  closeTargetPicker();
  await loadPanes();
}

async function renameSelectedWindow() {
  const win = selectedWindow();
  if (!win) {
    setStatus("Select a window first", false);
    return;
  }
  const next = window.prompt("Rename window", win.name);
  if (next === null) return;
  const name = next.trim();
  if (!name || name === win.name) return;
  els.renameWindow.disabled = true;
  setStatus("renaming window...");
  try {
    await api("/api/windows", {
      method: "PATCH",
      body: JSON.stringify({ windowId: win.id, name }),
    });
    await refreshTree();
    setStatus(`renamed window: ${name}`);
  } catch (error) {
    setStatus(error.message, false);
  } finally {
    els.renameWindow.disabled = false;
  }
}

// Create a fresh window in the current session and switch to it.
async function createNewWindow() {
  const sessionId = selectedWindow()?.sessionId || state.sessionId;
  if (!sessionId) {
    setStatus("Select a window first", false);
    return;
  }
  els.newWindow.disabled = true;
  setStatus("creating window...");
  try {
    const created = await api("/api/windows", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    });
    await refreshTree();
    if (created?.id) await selectWindow(created.id);
    setStatus(`new window: ${created.index}: ${created.name}`);
  } catch (error) {
    setStatus(error.message, false);
  } finally {
    els.newWindow.disabled = false;
  }
}

// Duplicate the current window: open a confirmation pre-filled with the source
// window's title + start command (and cwd) so the user can adjust before the new
// window is created. Creation happens in confirmDuplicate().
let duplicateSourceId = null;
let newBranchSourceId = null;
async function duplicateCurrentWindow() {
  const win = selectedWindow();
  if (!win) {
    setStatus("Select a window first", false);
    return;
  }
  duplicateSourceId = win.id;
  els.duplicateName.value = "";
  els.duplicateCommand.value = "";
  els.duplicateCwd.textContent = "";
  els.duplicateStatus.textContent = "Loading…";
  els.duplicateStatus.classList.remove("error");
  els.duplicateSheet.hidden = false;
  try {
    const info = await api(`/api/window-duplicate-info?windowId=${encodeURIComponent(win.id)}`);
    els.duplicateName.value = info.name || "";
    els.duplicateCommand.value = info.command || "";
    els.duplicateCwd.textContent = info.cwd || "";
    els.duplicateStatus.textContent = "";
    els.duplicateName.focus();
    els.duplicateName.select();
  } catch (error) {
    els.duplicateStatus.textContent = error.message || "Could not load window info";
    els.duplicateStatus.classList.add("error");
  }
}

function closeDuplicateSheet() {
  els.duplicateSheet.hidden = true;
  duplicateSourceId = null;
}

async function confirmDuplicate() {
  if (!duplicateSourceId) return;
  els.confirmDuplicate.disabled = true;
  els.duplicateStatus.classList.remove("error");
  els.duplicateStatus.textContent = "Creating…";
  try {
    const created = await api("/api/windows", {
      method: "POST",
      body: JSON.stringify({
        duplicateFrom: duplicateSourceId,
        name: els.duplicateName.value,
        command: els.duplicateCommand.value,
      }),
    });
    closeDuplicateSheet();
    await refreshTree();
    if (created?.id) await selectWindow(created.id); // switch to the new window
    setStatus(
      created?.command
        ? `duplicated window (running: ${created.command})`
        : "duplicated window",
    );
  } catch (error) {
    els.duplicateStatus.textContent = error.message || "Could not create window";
    els.duplicateStatus.classList.add("error");
  } finally {
    els.confirmDuplicate.disabled = false;
  }
}

// "New branch": open the sheet, prefilling the start command from the current
// window (like Duplicate). Reuses /api/window-duplicate-info for the command.
async function openNewBranchSheet() {
  setMoreActionsOpen(false);
  const win = selectedWindow();
  if (!win) {
    setStatus("Select a window first", false);
    return;
  }
  newBranchSourceId = win.id;
  els.newBranchName.value = "";
  els.newBranchCommand.value = "";
  els.newBranchFrom.textContent = "";
  els.newBranchStatus.textContent = "Loading…";
  els.newBranchStatus.classList.remove("error");
  els.newBranchSheet.hidden = false;
  try {
    const info = await api(`/api/window-duplicate-info?windowId=${encodeURIComponent(win.id)}`);
    els.newBranchCommand.value = info.command || "";
    els.newBranchFrom.textContent = info.cwd || "";
    els.newBranchStatus.textContent = "";
    els.newBranchName.focus();
  } catch (error) {
    els.newBranchStatus.textContent = error.message || "Could not load window info";
    els.newBranchStatus.classList.add("error");
  }
}

function closeNewBranchSheet() {
  els.newBranchSheet.hidden = true;
  newBranchSourceId = null;
}

async function confirmNewBranch() {
  if (!newBranchSourceId) return;
  const branch = els.newBranchName.value.trim();
  if (!branch) {
    els.newBranchStatus.textContent = "Enter a branch name";
    els.newBranchStatus.classList.add("error");
    return;
  }
  els.confirmNewBranch.disabled = true;
  els.newBranchStatus.classList.remove("error");
  els.newBranchStatus.textContent = "Creating worktree…";
  try {
    const created = await api("/api/window-new-branch", {
      method: "POST",
      body: JSON.stringify({
        windowId: newBranchSourceId,
        branch,
        command: els.newBranchCommand.value,
      }),
    });
    closeNewBranchSheet();
    await refreshTree();
    if (created?.id) await selectWindow(created.id); // switch to the new window
    setStatus(
      created?.command
        ? `new branch ${created.branch} (running: ${created.command})`
        : `new branch ${created.branch}`,
    );
  } catch (error) {
    els.newBranchStatus.textContent = error.message || "Could not create branch";
    els.newBranchStatus.classList.add("error");
  } finally {
    els.confirmNewBranch.disabled = false;
  }
}

// Close the current window after a confirmation.
async function closeCurrentWindow() {
  const win = selectedWindow();
  if (!win) {
    setStatus("Select a window first", false);
    return;
  }
  const ok = window.confirm(`Close window "${win.index}: ${win.name}"? This kills the window and its panes.`);
  if (!ok) return;
  els.closeWindow.disabled = true;
  setStatus("closing window...");
  try {
    await api("/api/windows", {
      method: "DELETE",
      body: JSON.stringify({ windowId: win.id }),
    });
    // The killed window is gone; clear selection and let refreshTree pick a new
    // target (refreshTree falls back when the current window no longer exists).
    state.windowId = "";
    state.paneId = "";
    await refreshTree();
    setStatus(`closed window: ${win.index}: ${win.name}`);
  } catch (error) {
    setStatus(error.message, false);
  } finally {
    els.closeWindow.disabled = false;
  }
}

// --- AskUserQuestion overlay (user-triggered) ---

// Open the overlay: on demand, ask the server to parse the active pane's current
// Claude AskUserQuestion, then render it. Nothing is scanned until this runs.
async function openAskOverlay() {
  if (!state.paneId) {
    setStatus("Select a window first", false);
    return;
  }
  els.askSheet.hidden = false;
  els.askTabs.innerHTML = "";
  els.askBody.innerHTML = '<div class="ask-loading">Scanning for a question…</div>';
  els.askStatus.textContent = "";
  els.askStatus.classList.remove("error");
  try {
    const data = await api(`/api/ask-question?paneId=${encodeURIComponent(state.paneId)}`);
    renderAsk(data.question);
  } catch (error) {
    askError(error.message || "Could not read the pane");
  }
}

function closeAskOverlay() {
  els.askSheet.hidden = true;
  els.askBody.innerHTML = "";
  els.askTabs.innerHTML = "";
}

function askError(msg) {
  els.askBody.innerHTML = "";
  const d = document.createElement("div");
  d.className = "ask-empty";
  d.textContent = msg;
  els.askBody.append(d);
}

// Render the parsed question (or the "no question / done" states).
function renderAsk(q) {
  els.askTabs.innerHTML = "";
  els.askBody.innerHTML = "";
  if (!q) {
    askError("No active question in this window. (Answered, or none showing.)");
    return;
  }
  // Tab strip (one chip per question; ✓ = answered).
  if (q.tabs && q.tabs.length) {
    for (const t of q.tabs) {
      const chip = document.createElement("span");
      chip.className = `ask-tab${t.answered ? " answered" : ""}`;
      chip.textContent = `${t.answered ? "✓ " : ""}${t.header}`;
      els.askTabs.append(chip);
    }
  }

  // Review screen -> a confirm button.
  if (q.review) {
    const note = document.createElement("div");
    note.className = "ask-review";
    note.textContent = "Review your answers, then submit.";
    els.askBody.append(note);
    const submit = button("Submit answers", "ask-submit", () => submitAsk({ action: "reviewSubmit" }));
    els.askBody.append(submit);
    els.askBody.append(button("Cancel", "ask-cancel", () => submitAsk({ action: "cancel" })));
    return;
  }

  // The picker (option cards + free-form). Pulled out so the confirmation step's
  // "Back" button can return to it with multi-select state preserved.
  renderQuestionPicker(q);
}

// Render the option cards + free-form input for one question. `preChecked` is an
// optional Set of option indices to start checked (used when returning from the
// confirm step so the user's multi-select survives "Back").
function renderQuestionPicker(q, preChecked) {
  els.askBody.innerHTML = "";

  // Question text.
  const qt = document.createElement("div");
  qt.className = "ask-question";
  qt.textContent = q.questionText || "";
  els.askBody.append(qt);

  // Option cards. Skip the Submit pseudo-option; "Type something" -> free-form;
  // "Chat about this" omitted (the free-form path covers typing your own answer).
  const realOptions = q.options
    .map((o, i) => ({ ...o, index: i }))
    .filter((o) => !o.isSubmit && !o.isChat);
  const titleOf = (index) => q.options[index]?.title || "";

  if (q.multiSelect) {
    const checked =
      preChecked ||
      new Set(q.options.map((o, i) => (o.checked ? i : -1)).filter((i) => i >= 0));
    for (const o of realOptions) {
      if (o.isFreeForm) continue;
      const card = optionCard(o, true, checked.has(o.index));
      card.addEventListener("click", () => {
        if (checked.has(o.index)) checked.delete(o.index);
        else checked.add(o.index);
        card.classList.toggle("checked");
      });
      els.askBody.append(card);
    }
    // Confirm step before sending: summarize the picks, then Confirm/Back.
    els.askBody.append(button("Submit selected", "ask-submit", () => {
      const picks = [...checked];
      const summary = picks.length
        ? picks.map(titleOf).join(", ")
        : "(nothing selected)";
      renderConfirm(
        { action: "multi", checked: picks },
        summary,
        () => renderQuestionPicker(q, checked),
      );
    }));
  } else {
    for (const o of realOptions) {
      if (o.isFreeForm) continue;
      // Single-select: tap picks the option, then confirm before sending (no
      // more tap-to-submit) so every answer gets a confirmation step.
      const card = optionCard(o, false, false);
      card.addEventListener("click", () =>
        renderConfirm(
          { action: "single", optionIndex: o.index },
          titleOf(o.index),
          () => renderQuestionPicker(q),
        ),
      );
      els.askBody.append(card);
    }
  }

  // Free-form ("type your own answer") — always offered; it declines the
  // structured prompt and sends your text as a normal reply (matches the TUI).
  const wrap = document.createElement("div");
  wrap.className = "ask-free";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Or type your own answer…";
  const send = button("Send", "ask-free-send", () => {
    const text = input.value.trim();
    if (!text) return;
    renderConfirm(
      { action: "free", text },
      `“${text}” (sent as your own reply)`,
      () => renderQuestionPicker(q),
    );
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); send.click(); }
  });
  wrap.append(input, send);
  els.askBody.append(wrap);
}

// Inline confirmation before an answer is sent to Claude. Shows what will be
// submitted, then Confirm (drives the TUI) / Back (returns to the picker).
function renderConfirm(payload, summaryText, onBack) {
  els.askBody.innerHTML = "";
  const note = document.createElement("div");
  note.className = "ask-review";
  const label = document.createElement("div");
  label.className = "ask-confirm-label";
  label.textContent = "Send this answer to Claude?";
  const val = document.createElement("div");
  val.className = "ask-confirm-value";
  val.textContent = summaryText;
  note.append(label, val);
  els.askBody.append(note);
  els.askBody.append(button("Confirm & send", "ask-submit", () => submitAsk(payload)));
  els.askBody.append(button("Back", "ask-cancel", onBack));
}

function optionCard(o, multi, checked) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = `ask-option${multi ? " multi" : ""}${checked ? " checked" : ""}`;
  const mark = document.createElement("span");
  mark.className = "ask-mark";
  mark.setAttribute("aria-hidden", "true");
  const title = document.createElement("div");
  title.className = "ask-option-title";
  title.textContent = o.title;
  const left = document.createElement("div");
  left.className = "ask-option-main";
  left.append(title);
  if (o.desc) {
    const desc = document.createElement("div");
    desc.className = "ask-option-desc";
    desc.textContent = o.desc;
    left.append(desc);
  }
  card.append(mark, left);
  return card;
}

function button(label, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `small-button ${cls}`;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

// Apply an action via the server (drives the TUI), then re-render with the
// returned next state (next question / review / done). Guarded against
// double-submit: a second click while a request is in flight is a no-op, and the
// action buttons are disabled for the duration (a stray double-tap used to fire a
// second keystroke into a pane whose prompt had already closed, which read as
// "stuck" with a spurious error).
let askSubmitInFlight = false;

async function submitAsk(payload) {
  if (askSubmitInFlight) return;
  askSubmitInFlight = true;
  setAskButtonsDisabled(true);
  els.askStatus.classList.remove("error");
  els.askStatus.textContent = "Applying…";
  try {
    const data = await api("/api/ask-answer", {
      method: "POST",
      body: JSON.stringify({ paneId: state.paneId, ...payload }),
    });
    els.askStatus.textContent = "";
    if (!data.active) {
      // Done (or declined) — close and refresh the snapshot to show the result.
      closeAskOverlay();
      setStatus("answer sent");
      window.setTimeout(() => refreshSnapshot(true), 400);
      return;
    }
    renderAsk(data.question); // next question or the review screen
  } catch (error) {
    // A 409 "no active question" means the prompt is already gone — i.e. the
    // answer landed (or someone else dismissed it). That's success, not an
    // error: close the overlay instead of leaving it stuck on an error message.
    if (error.status === 409) {
      closeAskOverlay();
      setStatus("answer sent");
      window.setTimeout(() => refreshSnapshot(true), 400);
      return;
    }
    els.askStatus.textContent = error.message || "Could not apply";
    els.askStatus.classList.add("error");
  } finally {
    askSubmitInFlight = false;
    setAskButtonsDisabled(false);
  }
}

// Disable/enable every button in the overlay body while a submit is in flight.
function setAskButtonsDisabled(disabled) {
  for (const b of els.askBody.querySelectorAll("button")) b.disabled = disabled;
}

async function loadPanes() {
  const windowId = state.windowId;
  const loadGeneration = state.viewLoadGeneration;
  const previousPaneId = state.paneId;
  state.panes = [];
  if (!windowId) {
    renderTargetLabels();
    resetDirectoryNavigator();
    return;
  }

  // One batched fetch instead of /api/panes → /api/directories → /api/capture.
  // The server runs the pane list once, then capture-pane and readdir in
  // parallel — so the agent sees 2 round-trips instead of 3, and the browser
  // makes a single request. See server.mjs::getWindowView.
  let view;
  try {
    view = await api(
      `/api/window-view?windowId=${encodeURIComponent(windowId)}&lines=${state.lines}`,
    );
  } catch (error) {
    if (state.windowId !== windowId || state.viewLoadGeneration !== loadGeneration) return;
    // Same UX as the old refreshSnapshot catch: keep the last good snapshot
    // visible, raise the stale-icon, swallow silently. The whole batched
    // fetch having failed is a single signal — not three.
    setSnapshotStale(true, error);
    renderTargetLabels();
    return;
  }
  if (state.windowId !== windowId || state.viewLoadGeneration !== loadGeneration) return;
  state.panes = view.panes || [];
  state.paneId = view.activePaneId || "";
  const paneChanged = state.paneId !== previousPaneId;

  loadChat();
  renderTargetLabels();
  renderChat();
  // Conservatively disable Read until detection comes back; otherwise a
  // half-second of network can land the user mid-tap on a stale Enabled.
  state.currentAgentKind = null;
  renderReadButtonsEnabled();
  refreshAgentDetection();

  // Apply the bundled directory listing (no separate /api/directories call).
  const dir = view.directories || {};
  state.directories = {
    cwd: dir.cwd || "",
    parent: dir.parent || "",
    entries: dir.error ? [] : dir.entries || [],
    loading: false,
    error: dir.error || "",
  };
  renderDirectoryNavigator();

  // Apply the bundled capture (no separate /api/capture call). A per-piece
  // capture failure is treated like today's transient blip: stale-icon up,
  // last good snapshot preserved.
  const cap = view.capture || {};
  if (cap.error) {
    setSnapshotStale(true, new Error(cap.error));
  } else {
    updateSnapshotText(cap.text || "[no visible output]", {
      forceScrollBottom: paneChanged,
    });
    setSnapshotStale(false);
  }
}

async function loadDirectories({ clear = false } = {}) {
  const paneId = state.paneId;
  if (!paneId) {
    resetDirectoryNavigator();
    return;
  }

  state.directories.loading = true;
  state.directories.error = "";
  if (clear) {
    state.directories.cwd = "";
    state.directories.parent = "";
    state.directories.entries = [];
  }
  renderDirectoryNavigator();
  try {
    const data = await api(`/api/directories?paneId=${encodeURIComponent(paneId)}`);
    if (state.paneId !== paneId) return;
    state.directories = {
      cwd: data.cwd || "",
      parent: data.parent || "",
      entries: Array.isArray(data.entries) ? data.entries : [],
      loading: false,
      error: "",
    };
  } catch (error) {
    if (state.paneId !== paneId) return;
    state.directories = {
      cwd: "",
      parent: "",
      entries: [],
      loading: false,
      error: error.message || "Directory unavailable",
    };
  }
  renderDirectoryNavigator();
}

async function changeDirectory(targetPath) {
  if (!state.paneId) {
    addChat("system", "Select a window first.", "system");
    return;
  }
  if (!targetPath) return;

  const label = pathLabel(targetPath);
  setStatus(`cd: ${label}`);
  await sendMessage(`cd ${shellQuote(targetPath)}`, true);
  window.setTimeout(() => {
    loadPanes().catch((error) => {
      addChat("system", error.message, "directory error");
    });
  }, 650);
}

function setSnapshotStale(stale, error) {
  if (!els.snapshotStaleIcon) return;
  els.snapshotStaleIcon.hidden = !stale;
  if (stale && error) {
    els.snapshotStaleIcon.title = `Last refresh failed (${error.message || error}) — showing previous content`;
  } else {
    els.snapshotStaleIcon.title = "Last refresh failed — showing previous content";
  }
}

async function refreshSnapshot(addToChat = false, { forceScrollBottom = false } = {}) {
  const paneId = state.paneId;
  const loadGeneration = state.viewLoadGeneration;
  if (!paneId) {
    updateSnapshotText("Select a window.", { forceScrollBottom: true });
    setSnapshotStale(false);
    return;
  }
  try {
    const params = new URLSearchParams({
      paneId,
      mode: "tail",
      lines: String(state.lines),
    });
    const data = await api(`/api/capture?${params}`);
    if (state.paneId !== paneId || state.viewLoadGeneration !== loadGeneration) return;
    updateSnapshotText(data.text || "[no visible output]", { forceScrollBottom });
    setSnapshotStale(false);
    if (addToChat) {
      addChat("pane", excerptForChat(data.text), "tmux output");
    }
  } catch (error) {
    if (state.paneId !== paneId || state.viewLoadGeneration !== loadGeneration) return;
    // Keep the last good snapshot visible — wiping it on every transient
    // network blip is the worst possible UX. The toolbar icon is the only
    // signal that something's off; the user can hit Refresh to retry.
    setSnapshotStale(true, error);
    if (addToChat) {
      // Only surface the error in the chat when the user actually pressed
      // Refresh / sent something. Silent auto-poll failures stay silent.
      addChat("system", error.message, "error");
    }
  }
}

async function sendMessage(text, enter, { submitNudge = false } = {}) {
  // submitNudge defaults FALSE. I had this defaulting to true for a few
  // commits because I assumed the paste→Enter race was still live in this
  // codebase — but the upstream sync already fixed it by waiting
  // PASTE_ENTER_DELAY_MS between paste-buffer and send-keys Enter (see
  // server.mjs sendTextToPane). With that delay in place, the single Enter
  // already submits cleanly; tacking on a nudge Enter ~700ms later just
  // fires into whatever state the agent has moved into — empty submit on a
  // shell, AUTO-CONFIRMING a "Y/n" or rating prompt on Claude/Codex.
  // Verified empirically: shell shows a duplicate $ prompt with nudge,
  // clean prompt without.
  if (!state.paneId) {
    addChat("system", "Select a window first.", "system");
    return;
  }

  addChat("user", text || "[Enter]", enter ? "send + Enter" : "send");
  await api("/api/send", {
    method: "POST",
    body: JSON.stringify({ paneId: state.paneId, text, enter, submitNudge }),
  });
  window.setTimeout(() => refreshSnapshot(true), 350);
}

async function sendKey(key) {
  if (!state.paneId) {
    addChat("system", "Select a window first.", "system");
    return;
  }
  addChat("user", `[${key}]`, "key");
  await api("/api/key", {
    method: "POST",
    body: JSON.stringify({ paneId: state.paneId, key }),
  });
  window.setTimeout(() => refreshSnapshot(true), 350);
}

// --- Agent mode + effort switching ---------------------------------------
//
// The focused window's agent (claude/codex) and its parsed current mode/effort
// arrive in window metadata as `agentType` + `agentMode` (see lib/agent-mode.mjs
// server-side). The pill shows the live mode; tapping it cycles via Shift+Tab
// (tmux BTab); the sheet jumps to a specific mode (cycle N times) and, for
// Claude, sets effort by driving its /effort slider through /api/agent-effort.
//
// This UI table mirrors the server's AGENT_MODES for the parts the client needs
// to RENDER (cycle order + labels + effort levels). Keep in sync with the lib.
const AGENT_MODE_UI = {
  claude: {
    // Cycle order matches Claude's Shift+Tab rotation (normal is the unmarked
    // default). Used to compute how many BTab presses reach a target.
    cycle: ["normal", "auto", "acceptEdits", "plan"],
    labels: {
      normal: "Normal",
      auto: "Auto",
      acceptEdits: "Accept edits",
      plan: "Plan",
      bypass: "Bypass",
    },
    effortLevels: ["low", "medium", "high", "xhigh", "max", "ultracode"],
  },
  codex: {
    cycle: ["fullAccess", "plan"],
    labels: {
      fullAccess: "Full access",
      plan: "Plan",
      readOnly: "Read-only",
      auto: "Auto",
    },
    effortLevels: null, // fast-follow
  },
};

// The focused window's { agentType, mode, label, effort, model } or null.
function focusedAgentMode() {
  const meta = state.windowMetadata[state.windowId];
  if (!meta || !meta.agentType) return null;
  const m = meta.agentMode || {};
  return {
    agentType: meta.agentType,
    mode: m.mode || null,
    label: m.label || "",
    effort: m.effort || null,
    model: m.model || null,
  };
}

// Show/hide + label the pill from the focused window's agent state. Called on
// every metadata refresh (cheap; just reads state).
function renderModeBar() {
  if (!els.modeBar) return;
  const a = focusedAgentMode();
  if (!a || !AGENT_MODE_UI[a.agentType]) {
    els.modeBar.hidden = true;
    return;
  }
  els.modeBar.hidden = false;
  els.modeLabel.textContent = a.label || "Mode";
  els.modeEffort.textContent = a.effort ? `· ${a.effort}` : "";
  els.modeBar.dataset.agent = a.agentType;
  // data-mode drives the risk-escalating color (CSS keys off it). Fall back to
  // "normal" styling when the mode is unknown so the pill is never unstyled.
  els.modeBar.dataset.mode = a.mode || "normal";
}

// Tapping the pill cycles the mode one step (Shift+Tab). We don't track which
// way it lands — the next metadata poll re-parses the real mode and relabels.
async function cycleAgentMode() {
  const a = focusedAgentMode();
  if (!a) return;
  try {
    await sendKey("BTab");
    // Pull fresh metadata sooner than the poll so the pill updates promptly.
    window.setTimeout(loadWindowMetadata, 500);
  } catch (error) {
    addChat("system", error.message, "error");
  }
}

function openModeSheet() {
  const a = focusedAgentMode();
  if (!a) return;
  renderModeSheet(a);
  els.modeSheet.hidden = false;
}

function closeModeSheet() {
  if (els.modeSheet) els.modeSheet.hidden = true;
  if (els.modeStatus) els.modeStatus.textContent = "";
}

function renderModeSheet(a) {
  const ui = AGENT_MODE_UI[a.agentType];
  els.modeSheetHint.textContent =
    a.agentType === "claude"
      ? "Switch Claude's permission mode (sent as Shift+Tab). Effort sets the model's reasoning level."
      : "Switch the agent's permission mode (sent as Shift+Tab).";

  // Mode options: tapping one cycles BTab the right number of times to land on it.
  els.modeOptions.replaceChildren();
  for (const mode of ui.cycle) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mode-option" + (mode === a.mode ? " selected" : "");
    btn.textContent = ui.labels[mode] || mode;
    btn.addEventListener("click", () => selectMode(mode));
    els.modeOptions.append(btn);
  }

  // Effort options (Claude only).
  if (ui.effortLevels) {
    els.effortSection.hidden = false;
    els.effortOptions.replaceChildren();
    for (const level of ui.effortLevels) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mode-option" + (level === a.effort ? " selected" : "");
      btn.textContent = level;
      btn.addEventListener("click", () => selectEffort(level));
      els.effortOptions.append(btn);
    }
  } else {
    els.effortSection.hidden = true;
  }
}

// Jump to a specific mode. The server cycles Shift+Tab and re-reads the REAL
// mode until it lands on the target (the ring order/membership varies by launch
// flags, so we don't compute a step count client-side).
async function selectMode(targetMode) {
  const a = focusedAgentMode();
  if (!a) return;
  const ui = AGENT_MODE_UI[a.agentType];
  if (targetMode === a.mode) {
    closeModeSheet();
    return;
  }
  els.modeStatus.textContent = `Switching to ${ui.labels[targetMode] || targetMode}…`;
  try {
    const r = await api("/api/agent-mode", {
      method: "POST",
      body: JSON.stringify({ paneId: state.paneId, agentType: a.agentType, mode: targetMode }),
    });
    window.setTimeout(loadWindowMetadata, 400);
    window.setTimeout(() => refreshSnapshot(true), 400);
    if (r && r.reached === false) {
      els.modeStatus.textContent = `Couldn't reach ${ui.labels[targetMode] || targetMode} (now: ${r.mode || "?"})`;
    } else {
      closeModeSheet();
    }
  } catch (error) {
    els.modeStatus.textContent = error.message || "Could not switch mode";
  }
}

// Set effort by driving the agent's /effort slider server-side.
async function selectEffort(level) {
  const a = focusedAgentMode();
  if (!a) return;
  els.modeStatus.textContent = `Setting effort to ${level}…`;
  try {
    await api("/api/agent-effort", {
      method: "POST",
      body: JSON.stringify({ paneId: state.paneId, agentType: a.agentType, level }),
    });
    window.setTimeout(loadWindowMetadata, 700);
    window.setTimeout(() => refreshSnapshot(true), 700);
    closeModeSheet();
  } catch (error) {
    els.modeStatus.textContent = error.message || "Could not set effort";
  }
}

// --- Snippets: reusable text that inserts into the message box ---

// Render the snippet chips in the bar. Each chip inserts its text into the box.
function renderSnippetChips() {
  if (!els.snippetChips) return;
  const items = getSnippets();
  els.snippetChips.replaceChildren();
  if (items.length === 0) {
    const hint = document.createElement("span");
    hint.className = "snippet-empty";
    hint.textContent = "No snippets — tap ✎ to add";
    els.snippetChips.append(hint);
    return;
  }
  items.forEach((item, index) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "snippet-chip";
    chip.dataset.index = String(index);
    chip.title = `Insert "${item.text}"`;
    chip.textContent = item.text;
    els.snippetChips.append(chip);
  });
}

// Tapping a snippet inserts its text into the message box (no direct send).
function insertSnippet(index) {
  const item = getSnippets()[index];
  if (!item) return;
  composerAppendText(item.text);
}

// Render the editable rows in the snippet manager.
function renderSnippetList() {
  if (!els.snippetList) return;
  const items = getSnippets();
  els.snippetList.replaceChildren();
  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "snippet-row";
    row.dataset.index = String(index);

    const insert = document.createElement("button");
    insert.type = "button";
    insert.className = "small-button submit snippet-row-insert";
    insert.textContent = "Insert";
    insert.title = `Insert "${item.text}" into the message box`;
    insert.addEventListener("click", () => {
      closeSnippetManager();
      composerAppendText(item.text);
    });

    const text = document.createElement("input");
    text.type = "text";
    text.className = "snippet-row-text";
    text.value = item.text;
    text.setAttribute("aria-label", "Snippet text");
    text.addEventListener("change", () => updateSnippet(index, { text: text.value }));

    const up = document.createElement("button");
    up.type = "button";
    up.className = "small-button snippet-row-move";
    up.textContent = "↑";
    up.title = "Move up";
    up.disabled = index === 0;
    up.addEventListener("click", () => moveSnippet(index, -1));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "small-button cancel snippet-row-del";
    del.textContent = "Delete";
    del.addEventListener("click", () => removeSnippet(index));

    row.append(insert, text, up, del);
    els.snippetList.append(row);
  });
}

function updateSnippet(index, patch) {
  const items = getSnippets().slice();
  if (!items[index]) return;
  items[index] = { ...items[index], ...patch };
  setSnippets(items);
  renderSnippetChips();
}

function removeSnippet(index) {
  const items = getSnippets().slice();
  items.splice(index, 1);
  setSnippets(items);
  renderSnippetList();
  renderSnippetChips();
}

function moveSnippet(index, delta) {
  const items = getSnippets().slice();
  const target = index + delta;
  if (target < 0 || target >= items.length) return;
  [items[index], items[target]] = [items[target], items[index]];
  setSnippets(items);
  renderSnippetList();
  renderSnippetChips();
}

function addSnippet() {
  const text = els.snippetNewText.value.trim();
  if (!text) {
    els.snippetNewText.focus();
    return;
  }
  setSnippets([...getSnippets(), { text }]);
  els.snippetNewText.value = "";
  renderSnippetList();
  renderSnippetChips();
  els.snippetNewText.focus();
}

// The unified Insert picker: curated Snippets (editable) + auto Recent history.
function openSnippetManager() {
  renderSnippetList();
  renderHistoryList();
  els.snippetSheet.hidden = false;
}

function closeSnippetManager() {
  els.snippetSheet.hidden = true;
}

async function forkAgentWindow() {
  if (!state.paneId) {
    setStatus("Select a window first", false);
    return;
  }
  const data = await api("/api/fork-agent-window", {
    method: "POST",
    body: JSON.stringify({ paneId: state.paneId }),
  });
  if (!data.forked) return;

  await refreshTree();
  if (data.window?.id) {
    await selectWindow(data.window.id);
  }
  setStatus(`forked ${data.agent}`);
}

function setAutoRefresh(enabled) {
  if (state.autoRefreshTimer) {
    window.clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }
  if (enabled) {
    state.autoRefreshTimer = window.setInterval(() => {
      // Back-pressure. Each refresh cycle fans out ~20 requests
      // (sessions + 8 × /api/windows + 8 × /api/window-metadata + capture
      // + attention + …). On a slow link a cycle can take 5–10 s, so the
      // raw 3-second interval was firing cycle N+1 while cycle N's
      // responses were still landing. Out-of-order responses then kept
      // overwriting state.windows / state.panes mid-render — which the
      // user perceives as the window list "jumping between channels
      // many times" before settling. Verified empirically:
      //   /tmp/verify-tmux-mobile/events.jsonl on slow-3g showed 3
      //   overlapping cycles, 57 in-flight requests, in 10 s.
      // Skip the tick if the previous network is still in flight; with
      // this guard the effective cadence becomes min(3s, cycle-duration)
      // which is exactly the back-pressure we want.
      if (state.autoRefreshInFlight) return;
      state.autoRefreshInFlight = true;
      Promise.allSettled([refreshTree(), refreshSnapshot()]).finally(() => {
        state.autoRefreshInFlight = false;
      });
    }, 3000);
  }
}

els.mobileRefreshTree.addEventListener("click", async () => {
  await refreshTree();
});
els.mobileRefresh.addEventListener("click", async () => {
  await refreshTree();
  await refreshSnapshot();
});
const THEME_ICONS = {
  // sun
  kami: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  // moon
  dark: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/>',
  // monitor / auto
  auto: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
};
const THEME_LABELS = { kami: "Theme: Light", dark: "Theme: Dark", auto: "Theme: Auto" };

function updateThemeToggle(theme) {
  els.themeToggle.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    (THEME_ICONS[theme] || THEME_ICONS.kami) +
    "</svg>";
  const label = THEME_LABELS[theme] || THEME_LABELS.kami;
  els.themeToggle.title = label;
  els.themeToggle.setAttribute("aria-label", label);
}

els.themeToggle.addEventListener("click", () => {
  const cur = themeAtom.get().theme;
  const idx = THEME_ORDER.indexOf(cur);
  const next = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
  themeAtom.set({ theme: next });
  applyTheme(next);
  updateThemeToggle(next);
  window.dispatchEvent(new CustomEvent("tmux-mobile-theme-change", {
    detail: { theme: next },
  }));
});

window.addEventListener("tmux-mobile-theme-change", (event) => {
  const theme = event.detail?.theme;
  if (!THEME_ORDER.includes(theme)) return;
  themeAtom.set({ theme });
  applyTheme(theme);
  updateThemeToggle(theme);
});

// Voice settings sheet — lets the user pick the OpenAI voice models
// (transcription / read-aloud / realtime) the server uses. Config is
// server-global via /api/voice-config; the dropdowns are populated from the
// option lists the server returns so the client never invents a model name.
const VOICE_FIELD_SELECTS = {
  transcribeModel: "voiceTranscribeModel",
  speechModel: "voiceSpeechModel",
  speechVoice: "voiceSpeechVoice",
  realtimeModel: "voiceRealtimeModel",
  realtimeVoice: "voiceRealtimeVoice",
};

// Currently-playing voice sample, if any (declared here so closeVoiceSettings
// can stop it).
let voicePreviewAudio = null;

function setVoiceSettingsStatus(message, isError = false) {
  els.voiceSettingsStatus.textContent = message || "";
  els.voiceSettingsStatus.classList.toggle("error", Boolean(isError));
}

function populateVoiceSelect(select, options, current, defaultValue) {
  select.textContent = "";
  for (const option of options) {
    const el = document.createElement("option");
    el.value = option;
    el.textContent = option === defaultValue ? `${option} (default)` : option;
    if (option === current) el.selected = true;
    select.appendChild(el);
  }
}

async function openVoiceSettings() {
  els.voiceSettingsSheet.hidden = false;
  setVoiceSettingsStatus("Loading…");
  try {
    const config = await api("/api/voice-config");
    for (const [field, elKey] of Object.entries(VOICE_FIELD_SELECTS)) {
      populateVoiceSelect(
        els[elKey],
        config.options[field] || [],
        config.current[field],
        config.defaults[field],
      );
    }
    setVoiceSettingsStatus("");
  } catch (error) {
    setVoiceSettingsStatus(error.message || "Failed to load voice settings", true);
  }
}

function closeVoiceSettings() {
  els.voiceSettingsSheet.hidden = true;
  if (voicePreviewAudio) {
    voicePreviewAudio.pause();
    voicePreviewAudio = null;
  }
}

async function saveVoiceSettings() {
  const patch = {};
  for (const [field, elKey] of Object.entries(VOICE_FIELD_SELECTS)) {
    patch[field] = els[elKey].value;
  }
  els.saveVoiceSettings.disabled = true;
  setVoiceSettingsStatus("Saving…");
  try {
    const result = await api("/api/voice-config", {
      method: "PUT",
      body: JSON.stringify(patch),
    });
    setVoiceSettingsStatus(
      result.persisted === false ? "Saved (in memory only)" : "Saved",
    );
    setTimeout(() => closeVoiceSettings(), 700);
  } catch (error) {
    setVoiceSettingsStatus(error.message || "Failed to save", true);
  } finally {
    els.saveVoiceSettings.disabled = false;
  }
}

// Voice sample preview: play a short clip in the currently-selected voice so
// the user can hear it before saving. Both the read-aloud and realtime voice
// pickers use the TTS sample endpoint (the realtime API shares the same voices).
async function previewVoice(button) {
  const select = els[button.dataset.source];
  const voice = select?.value;
  if (!voice) return;
  // Stop any sample already playing (including a re-click of the same button).
  if (voicePreviewAudio) {
    voicePreviewAudio.pause();
    voicePreviewAudio = null;
  }
  const previousLabel = button.textContent;
  button.disabled = true;
  button.textContent = "…";
  try {
    const result = await api("/api/voice-preview", {
      method: "POST",
      body: JSON.stringify({ voice }),
    });
    const bytes = audioBytesFromBase64(result.audioBase64);
    const blob = new Blob([bytes], { type: result.mimeType || "audio/mpeg" });
    const objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(objectUrl);
    voicePreviewAudio = audio;
    audio.addEventListener("ended", () => URL.revokeObjectURL(objectUrl), { once: true });
    await audio.play();
  } catch (error) {
    setVoiceSettingsStatus(error.message || "Preview failed", true);
  } finally {
    button.disabled = false;
    button.textContent = previousLabel;
  }
}

els.openVoiceSettings.addEventListener("click", openVoiceSettings);
els.closeVoiceSettings.addEventListener("click", closeVoiceSettings);
els.voiceSettingsBackdrop.addEventListener("click", closeVoiceSettings);
els.saveVoiceSettings.addEventListener("click", saveVoiceSettings);
els.previewSpeechVoice.addEventListener("click", () => previewVoice(els.previewSpeechVoice));
els.previewRealtimeVoice.addEventListener("click", () => previewVoice(els.previewRealtimeVoice));

// --- Notification-sound settings ---
function openNotifySettings() {
  // The More menu auto-closes on .more-actions-item click (see the delegated
  // handler), so no explicit close is needed here.
  els.notifySoundEnabled.checked = notifySoundAtom.get().enabled === true;
  els.notifySettingsStatus.textContent = "";
  els.notifySettingsSheet.hidden = false;
}
function closeNotifySettings() {
  els.notifySettingsSheet.hidden = true;
}
function saveNotifySettings() {
  notifySoundAtom.set({ enabled: els.notifySoundEnabled.checked });
  els.notifySettingsStatus.textContent = "Saved";
  setTimeout(closeNotifySettings, 500);
}
els.openNotifySettings.addEventListener("click", openNotifySettings);
els.closeNotifySettings.addEventListener("click", closeNotifySettings);
els.notifySettingsBackdrop.addEventListener("click", closeNotifySettings);
els.saveNotifySettings.addEventListener("click", saveNotifySettings);
// Preview plays the chime — also the user gesture that unlocks browser audio
// playback for later auto-chimes.
els.previewNotifySound.addEventListener("click", () => playNotifySound());

// Copy the restart command from the stale-connector banner.
if (els.staleAgentBanner) {
  els.staleAgentBanner.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy]");
    if (!button || !els.staleAgentCmd) return;
    const text = els.staleAgentCmd.dataset.copyText || els.staleAgentCmd.textContent;
    try {
      await navigator.clipboard.writeText(text);
      const previous = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = previous;
      }, 1200);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(els.staleAgentCmd);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  });
}

// Dismiss the stale-connector warning for the current machine+skew.
if (els.staleAgentDismiss) {
  els.staleAgentDismiss.addEventListener("click", () => {
    const machine = staleSelectedMachine();
    if (machine) dismissStale(machine);
    updateStaleAgentBanner();
  });
}

// Copy buttons in the connector-help panel: copy the referenced <code> text.
if (els.connectorHelp) {
  els.connectorHelp.addEventListener("click", async (event) => {
    const button = event.target.closest(".connector-copy");
    if (!button) return;
    const source = els[button.dataset.copy];
    if (!source) return;
    const text = source.textContent;
    try {
      await navigator.clipboard.writeText(text);
      const previous = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = previous;
      }, 1200);
    } catch {
      // Clipboard blocked (e.g. insecure context): select the text so the user
      // can copy manually.
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  });
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.voiceSettingsSheet.hidden) closeVoiceSettings();
});

// Reflect OS theme changes live while in auto mode.
if (window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (themeAtom.get().theme === "auto") applyTheme("auto");
  });
}

updateThemeToggle(themeAtom.get().theme);

// "More" overflow menu — folds rename/directories/refresh/theme behind one
// button so the topbar has room for the full cwd path. Toggle on tap, close
// on Esc, outside-click, or after any item is activated.
function setMoreActionsOpen(open) {
  els.moreActionsMenu.hidden = !open;
  els.moreActionsToggle.setAttribute("aria-expanded", String(open));
}
els.moreActionsToggle.addEventListener("click", (event) => {
  event.stopPropagation();
  setMoreActionsOpen(els.moreActionsMenu.hidden);
});
els.moreActionsMenu.addEventListener("click", (event) => {
  if (event.target.closest(".more-actions-item")) setMoreActionsOpen(false);
});
document.addEventListener("click", (event) => {
  if (els.moreActionsMenu.hidden) return;
  if (els.moreActionsMenu.contains(event.target)) return;
  if (els.moreActionsToggle.contains(event.target)) return;
  setMoreActionsOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.moreActionsMenu.hidden) setMoreActionsOpen(false);
});

function setDirectKeysOpen(open) {
  if (!els.directKeysMenu || !els.directKeysToggle) return;
  els.directKeysMenu.hidden = !open;
  els.directKeysToggle.setAttribute("aria-expanded", String(open));
}
els.directKeysToggle?.addEventListener("click", (event) => {
  event.stopPropagation();
  setDirectKeysOpen(els.directKeysMenu.hidden);
});
els.directKeysMenu?.addEventListener("click", (event) => {
  if (event.target.closest(".direct-key")) setDirectKeysOpen(false);
});
document.addEventListener("click", (event) => {
  if (!els.directKeysMenu || els.directKeysMenu.hidden) return;
  if (els.directKeysMenu.contains(event.target)) return;
  if (els.directKeysToggle?.contains(event.target)) return;
  setDirectKeysOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && els.directKeysMenu && !els.directKeysMenu.hidden) {
    setDirectKeysOpen(false);
    event.preventDefault();
    event.stopImmediatePropagation();
  }
});

// Snapshot font-size A−/A+ inside the More menu. These intentionally do NOT
// close the menu (they're inside .more-actions-row, not .more-actions-item)
// so the user can tap a few times to dial in the right size in one go.
function applySnapshotFontSize(px) {
  const clamped = clampSnapshotFont(px);
  document.documentElement.style.setProperty("--snapshot-font-size", `${clamped}px`);
  els.fontSizeValue.textContent = String(clamped);
  els.fontSizeDecrease.disabled = clamped <= SNAPSHOT_FONT_MIN;
  els.fontSizeIncrease.disabled = clamped >= SNAPSHOT_FONT_MAX;
}
function stepSnapshotFontSize(delta) {
  const next = clampSnapshotFont(readPersistedSnapshotFont() + delta);
  snapshotFontAtom.set({ px: next });
  applySnapshotFontSize(next);
}
applySnapshotFontSize(readPersistedSnapshotFont());
els.fontSizeDecrease.addEventListener("click", (event) => {
  event.stopPropagation();
  stepSnapshotFontSize(-1);
});
els.fontSizeIncrease.addEventListener("click", (event) => {
  event.stopPropagation();
  stepSnapshotFontSize(+1);
});

// Transcript view: every user prompt + assistant final response from the
// agent's own JSONL, filtered to clean dialogue (no tool calls, no system
// reminders). The first useful thing on top of the structured-read
// protocol — purpose-built so future features (jump-to-turn, fork-from-
// turn, diff between sessions, etc.) can hang off this same view.
function hideAgentTranscriptSheet() {
  els.agentTranscriptSheet.hidden = true;
}
function setAgentTranscriptEmpty(message) {
  els.agentTranscriptBody.innerHTML = "";
  const note = document.createElement("div");
  note.className = "agent-transcript-empty";
  note.textContent = message;
  els.agentTranscriptBody.append(note);
}
function renderAgentTranscriptTurns(turns) {
  els.agentTranscriptBody.innerHTML = "";
  for (const turn of turns) {
    const row = document.createElement("div");
    row.className = `agent-turn agent-turn-${turn.role}`;
    const role = document.createElement("span");
    role.className = "agent-turn-role";
    role.textContent = turn.role === "user" ? "USER" : "ASSISTANT";
    const text = document.createElement("div");
    text.className = "agent-turn-text";
    text.textContent = turn.text;
    row.append(role, text);
    els.agentTranscriptBody.append(row);
  }
  // Latest turn at the bottom — scroll there so the user lands on "what
  // just happened" by default.
  requestAnimationFrame(() => {
    els.agentTranscriptBody.scrollTop = els.agentTranscriptBody.scrollHeight;
  });
}
async function showAgentTranscript() {
  if (!state.paneId) {
    addChat("system", "Select a window first.", "system");
    return;
  }
  els.agentTranscriptTitle.textContent = "Transcript";
  els.agentTranscriptMeta.textContent = "Loading transcript…";
  setAgentTranscriptEmpty("Loading…");
  els.agentTranscriptSheet.hidden = false;
  try {
    const data = await api(
      `/api/agent-transcript?paneId=${encodeURIComponent(state.paneId)}`,
    );
    const result = data.result;
    if (!result) {
      els.agentTranscriptTitle.textContent = "Transcript · none";
      els.agentTranscriptMeta.textContent =
        "No Codex or Claude agent detected in this pane's process tree.";
      setAgentTranscriptEmpty("Nothing to show.");
      return;
    }
    els.agentTranscriptTitle.textContent = `Transcript · ${result.kind}`;
    const turns = Array.isArray(result.turns) ? result.turns : [];
    els.agentTranscriptMeta.textContent = [
      `session  ${result.sessionId || "(none)"}`,
      `file     ${result.transcriptPath || "(none)"}`,
      `turns    ${turns.length}`,
    ].join("\n");
    if (turns.length === 0) {
      setAgentTranscriptEmpty(
        "Transcript located but no user/assistant turns parsed yet.",
      );
      return;
    }
    renderAgentTranscriptTurns(turns);
  } catch (error) {
    els.agentTranscriptTitle.textContent = "Transcript · error";
    els.agentTranscriptMeta.textContent = error.message || String(error);
    setAgentTranscriptEmpty("Failed to load.");
  }
}
els.showTranscript.addEventListener("click", showAgentTranscript);
els.agentTranscriptBackdrop.addEventListener("click", hideAgentTranscriptSheet);
els.closeAgentTranscript.addEventListener("click", hideAgentTranscriptSheet);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.agentTranscriptSheet.hidden) {
    hideAgentTranscriptSheet();
  }
});
els.refreshSnapshot.addEventListener("click", () => refreshSnapshot());
els.fullscreenSnapshot.addEventListener("click", () => {
  setSnapshotFullscreen(!state.snapshotFullscreen);
});
els.exitSnapshotFullscreen.addEventListener("click", () => {
  setSnapshotFullscreen(false);
});

// Smart content viewer: fetch a pane-referenced file and show it inline. The
// path is resolved against the pane's cwd server-side (and confined to it).
// Markdown opens as a rendered HTML page (/api/file-view); images and standalone
// HTML open through a viewer-wrapper page (/api/file-page) that embeds the
// artifact and carries the "Pin" overlay; raw media (video/audio) open as a real,
// named URL (/api/file-raw) — they can't host an overlay, so they pin from the
// file chip instead. All are real server URLs (not blob:) so the tab title and
// any "Save as…" use the actual file name (Content-Disposition), no blob GUIDs.
const MARKDOWN_FILE_EXT = /\.(md|markdown|mdown|mkd)$/i;
// Image + standalone-HTML kinds get the overlay-bearing wrapper page.
const OVERLAY_VIEWER_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|ico|html?)$/i;

// Build an authed, machine-scoped file URL. A new tab can't send the x-machine-id
// header, so the machine is passed as a query param (the server accepts either);
// auth rides on the same-origin cookie. `dl` forces a download.
function fileUrl(endpoint, filePath, { dl = false } = {}) {
  const params = new URLSearchParams({ paneId: state.paneId, path: filePath });
  if (state.machineId) params.set("machineId", state.machineId);
  if (state.mux) params.set("mux", state.mux);
  if (dl) params.set("dl", "1");
  return `${endpoint}?${params}`;
}

function openFileViewer(filePath) {
  if (!filePath) return;
  if (!state.paneId) {
    setStatus("Select a pane first", false);
    return;
  }
  // Open in a new tab via a real server URL. window.open in the click gesture
  // avoids popup blocking; no fetch/blob round-trip needed.
  const endpoint = MARKDOWN_FILE_EXT.test(filePath)
    ? "/api/file-view"
    : OVERLAY_VIEWER_EXT.test(filePath)
      ? "/api/file-page"
      : "/api/file-raw";
  const url = fileUrl(endpoint, filePath);
  openViewerUrl(url);
}

function filePathFromSnapshotTarget(target) {
  const fileSpan = target?.closest?.(".pane-file");
  if (fileSpan?.dataset?.filePath) return fileSpan.dataset.filePath;
  const link = target?.closest?.("a[href]");
  if (!link) return "";
  return filePathFromLocalHref(link.getAttribute("href"));
}

// Pin a pane-referenced file directly (the fallback path for raw media, whose
// viewer tab can't host the in-page Pin overlay, and a right-click/long-press
// affordance on any file chip). POSTs the file's current bytes to /api/pins and,
// on success, copies the shareable link to the clipboard and surfaces it in the
// status line. Re-pinning unchanged content dedups server-side.
async function pinArtifact(filePath, { share = { scope: "private" } } = {}) {
  if (!filePath) return;
  if (!state.paneId) {
    setStatus("Select a pane first", false);
    return;
  }
  setStatus("Pinning…", true);
  try {
    const params = new URLSearchParams({ paneId: state.paneId, path: filePath });
    if (state.machineId) params.set("machineId", state.machineId);
    const res = await api(`/api/pins?${params}`, {
      method: "POST",
      body: JSON.stringify({ share }),
    });
    const link = `${window.location.origin}${res.pin.shareUrl}`;
    try {
      await navigator.clipboard?.writeText(link);
      setStatus(res.deduped ? "Already pinned — link copied" : "Pinned — link copied", true);
    } catch {
      setStatus(res.deduped ? "Already pinned (unchanged)" : "Pinned", true);
    }
    // Refresh the manage sheet if it happens to be open.
    if (els.pinsSheet && !els.pinsSheet.hidden) loadPins();
  } catch (error) {
    setStatus(error.message || "Pin failed", false);
  }
}



// Hold the pane to open the "Answer question" overlay — the gesture the user
// reaches for when they see Claude waiting on an AskUserQuestion. Like the
// More-menu item, this is an explicit, user-triggered scan: it just calls
// openAskOverlay(), which fetches/parses on demand.
//
// The trigger differs by input so it NEVER competes with copying text:
//   • Touch  — TWO fingers held still. A single-finger press-and-hold is the
//              native OS gesture for starting a text selection / showing the
//              copy callout, so we leave it completely alone (a one-finger hold
//              used to race the selection and pop this overlay over the text the
//              user was trying to copy — especially on mobile Safari/Chrome).
//   • Mouse  — left button held still (desktop has no native finger-selection
//              race, and drag-select still cancels via the move slop).
//
// In both cases we cancel on movement past a small slop (scroll/select), on
// early release, and bail if a text selection is already in progress; and we
// suppress the synthetic click that follows so it doesn't also grab pane focus.
//
// Arming feedback: a held gesture is otherwise silent for the full 500ms and
// then the overlay appears all at once, which feels laggy/uncertain. Partway
// through (ARM_MS) we add a faint "arming" highlight to the pane so the hold
// reads as intentional — removed the instant it fires or cancels.
function setupSnapshotLongPress() {
  const LONG_PRESS_MS = 500;
  const ARM_MS = 220; // show the arming cue partway through the hold
  const MOVE_SLOP_PX = 10; // movement beyond this = a scroll/select, not a press
  let timer = null;
  let armTimer = null;
  let startX = 0;
  let startY = 0;
  let fired = false; // a long-press fired for the current gesture

  const disarm = () => {
    if (armTimer !== null) {
      clearTimeout(armTimer);
      armTimer = null;
    }
    els.snapshot.classList.remove("press-arming");
  };

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    disarm();
  };

  const start = (x, y, target) => {
    fired = false;
    // Don't hijack a press that starts on a link/file — those have their own tap
    // actions and shouldn't be shadowed by the overlay.
    if (target?.closest?.("a.pane-link, .pane-file, a[href]")) return;
    startX = x;
    startY = y;
    clear();
    armTimer = setTimeout(() => {
      armTimer = null;
      // Only show the cue if the user isn't actually selecting text — same bail
      // the fire path uses, so we never glow during a real selection.
      if (hasSnapshotSelection()) return;
      els.snapshot.classList.add("press-arming");
    }, ARM_MS);
    timer = setTimeout(() => {
      timer = null;
      disarm();
      // If the user has started selecting text, this is a selection gesture, not
      // a long-press — leave it alone.
      if (hasSnapshotSelection()) return;
      fired = true;
      if (navigator.vibrate) navigator.vibrate(15); // subtle haptic ack
      openAskOverlay();
    }, LONG_PRESS_MS);
  };

  const move = (x, y) => {
    if (timer === null) return;
    if (Math.abs(x - startX) > MOVE_SLOP_PX || Math.abs(y - startY) > MOVE_SLOP_PX) {
      clear(); // finger moved — treat as scroll/select, cancel the long-press
    }
  };

  // Touch: arm only on a deliberate TWO-finger hold. One finger (native copy) or
  // three+ never arms. The midpoint of the two fingers is the anchor; if a
  // finger lifts (back to one) or another lands (three+), cancel — the gesture
  // is only valid while exactly two fingers are down and still.
  els.snapshot.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 2) {
        clear(); // one finger = let the OS handle selection; 3+ = not our gesture
        return;
      }
      const [a, b] = e.touches;
      start((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2, e.target);
    },
    { passive: true },
  );
  els.snapshot.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length !== 2) {
        clear(); // finger count changed mid-hold — no longer the two-finger gesture
        return;
      }
      const [a, b] = e.touches;
      move((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
    },
    { passive: true },
  );
  els.snapshot.addEventListener("touchend", clear, { passive: true });
  els.snapshot.addEventListener("touchcancel", clear, { passive: true });

  // Mouse long-press (desktop): left button held still.
  els.snapshot.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    start(e.clientX, e.clientY, e.target);
  });
  els.snapshot.addEventListener("mousemove", (e) => move(e.clientX, e.clientY));
  els.snapshot.addEventListener("mouseup", clear);
  els.snapshot.addEventListener("mouseleave", clear);

  // Suppress the click synthesized after a long press so it doesn't also focus
  // the pane input / follow a link. The capture-phase listener runs before the
  // normal click handler below.
  els.snapshot.addEventListener(
    "click",
    (e) => {
      if (fired) {
        fired = false;
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
}
setupSnapshotLongPress();

els.snapshot.addEventListener("click", (event) => {
  // A click on a detected URL should just open the link — don't also grab focus
  // for the pane input (which would pop the mobile keyboard).
  if (event.target.closest("a.pane-link")) return;
  // A click on a detected file path opens the in-app content viewer.
  const filePath = filePathFromSnapshotTarget(event.target);
  if (filePath) {
    event.preventDefault();
    openFileViewer(filePath);
    return;
  }
});

// When a deferred snapshot update is pending (held back because the user was
// selecting text), apply it as soon as the selection clears so the view doesn't
// stay stale.
document.addEventListener("selectionchange", () => {
  if (state.pendingSnapshotText != null && !hasSnapshotSelection()) {
    const text = state.pendingSnapshotText;
    state.pendingSnapshotText = null;
    updateSnapshotText(text);
  }
});

// Keyboard activation for the file-path spans (they're role="link" tabindex=0).
els.snapshot.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const filePath = filePathFromSnapshotTarget(event.target);
  if (!filePath) return;
  event.preventDefault();
  openFileViewer(filePath);
});

// Right-click / long-press context menu on a file chip pins it directly. This is
// the pin path for raw media (whose viewer tab can't host the overlay) and a
// quick shortcut for any artifact.
els.snapshot.addEventListener("contextmenu", (event) => {
  const filePath = filePathFromSnapshotTarget(event.target);
  if (!filePath) return;
  event.preventDefault();
  pinArtifact(filePath);
});

els.snapshot.addEventListener(
  "scroll",
  () => {
    state.snapshotPinnedToBottom = isSnapshotAtBottom();
  },
  { passive: true },
);
els.renameWindow.addEventListener("click", renameSelectedWindow);
els.answerQuestion.addEventListener("click", openAskOverlay);
els.closeAsk.addEventListener("click", closeAskOverlay);
els.askBackdrop.addEventListener("click", closeAskOverlay);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.askSheet.hidden) closeAskOverlay();
});
els.newWindow.addEventListener("click", createNewWindow);
els.duplicateWindow.addEventListener("click", duplicateCurrentWindow);
els.closeWindow.addEventListener("click", closeCurrentWindow);
els.confirmDuplicate.addEventListener("click", confirmDuplicate);
els.closeDuplicate.addEventListener("click", closeDuplicateSheet);
els.duplicateBackdrop.addEventListener("click", closeDuplicateSheet);
if (els.newBranchWindow) {
  els.newBranchWindow.addEventListener("click", openNewBranchSheet);
  els.confirmNewBranch.addEventListener("click", confirmNewBranch);
  els.closeNewBranch.addEventListener("click", closeNewBranchSheet);
  els.newBranchBackdrop.addEventListener("click", closeNewBranchSheet);
  els.newBranchName.addEventListener("keydown", (event) => {
    if (event.key === "Enter") confirmNewBranch();
  });
}
els.duplicateCommand.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    confirmDuplicate();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.duplicateSheet.hidden) closeDuplicateSheet();
});
// Reflect the persisted depth in the picker before the user sees it. The HTML
// default is option value="500" but state.lines may already be something else
// from localStorage; this keeps them in lockstep.
els.lineCount.value = String(state.lines);
els.lineCount.addEventListener("change", () => {
  state.lines = Number(els.lineCount.value);
  linesAtom.set({ lines: state.lines });
  refreshSnapshot();
});
els.autoRefresh.addEventListener("change", () => setAutoRefresh(els.autoRefresh.checked));
els.sessionNameInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  createTmuxSession();
});
els.createSession.addEventListener("click", createTmuxSession);
els.machineSelect?.addEventListener("change", () => {
  selectMachine(els.machineSelect.value).catch((error) => {
    setStatus(error.message, false);
  });
});
els.openTargetPicker.addEventListener("click", openTargetPicker);
// Copy the current window's full descriptor (stable id + context). Lives on its
// own button so the title keeps its tap-to-open-picker behavior. Flips to a
// check icon for ~1.2s on success; falls back to selecting the title text if
// the clipboard is blocked (insecure context).
if (els.copyWindowId) {
  const copyLabel = els.copyWindowId.querySelector("[data-copy-label]");
  els.copyWindowId.addEventListener("click", async (event) => {
    // Keep the More menu open briefly so the "Copied" confirmation is visible
    // (stopPropagation prevents the menu's close-on-item-click), then close it.
    event.stopPropagation();
    const win = selectedWindow();
    if (!win) return;
    const text = windowDescriptor(windowIdFields(win));
    const flash = (msg) => {
      if (!copyLabel) return;
      copyLabel.textContent = msg;
      els.copyWindowId.classList.add("copied");
      setTimeout(() => {
        copyLabel.textContent = "Copy window id";
        els.copyWindowId.classList.remove("copied");
        setMoreActionsOpen(false);
      }, 1000);
    };
    try {
      await navigator.clipboard.writeText(text);
      flash("Copied!");
    } catch {
      // Clipboard blocked (insecure context): select the title text so the user
      // can copy it manually, and say so.
      const range = document.createRange();
      range.selectNodeContents(els.mobileTargetLabel);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      flash("Select + copy ↑");
    }
  });
}
// Global recents popup: a quick-switch list of recently-visited windows across
// ALL machines, each labelled with the same descriptor format as the window
// title. Switching is cross-machine aware (selectMachine first in hub mode,
// then resolve the stable key to a live window).
function setGlobalRecentsOpen(open) {
  if (!els.globalRecentsMenu) return;
  if (open) {
    // Mutually exclusive with the full window-list picker (same intent).
    if (state.targetPickerOpen) closeTargetPicker();
    renderGlobalRecentsMenu();
  }
  els.globalRecentsMenu.hidden = !open;
  els.globalRecentsToggle?.setAttribute("aria-expanded", String(open));
}

function renderGlobalRecentsMenu() {
  if (!els.globalRecentsMenu) return;
  els.globalRecentsMenu.innerHTML = "";
  const entries = globalRecents();
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "recents-menu-empty";
    empty.textContent = "No recent windows yet.";
    els.globalRecentsMenu.append(empty);
    return;
  }
  for (const entry of entries) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "recents-menu-item";
    item.setAttribute("role", "menuitem");
    // Exact same format as the top-left window title — built by the shared
    // windowTitleText(). Recents is cross-machine, so always include the host
    // prefix (the title does this in hub mode).
    const titleFields = {
      machine: entry.host || entry.machineId || "",
      index: entry.index,
      name: entry.name,
      cwd: entry.cwd,
      branch: entry.branch,
    };
    item.textContent = windowTitleText(titleFields);
    // Hover shows the captured note, agent type, and activity state.
    item.title = windowHoverDetail({
      ...titleFields,
      note: entry.note,
      agentType: entry.agentType,
      turn: entry.turn,
      live: entry.live,
    });
    item.addEventListener("click", () => {
      setGlobalRecentsOpen(false);
      switchToGlobalRecent(entry);
    });
    els.globalRecentsMenu.append(item);
  }
}

async function switchToGlobalRecent(entry) {
  const entryMux = normalizeMux(entry.mux);
  const onOtherMachine =
    state.runtimeMode === "hub" &&
    entry.machineId &&
    (entry.machineId !== state.machineId || entryMux !== state.mux);
  if (onOtherMachine) {
    // Hop to the other machine AND land directly on this window in one step:
    // pass the target so refreshTree's urlTarget resolution selects it once the
    // new machine's windows load (avoids a switch-then-find race where the
    // window list isn't ready yet and we'd fall back to the picker).
    await selectMachine(entry.machineId, {
      mux: entryMux,
      session: entry.sessionName,
      windowIndex: entry.index,
    });
    // selectMachine → loadWindows already selected the target window (it matches
    // urlTarget by session name + index and sets state.windowId). Verify by the
    // ACTUAL outcome rather than re-deriving the stable key, which can mismatch
    // on machineId representation and wrongly pop the picker even though the
    // switch worked.
    if (selectedMatchesTarget(entry.sessionName, entry.index)) {
      // Switched cleanly — make sure neither switcher surface lingers.
      closeTargetPicker();
      setGlobalRecentsOpen(false);
    } else {
      // Genuinely couldn't land (window gone / not loaded) — let the user find
      // it in the full picker.
      showTargetPicker();
    }
    return;
  }
  // Same machine: resolve the stable key to a live window and select it.
  const win = state.windows.find((w) => windowRecentKey(w) === entry.key);
  if (win) {
    await selectWindow(win.id);
  } else {
    // The window is gone / not loaded — fall back to the full picker so the
    // user can find it (or confirm it's closed).
    showTargetPicker();
  }
}

if (els.globalRecentsToggle && els.globalRecentsMenu) {
  els.globalRecentsToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    setGlobalRecentsOpen(els.globalRecentsMenu.hidden);
  });
  document.addEventListener("click", (event) => {
    if (els.globalRecentsMenu.hidden) return;
    if (els.globalRecentsMenu.contains(event.target)) return;
    if (els.globalRecentsToggle.contains(event.target)) return;
    setGlobalRecentsOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.globalRecentsMenu.hidden) {
      setGlobalRecentsOpen(false);
    }
  });
}

if (els.needsAttention) {
  els.needsAttention.addEventListener("click", jumpToFirstAttention);
}
if (els.exitCopyMode) {
  els.exitCopyMode.addEventListener("click", exitCopyModeNow);
}
els.closeTargetPicker.addEventListener("click", closeTargetPicker);
els.targetBackdrop.addEventListener("click", closeTargetPicker);
els.openDirectoryPicker.addEventListener("click", openDirectoryPicker);
els.closeDirectoryPicker.addEventListener("click", closeDirectoryPicker);
els.directoryBackdrop.addEventListener("click", closeDirectoryPicker);
els.refreshDirectoryPicker.addEventListener("click", () => {
  loadDirectories({ clear: false }).catch((error) => {
    addChat("system", error.message, "directory error");
  });
});
els.openPinsSheet?.addEventListener("click", openPinsSheet);
els.closePinsSheet?.addEventListener("click", closePinsSheet);
els.pinsBackdrop?.addEventListener("click", closePinsSheet);
els.refreshPins?.addEventListener("click", () => loadPins());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && els.pinsSheet && !els.pinsSheet.hidden) {
    closePinsSheet();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && shouldHoldScreenAwake()) {
    requestScreenWakeLock();
  }
});
// Attach: open the file picker; on selection, upload + insert the temp path(s).
if (els.attachButton && els.fileInput) {
  els.attachButton.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", async () => {
    // Snapshot the files into an array BEFORE clearing the input — fileInput.files
    // is live, so resetting .value would empty it out from under the async upload.
    const files = Array.from(els.fileInput.files || []);
    els.fileInput.value = ""; // reset so picking the same file re-fires change
    await uploadFiles(files);
  });
}
// Mic: tap to start dictating into the box; while recording the Keep/Discard
// controls take over (the mic itself is hidden via CSS).
els.voiceButton.addEventListener("click", toggleVoiceRecording);
// Submit: send the box contents to the pane.
// Send button = explicit "done": submit and hide the virtual keyboard.
els.submitText.addEventListener("click", (event) =>
  submitTextComposer(event, { keepFocus: false }),
);
els.clearText?.addEventListener("click", () => {
  composerClear();
  composerFocus();
});
els.textInput.addEventListener("input", () => {
  if (!composerEditor) {
    els.textInput.classList.toggle("empty", els.textInput.innerText.trim().length === 0);
  }
});
els.textInput.addEventListener("keydown", (event) => {
  if (composerEditor) return; // Lexical handles Enter via KEY_ENTER_COMMAND
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (state.voice.status === "recording") {
      submitVoiceRecording({ sendAfterTranscribe: true });
      return;
    }
    submitTextComposer();
  }
});

// iOS PWA / Add-to-Home-Screen quirk: in standalone mode the virtual
// keyboard's Return key on a contenteditable fires `beforeinput` with
// `inputType: "insertParagraph"` but does NOT reliably fire a `keydown`
// with `key === "Enter"`. Lexical's KEY_ENTER_COMMAND and the keydown
// fallback above both bind to keydown, so both miss it — net effect is
// Enter does nothing in iOS PWAs even though typing works. Regular Safari
// / Chrome aren't standalone so they fire keydown the normal way.
// Catching beforeinput is harmless on those browsers: if both fire, the
// second submitTextComposer sees an empty editor and returns immediately.
els.textInput.addEventListener("beforeinput", (event) => {
  const type = event.inputType;
  if (type !== "insertParagraph" && type !== "insertLineBreak") return;
  if (event.shiftKey) return; // future-proof: Shift+Enter still a newline
  event.preventDefault();
  if (state.voice.status === "recording") {
    submitVoiceRecording({ sendAfterTranscribe: true });
    return;
  }
  submitTextComposer();
});
document.addEventListener("keydown", handleComposerVoiceShortcut, true);
document.addEventListener("keydown", handleComposerFocusShortcut);
els.submitVoice.addEventListener("click", submitVoiceRecording);
els.cancelVoice.addEventListener("click", cancelVoiceRecording);
els.retryVoice.addEventListener("click", retryVoiceRecording);
els.directoryList.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest("[data-cwd-path]");
  if (!button) return;
  try {
    await changeDirectory(button.dataset.cwdPath);
  } catch (error) {
    addChat("system", error.message, "directory error");
  }
});
els.speakWindow.addEventListener("click", async () => {
  if (state.audio.busy) {
    stopWindowSummary();
    return;
  }
  try {
    await speakWindowSummary();
  } catch (error) {
    addChat("system", error.message, "audio error");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.snapshotFullscreen) {
    event.preventDefault();
    setSnapshotFullscreen(false);
    return;
  }
  if (event.key === "Escape" && state.targetPickerOpen) {
    closeTargetPicker();
    return;
  }
  if (event.key === "Escape" && state.directoryPickerOpen) {
    closeDirectoryPicker();
  }
});

for (const button of document.querySelectorAll("[data-key]")) {
  button.addEventListener("click", async () => {
    try {
      await sendKey(button.dataset.key);
    } catch (error) {
      addChat("system", error.message, "error");
    }
  });
}

for (const button of document.querySelectorAll("[data-command]")) {
  button.addEventListener("click", async () => {
    try {
      await sendMessage(button.dataset.command || "", true);
    } catch (error) {
      addChat("system", error.message, "error");
    }
  });
}

// Mode pill: tap to cycle, caret to open the mode/effort sheet.
els.modeCycle?.addEventListener("click", cycleAgentMode);
els.modeMore?.addEventListener("click", openModeSheet);
els.closeMode?.addEventListener("click", closeModeSheet);
els.modeBackdrop?.addEventListener("click", closeModeSheet);

// Snippet bar: delegated so dynamically-rendered chips work. Tapping a chip
// inserts its text into the message box (you then Send).
els.snippetChips?.addEventListener("click", (event) => {
  const chip = event.target.closest(".snippet-chip");
  if (!chip) return;
  insertSnippet(Number(chip.dataset.index));
});
els.manageSnippets?.addEventListener("click", openSnippetManager);
els.closeSnippets?.addEventListener("click", closeSnippetManager);
els.snippetBackdrop?.addEventListener("click", closeSnippetManager);
els.snippetAdd?.addEventListener("click", addSnippet);
els.snippetNewText?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addSnippet();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.snippetSheet?.hidden) closeSnippetManager();
});
onSnippetsChanged(() => {
  renderSnippetChips();
  if (!els.snippetSheet?.hidden) renderSnippetList();
});
renderSnippetChips();
initSnippets();

// Fork this agent into a fresh window (duplicates the agent's launch command in
// a new worktree). Wired by data-attribute so the trigger can live anywhere.
for (const button of document.querySelectorAll("[data-agent-fork]")) {
  button.addEventListener("click", async () => {
    try {
      await forkAgentWindow();
    } catch (error) {
      addChat("system", error.message, "error");
    }
  });
}

window.addEventListener("popstate", () => {
  const urlTarget = readUrlTarget();
  if (hasUrlTarget(urlTarget)) clearTargetViewForUrlNavigation(urlTarget);
  refreshTree({
    urlTarget,
    forceUrlTarget: true,
  });
});

renderComposerMode();
initComposerEditor();
// Start with Read disabled — refreshAgentDetection in loadPanes() will
// turn it on for Codex/Claude panes once the first window loads.
renderReadButtonsEnabled();

refreshTree({
  urlTarget: state.pendingUrlTarget,
  forceUrlTarget: hasUrlTarget(state.pendingUrlTarget),
  syncUrl: true,
}).then(() => {
  els.autoRefresh.checked = true;
  setAutoRefresh(true);
});

// SPA router hook. Called by spa-router.mjs the moment this view becomes the
// active one again (after the user navigated away to Command Center and back).
// If the URL names a target window, treat that navigation as foreground work:
// clear the previous pane immediately and force the tree selection to consume
// the new query. Plain returns without a target keep the old background-refresh
// behavior.
export function resumeView() {
  const urlTarget = readUrlTarget();
  if (hasUrlTarget(urlTarget)) {
    clearTargetViewForUrlNavigation(urlTarget);
    state.autoRefreshInFlight = true;
    refreshTree({
      urlTarget,
      forceUrlTarget: true,
      syncUrl: true,
    }).finally(() => {
      state.autoRefreshInFlight = false;
    });
    return;
  }
  if (state.autoRefreshInFlight) return;
  state.autoRefreshInFlight = true;
  Promise.allSettled([refreshTree(), refreshSnapshot()]).finally(() => {
    state.autoRefreshInFlight = false;
  });
}

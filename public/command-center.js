import { buildAgentAppUrl } from "./agent-link.mjs";
import {
  clearCommandCenterGrace,
  commandCenterGraceActive,
  commandCenterGraceMachineKeys,
  createCommandCenterGrace,
  holdCommandCenterSnapshot as holdCommandCenterGraceSnapshot,
} from "./command-center-grace.mjs";
import { linkifyEscaped, linkifyFilesEscaped } from "./linkify.js";
import { renderMarkdown } from "./markdown.js";
import { closeRealtimeReadAudio, playRealtimeRead } from "./realtime-read.js";

// Command Center — separate top-level page. Polls /api/command-center on
// a slow cadence, drops non-agent windows, renders one card per agent
// with the last user prompt + last assistant response taken verbatim from
// the agent's JSONL transcript. No tmux capture, no LLM summary.

const POLL_MS = 4000;
const INTERACT_WAVEFORM_SAMPLES = 40;
const INTERACT_WAVEFORM_SAMPLE_INTERVAL_MS = 200;
const SNIPPETS_KEY = "tmux-mobile-snippets";
const COMPOSER_HISTORY_KEY = "tmux-mobile-composer-history";
const COMPOSER_HISTORY_MAX = 100;
const THEME_KEY = "tmux-mobile-theme";
const THEME_OPTIONS = ["kami", "dark", "auto"];
const CC_FONT_KEY = "tmux-mobile-cc-font-size";
const CC_FONT_MIN = 10;
const CC_FONT_MAX = 18;
const CC_FONT_DEFAULT = 13;
const DEFAULT_SNIPPETS = [
  { text: "yes" },
  { text: "continue" },
  { text: "/clear" },
  { text: "/btw " },
  { text: "claude" },
  { text: "codex" },
  { text: "/goal " },
];
const ICONS = {
  interact:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M8 9h8"/><path d="M8 13h5"/></svg>',
  read:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4Z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
  stop:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  open:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
  fullscreen:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
  transcript:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>',
  share:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 0 20"/><path d="M12 2a15.3 15.3 0 0 0 0 20"/></svg>',
  copy:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>',
  check:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  delete:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
};
const AGENT_ICONS = {
  claude:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M12 2l1.5 6L18 4.8l-2.3 4.4 6.3-.7-5.7 2.7 5.7 2.7-6.3-.7L18 19.2 13.5 16 12 22l-1.5-6L6 19.2l2.3-4.4-6.3.7L7.7 12 2 9.3l6.3.7L6 4.8 10.5 8 12 2z"/></svg>',
  codex:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 5.2a3.4 3.4 0 0 1 5.9 1.9 3.4 3.4 0 0 1 0 5.8 3.4 3.4 0 0 1-5.9 5.9 3.4 3.4 0 0 1-5.9-1.9 3.4 3.4 0 0 1 0-5.8A3.4 3.4 0 0 1 12 5.2z"/><path d="M12 8.4v7.2M8.9 10.2l6.2 3.6M15.1 10.2l-6.2 3.6"/></svg>',
};
const AGENT_LABELS = {
  claude: "Claude Code",
  codex: "Codex",
};

const els = {
  list: document.querySelector("#ccList"),
  status: document.querySelector("#ccStatus"),
  refresh: document.querySelector("#ccRefresh"),
  filterRow: document.querySelector("#ccFilterRow"),
  sortSelect: document.querySelector("#ccSort"),
  welcome: document.querySelector("#ccWelcome"),
  welcomeClose: document.querySelector("#ccWelcomeClose"),
  welcomeShow: document.querySelector("#ccWelcomeShow"),
  moreMenu: document.querySelector("#ccMoreMenu"),
  cardSearchOpen: document.querySelector("#ccCardSearchOpen"),
  themeButtons: [...document.querySelectorAll("[data-cc-theme]")],
  fontDecrease: document.querySelector("#ccFontDecrease"),
  fontIncrease: document.querySelector("#ccFontIncrease"),
  fontSizeValue: document.querySelector("#ccFontSizeValue"),
  interactSheet: document.querySelector("#ccInteractSheet"),
  interactBackdrop: document.querySelector("#ccInteractBackdrop"),
  interactClose: document.querySelector("#ccInteractClose"),
  interactTarget: document.querySelector("#ccInteractTarget"),
  interactInputArea: document.querySelector("#ccInteractInputArea"),
  interactInput: document.querySelector("#ccInteractInput"),
  interactAttachButton: document.querySelector("#ccInteractAttachButton"),
  interactFileInput: document.querySelector("#ccInteractFileInput"),
  interactSend: document.querySelector("#ccInteractSend"),
  interactStatus: document.querySelector("#ccInteractStatus"),
  interactSnippetChips: document.querySelector("#ccInteractSnippetChips"),
  interactManageSnippets: document.querySelector("#ccInteractManageSnippets"),
  snippetSheet: document.querySelector("#ccSnippetSheet"),
  snippetBackdrop: document.querySelector("#ccSnippetBackdrop"),
  snippetClose: document.querySelector("#ccSnippetClose"),
  snippetList: document.querySelector("#ccSnippetList"),
  snippetNewText: document.querySelector("#ccSnippetNewText"),
  snippetAdd: document.querySelector("#ccSnippetAdd"),
  historyList: document.querySelector("#ccHistoryList"),
  interactKeys: document.querySelector("#ccInteractKeys"),
  interactVoiceButton: document.querySelector("#ccInteractVoiceButton"),
  interactVoiceWaveform: document.querySelector("#ccInteractVoiceWaveform"),
  interactSubmitVoice: document.querySelector("#ccInteractSubmitVoice"),
  interactCancelVoice: document.querySelector("#ccInteractCancelVoice"),
  startAgentOpen: document.querySelector("#ccStartAgentOpen"),
  startAgentSheet: document.querySelector("#ccStartAgentSheet"),
  startAgentBackdrop: document.querySelector("#ccStartAgentBackdrop"),
  startAgentClose: document.querySelector("#ccStartAgentClose"),
  startAgentMachine: document.querySelector("#ccStartAgentMachine"),
  startAgentKindButtons: [
    ...document.querySelectorAll("[data-start-agent-kind]"),
  ],
  startAgentMuxButtons: [
    ...document.querySelectorAll("[data-start-agent-mux]"),
  ],
  startAgentSessionName: document.querySelector("#ccStartAgentSessionName"),
  startAgentPath: document.querySelector("#ccStartAgentPath"),
  startAgentLoadDir: document.querySelector("#ccStartAgentLoadDir"),
  startAgentDirectoryPath: document.querySelector("#ccStartAgentDirectoryPath"),
  startAgentDirectoryList: document.querySelector("#ccStartAgentDirectoryList"),
  startAgentStatus: document.querySelector("#ccStartAgentStatus"),
  startAgentCancel: document.querySelector("#ccStartAgentCancel"),
  startAgentSubmit: document.querySelector("#ccStartAgentSubmit"),
  deleteDialog: document.querySelector("#ccDeleteDialog"),
  deleteTarget: document.querySelector("#ccDeleteTarget"),
  deleteStatus: document.querySelector("#ccDeleteStatus"),
  deleteCancel: document.querySelector("#ccDeleteCancel"),
  deleteConfirm: document.querySelector("#ccDeleteConfirm"),
  responseFullscreen: document.querySelector("#ccResponseFullscreen"),
  responseFullscreenBackdrop: document.querySelector("#ccResponseFullscreenBackdrop"),
  responseFullscreenClose: document.querySelector("#ccResponseFullscreenClose"),
  responseFullscreenTitle: document.querySelector("#ccResponseFullscreenTitle"),
  responseFullscreenMeta: document.querySelector("#ccResponseFullscreenMeta"),
  responseFullscreenBody: document.querySelector("#ccResponseFullscreenBody"),
  transcriptSheet: document.querySelector("#ccTranscriptSheet"),
  transcriptBackdrop: document.querySelector("#ccTranscriptBackdrop"),
  transcriptClose: document.querySelector("#ccTranscriptClose"),
  transcriptTitle: document.querySelector("#ccTranscriptTitle"),
  transcriptMeta: document.querySelector("#ccTranscriptMeta"),
  transcriptBody: document.querySelector("#ccTranscriptBody"),
  cardSearchSheet: document.querySelector("#ccCardSearchSheet"),
  cardSearchBackdrop: document.querySelector("#ccCardSearchBackdrop"),
  cardSearchClose: document.querySelector("#ccCardSearchClose"),
  cardSearchInput: document.querySelector("#ccCardSearchInput"),
  cardSearchResults: document.querySelector("#ccCardSearchResults"),
};

try {
  localStorage.removeItem("tmux-mobile-cc-prefs");
} catch {}

function loadJson(key, fallback = {}) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) || fallback : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function systemPrefersDark() {
  return !!(
    window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function themeIsDark(theme) {
  if (theme === "dark") return true;
  if (theme === "auto") return systemPrefersDark();
  return false;
}

function readTheme() {
  const theme = loadJson(THEME_KEY, { theme: "kami" }).theme;
  return THEME_OPTIONS.includes(theme) ? theme : "kami";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = themeIsDark(theme) ? "" : "kami";
  for (const button of els.themeButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.ccTheme === theme));
  }
}

function setTheme(theme) {
  const next = THEME_OPTIONS.includes(theme) ? theme : "kami";
  saveJson(THEME_KEY, { theme: next });
  applyTheme(next);
  window.dispatchEvent(new CustomEvent("tmux-mobile-theme-change", {
    detail: { theme: next },
  }));
}

function clampCommandCenterFont(px) {
  const value = Number(px);
  if (!Number.isFinite(value)) return CC_FONT_DEFAULT;
  return Math.max(CC_FONT_MIN, Math.min(CC_FONT_MAX, Math.round(value)));
}

function readCommandCenterFontSize() {
  return clampCommandCenterFont(loadJson(CC_FONT_KEY, { px: CC_FONT_DEFAULT }).px);
}

function commandCenterFontTargets() {
  const targets = [...document.querySelectorAll(".command-center-body")];
  targets.push(document.documentElement);
  return [...new Set(targets)];
}

function applyCommandCenterFontSize(px) {
  const clamped = clampCommandCenterFont(px);
  const values = {
    "--cc-card-title-size": `${clamped}px`,
    "--cc-chip-size": `${Math.max(8, clamped - 3.5)}px`,
    "--cc-machine-chip-size": `${Math.max(9, clamped - 2.5)}px`,
    "--cc-status-size": `${Math.max(8.5, clamped - 3)}px`,
    "--cc-cwd-size": `${Math.max(9, clamped - 2.5)}px`,
    "--cc-section-label-size": `${Math.max(8, clamped - 3.5)}px`,
    "--cc-section-text-size": `${Math.max(9.5, clamped - 1.5)}px`,
    "--cc-footer-size": `${Math.max(9, clamped - 2.5)}px`,
  };
  for (const target of commandCenterFontTargets()) {
    for (const [property, value] of Object.entries(values)) {
      target.style.setProperty(property, value);
    }
  }
  if (els.fontSizeValue) els.fontSizeValue.textContent = String(clamped);
  if (els.fontDecrease) els.fontDecrease.disabled = clamped <= CC_FONT_MIN;
  if (els.fontIncrease) els.fontIncrease.disabled = clamped >= CC_FONT_MAX;
}

function stepCommandCenterFontSize(delta) {
  const next = clampCommandCenterFont(readCommandCenterFontSize() + delta);
  saveJson(CC_FONT_KEY, { px: next });
  applyCommandCenterFontSize(next);
}

applyTheme(readTheme());
applyCommandCenterFontSize(readCommandCenterFontSize());

const state = {
  machines: [],
  agents: [],
  loading: false,
  loadGeneration: 0,
  serverRevision: "",
  machineLoads: new Map(),
  // Track which (windowId, section) cards the user expanded so a refresh
  // doesn't collapse what they were reading.
  expanded: new Set(),
  pollTimer: null,
  lastError: "",
  reconnectGrace: createCommandCenterGrace(),
  // Machine filter is in-memory only. Empty = "show all".
  sortBy: "recent",
  filterMachines: new Set(),
  cardSearchQuery: "",
  cardSearchIndex: 0,
  interactAgent: null,
  interactSending: false,
  deleteAgent: null,
  deleteBusy: false,
  deletingWindows: new Set(),
  sharingWindows: new Set(),
  updatingMachines: new Set(),
  startAgent: {
    machineId: "",
    kind: "codex",
    mux: "",
    cwd: "",
    loadingDirs: false,
    starting: false,
    generation: 0,
    directories: {
      cwd: "",
      parent: "",
      entries: [],
      error: "",
    },
  },
  selectedCardKey: "",
  // Agents backing the transcript sheet and the response-fullscreen overlay, so
  // a tapped file path in those views resolves to the right pane/machine.
  transcriptAgent: null,
  fullscreenAgent: null,
  interactVoice: {
    status: "idle",
    audioContext: null,
    analyser: null,
    sampleTimer: null,
    waveform: [],
    stream: null,
    mediaRecorder: null,
    chunks: [],
    cancelRequested: false,
    sendAfterTranscribe: false,
  },
  readingKey: "",
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function abbrevHome(value) {
  return String(value || "")
    .replace(/^\/(?:Users|home)\/[^/]+/, "~")
    .replace(/^\/root(?=\/|$)/, "~");
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function parseDateMs(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : 0;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function exactTimeLabel(value) {
  const ms = parseDateMs(value);
  if (!ms) return "";
  const date = new Date(ms);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (sameDay(date, now)) return `Today ${time}`;
  return `${date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  })} ${time}`;
}

function relativeTimeLabel(value) {
  const ms = parseDateMs(value);
  if (!ms) return "";
  const diffMs = Date.now() - ms;
  const future = diffMs < 0;
  const seconds = Math.max(0, Math.round(Math.abs(diffMs) / 1000));
  if (seconds < 45) return future ? "soon" : "now";
  const units = [
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
  ];
  for (const [label, size] of units) {
    if (seconds >= size) {
      const count = Math.floor(seconds / size);
      return future ? `in ${count}${label}` : `${count}${label} ago`;
    }
  }
  return future ? "in 1m" : "1m ago";
}

function setStatus(text) {
  els.status.textContent = text;
}

function isLocalMachineId(machineId) {
  return !machineId || machineId === "local";
}

function machineKey(machine) {
  return String(machine?.id || machine?.machineId || machine?.hostname || "local");
}

function agentMachineKey(agent) {
  return String(agent?.machineId || agent?.machineRawId || agent?.machineHostname || "local");
}

function machineLabel(machine) {
  return String(machine?.hostname || machine?.machineId || machine?.id || "local");
}

function normalizedAgentKind(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "codex") return "codex";
  if (text === "claude" || text === "claude-code" || text === "claude code" || text === "cc") {
    return "claude";
  }
  return "";
}

function agentKindLabel(kind) {
  return AGENT_LABELS[kind] || kind || "Agent";
}

function agentLogo(kind, className = "") {
  const normalized = normalizedAgentKind(kind);
  const icon = AGENT_ICONS[normalized];
  if (!icon) return "";
  const label = agentKindLabel(normalized);
  const classes = `cc-agent-logo cc-agent-logo-${normalized}${className ? ` ${className}` : ""}`;
  return `<span class="${classes}" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${icon}</span>`;
}

function agentKindChip(kind) {
  const normalized = normalizedAgentKind(kind);
  if (!normalized) return kind ? `<span class="cc-kind-chip">${escapeHtml(kind)}</span>` : "";
  return `<span class="cc-kind-chip cc-kind-chip-logo cc-kind-chip-${escapeHtml(normalized)}">${agentLogo(normalized)}</span>`;
}

function muxLabel(value) {
  const mux = String(value || "tmux").trim().toLowerCase();
  return mux === "rmux" ? "RMUX" : "TMUX";
}

function agentMux(agent) {
  const mux = String(agent?.mux || agent?.machineMux || "").trim().toLowerCase();
  return mux === "rmux" || mux === "tmux" ? mux : "";
}

function agentMuxChip(agent) {
  const mux = muxLabel(agentMux(agent) || agent.machineMux);
  const version = agent.muxVersion || agent.machineMuxVersion || "";
  const command =
    agent.muxCommand || agent.machineMuxCommand || agent.machineMux || mux.toLowerCase();
  const title = [command, version].filter(Boolean).join(" · ");
  return `<span class="cc-mux-chip cc-mux-chip-${escapeHtml(mux.toLowerCase())}" title="${escapeHtml(title)}">${escapeHtml(mux)}</span>`;
}

function agentWindowName(agent) {
  // Always plain text. The executor is already shown once by the kind chip
  // (agentKindChip); rendering a default window name ("codex"/"claude") as a
  // logo here produced a second, duplicate executor logo — keep just the chip.
  const name = String(agent?.windowName || "(unnamed)");
  return {
    html: escapeHtml(name),
    logo: false,
  };
}

function machineInventoryStatus(machine) {
  return String(machine?.inventoryStatus || "");
}

function shouldPreserveEmptyInventory(machine) {
  const status = machineInventoryStatus(machine);
  return status === "pending" || status === "failed" || status === "stale";
}

function loadStatusForMachine(machine) {
  const status = machineInventoryStatus(machine);
  if (status === "pending") return "loading";
  if (status === "failed") return "error";
  if (status === "stale") return "reconnecting";
  return "loaded";
}

function compareMachineLabel(aLabel, aKey, bLabel, bKey) {
  const labelOrder = String(aLabel || "").localeCompare(String(bLabel || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (labelOrder !== 0) return labelOrder;
  return String(aKey || "").localeCompare(String(bKey || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function compareMachines(a, b) {
  return compareMachineLabel(machineLabel(a), machineKey(a), machineLabel(b), machineKey(b));
}

function inferHomeDirectory(value) {
  const dir = String(value || "").trim().replace(/\/+$/, "");
  if (!dir) return "";
  const unixHome = dir.match(/^(\/(?:Users|home)\/[^/]+)(?:\/|$)/);
  if (unixHome) return unixHome[1];
  if (dir === "/root" || dir.startsWith("/root/")) return "/root";
  return "";
}

function machineHomeDirectory(machine) {
  return (
    String(machine?.homeDir || "").trim() ||
    inferHomeDirectory(machine?.agentCwd) ||
    inferHomeDirectory(machine?.cwd)
  );
}

function startAgentMachines() {
  const machines = [];
  const seen = new Set();
  const addMachine = (machine) => {
    const id = machineKey(machine);
    if (!id || seen.has(id)) return;
    seen.add(id);
    machines.push(machine);
  };
  for (const machine of state.machines) addMachine(machine);
  if (machines.length === 0) {
    for (const agent of state.agents) {
      const id = agentMachineKey(agent);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      machines.push({
        id,
        machineId: id,
        hostname: agent.machineHostname || id,
        agentCwd: agent.cwd || "",
        mux: agent.machineMux || agent.mux || "",
        muxCommand: agent.machineMuxCommand || agent.muxCommand || "",
        muxVersion: agent.machineMuxVersion || agent.muxVersion || "",
        muxes: agent.machineMux || agent.mux
          ? [{ mux: agent.machineMux || agent.mux }]
          : [],
      });
    }
  }
  return machines;
}

function startAgentMachineChoices() {
  return startAgentMachines().slice().sort(compareMachines);
}

function findStartAgentMachine(machineId, machines = startAgentMachineChoices()) {
  const key = String(machineId || "");
  if (!key) return null;
  return machines.find((machine) => machineKey(machine) === key) || null;
}

function contextStartAgentMachine(machines = startAgentMachineChoices()) {
  if (state.filterMachines.size === 1) {
    const [machineId] = [...state.filterMachines];
    const filteredMachine = findStartAgentMachine(machineId, machines);
    if (filteredMachine) return filteredMachine;
  }
  const selectedAgent = selectedAgentFrom(filterAndSort(state.agents));
  return findStartAgentMachine(agentMachineKey(selectedAgent), machines);
}

async function api(path, options = {}) {
  const { machineId, mux, headers: inputHeaders, ...requestOptions } = options;
  const headers = { accept: "application/json", ...(inputHeaders || {}) };
  const hasBody =
    requestOptions.body !== undefined && requestOptions.body !== null;
  const isRawBody =
    typeof Blob !== "undefined" && requestOptions.body instanceof Blob;
  if (hasBody && !isRawBody && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  if (!isLocalMachineId(machineId)) headers["x-machine-id"] = machineId;
  if (mux) headers["x-mux"] = mux;

  const response = await fetch(path, {
    cache: "no-store",
    ...requestOptions,
    headers,
  });
  let json = {};
  try {
    json = await response.json();
  } catch {}
  if (!response.ok) {
    const error = new Error(json.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return json;
}

async function sendTextToAgent(agent, text) {
  if (!agent?.paneId) throw new Error("No target");
  const machineId = agentMachineKey(agent);
  return api("/api/send", {
    method: "POST",
    machineId,
    mux: agentMux(agent),
    body: JSON.stringify({ paneId: agent.paneId, text, enter: true }),
  });
}

async function sendKeyToAgent(agent, key) {
  if (!agent?.paneId) throw new Error("No target");
  const machineId = agentMachineKey(agent);
  return api("/api/key", {
    method: "POST",
    machineId,
    mux: agentMux(agent),
    body: JSON.stringify({ paneId: agent.paneId, key }),
  });
}

function logClientEvent(event, details = {}, machineId = "") {
  const headers = { "content-type": "application/json" };
  if (!isLocalMachineId(machineId)) headers["x-machine-id"] = machineId;
  fetch("/api/client-log", {
    method: "POST",
    headers,
    body: JSON.stringify({ event, details }),
  }).catch(() => {});
}

function loadSnippets() {
  try {
    const raw = localStorage.getItem(SNIPPETS_KEY);
    const data = raw ? JSON.parse(raw) : null;
    const items = Array.isArray(data?.items) ? data.items : DEFAULT_SNIPPETS;
    return items
      .map((item) => ({ text: String(item?.text || "") }))
      .filter((item) => item.text);
  } catch {
    return DEFAULT_SNIPPETS;
  }
}

function saveSnippets(items) {
  try {
    localStorage.setItem(SNIPPETS_KEY, JSON.stringify({ items }));
  } catch {}
}

function loadComposerHistory() {
  try {
    const raw = localStorage.getItem(COMPOSER_HISTORY_KEY);
    const data = raw ? JSON.parse(raw) : null;
    return Array.isArray(data?.items) ? data.items.map((item) => String(item || "")).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function saveComposerHistory(items) {
  try {
    localStorage.setItem(COMPOSER_HISTORY_KEY, JSON.stringify({ items }));
  } catch {}
}

function pushComposerHistory(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return;
  const items = loadComposerHistory().filter((item) => item !== trimmed);
  items.push(trimmed);
  if (items.length > COMPOSER_HISTORY_MAX) {
    items.splice(0, items.length - COMPOSER_HISTORY_MAX);
  }
  saveComposerHistory(items);
}

function interactGetText() {
  return els.interactInput?.innerText || "";
}

function interactSetText(text) {
  const value = String(text || "");
  els.interactInput.textContent = value;
  els.interactInput.classList.toggle("empty", value.trim().length === 0);
}

function interactClear() {
  interactSetText("");
}

function interactFocus() {
  requestAnimationFrame(() => els.interactInput?.focus());
}

function interactAppendText(text) {
  const add = String(text || "");
  if (!add) return;
  const current = interactGetText();
  const sep = current && !/\s$/.test(current) ? " " : "";
  interactSetText(current + sep + add);
  interactFocus();
}

async function uploadInteractFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const agent = state.interactAgent;
  if (!agent?.paneId) {
    setInteractStatus("No target");
    return;
  }

  if (els.interactAttachButton) els.interactAttachButton.disabled = true;
  setInteractStatus(files.length === 1 ? "Uploading..." : `Uploading ${files.length} files...`);
  try {
    for (const file of files) {
      const params = new URLSearchParams({
        paneId: agent.paneId,
        name: file.name || "upload",
      });
      const data = await api(`/api/upload?${params}`, {
        method: "POST",
        machineId: agentMachineKey(agent),
        mux: agentMux(agent),
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
      });
      if (data.path) interactAppendText(data.path);
    }
    setInteractStatus(files.length === 1 ? "File uploaded" : `${files.length} files uploaded`);
  } catch (error) {
    setInteractStatus(error.message || "Upload failed");
  } finally {
    if (els.interactAttachButton) els.interactAttachButton.disabled = false;
  }
}

function renderInteractSnippets() {
  if (!els.interactSnippetChips) return;
  els.interactSnippetChips.replaceChildren();
  const snippets = loadSnippets();
  if (snippets.length === 0) {
    const empty = document.createElement("span");
    empty.className = "snippet-empty";
    empty.textContent = "No snippets - tap list to add";
    els.interactSnippetChips.append(empty);
    return;
  }
  snippets.forEach((item, index) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "snippet-chip";
    chip.dataset.snippetIndex = String(index);
    chip.title = `Insert "${item.text}"`;
    chip.textContent = item.text;
    els.interactSnippetChips.append(chip);
  });
}

function insertInteractSnippet(index) {
  const item = loadSnippets()[index];
  if (!item) return;
  interactAppendText(item.text);
}

function renderSnippetList() {
  if (!els.snippetList) return;
  const snippets = loadSnippets();
  els.snippetList.replaceChildren();
  snippets.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "snippet-row";

    const insert = document.createElement("button");
    insert.type = "button";
    insert.className = "small-button submit snippet-row-insert";
    insert.textContent = "Insert";
    insert.title = `Insert "${item.text}" into the message box`;
    insert.addEventListener("click", () => {
      closeSnippetManager();
      interactAppendText(item.text);
    });

    const text = document.createElement("input");
    text.type = "text";
    text.name = "snippetText";
    text.className = "snippet-row-text";
    text.value = item.text;
    text.setAttribute("aria-label", "Snippet text");
    text.addEventListener("change", () => updateSnippet(index, { text: text.value }));

    const up = document.createElement("button");
    up.type = "button";
    up.className = "small-button snippet-row-move";
    up.textContent = "Up";
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
  const snippets = loadSnippets();
  if (!snippets[index]) return;
  snippets[index] = { ...snippets[index], ...patch };
  saveSnippets(snippets.filter((item) => String(item.text || "").trim()));
  renderInteractSnippets();
}

function removeSnippet(index) {
  const snippets = loadSnippets();
  snippets.splice(index, 1);
  saveSnippets(snippets);
  renderSnippetList();
  renderInteractSnippets();
}

function moveSnippet(index, delta) {
  const snippets = loadSnippets();
  const target = index + delta;
  if (target < 0 || target >= snippets.length) return;
  [snippets[index], snippets[target]] = [snippets[target], snippets[index]];
  saveSnippets(snippets);
  renderSnippetList();
  renderInteractSnippets();
}

function addSnippet() {
  const text = String(els.snippetNewText?.value || "").trim();
  if (!text) {
    els.snippetNewText?.focus();
    return;
  }
  saveSnippets([...loadSnippets(), { text }]);
  if (els.snippetNewText) els.snippetNewText.value = "";
  renderSnippetList();
  renderInteractSnippets();
  els.snippetNewText?.focus();
}

function renderHistoryList() {
  if (!els.historyList) return;
  els.historyList.replaceChildren();
  const items = loadComposerHistory().slice().reverse();
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "No recent messages yet.";
    els.historyList.append(empty);
    return;
  }
  for (const text of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-item";
    button.textContent = text;
    button.title = text;
    button.addEventListener("click", () => {
      closeSnippetManager();
      interactAppendText(text);
    });
    els.historyList.append(button);
  }
}

function openSnippetManager() {
  renderSnippetList();
  renderHistoryList();
  if (els.snippetSheet) els.snippetSheet.hidden = false;
}

function closeSnippetManager() {
  if (els.snippetSheet) els.snippetSheet.hidden = true;
  if (!els.interactSheet?.hidden) interactFocus();
}

function setInteractStatus(text) {
  els.interactStatus.textContent = text;
}

function interactAgentLabel(agent) {
  const machine = agent.machineHostname ? `${agent.machineHostname} · ` : "";
  const windowLabel = agent.windowName || "(unnamed)";
  const session = agent.sessionName ? ` · ${agent.sessionName}` : "";
  return `${machine}${windowLabel}${session}`;
}

function openInteract(agent) {
  if (state.interactSending) return;
  state.interactAgent = agent;
  state.interactSending = false;
  resetInteractVoice();
  els.interactTarget.textContent = interactAgentLabel(agent);
  els.interactSend.disabled = false;
  setInteractStatus("");
  renderInteractSnippets();
  interactClear();
  els.interactSheet.hidden = false;
  interactFocus();
}

function closeInteract() {
  if (state.interactSending || state.interactVoice.status === "transcribing") return;
  resetInteractVoice();
  state.interactAgent = null;
  if (els.snippetSheet) els.snippetSheet.hidden = true;
  els.interactSheet.hidden = true;
  setInteractStatus("");
  interactClear();
}

async function sendInteractText({ keepFocus = true } = {}) {
  if (state.interactSending) return;
  const agent = state.interactAgent;
  const text = interactGetText();
  if (!text.trim()) {
    interactFocus();
    return;
  }
  if (!agent?.paneId) {
    setInteractStatus("No target");
    return;
  }

  state.interactSending = true;
  setInteractVoiceStatus(state.interactVoice.status, "");
  setInteractStatus("Sending...");
  interactClear();
  if (keepFocus) interactFocus();
  else els.interactInput?.blur();
  pushComposerHistory(text);
  try {
    await sendTextToAgent(agent, text);
    setInteractStatus("Sent");
    window.setTimeout(loadAgents, 700);
  } catch (error) {
    interactSetText(text);
    setInteractStatus(`Send failed: ${error.message}`);
    interactFocus();
  } finally {
    state.interactSending = false;
    setInteractVoiceStatus(state.interactVoice.status, "");
  }
}

async function sendInteractKey(key) {
  const agent = state.interactAgent;
  if (!agent?.paneId) {
    setInteractStatus("No target");
    return;
  }
  try {
    await sendKeyToAgent(agent, key);
    setInteractStatus(`Sent ${key}`);
    interactFocus();
    window.setTimeout(loadAgents, 350);
  } catch (error) {
    setInteractStatus(`Key failed: ${error.message}`);
    interactFocus();
  }
}

function setDeleteStatus(text, error = false) {
  if (!els.deleteStatus) return;
  els.deleteStatus.textContent = text || "";
  els.deleteStatus.classList.toggle("is-error", Boolean(error));
}

function syncDeleteControls() {
  if (els.deleteCancel) els.deleteCancel.disabled = state.deleteBusy;
  if (els.deleteConfirm) {
    els.deleteConfirm.disabled = state.deleteBusy;
    els.deleteConfirm.textContent = state.deleteBusy ? "Deleting..." : "Delete window";
  }
}

function openDeleteWindowDialog(agent) {
  if (state.deleteBusy) return;
  state.deleteAgent = agent;
  setDeleteStatus("");
  syncDeleteControls();
  els.deleteTarget.textContent = interactAgentLabel(agent);
  els.deleteDialog.hidden = false;
  requestAnimationFrame(() => els.deleteCancel?.focus());
}

function closeDeleteWindowDialog() {
  if (state.deleteBusy) return;
  state.deleteAgent = null;
  els.deleteDialog.hidden = true;
  setDeleteStatus("");
}

async function confirmDeleteWindow() {
  if (state.deleteBusy) return;
  const agent = state.deleteAgent;
  if (!agent?.windowId) {
    setDeleteStatus("No mux window target", true);
    return;
  }

  const key = deleteKeyForAgent(agent);
  state.deleteBusy = true;
  state.deletingWindows.add(key);
  syncDeleteControls();
  setDeleteStatus("Deleting...");
  renderAgents();
  try {
    await api("/api/windows", {
      method: "DELETE",
      machineId: agentMachineKey(agent),
      mux: agentMux(agent),
      body: JSON.stringify({ windowId: agent.windowId }),
    });
    setStatus(`Deleted ${agent.windowIndex}: ${agent.windowName || "(unnamed)"}`);
    state.deleteAgent = null;
    els.deleteDialog.hidden = true;
    window.setTimeout(loadAgents, 250);
  } catch (error) {
    setDeleteStatus(`Delete failed: ${error.message}`, true);
  } finally {
    state.deleteBusy = false;
    state.deletingWindows.delete(key);
    syncDeleteControls();
    renderAgents();
  }
}

function setInteractVoiceStatus(status, text) {
  state.interactVoice.status = status;
  if (text) setInteractStatus(text);
  const listening = status === "recording";
  const busy = status === "transcribing";
  els.interactInputArea?.classList.toggle("listening", listening);
  els.interactInputArea?.classList.toggle("busy", busy);
  els.interactVoiceButton.disabled = status !== "idle" || state.interactSending;
  els.interactVoiceButton.classList.toggle("recording", listening);
  els.interactVoiceButton.classList.toggle("busy", busy);
  els.interactVoiceButton.title = status === "idle" ? "Dictate" : text || status;
  els.interactVoiceButton.setAttribute(
    "aria-label",
    status === "idle" ? "Dictate into the message box" : text || status,
  );
  els.interactSubmitVoice.disabled = !listening;
  els.interactCancelVoice.disabled = !listening;
  if (els.interactSend) {
    els.interactSend.disabled = state.interactSending || status !== "idle";
  }
}

function chooseInteractAudioMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/mpeg",
  ];
  if (!window.MediaRecorder?.isTypeSupported) return "";
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

const STATUS_LABELS = {
  waiting: "Needs input",
  running: "Working",
  idle: "Idle",
  unverified: "Unknown",
};
const STATUS_ORDER = ["waiting", "running", "unverified", "idle"];
const STATUS_PRIORITY = new Map(STATUS_ORDER.map((status, index) => [status, index]));

function statusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS.unverified;
}

function statusClass(status) {
  const normalized = STATUS_LABELS[status] ? status : "unverified";
  return normalized !== "idle" ? ` is-${normalized}` : "";
}

function machineChipStatus(machineId) {
  const key = String(machineId || "");
  let hasRunning = false;
  for (const agent of state.agents) {
    if (agentMachineKey(agent) !== key) continue;
    if (agent.status === "waiting") return "waiting";
    if (agent.status === "running") hasRunning = true;
  }
  return hasRunning ? "running" : "";
}

function machineChipStatusLabel(status) {
  if (status === "waiting") return STATUS_LABELS.waiting;
  if (status === "running") return STATUS_LABELS.running;
  return "";
}

function renderInteractVoiceWaveform() {
  if (!els.interactVoiceWaveform) return;
  if (els.interactVoiceWaveform.children.length !== INTERACT_WAVEFORM_SAMPLES) {
    els.interactVoiceWaveform.replaceChildren(
      ...Array.from({ length: INTERACT_WAVEFORM_SAMPLES }, () =>
        document.createElement("span"),
      ),
    );
  }
  const padded = [
    ...Array(Math.max(0, INTERACT_WAVEFORM_SAMPLES - state.interactVoice.waveform.length)).fill(0),
    ...state.interactVoice.waveform.slice(-INTERACT_WAVEFORM_SAMPLES),
  ];
  [...els.interactVoiceWaveform.children].forEach((bar, index) => {
    const level = padded[index] || 0;
    const pct = level > 0.02 ? 0.15 + level * 0.85 : 0.08;
    bar.style.height = `${Math.max(3, Math.round(pct * 28))}px`;
  });
}

function sampleInteractVoiceAmplitude() {
  const analyser = state.interactVoice.analyser;
  if (!analyser) return;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let index = 0; index < data.length; index += 1) {
    const value = (data[index] - 128) / 128;
    sum += value * value;
  }
  const amplitude = Math.min(1, Math.sqrt(sum / data.length) * 3);
  state.interactVoice.waveform = [...state.interactVoice.waveform, amplitude].slice(
    -INTERACT_WAVEFORM_SAMPLES,
  );
  renderInteractVoiceWaveform();
}

function stopInteractVoiceAnalysis({ clearWaveform = true } = {}) {
  if (state.interactVoice.sampleTimer) {
    window.clearInterval(state.interactVoice.sampleTimer);
    state.interactVoice.sampleTimer = null;
  }
  if (state.interactVoice.audioContext) {
    state.interactVoice.audioContext.close().catch(() => {});
    state.interactVoice.audioContext = null;
  }
  state.interactVoice.analyser = null;
  if (clearWaveform) {
    state.interactVoice.waveform = [];
    renderInteractVoiceWaveform();
  }
}

function startInteractVoiceAnalysis(stream) {
  stopInteractVoiceAnalysis({ clearWaveform: true });
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return;
  const audioContext = new AudioContextCtor();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  state.interactVoice.audioContext = audioContext;
  state.interactVoice.analyser = analyser;
  state.interactVoice.sampleTimer = window.setInterval(
    sampleInteractVoiceAmplitude,
    INTERACT_WAVEFORM_SAMPLE_INTERVAL_MS,
  );
  sampleInteractVoiceAmplitude();
}

function stopInteractVoiceStream() {
  if (state.interactVoice.stream) {
    for (const track of state.interactVoice.stream.getTracks()) track.stop();
  }
  state.interactVoice.stream = null;
}

function resetInteractVoice() {
  const recorder = state.interactVoice.mediaRecorder;
  if (recorder && recorder.state === "recording") {
    state.interactVoice.cancelRequested = true;
    recorder.stop();
    return;
  }
  stopInteractVoiceAnalysis({ clearWaveform: true });
  stopInteractVoiceStream();
  state.interactVoice.cancelRequested = false;
  state.interactVoice.mediaRecorder = null;
  state.interactVoice.chunks = [];
  state.interactVoice.sendAfterTranscribe = false;
  setInteractVoiceStatus("idle", "");
}

async function startInteractVoiceRecording() {
  if (!state.interactAgent?.paneId) {
    setInteractStatus("No target");
    return;
  }
  if (!window.isSecureContext) {
    setInteractStatus("Microphone needs HTTPS or localhost");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setInteractStatus("This browser does not support recording");
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
  startInteractVoiceAnalysis(stream);
  const mimeType = chooseInteractAudioMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  state.interactVoice.chunks = [];
  state.interactVoice.cancelRequested = false;
  state.interactVoice.stream = stream;
  state.interactVoice.mediaRecorder = recorder;

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data?.size > 0) state.interactVoice.chunks.push(event.data);
  });
  recorder.addEventListener("stop", () => {
    if (state.interactVoice.cancelRequested) {
      resetInteractVoice();
      setInteractStatus("Discarded");
      return;
    }
    finishInteractVoiceRecording().catch((error) => {
      resetInteractVoice();
      setInteractStatus(`Voice failed: ${error.message}`);
    });
  });

  recorder.start(1000);
  setInteractVoiceStatus("recording", "Listening");
}

function submitInteractVoiceRecording(options = {}) {
  const recorder = state.interactVoice.mediaRecorder;
  if (!recorder || recorder.state !== "recording") return;
  state.interactVoice.sendAfterTranscribe = Boolean(options?.sendAfterTranscribe);
  state.interactVoice.cancelRequested = false;
  stopInteractVoiceAnalysis({ clearWaveform: false });
  setInteractVoiceStatus("transcribing", "Transcribing...");
  recorder.stop();
}

function cancelInteractVoiceRecording() {
  const recorder = state.interactVoice.mediaRecorder;
  state.interactVoice.sendAfterTranscribe = false;
  state.interactVoice.cancelRequested = true;
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    return;
  }
  resetInteractVoice();
  setInteractStatus("Discarded");
}

async function finishInteractVoiceRecording() {
  const sendAfterTranscribe = state.interactVoice.sendAfterTranscribe;
  try {
    const mimeType = state.interactVoice.mediaRecorder?.mimeType || "audio/webm";
    stopInteractVoiceAnalysis({ clearWaveform: false });
    stopInteractVoiceStream();
    const blob = new Blob(state.interactVoice.chunks, { type: mimeType });
    state.interactVoice.chunks = [];
    state.interactVoice.cancelRequested = false;
    state.interactVoice.mediaRecorder = null;
    if (blob.size === 0) throw new Error("No audio captured");

    const machineId = agentMachineKey(state.interactAgent);
    const data = await api("/api/transcribe", {
      method: "POST",
      machineId,
      headers: { "content-type": mimeType || "audio/webm" },
      body: blob,
    });
    const text = String(data.text || "").trim();
    if (!text) throw new Error("No speech detected");
    interactAppendText(text);
    stopInteractVoiceAnalysis({ clearWaveform: true });
    setInteractVoiceStatus("idle", "Ready");
    if (sendAfterTranscribe) {
      await sendInteractText({ keepFocus: true });
    }
  } finally {
    state.interactVoice.sendAfterTranscribe = false;
  }
}

async function toggleInteractVoiceRecording() {
  if (state.interactVoice.status !== "idle") return;
  try {
    state.interactVoice.sendAfterTranscribe = false;
    await startInteractVoiceRecording();
  } catch (error) {
    resetInteractVoice();
    setInteractStatus(`Voice failed: ${error.message}`);
  }
}

function isNonInteractEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  if (els.interactInput?.contains(target)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function handleInteractVoiceShortcut(event) {
  if (event.defaultPrevented || event.isComposing || els.interactSheet?.hidden) return;
  const plainEnter =
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey;

  if (plainEnter && state.interactVoice.status === "recording") {
    event.preventDefault();
    event.stopPropagation();
    submitInteractVoiceRecording({ sendAfterTranscribe: true });
    return;
  }

  if (
    event.key === "," &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !isNonInteractEditableTarget(event.target)
  ) {
    event.preventDefault();
    event.stopPropagation();
    toggleInteractVoiceRecording();
  }
}

// Apply filters + sort to the current agent list. Pure function — call
// before renderAgents and feed it the result.
function filterAndSort(agents) {
  let out = agents;
  if (state.filterMachines.size > 0) {
    out = out.filter((a) => state.filterMachines.has(agentMachineKey(a)));
  }
  const cmp = sortComparator(state.sortBy);
  return [...out].sort(cmp);
}

function sortComparator(by) {
  switch (by) {
    case "machine":
      return (a, b) =>
        (a.machineHostname || a.machineId || "").localeCompare(
          b.machineHostname || b.machineId || "",
        ) || a.windowIndex - b.windowIndex;
    case "recent":
      return (a, b) => {
        // null/missing timestamps sort last
        const ta = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
        const tb = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
        return tb - ta;
      };
    case "name":
      return (a, b) => (a.windowName || "").localeCompare(b.windowName || "");
    case "status":
    default:
      // Actionable first, unknown before calm idle.
      return (a, b) => {
        if (a.status === b.status) return a.windowIndex - b.windowIndex;
        const pa = STATUS_PRIORITY.get(a.status) ?? STATUS_PRIORITY.get("unverified");
        const pb = STATUS_PRIORITY.get(b.status) ?? STATUS_PRIORITY.get("unverified");
        return pa - pb;
      };
  }
}

// Rebuild the machine chip row whenever the agent list changes (e.g. a new
// machine came online). Status is displayed on cards, not used as a filter.
function renderFilterRow() {
  const row = els.filterRow;
  const priorFocusedMachineKey = focusedMachineChipKey();
  row.innerHTML = "";
  // Agentless machines stay visible without adding separate machine cards to
  // the agent feed.
  const machines = new Map(); // id -> hostname
  for (const machine of state.machines) {
    const id = machineKey(machine);
    if (!id) continue;
    if (!machines.has(id)) machines.set(id, machineLabel(machine));
  }
  if (machines.size === 0) {
    for (const a of state.agents) {
      const id = agentMachineKey(a);
      if (!id) continue;
      if (!machines.has(id)) machines.set(id, a.machineHostname || id);
    }
  }
  if (machines.size > 0) {
    const sep = document.createElement("span");
    sep.className = "cc-filter-sep";
    row.append(sep);
    const sortedMachines = [...machines].sort(([aId, aLabel], [bId, bLabel]) =>
      compareMachineLabel(aLabel, aId, bLabel, bId),
    );
    for (const [id, hostname] of sortedMachines) {
      const active = state.filterMachines.has(id);
      row.append(chipButton({
        label: hostname,
        active,
        kind: "machine",
        value: id,
        status: machineChipStatus(id),
        onTap: () => toggleFilter("filterMachines", id, { focusMachineKey: id }),
      }));
    }
  }
  if (!els.startAgentSheet?.hidden) renderStartAgentMachineOptions();
  if (priorFocusedMachineKey) {
    requestAnimationFrame(() => focusMachineChip(priorFocusedMachineKey, { scroll: false }));
  }
}

function chipButton({ label, active, kind, value = "", status = "", onTap }) {
  const btn = document.createElement("button");
  btn.type = "button";
  const statusLabel_ = machineChipStatusLabel(status);
  btn.className = [
    "cc-filter-chip",
    `cc-filter-chip-${kind}`,
    active ? "is-active" : "",
    status ? `is-${status}` : "",
  ].filter(Boolean).join(" ");
  btn.title = statusLabel_ ? `${label} · ${statusLabel_}` : label;
  btn.setAttribute("aria-label", btn.title);
  btn.setAttribute("aria-pressed", String(active));
  if (value) btn.dataset.machineKey = value;
  if (status) {
    const statusIcon = document.createElement("span");
    statusIcon.className = `cc-filter-chip-status is-${status}`;
    statusIcon.setAttribute("aria-hidden", "true");
    btn.append(statusIcon);
  }
  const text = document.createElement("span");
  text.className = "cc-filter-chip-label";
  text.textContent = label;
  btn.append(text);
  btn.addEventListener("click", onTap);
  return btn;
}

function toggleFilter(setName, value, { focusMachineKey = "" } = {}) {
  const s = state[setName];
  if (s.has(value)) s.delete(value);
  else s.add(value);
  renderFilterRow();
  renderAgents();
  if (focusMachineKey) {
    requestAnimationFrame(() => focusMachineChip(focusMachineKey, { scroll: false }));
  }
}

function renderEmpty() {
  els.list.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "cc-empty";
  if (commandCenterGraceActive(state.reconnectGrace)) {
    empty.textContent = "Reconnecting to machines...";
  } else {
    empty.textContent = state.lastError
      ? `Couldn't load agents — ${state.lastError}`
      : "No machines online.";
  }
  els.list.append(empty);
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

function renderSectionContent(text, format) {
  // Markdown renders to HTML, then file paths in it are linkified (tag-safe, so
  // the markdown's own links/images are untouched) — otherwise a path inside a
  // rendered response wouldn't be tappable. Plain text gets the full linkifier.
  if (format === "markdown") return linkifyFilesEscaped(renderMarkdown(text));
  return linkifyEscaped(escapeHtml(text));
}

function scrollableSectionChildren(section) {
  if (!section) return [];
  return [...section.querySelectorAll("*")].filter(
    (node) =>
      node.scrollTop > 0 ||
      node.scrollLeft > 0 ||
      node.scrollHeight > node.clientHeight ||
      node.scrollWidth > node.clientWidth,
  );
}

function captureCommandCenterScroll() {
  const sections = new Map();
  for (const section of els.list.querySelectorAll(".cc-section-text[data-section-scroll-key]")) {
    const key = section.dataset.sectionScrollKey || "";
    if (!key) continue;
    sections.set(key, {
      top: section.scrollTop,
      left: section.scrollLeft,
      children: scrollableSectionChildren(section).map((node) => ({
        top: node.scrollTop,
        left: node.scrollLeft,
      })),
    });
  }
  return {
    listTop: els.list.scrollTop,
    listLeft: els.list.scrollLeft,
    sections,
  };
}

function restoreCommandCenterScroll(snapshot) {
  if (!snapshot) return;
  els.list.scrollTop = snapshot.listTop || 0;
  els.list.scrollLeft = snapshot.listLeft || 0;
  for (const section of els.list.querySelectorAll(".cc-section-text[data-section-scroll-key]")) {
    const saved = snapshot.sections.get(section.dataset.sectionScrollKey || "");
    if (!saved) continue;
    section.scrollTop = saved.top || 0;
    section.scrollLeft = saved.left || 0;
    const children = scrollableSectionChildren(section);
    for (const [index, node] of children.entries()) {
      const child = saved.children[index];
      if (!child) continue;
      node.scrollTop = child.top || 0;
      node.scrollLeft = child.left || 0;
    }
  }
}

function restoreCommandCenterScrollSoon(snapshot) {
  restoreCommandCenterScroll(snapshot);
  requestAnimationFrame(() => restoreCommandCenterScroll(snapshot));
}

function openResponseFullscreen({ label, text, timestamp, format, agent = null }) {
  if (!text || !els.responseFullscreen || !els.responseFullscreenBody) return;
  state.fullscreenAgent = agent || null;
  if (els.responseFullscreenTitle) els.responseFullscreenTitle.textContent = label;
  if (els.responseFullscreenMeta) {
    els.responseFullscreenMeta.textContent =
      exactTimeLabel(timestamp) || relativeTimeLabel(timestamp) || "";
  }
  els.responseFullscreenBody.className = "cc-section-text cc-response-fullscreen-body";
  if (format === "markdown") els.responseFullscreenBody.classList.add("is-markdown");
  els.responseFullscreenBody.innerHTML = renderSectionContent(text, format);
  els.responseFullscreen.hidden = false;
  requestAnimationFrame(() => els.responseFullscreenClose?.focus());
}

function closeResponseFullscreen() {
  if (!els.responseFullscreen) return;
  els.responseFullscreen.hidden = true;
  els.responseFullscreenBody?.replaceChildren();
  state.fullscreenAgent = null;
}

function transcriptKeyForAgent(agent) {
  return `${readKeyForAgent(agent)}::transcript`;
}

function setTranscriptEmpty(message) {
  if (!els.transcriptBody) return;
  const empty = document.createElement("div");
  empty.className = "cc-transcript-empty";
  empty.textContent = message;
  els.transcriptBody.replaceChildren(empty);
}

function renderTranscriptTurns(agent, turns) {
  if (!els.transcriptBody) return;
  const nodes = [];
  turns.forEach((turn, index) => {
    const role = turn?.role === "assistant" ? "assistant" : "user";
    const label = role === "assistant" ? "Agent response" : "User prompt";
    nodes.push(
      renderSection({
        className: role,
        label: `${label} ${index + 1}`,
        text: turn?.text || "",
        timestamp: turn?.t || null,
        expandedKey: `${transcriptKeyForAgent(agent)}::${index}`,
        format: role === "assistant" ? "markdown" : "plain",
        agent,
      }),
    );
  });
  els.transcriptBody.replaceChildren(...nodes);
  requestAnimationFrame(() => {
    if (els.transcriptBody) els.transcriptBody.scrollTop = els.transcriptBody.scrollHeight;
  });
}

async function openAgentTranscript(agent) {
  if (!agent?.paneId || !els.transcriptSheet) return;
  state.transcriptAgent = agent;
  if (els.transcriptTitle) els.transcriptTitle.textContent = "Transcript";
  if (els.transcriptMeta) els.transcriptMeta.textContent = "Loading transcript...";
  setTranscriptEmpty("Loading...");
  els.transcriptSheet.hidden = false;
  requestAnimationFrame(() => els.transcriptClose?.focus());
  try {
    const params = new URLSearchParams({ paneId: agent.paneId });
    const data = await api(`/api/agent-transcript?${params}`, {
      machineId: agentMachineKey(agent),
      mux: agentMux(agent),
    });
    const result = data.result;
    if (!result) {
      if (els.transcriptTitle) els.transcriptTitle.textContent = "Transcript · none";
      if (els.transcriptMeta) {
        els.transcriptMeta.textContent = "No Codex or Claude transcript detected.";
      }
      setTranscriptEmpty("Nothing to show.");
      return;
    }

    const turns = Array.isArray(result.turns) ? result.turns : [];
    if (els.transcriptTitle) {
      els.transcriptTitle.textContent = `Transcript · ${agentKindLabel(result.kind || agent.kind)}`;
    }
    if (els.transcriptMeta) {
      els.transcriptMeta.textContent = [
        agent.machineHostname || "",
        agent.sessionName || "",
        `${turns.length} turn${turns.length === 1 ? "" : "s"}`,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    if (turns.length === 0) {
      setTranscriptEmpty("Transcript located but no user/assistant turns parsed yet.");
      return;
    }
    renderTranscriptTurns(agent, turns);
  } catch (error) {
    if (els.transcriptTitle) els.transcriptTitle.textContent = "Transcript · error";
    if (els.transcriptMeta) els.transcriptMeta.textContent = error.message || String(error);
    setTranscriptEmpty("Failed to load.");
  }
}

function closeAgentTranscript() {
  if (!els.transcriptSheet) return;
  els.transcriptSheet.hidden = true;
  els.transcriptBody?.replaceChildren();
  state.transcriptAgent = null;
}

function renderSection({ className, label, text, timestamp, expandedKey, format = "plain", fullscreen = false, agent = null }) {
  const wrap = document.createElement("div");
  wrap.className = `cc-section ${className}`;
  if (state.expanded.has(expandedKey)) wrap.classList.add("is-expanded");

  const heading = document.createElement("div");
  heading.className = "cc-section-heading";

  const title = document.createElement("div");
  title.className = "cc-section-title";

  const labelEl = document.createElement("span");
  labelEl.className = "cc-section-label";
  labelEl.textContent = label;

  const relative = relativeTimeLabel(timestamp);
  if (relative) {
    const timeEl = document.createElement("time");
    timeEl.className = "cc-section-time";
    timeEl.dateTime = new Date(parseDateMs(timestamp)).toISOString();
    timeEl.title = exactTimeLabel(timestamp);
    timeEl.textContent = relative;
    title.append(labelEl, timeEl);
  } else {
    title.append(labelEl);
  }

  const actions = document.createElement("div");
  actions.className = "cc-section-actions";

  if (fullscreen) {
    const fullscreenButton = document.createElement("button");
    fullscreenButton.className = "cc-section-copy cc-section-fullscreen";
    fullscreenButton.type = "button";
    fullscreenButton.title = `Open ${label.toLowerCase()} fullscreen`;
    fullscreenButton.setAttribute("aria-label", `Open ${label.toLowerCase()} fullscreen`);
    fullscreenButton.innerHTML = ICONS.fullscreen;
    fullscreenButton.disabled = !text;
    fullscreenButton.addEventListener("click", () => {
      openResponseFullscreen({ label, text, timestamp, format, agent });
    });
    actions.append(fullscreenButton);
  }

  const copyButton = document.createElement("button");
  copyButton.className = "cc-section-copy";
  copyButton.type = "button";
  copyButton.title = `Copy ${label.toLowerCase()}`;
  copyButton.setAttribute("aria-label", `Copy ${label.toLowerCase()}`);
  copyButton.innerHTML = ICONS.copy;
  copyButton.disabled = !text;
  copyButton.addEventListener("click", async () => {
    if (!text) return;
    copyButton.disabled = true;
    try {
      await copyTextToClipboard(text);
      copyButton.classList.add("is-copied");
      copyButton.title = "Copied";
      copyButton.setAttribute("aria-label", "Copied");
      copyButton.innerHTML = ICONS.check;
      window.setTimeout(() => {
        copyButton.classList.remove("is-copied");
        copyButton.title = `Copy ${label.toLowerCase()}`;
        copyButton.setAttribute("aria-label", `Copy ${label.toLowerCase()}`);
        copyButton.innerHTML = ICONS.copy;
        copyButton.disabled = !text;
      }, 1200);
    } catch {
      copyButton.title = "Copy failed";
      window.setTimeout(() => {
        copyButton.title = `Copy ${label.toLowerCase()}`;
        copyButton.disabled = !text;
      }, 1200);
    }
  });
  actions.append(copyButton);
  heading.append(title, actions);

  const body = document.createElement("div");
  body.className = "cc-section-text";
  body.dataset.sectionScrollKey = expandedKey;
  if (format === "markdown") body.classList.add("is-markdown");
  if (!text) {
    body.classList.add("is-empty");
    body.textContent = "(nothing yet)";
  } else {
    body.innerHTML = renderSectionContent(text, format);
  }

  body.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("a, button, input, select, textarea")) return;
    if (state.expanded.has(expandedKey)) state.expanded.delete(expandedKey);
    else state.expanded.add(expandedKey);
    wrap.classList.toggle("is-expanded");
  });

  wrap.append(heading, body);
  return wrap;
}

function countAgentsByMachine(agents) {
  const counts = new Map();
  for (const agent of agents) {
    const key = agentMachineKey(agent);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function machinesFromAgents(agents) {
  const counts = countAgentsByMachine(agents);
  const machines = new Map();
  for (const agent of agents) {
    const id = agentMachineKey(agent);
    if (!machines.has(id)) {
      machines.set(id, {
        id,
        machineId: agent.machineRawId || id,
        hostname: agent.machineHostname || id,
        ownerId: agent.machineOwnerId || "",
        ownerEmail: agent.machineOwnerId || "",
        ownerHd: agent.machineOwnerHd || "",
        mux: agentMux(agent) || "tmux",
        muxCommand: agent.muxCommand || agent.machineMuxCommand || agent.machineMux || "tmux",
        muxVersion: agent.muxVersion || agent.machineMuxVersion || "",
        online: true,
        stale: false,
        missingOps: [],
        agentRevision: "",
        connectorVersion: "",
        expectedRevision: "",
        expectedConnectorVersion: "",
        connectorStatus: "",
        revisionStatus: "",
        agentCwd: "",
        nodePath: "",
      });
    }
  }
  return [...machines.values()].map((machine) => ({
    ...machine,
    agentCount: counts.get(machineKey(machine)) || 0,
  }));
}

function machineMuxes(machine) {
  const muxes = Array.isArray(machine?.muxes)
    ? machine.muxes
        .map((item) => String(item?.mux || item?.kind || "").trim().toLowerCase())
        .filter((mux) => mux === "tmux" || mux === "rmux")
    : [];
  const primary = String(machine?.mux || "").trim().toLowerCase();
  if ((primary === "tmux" || primary === "rmux") && !muxes.includes(primary)) {
    muxes.unshift(primary);
  }
  return [...new Set(muxes)];
}

function preferredStartMux(machine) {
  const muxes = machineMuxes(machine);
  if (muxes.includes("tmux")) return "tmux";
  if (muxes.includes("rmux")) return "rmux";
  return "";
}

function normalizeStartAgentMux(value) {
  const mux = String(value || "").trim().toLowerCase();
  return mux === "tmux" || mux === "rmux" ? mux : "";
}

function startAgentMuxes(machine) {
  if (!machine) return [];
  const muxes = machineMuxes(machine);
  return muxes.length > 0 ? muxes : ["tmux"];
}

function resolveStartAgentMux(machine, requestedMux = "") {
  const muxes = startAgentMuxes(machine);
  const requested = normalizeStartAgentMux(requestedMux);
  if (requested && muxes.includes(requested)) return requested;
  const preferred = preferredStartMux(machine);
  if (preferred && muxes.includes(preferred)) return preferred;
  if (muxes.includes("tmux")) return "tmux";
  if (muxes.includes("rmux")) return "rmux";
  return "";
}

function normalizeMachines(machines, agents) {
  const counts = countAgentsByMachine(agents);
  return machines.map((machine) => ({
    ...machine,
    agentCount:
      typeof machine.agentCount === "number"
        ? machine.agentCount
        : counts.get(machineKey(machine)) || 0,
  }));
}

function mergeMachineState(machines) {
  const previous = new Map(
    state.machines
      .map((machine) => [machineKey(machine), machine])
      .filter(([key]) => Boolean(key)),
  );
  const seen = new Set();
  const merged = [];
  for (const machine of machines) {
    const key = machineKey(machine);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...(previous.get(key) || {}), ...machine });
  }
  return merged;
}

function replaceMachine(nextMachine) {
  const key = machineKey(nextMachine);
  if (!key) return;
  let replaced = false;
  state.machines = state.machines.map((machine) => {
    if (machineKey(machine) !== key) return machine;
    replaced = true;
    return { ...machine, ...nextMachine };
  });
  if (!replaced) state.machines.push(nextMachine);
}

function replaceAgentsForMachine(machineId, agents) {
  const key = String(machineId || "");
  state.agents = [
    ...state.agents.filter((agent) => agentMachineKey(agent) !== key),
    ...agents,
  ];
  updateMachineAgentCounts();
}

function removeMachine(machineId) {
  const key = String(machineId || "");
  if (!key) return;
  state.machines = state.machines.filter((machine) => machineKey(machine) !== key);
  state.agents = state.agents.filter((agent) => agentMachineKey(agent) !== key);
}

function updateMachineAgentCounts() {
  const counts = countAgentsByMachine(state.agents);
  state.machines = state.machines.map((machine) => ({
    ...machine,
    agentCount: counts.get(machineKey(machine)) || 0,
  }));
}

function currentCommandCenterMachineKeys() {
  const keys = new Set();
  for (const machine of state.machines) {
    const key = machineKey(machine);
    if (key) keys.add(key);
  }
  for (const agent of state.agents) {
    const key = agentMachineKey(agent);
    if (key) keys.add(key);
  }
  return [...keys];
}

function hasCommandCenterSnapshot() {
  return state.machines.length > 0 || state.agents.length > 0;
}

function markReconnectLoads(machineKeys) {
  for (const key of machineKeys) {
    if (!key) continue;
    state.machineLoads.set(String(key), { status: "reconnecting", error: "" });
  }
}

function holdCommandCenterSnapshot(machineKeys = currentCommandCenterMachineKeys()) {
  if (!hasCommandCenterSnapshot()) return false;
  const held = holdCommandCenterGraceSnapshot(state.reconnectGrace, machineKeys);
  if (!held) return false;
  markReconnectLoads(commandCenterGraceMachineKeys(state.reconnectGrace));
  state.lastError = "";
  return true;
}

function clearCommandCenterReconnect(machineKeys = null) {
  clearCommandCenterGrace(state.reconnectGrace, machineKeys);
}

function machineLoadCounts() {
  const counts = { loading: 0, reconnecting: 0, error: 0 };
  for (const load of state.machineLoads.values()) {
    if (load?.status === "loading") counts.loading += 1;
    if (load?.status === "reconnecting") counts.reconnecting += 1;
    if (load?.status === "error") counts.error += 1;
  }
  return counts;
}

function updateCommandCenterStatus() {
  const loads = machineLoadCounts();
  const base = `${state.machines.length} machine${state.machines.length === 1 ? "" : "s"} · ${state.agents.length} agent${state.agents.length === 1 ? "" : "s"}`;
  if (commandCenterGraceActive(state.reconnectGrace)) {
    setStatus(`${base} · reconnecting`);
  } else if (loads.loading > 0) {
    setStatus(`${base} · loading`);
  } else if (loads.error > 0) {
    setStatus(`${base} · ${loads.error} inventory error${loads.error === 1 ? "" : "s"}`);
  } else {
    setStatus(`${base} · refreshed ${nowLabel()}`);
  }
}

function staleMachines() {
  return state.machines.filter((machine) => machine.stale);
}

function inventoryProblemMachines() {
  return state.machines.filter((machine) =>
    ["failed", "stale"].includes(machineInventoryStatus(machine)),
  );
}

function renderStaleMachine(machine) {
  const wrap = document.createElement("div");
  wrap.className = "cc-machine-alert";
  const key = machineKey(machine);
  const updating = state.updatingMachines.has(key);
  const host = machineLabel(machine);
  const expected = machine.expectedConnectorVersion || "current";
  const current = machine.connectorVersion || "unknown";
  const connectorStatus = machine.connectorStatus || machine.revisionStatus || "";
  const parts = [];
  if (connectorStatus === "outdated") {
    parts.push(`connector version ${current}, expected ${expected}`);
  } else if (connectorStatus === "missing") {
    parts.push("no connector version reported");
  }
  if (machine.missingOps?.length) {
    parts.push(`missing ops: ${machine.missingOps.join(", ")}`);
  }
  const detail = parts.length ? parts.join(" · ") : "connector is out of date";
  wrap.innerHTML = `
    <div class="cc-machine-alert-main">
      <strong>${escapeHtml(host)} needs connector update</strong>
      <span>${escapeHtml(detail)}</span>
      <code>${escapeHtml(machine.agentRevision || "unknown revision")}</code>
    </div>
    <button class="small-button cc-machine-alert-copy" type="button" data-update-machine="${escapeHtml(key)}"${updating ? " disabled" : ""}>${updating ? "Starting..." : "Update connector"}</button>
  `;
  return wrap;
}

function renderInventoryMachine(machine) {
  const wrap = document.createElement("div");
  wrap.className = "cc-machine-alert cc-machine-alert-inventory";
  const host = machineLabel(machine);
  const status = machineInventoryStatus(machine);
  const observed = relativeTimeLabel(machine.inventoryObservedAt);
  const source = machine.inventorySource || "inventory";
  const detail = status === "failed"
    ? machine.inventoryError || "last inventory scan failed"
    : observed
      ? `last inventory ${observed}`
      : "waiting for first inventory snapshot";
  wrap.innerHTML = `
    <div class="cc-machine-alert-main">
      <strong>${escapeHtml(host)} inventory ${escapeHtml(status)}</strong>
      <span>${escapeHtml(detail)}</span>
      <code>${escapeHtml(source)}</code>
    </div>
  `;
  return wrap;
}

async function updateConnector(machine) {
  const key = machineKey(machine);
  if (!key || state.updatingMachines.has(key)) return;
  state.updatingMachines.add(key);
  setStatus(`Starting connector update on ${machineLabel(machine)}.`);
  renderAgents();
  try {
    const result = await api("/api/connector-update", {
      method: "POST",
      machineId: key,
      body: JSON.stringify({
        repoDir: machine.agentCwd || "~/src/tmux-mobile",
        expectedRevision: machine.expectedRevision || "",
        targetRef: machine.updateRef || "",
        updateScriptUrl: machine.updateScriptUrl || "",
        nodePath: machine.nodePath || "node",
        agentMachine: machine.machineAlias || machine.hostname || machine.machineId || "",
        machineLabel: machineLabel(machine),
        mux: machine.mux || "",
        muxes: "tmux,rmux",
      }),
    });
    setStatus(
      `Update started on ${machineLabel(machine)}; the mux update session closes on success.`,
    );
  } catch (error) {
    setStatus(`Update failed to start on ${machineLabel(machine)}: ${error.message}`);
  } finally {
    state.updatingMachines.delete(key);
    renderAgents();
  }
}

function defaultStartAgentDirectory(machine) {
  return machineHomeDirectory(machine) || "/";
}

function setStartAgentStatus(text, { error = false } = {}) {
  if (!els.startAgentStatus) return;
  els.startAgentStatus.textContent = text || "";
  els.startAgentStatus.classList.toggle("is-error", Boolean(error));
}

function setStartAgentKind(kind) {
  const next = kind === "claude" ? "claude" : "codex";
  state.startAgent.kind = next;
  for (const button of els.startAgentKindButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.startAgentKind === next));
  }
}

function setStartAgentMux(mux) {
  const machine = selectedStartAgentMachine();
  state.startAgent.mux = resolveStartAgentMux(machine, mux);
  syncStartAgentControls();
}

function selectedStartAgentMachine({ preferContext = false } = {}) {
  const machines = startAgentMachineChoices();
  if (machines.length === 0) return null;
  if (preferContext) {
    const contextMachine = contextStartAgentMachine(machines);
    if (contextMachine) return contextMachine;
  }
  const selectedId = els.startAgentMachine?.value || state.startAgent.machineId;
  const current = machines.find((machine) => machineKey(machine) === selectedId);
  return current || contextStartAgentMachine(machines) || machines[0];
}

function renderStartAgentMachineOptions() {
  if (!els.startAgentMachine) return;
  const machines = startAgentMachineChoices();
  const selected = selectedStartAgentMachine();
  state.startAgent.machineId = selected ? machineKey(selected) : "";
  els.startAgentMachine.replaceChildren(
    ...machines.map((machine) => {
      const option = document.createElement("option");
      option.value = machineKey(machine);
      option.textContent = machineLabel(machine);
      return option;
    }),
  );
  els.startAgentMachine.value = state.startAgent.machineId;
}

function syncStartAgentControls() {
  const busy = state.startAgent.starting;
  const machine = findStartAgentMachine(state.startAgent.machineId);
  const hasMachine = Boolean(machine);
  const selectedMux = resolveStartAgentMux(machine, state.startAgent.mux);
  state.startAgent.mux = selectedMux;
  if (els.startAgentMachine) {
    els.startAgentMachine.disabled = busy || startAgentMachineChoices().length === 0;
  }
  if (els.startAgentSessionName) els.startAgentSessionName.disabled = busy || !hasMachine;
  if (els.startAgentPath) els.startAgentPath.disabled = busy || !hasMachine;
  if (els.startAgentLoadDir) {
    els.startAgentLoadDir.disabled = busy || !hasMachine || state.startAgent.loadingDirs;
    els.startAgentLoadDir.textContent = state.startAgent.loadingDirs ? "Loading" : "Load";
  }
  for (const button of els.startAgentKindButtons) {
    button.disabled = busy || !hasMachine;
  }
  for (const button of els.startAgentMuxButtons) {
    const mux = normalizeStartAgentMux(button.dataset.startAgentMux);
    const available = Boolean(hasMachine && startAgentMuxes(machine).includes(mux));
    button.disabled = busy || !available;
    button.setAttribute("aria-pressed", String(available && mux === selectedMux));
    button.title = available ? `${muxLabel(mux)} runtime` : `${muxLabel(mux)} unavailable`;
  }
  if (els.startAgentSubmit) {
    els.startAgentSubmit.disabled = busy || !hasMachine || !selectedMux || state.startAgent.loadingDirs;
    els.startAgentSubmit.textContent = busy ? "Starting..." : "Start";
  }
}

function startDirectoryStatus(text) {
  const item = document.createElement("span");
  item.className = "directory-status";
  item.textContent = text;
  return item;
}

function startDirectoryButton(label, targetPath, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `directory-button ${className}`.trim();
  button.textContent = label;
  button.title = targetPath;
  button.dataset.startAgentCwd = targetPath;
  return button;
}

function renderStartAgentDirectories() {
  if (!els.startAgentDirectoryPath || !els.startAgentDirectoryList) return;
  const { cwd, parent, entries, error } = state.startAgent.directories;
  els.startAgentDirectoryPath.textContent =
    cwd || error || (state.startAgent.machineId ? "Directory unavailable" : "Select a machine");
  els.startAgentDirectoryList.replaceChildren();
  if (state.startAgent.loadingDirs && entries.length === 0) {
    els.startAgentDirectoryList.append(startDirectoryStatus("Loading directories..."));
    return;
  }
  if (error && entries.length === 0) {
    els.startAgentDirectoryList.append(startDirectoryStatus(error));
    return;
  }
  if (parent && parent !== cwd) {
    els.startAgentDirectoryList.append(startDirectoryButton("..", parent, "parent"));
  }
  const visibleEntries = entries.filter((entry) => !entry.hidden && !entry.name.startsWith("."));
  for (const entry of visibleEntries) {
    els.startAgentDirectoryList.append(startDirectoryButton(entry.name, entry.path));
  }
  if (visibleEntries.length === 0 && !(parent && parent !== cwd)) {
    els.startAgentDirectoryList.append(startDirectoryStatus("No child directories."));
  }
}

function renderStartAgentSheet() {
  renderStartAgentMachineOptions();
  setStartAgentKind(state.startAgent.kind);
  state.startAgent.mux = resolveStartAgentMux(
    findStartAgentMachine(state.startAgent.machineId),
    state.startAgent.mux,
  );
  if (els.startAgentPath && els.startAgentPath.value !== state.startAgent.cwd) {
    els.startAgentPath.value = state.startAgent.cwd;
  }
  renderStartAgentDirectories();
  syncStartAgentControls();
}

async function loadStartAgentDirectories({ path: targetPath } = {}) {
  const machine = selectedStartAgentMachine();
  const machineId = machine ? machineKey(machine) : "";
  const cwd = String(targetPath ?? els.startAgentPath?.value ?? state.startAgent.cwd).trim();
  if (!machineId) {
    setStartAgentStatus("Select a machine first.", { error: true });
    return;
  }
  state.startAgent.machineId = machineId;
  if (!cwd) {
    setStartAgentStatus("Enter a directory path.", { error: true });
    els.startAgentPath?.focus();
    return;
  }

  const generation = ++state.startAgent.generation;
  state.startAgent.cwd = cwd;
  state.startAgent.loadingDirs = true;
  state.startAgent.directories = {
    cwd,
    parent: "",
    entries: [],
    error: "",
  };
  setStartAgentStatus(`Loading ${abbrevHome(cwd)}...`);
  renderStartAgentSheet();
  try {
    const data = await api(`/api/directories?path=${encodeURIComponent(cwd)}`, {
      machineId,
    });
    if (generation !== state.startAgent.generation) return;
    state.startAgent.cwd = data.cwd || cwd;
    state.startAgent.directories = {
      cwd: data.cwd || cwd,
      parent: data.parent || "",
      entries: Array.isArray(data.entries) ? data.entries : [],
      error: "",
    };
    setStartAgentStatus("");
  } catch (error) {
    if (generation !== state.startAgent.generation) return;
    state.startAgent.directories = {
      cwd: "",
      parent: "",
      entries: [],
      error: error.message || "Directory unavailable",
    };
    setStartAgentStatus(error.message || "Directory unavailable", { error: true });
  } finally {
    if (generation === state.startAgent.generation) {
      state.startAgent.loadingDirs = false;
      renderStartAgentSheet();
    }
  }
}

function openStartAgent() {
  closeMoreMenu();
  const machine = selectedStartAgentMachine({ preferContext: true });
  state.startAgent.machineId = machine ? machineKey(machine) : "";
  state.startAgent.mux = resolveStartAgentMux(machine, state.startAgent.mux);
  state.startAgent.cwd = machine ? defaultStartAgentDirectory(machine) : "";
  state.startAgent.directories = {
    cwd: state.startAgent.cwd,
    parent: "",
    entries: [],
    error: machine ? "" : "No machines online.",
  };
  state.startAgent.loadingDirs = false;
  state.startAgent.starting = false;
  setStartAgentStatus(machine ? "" : "No machines online.", { error: !machine });
  if (els.startAgentSessionName) els.startAgentSessionName.value = "";
  if (els.startAgentSheet) els.startAgentSheet.hidden = false;
  renderStartAgentSheet();
  if (!machine) return;
  loadStartAgentDirectories({ path: state.startAgent.cwd }).catch((error) => {
    setStartAgentStatus(error.message || "Directory unavailable", { error: true });
  });
}

function closeStartAgent() {
  if (els.startAgentSheet) els.startAgentSheet.hidden = true;
  state.startAgent.starting = false;
  state.startAgent.loadingDirs = false;
  syncStartAgentControls();
}

function ensureStartedMachineVisible(machineId) {
  const key = String(machineId || "");
  if (!key || state.filterMachines.size === 0 || state.filterMachines.has(key)) return;
  state.filterMachines.add(key);
  renderFilterRow();
}

function handleStartAgentMachineChange() {
  state.startAgent.machineId = els.startAgentMachine?.value || "";
  const machine = selectedStartAgentMachine();
  if (!machine) {
    state.startAgent.machineId = "";
    state.startAgent.cwd = "";
    state.startAgent.directories = {
      cwd: "",
      parent: "",
      entries: [],
      error: "No machines online.",
    };
    state.startAgent.mux = "";
    setStartAgentStatus("No machines online.", { error: true });
    renderStartAgentSheet();
    return;
  }
  state.startAgent.machineId = machineKey(machine);
  state.startAgent.mux = resolveStartAgentMux(machine, state.startAgent.mux);
  state.startAgent.cwd = defaultStartAgentDirectory(machine);
  if (els.startAgentPath) els.startAgentPath.value = state.startAgent.cwd;
  loadStartAgentDirectories({ path: state.startAgent.cwd }).catch((error) => {
    setStartAgentStatus(error.message || "Directory unavailable", { error: true });
  });
}

async function submitStartAgent() {
  if (state.startAgent.starting) return;
  const machine = selectedStartAgentMachine();
  const machineId = machine ? machineKey(machine) : "";
  const cwd = String(els.startAgentPath?.value || state.startAgent.cwd || "").trim();
  if (!machineId || !machine) {
    setStartAgentStatus("Select a machine first.", { error: true });
    return;
  }
  state.startAgent.machineId = machineId;
  if (!cwd) {
    setStartAgentStatus("Enter a directory path.", { error: true });
    els.startAgentPath?.focus();
    return;
  }
  state.startAgent.starting = true;
  syncStartAgentControls();
  const mux = resolveStartAgentMux(machine, state.startAgent.mux);
  state.startAgent.mux = mux;
  if (!mux) {
    state.startAgent.starting = false;
    syncStartAgentControls();
    setStartAgentStatus("No runtime available on this machine.", { error: true });
    return;
  }
  setStartAgentStatus(`Starting ${state.startAgent.kind} in ${abbrevHome(cwd)} on ${muxLabel(mux)}...`);
  try {
    const result = await api("/api/agent-sessions", {
      method: "POST",
      machineId,
      body: JSON.stringify({
        kind: state.startAgent.kind,
        cwd,
        sessionName: els.startAgentSessionName?.value || "",
        mux,
      }),
    });
    closeStartAgent();
    const sessionName = result.session?.name || "new mux session";
    ensureStartedMachineVisible(machineId);
    setStatus(
      `Started ${result.kind} on ${machineLabel(machine)} in ${abbrevHome(cwd)} via ${muxLabel(result.mux || mux)} (${sessionName}).`,
    );
    window.setTimeout(() => loadAgents(), 900);
  } catch (error) {
    setStartAgentStatus(error.message || "Could not start agent.", { error: true });
  } finally {
    state.startAgent.starting = false;
    syncStartAgentControls();
  }
}

function readKeyForAgent(agent) {
  return `${agentMachineKey(agent)}::${agentMux(agent) || "tmux"}::${agent.windowId || agent.paneId || agent.agentSessionId || ""}`;
}

function selectedAgentFrom(agents = filterAndSort(state.agents)) {
  if (!state.selectedCardKey) return null;
  return agents.find((agent) => readKeyForAgent(agent) === state.selectedCardKey) || null;
}

function ensureSelectedCard(agents) {
  if (agents.length === 0) {
    state.selectedCardKey = "";
    return;
  }
  if (!selectedAgentFrom(agents)) {
    state.selectedCardKey = readKeyForAgent(agents[0]);
  }
}

function cardElements() {
  return [...els.list.querySelectorAll(".cc-card[data-card-key]")];
}

function cardElementByKey(key) {
  if (!key) return null;
  return cardElements().find((card) => card.dataset.cardKey === key) || null;
}

function machineChipElements() {
  return [...els.filterRow.querySelectorAll(".cc-filter-chip-machine[data-machine-key]")];
}

function machineChipElementByKey(key) {
  if (!key) return null;
  return machineChipElements().find((chip) => chip.dataset.machineKey === key) || null;
}

function focusedCardKey() {
  const active = document.activeElement instanceof Element ? document.activeElement : null;
  const card = active?.closest(".cc-card[data-card-key]");
  return card?.dataset.cardKey || "";
}

function focusedMachineChipKey() {
  const active = document.activeElement instanceof Element ? document.activeElement : null;
  const chip = active?.closest(".cc-filter-chip-machine[data-machine-key]");
  return chip?.dataset.machineKey || "";
}

function restoreFocusedCard(key) {
  const card = cardElementByKey(key);
  if (!card) return;
  card.focus({ preventScroll: true });
  card.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function focusMachineChip(key, { scroll = true } = {}) {
  const chip = machineChipElementByKey(key);
  if (!chip) return false;
  chip.focus({ preventScroll: true });
  if (scroll) chip.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

function focusSelectedCard({ scroll = true } = {}) {
  const card = cardElementByKey(state.selectedCardKey);
  if (!card) return false;
  card.focus({ preventScroll: true });
  if (scroll) card.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

function machineChipKeyForCardFocus() {
  const selectedAgent = selectedAgentFrom();
  const selectedMachine = selectedAgent ? agentMachineKey(selectedAgent) : "";
  if (selectedMachine && machineChipElementByKey(selectedMachine)) return selectedMachine;
  const active = machineChipElements().find((chip) => state.filterMachines.has(chip.dataset.machineKey));
  if (active) return active.dataset.machineKey || "";
  return machineChipElements()[0]?.dataset.machineKey || "";
}

function focusMachineChipsFromCards() {
  return focusMachineChip(machineChipKeyForCardFocus());
}

function updateSelectedCard(key, { scroll = false, focus = false } = {}) {
  if (!key) return;
  state.selectedCardKey = key;
  for (const card of cardElements()) {
    const selected = card.dataset.cardKey === key;
    card.classList.toggle("is-selected", selected);
    card.setAttribute("aria-selected", String(selected));
    card.tabIndex = selected ? 0 : -1;
    if (selected && focus) {
      card.focus({ preventScroll: true });
    }
    if (selected && scroll) {
      card.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
}

function syncSelectedCardDom({ scroll = false } = {}) {
  if (!state.selectedCardKey) return;
  updateSelectedCard(state.selectedCardKey, { scroll });
}

function cardColumnCount(cards) {
  if (cards.length <= 1) return 1;
  const firstTop = cards[0].offsetTop;
  const columns = cards.filter((card) => Math.abs(card.offsetTop - firstTop) <= 2).length;
  return Math.max(1, columns);
}

function moveSelectedCard(direction) {
  const cards = cardElements();
  if (cards.length === 0) {
    if (direction === "up") focusMachineChipsFromCards();
    return;
  }
  let index = cards.findIndex((card) => card.dataset.cardKey === state.selectedCardKey);
  if (index < 0) index = 0;
  const columns = cardColumnCount(cards);
  const deltas = {
    left: -1,
    right: 1,
    up: -columns,
    down: columns,
  };
  if (direction === "up" && index - columns < 0 && focusMachineChipsFromCards()) {
    return;
  }
  const nextIndex = Math.max(
    0,
    Math.min(cards.length - 1, index + (deltas[direction] || 0)),
  );
  updateSelectedCard(cards[nextIndex].dataset.cardKey, { scroll: true, focus: true });
}

function openSelectedAgent({ newTab = false } = {}) {
  const agent = selectedAgentFrom();
  if (!agent) return;
  const href = buildAgentAppUrl(agent);
  if (newTab) {
    window.open(href, "_blank", "noopener");
    return;
  }
  const selectedLink = els.list.querySelector(".cc-card.is-selected .cc-open-button");
  if (selectedLink) {
    selectedLink.click();
    return;
  }
  window.location.href = href;
}

function openSelectedResponseFullscreen() {
  const agent = selectedAgentFrom();
  if (!agent?.lastAssistantText) return false;
  openResponseFullscreen({
    label: "Last response",
    text: agent.lastAssistantText,
    timestamp: agent.lastAssistantAt,
    format: "markdown",
    agent,
  });
  return true;
}

function openSelectedTranscript() {
  const agent = selectedAgentFrom();
  if (!agent?.paneId) return false;
  openAgentTranscript(agent);
  return true;
}

function machineForAgent(agent) {
  const key = agentMachineKey(agent);
  return state.machines.find((machine) => machineKey(machine) === key) || null;
}

function cardSearchTitle(agent) {
  return agent.sessionName || agent.windowName || "(unnamed)";
}

function cardSearchMeta(agent) {
  const machine = machineForAgent(agent);
  const machineText = agent.machineHostname || (machine ? machineLabel(machine) : "") || agentMachineKey(agent);
  const windowText = agent.windowName || "(unnamed)";
  const kind = agent.kind || agent.agentType || "";
  return [machineText, windowText, kind].filter(Boolean).join(" · ");
}

function cardSearchTerms(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function cardSearchHaystack(agent) {
  const machine = machineForAgent(agent);
  return [
    agent.machineHostname,
    agent.machineId,
    agent.machineRawId,
    machine?.hostname,
    machine?.machineId,
    machine?.id,
    agent.sessionName,
    agent.windowName,
    agent.windowId,
    agent.paneId,
    agent.windowIndex,
    agent.kind,
    agent.agentType,
  ]
    .filter((item) => item !== undefined && item !== null)
    .join(" ")
    .toLowerCase();
}

function cardSearchMatches(agent, terms) {
  if (terms.length === 0) return true;
  const haystack = cardSearchHaystack(agent);
  return terms.every((term) => haystack.includes(term));
}

function cardSearchAgents() {
  const terms = cardSearchTerms(state.cardSearchQuery);
  return filterAndSort(state.agents).filter((agent) => cardSearchMatches(agent, terms));
}

function renderCardSearchResults() {
  if (!els.cardSearchResults) return;
  const agents = cardSearchAgents();
  state.cardSearchIndex = Math.max(
    0,
    Math.min(state.cardSearchIndex, Math.max(0, agents.length - 1)),
  );
  els.cardSearchResults.replaceChildren();
  if (agents.length === 0) {
    const empty = document.createElement("div");
    empty.className = "cc-card-search-empty";
    empty.textContent = "No matching cards.";
    els.cardSearchResults.append(empty);
    return;
  }
  for (const [index, agent] of agents.entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `cc-card-search-result${index === state.cardSearchIndex ? " is-active" : ""}`;
    button.dataset.cardSearchKey = readKeyForAgent(agent);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === state.cardSearchIndex));

    const title = document.createElement("span");
    title.className = "cc-card-search-result-title";
    title.textContent = cardSearchTitle(agent);

    const meta = document.createElement("span");
    meta.className = "cc-card-search-result-meta";
    meta.textContent = cardSearchMeta(agent);

    button.append(title, meta);
    button.addEventListener("click", () => selectCardSearchAgent(agent));
    els.cardSearchResults.append(button);
  }
  els.cardSearchResults
    .querySelector(".cc-card-search-result.is-active")
    ?.scrollIntoView({ block: "nearest" });
}

function openCardSearch() {
  if (!els.cardSearchSheet || !els.cardSearchInput) return;
  closeMoreMenu();
  state.cardSearchQuery = "";
  const agents = cardSearchAgents();
  const selectedIndex = agents.findIndex((agent) => readKeyForAgent(agent) === state.selectedCardKey);
  state.cardSearchIndex = selectedIndex >= 0 ? selectedIndex : 0;
  els.cardSearchInput.value = "";
  renderCardSearchResults();
  els.cardSearchSheet.hidden = false;
  requestAnimationFrame(() => {
    els.cardSearchInput?.focus();
    els.cardSearchInput?.select();
  });
}

function closeCardSearch() {
  if (!els.cardSearchSheet) return;
  els.cardSearchSheet.hidden = true;
  state.cardSearchQuery = "";
  state.cardSearchIndex = 0;
  if (els.cardSearchInput) els.cardSearchInput.value = "";
}

function selectCardSearchAgent(agent) {
  if (!agent) return;
  const key = readKeyForAgent(agent);
  closeCardSearch();
  requestAnimationFrame(() => updateSelectedCard(key, { scroll: true, focus: true }));
}

function selectCardSearchIndex(delta) {
  const agents = cardSearchAgents();
  if (agents.length === 0) return;
  state.cardSearchIndex = Math.max(
    0,
    Math.min(agents.length - 1, state.cardSearchIndex + delta),
  );
  renderCardSearchResults();
}

function submitCardSearch() {
  const agent = cardSearchAgents()[state.cardSearchIndex];
  if (agent) selectCardSearchAgent(agent);
}

function handleCardSearchShortcut(event) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.altKey ||
    event.shiftKey ||
    !(event.metaKey || event.ctrlKey) ||
    event.key.toLowerCase() !== "k" ||
    !els.interactSheet?.hidden ||
    !els.startAgentSheet?.hidden ||
    !els.deleteDialog?.hidden ||
    !els.responseFullscreen?.hidden ||
    !els.transcriptSheet?.hidden
  ) {
    return;
  }
  event.preventDefault();
  openCardSearch();
}

function handleMachineChipShortcuts(event) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  ) {
    return;
  }
  const target = event.target instanceof Element ? event.target : null;
  const current = target?.closest(".cc-filter-chip-machine[data-machine-key]");
  if (!current) return;

  const directions = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
    h: "left",
    l: "right",
    k: "up",
    j: "down",
  };
  const direction = directions[event.key] || directions[event.key.toLowerCase()];
  if (direction) {
    event.preventDefault();
    if (direction === "down") {
      focusSelectedCard();
      return;
    }
    if (direction === "up") return;
    const chips = machineChipElements();
    const index = chips.findIndex((chip) => chip === current);
    if (index < 0) return;
    const delta = direction === "left" ? -1 : 1;
    const nextIndex = Math.max(0, Math.min(chips.length - 1, index + delta));
    focusMachineChip(chips[nextIndex]?.dataset.machineKey || "");
    return;
  }

  if (event.key === " " || event.key === "Enter") {
    const key = current.dataset.machineKey || "";
    if (!key) return;
    event.preventDefault();
    toggleFilter("filterMachines", key, { focusMachineKey: key });
  }
}

function shortcutTargetIsEditable(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, button, a, summary, [contenteditable='true']"));
}

function handleCardShortcuts(event) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    shortcutTargetIsEditable(event.target) ||
    !els.interactSheet?.hidden ||
    !els.startAgentSheet?.hidden ||
    !els.deleteDialog?.hidden ||
    !els.responseFullscreen?.hidden ||
    !els.transcriptSheet?.hidden ||
    !els.cardSearchSheet?.hidden ||
    els.moreMenu?.open
  ) {
    return;
  }

  const directions = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
    h: "left",
    l: "right",
    k: "up",
    j: "down",
  };
  const direction = directions[event.key] || directions[event.key.toLowerCase()];
  if (direction) {
    event.preventDefault();
    moveSelectedCard(direction);
    return;
  }

  const key = event.key.toLowerCase();
  if (key === "r") {
    const agent = selectedAgentFrom();
    if (agent) {
      event.preventDefault();
      openInteract(agent);
    }
  } else if (key === "i") {
    const agent = selectedAgentFrom();
    if (agent) {
      event.preventDefault();
      readAgent(agent);
    }
  } else if (key === "s") {
    if (state.audio.busy) {
      event.preventDefault();
      stopRead();
    }
  } else if (key === "o") {
    event.preventDefault();
    openSelectedAgent({ newTab: true });
  } else if (key === "f") {
    if (openSelectedResponseFullscreen()) {
      event.preventDefault();
    }
  } else if (key === "t") {
    if (openSelectedTranscript()) {
      event.preventDefault();
    }
  }
}

function deleteKeyForAgent(agent) {
  return `${agentMachineKey(agent)}::${agentMux(agent) || "tmux"}::${agent.windowId || ""}`;
}

function shareKeyForAgent(agent) {
  return `${agentMachineKey(agent)}::${agentMux(agent) || "tmux"}::${agent.paneId || agent.windowId || ""}`;
}

function openRmuxShareUrl(url) {
  if (!url) return false;
  const opened = window.open(url, "_blank");
  if (opened) opened.opener = null;
  return Boolean(opened);
}

async function shareRmuxAgent(agent) {
  if (!agent?.paneId || agentMux(agent) !== "rmux") return;
  const key = shareKeyForAgent(agent);
  if (state.sharingWindows.has(key)) return;
  state.sharingWindows.add(key);
  setStatus("sharing RMUX terminal...");
  renderAgents();
  try {
    const data = await api("/api/rmux-web-share", {
      method: "POST",
      machineId: agentMachineKey(agent),
      mux: "rmux",
      body: JSON.stringify({ paneId: agent.paneId }),
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
    setStatus(copied ? "RMUX share ready. PIN copied." : "RMUX share ready.");
  } catch (error) {
    setStatus(`RMUX share failed: ${error.message}`);
  } finally {
    state.sharingWindows.delete(key);
    renderAgents();
  }
}

function cardActionButton({ className = "", title, dataAttrs, disabled = false, busy = false, icon }) {
  const classes = `cc-card-action ${className}${busy ? " is-busy" : ""}`.trim();
  return `<button class="${classes}" type="button" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"${busy ? ' aria-busy="true"' : ""}${disabled ? " disabled" : ""} ${dataAttrs}>${icon}</button>`;
}

function cardActionLink({ href, title, icon }) {
  return `<a class="cc-card-action cc-open-button" href="${escapeHtml(href)}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${icon}</a>`;
}

function isCurrentRead(readId) {
  return state.audio.readId === readId;
}

function stopRead() {
  if (!state.audio.busy) return;
  const machineId = state.readingKey.split("::")[0] || "";
  state.audio.stopRequested = true;
  state.audio.readId += 1;
  logClientEvent("realtime_read_stop_requested", {}, machineId);
  closeRealtimeReadAudio(state.audio);
  state.audio.busy = false;
  state.readingKey = "";
  setStatus("realtime: stopped");
  renderAgents();
}

async function readAgent(agent) {
  const key = readKeyForAgent(agent);
  if (state.audio.busy) {
    if (state.readingKey === key) {
      stopRead();
      return;
    }
    stopRead();
  }

  const readId = state.audio.readId + 1;
  const machineId = agentMachineKey(agent);
  state.audio.readId = readId;
  state.audio.stopRequested = false;
  state.audio.busy = true;
  state.readingKey = key;
  setStatus("Connecting Realtime audio stream.");
  renderAgents();

  try {
    const data = await playRealtimeRead({
      audioState: state.audio,
      api,
      readId,
      windowId: agent.windowId,
      paneId: agent.paneId,
      machineId,
      mux: agentMux(agent),
      logClientEvent: (event, details = {}) =>
        logClientEvent(event, details, machineId),
      setStatus,
      onPlaybackBlocked: (error) => setStatus(`realtime audio: ${error.message}`),
    });
    if (isCurrentRead(readId)) setStatus(`realtime: ${data.model}`);
  } catch (error) {
    if (
      !isCurrentRead(readId) ||
      state.audio.stopRequested ||
      error.name === "AbortError" ||
      error.message === "Realtime read stopped"
    ) {
      logClientEvent("realtime_read_stopped", {}, machineId);
      if (isCurrentRead(readId)) setStatus("realtime: stopped");
      return;
    }
    logClientEvent("realtime_read_failed", { message: error.message }, machineId);
    closeRealtimeReadAudio(state.audio);
    setStatus(`Read failed: ${error.message}`);
  } finally {
    if (isCurrentRead(readId)) {
      state.audio.stopRequested = false;
      state.audio.busy = false;
      state.readingKey = "";
      renderAgents();
    }
  }
}

function renderCard(agent) {
  const cardKey = readKeyForAgent(agent);
  const selected = state.selectedCardKey === cardKey;
  const card = document.createElement("article");
  card.className = `cc-card${statusClass(agent.status)}${selected ? " is-selected" : ""}`;
  card.dataset.cardKey = cardKey;
  card.tabIndex = selected ? 0 : -1;
  card.setAttribute("aria-selected", String(selected));

  const header = document.createElement("div");
  header.className = "cc-card-header";
  // In controller mode the controller tags each agent with the machine it
  // came from + the email of whoever registered it. Show both as a
  // leading chip pair so you can tell whose Mac the window lives on at a
  // glance. Local mode skips both (fields absent).
  const machineChip = agent.machineHostname
    ? `<span class="cc-machine-chip" title="${escapeHtml(agent.machineId || "")}">${escapeHtml(agent.machineHostname)}</span>`
    : "";
  // Strip @domain for visual compactness; full email lives in the title.
  const ownerLocal = (agent.machineOwnerId || "").replace(/@.*$/, "");
  const ownerChip = agent.machineOwnerId
    ? `<span class="cc-owner-chip" title="${escapeHtml(agent.machineOwnerId)}">${escapeHtml(ownerLocal)}</span>`
    : "";
  const windowName = agentWindowName(agent);
  const windowNameClass = `cc-card-window-name${windowName.logo ? " is-logo" : ""}`;
  const sessionTitle = agent.sessionName
    ? `<span class="cc-card-session-name">${escapeHtml(agent.sessionName || "")}</span><span class="cc-card-title-separator"> · </span>`
    : "";
  header.innerHTML = `
    <span class="cc-card-title">
      ${sessionTitle}
      <span class="${windowNameClass}">${windowName.html}</span>
    </span>
    ${machineChip}
    ${ownerChip}
    ${agentMuxChip(agent)}
    ${agentKindChip(agent.kind)}
    <span class="cc-status-pill${statusClass(agent.status)}">
      ${escapeHtml(statusLabel(agent.status))}
    </span>
  `;
  card.append(header);

  const cwd = document.createElement("div");
  cwd.className = "cc-card-cwd";
  cwd.textContent = abbrevHome(agent.cwd);
  card.append(cwd);

  card.append(
    renderSection({
      className: "user",
      label: "Last prompt",
      text: agent.lastUserText,
      timestamp: agent.lastUserAt,
      expandedKey: `${agentMachineKey(agent)}::${agentMux(agent) || "tmux"}::${agent.windowId}::user`,
      format: "plain",
      agent,
    }),
  );
  card.append(
    renderSection({
      className: "assistant",
      label: "Last response",
      text: agent.lastAssistantText,
      timestamp: agent.lastAssistantAt,
      expandedKey: `${agentMachineKey(agent)}::${agentMux(agent) || "tmux"}::${agent.windowId}::assistant`,
      format: "markdown",
      fullscreen: true,
      agent,
    }),
  );

  const footer = document.createElement("div");
  footer.className = "cc-card-footer";
  const readKey = readKeyForAgent(agent);
  const deleteKey = deleteKeyForAgent(agent);
  const transcriptKey = transcriptKeyForAgent(agent);
  const shareKey = shareKeyForAgent(agent);
  const readingThis = state.audio.busy && state.readingKey === readKey;
  const readDisabled = state.audio.busy && !readingThis;
  const deletingThis = state.deletingWindows.has(deleteKey);
  const sharingThis = state.sharingWindows.has(shareKey);
  footer.innerHTML = `
    <span>${agent.turnCount} turn${agent.turnCount === 1 ? "" : "s"} · session <code>${escapeHtml((agent.agentSessionId || "").slice(0, 8))}</code></span>
    <span class="cc-card-actions">
      ${cardActionButton({
        className: "cc-interact-button",
        title: "Interact (R)",
        dataAttrs: `data-interact-key="${escapeHtml(readKey)}"`,
        icon: ICONS.interact,
      })}
      ${cardActionButton({
        className: "cc-transcript-button",
        title: "Transcript",
        dataAttrs: `data-transcript-key="${escapeHtml(transcriptKey)}"`,
        disabled: !agent.paneId,
        icon: ICONS.transcript,
      })}
      ${agentMux(agent) === "rmux" ? cardActionButton({
        className: "cc-rmux-share-button",
        title: sharingThis ? "Sharing RMUX terminal" : "Share RMUX terminal",
        dataAttrs: `data-rmux-share-key="${escapeHtml(shareKey)}"`,
        disabled: sharingThis || !agent.paneId,
        busy: sharingThis,
        icon: ICONS.share,
      }) : ""}
      ${cardActionButton({
        className: `cc-read-button${readingThis ? " is-reading" : ""}`,
        title: readingThis ? "Stop reading" : "Read aloud (I)",
        dataAttrs: `data-read-key="${escapeHtml(readKey)}"`,
        disabled: readDisabled,
        icon: readingThis ? ICONS.stop : ICONS.read,
      })}
      ${cardActionLink({
        href: buildAgentAppUrl(agent),
        title: "Open in app",
        icon: ICONS.open,
      })}
      ${cardActionButton({
        className: "cc-delete-button",
        title: "Complete and delete mux window",
        dataAttrs: `data-delete-window-key="${escapeHtml(deleteKey)}"`,
        disabled: deletingThis || !agent.windowId,
        busy: deletingThis,
        icon: ICONS.delete,
      })}
    </span>
  `;
  card.append(footer);

  return card;
}

function renderAgents() {
  const priorFocusedCardKey = focusedCardKey();
  const scrollSnapshot = captureCommandCenterScroll();
  if (state.machines.length === 0 && state.agents.length === 0) {
    state.selectedCardKey = "";
    const loads = machineLoadCounts();
    if (loads.loading > 0) {
      els.list.innerHTML = "";
      const note = document.createElement("div");
      note.className = "cc-empty";
      note.textContent = `Loading agents from ${loads.loading} machine${loads.loading === 1 ? "" : "s"}…`;
      els.list.append(note);
      restoreCommandCenterScrollSoon(scrollSnapshot);
      return;
    }
    renderEmpty();
    return;
  }
  const filtered = filterAndSort(state.agents);
  if (
    priorFocusedCardKey &&
    filtered.some((agent) => readKeyForAgent(agent) === priorFocusedCardKey)
  ) {
    state.selectedCardKey = priorFocusedCardKey;
  }
  ensureSelectedCard(filtered);
  els.list.innerHTML = "";
  for (const machine of staleMachines()) {
    els.list.append(renderStaleMachine(machine));
  }
  for (const machine of inventoryProblemMachines()) {
    els.list.append(renderInventoryMachine(machine));
  }
  if (filtered.length === 0) {
    const note = document.createElement("div");
    note.className = "cc-empty";
    const loads = machineLoadCounts();
    if (state.agents.length === 0 && state.machines.length > 0 && loads.loading > 0) {
      note.textContent = `Loading agents from ${loads.loading} machine${loads.loading === 1 ? "" : "s"}…`;
    } else if (
      state.agents.length === 0 &&
      state.machines.length > 0 &&
      loads.reconnecting > 0
    ) {
      note.textContent = `Reconnecting to agents from ${loads.reconnecting} machine${loads.reconnecting === 1 ? "" : "s"}…`;
    } else if (state.agents.length === 0 && state.machines.length > 0 && loads.error > 0) {
      note.textContent = `Couldn't load agents from ${loads.error} machine${loads.error === 1 ? "" : "s"}.`;
    } else {
      note.textContent = state.agents.length === 0 && state.machines.length > 0
        ? `${state.machines.length} machine${state.machines.length === 1 ? "" : "s"} online, no Codex or Claude Code agents running right now.`
        : "No agents match the current filters.";
    }
    els.list.append(note);
    restoreCommandCenterScrollSoon(scrollSnapshot);
    return;
  }
  for (const agent of filtered) {
    els.list.append(renderCard(agent));
  }
  syncSelectedCardDom();
  if (priorFocusedCardKey) restoreFocusedCard(priorFocusedCardKey);
  if (!els.cardSearchSheet?.hidden) renderCardSearchResults();
  restoreCommandCenterScrollSoon(scrollSnapshot);
}

async function loadAgentsAggregate(generation) {
  const data = await api("/api/command-center");
  if (generation !== state.loadGeneration) return;
  const agents = Array.isArray(data.agents) ? data.agents : [];
  const machines = Array.isArray(data.machines)
    ? normalizeMachines(data.machines, agents)
    : machinesFromAgents(agents);
  if (machines.length === 0 && agents.length === 0 && holdCommandCenterSnapshot()) {
    updateCommandCenterStatus();
    renderFilterRow();
    renderAgents();
    return;
  }
  clearCommandCenterReconnect();
  state.machines = machines;
  state.agents = agents;
  state.machineLoads.clear();
  state.lastError = "";
  updateCommandCenterStatus();
  renderFilterRow();
  renderAgents();
}

async function loadMachineAgents(machine, generation) {
  const key = machineKey(machine);
  if (!key) return;
  try {
    const data = await api("/api/command-center", { machineId: key });
    if (generation !== state.loadGeneration) return;
    const machines = Array.isArray(data.machines) ? data.machines : [];
    const returnedMachine = machines[0];
    if (returnedMachine) replaceMachine(returnedMachine);
    const agents = Array.isArray(data.agents) ? data.agents : [];
    const preserveAgents =
      agents.length === 0 &&
      returnedMachine &&
      shouldPreserveEmptyInventory(returnedMachine) &&
      state.agents.some((agent) => agentMachineKey(agent) === key);
    if (preserveAgents) updateMachineAgentCounts();
    else replaceAgentsForMachine(key, agents);
    clearCommandCenterReconnect([key]);
    state.machineLoads.set(key, {
      status: returnedMachine ? loadStatusForMachine(returnedMachine) : "loaded",
      error: returnedMachine?.inventoryError || "",
    });
  } catch (error) {
    if (generation !== state.loadGeneration) return;
    const message = error.message || String(error);
    if (holdCommandCenterSnapshot([key])) {
      state.machineLoads.set(key, {
        status: "reconnecting",
        error: message,
      });
    } else {
      replaceAgentsForMachine(key, []);
      state.machineLoads.set(key, {
        status: "error",
        error: message,
      });
    }
  }
  updateCommandCenterStatus();
  renderFilterRow();
  renderAgents();
}

async function loadAgentsByMachine(machines, generation) {
  let normalizedMachines = normalizeMachines(machines, state.agents);
  if (normalizedMachines.length === 0 && holdCommandCenterSnapshot()) {
    updateCommandCenterStatus();
    renderFilterRow();
    renderAgents();
    return;
  }
  const nextKeys = new Set(normalizedMachines.map(machineKey).filter(Boolean));
  const missingGraceMachines = state.machines.filter((machine) => {
    const key = machineKey(machine);
    return key && !nextKeys.has(key);
  });
  const missingGraceKeys = missingGraceMachines.map(machineKey).filter(Boolean);
  const machinesToLoad = normalizedMachines;
  if (missingGraceKeys.length > 0 && holdCommandCenterSnapshot(missingGraceKeys)) {
    normalizedMachines = [...normalizedMachines, ...missingGraceMachines];
  }
  clearCommandCenterReconnect([...nextKeys]);
  const machineKeys = new Set(normalizedMachines.map(machineKey).filter(Boolean));
  state.machines = mergeMachineState(normalizedMachines);
  state.agents = state.agents.filter((agent) => machineKeys.has(agentMachineKey(agent)));
  state.machineLoads = new Map(
    normalizeMachines(machines, state.agents)
      .map((machine) => machineKey(machine))
      .filter(Boolean)
      .map((key) => [key, { status: "loading", error: "" }]),
  );
  markReconnectLoads(commandCenterGraceMachineKeys(state.reconnectGrace));
  state.lastError = "";
  updateMachineAgentCounts();
  updateCommandCenterStatus();
  renderFilterRow();
  renderAgents();

  await Promise.allSettled(
    machinesToLoad.map((machine) => loadMachineAgents(machine, generation)),
  );
  if (generation !== state.loadGeneration) return;
  updateMachineAgentCounts();
  updateCommandCenterStatus();
  renderFilterRow();
  renderAgents();
}

async function loadAgents() {
  if (state.loading) return;
  state.loading = true;
  const generation = ++state.loadGeneration;
  if (state.machines.length === 0 && state.agents.length === 0) setStatus("Loading machines…");
  try {
    await checkServerRevision();
    let machines;
    try {
      machines = await api("/api/machines");
    } catch (error) {
      if (error.status === 404 || error.status === 400) {
        await loadAgentsAggregate(generation);
        return;
      }
      throw error;
    }
    if (!Array.isArray(machines)) {
      await loadAgentsAggregate(generation);
      return;
    }
    await loadAgentsByMachine(machines, generation);
  } catch (error) {
    if (error.silent) return;
    if (generation !== state.loadGeneration) return;
    if (holdCommandCenterSnapshot()) {
      updateCommandCenterStatus();
      renderFilterRow();
      renderAgents();
      return;
    }
    state.lastError = error.message || String(error);
    setStatus(`Refresh failed at ${nowLabel()}`);
    if (state.machines.length === 0 && state.agents.length === 0) renderEmpty();
  } finally {
    if (generation === state.loadGeneration) {
      state.loading = false;
      if (!state.lastError) updateCommandCenterStatus();
    }
  }
}

async function checkServerRevision() {
  const runtime = await api("/api/runtime");
  const revision = runtime?.revision || "";
  if (revision && state.serverRevision && revision !== state.serverRevision) {
    window.location.reload();
    const error = new Error("Reloading after server update");
    error.silent = true;
    throw error;
  }
  state.serverRevision = revision || state.serverRevision;
}

function startPolling() {
  stopPolling();
  state.pollTimer = window.setInterval(loadAgents, POLL_MS);
}
function stopPolling() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

// Tapping a detected file path in a card opens the same artifact viewer the SPA
// pane view uses. Markdown renders as an HTML page (/api/file-view); images and
// standalone HTML get the overlay wrapper (/api/file-page); everything else is
// served raw (/api/file-raw). A new tab can't send the x-machine-id header, so
// the machine rides as a query param (the file routes accept either), scoped to
// the card's own agent/pane.
const MARKDOWN_FILE_EXT = /\.(md|markdown|mdown|mkd)$/i;
const OVERLAY_VIEWER_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|ico|html?)$/i;

function openFileViewer(agent, filePath) {
  if (!filePath || !agent?.paneId) return;
  const endpoint = MARKDOWN_FILE_EXT.test(filePath)
    ? "/api/file-view"
    : OVERLAY_VIEWER_EXT.test(filePath)
      ? "/api/file-page"
      : "/api/file-raw";
  const params = new URLSearchParams({ paneId: agent.paneId, path: filePath });
  const machineId = agentMachineKey(agent);
  if (!isLocalMachineId(machineId)) params.set("machineId", machineId);
  const mux = agentMux(agent);
  if (mux) params.set("mux", mux);
  const url = `${endpoint}?${params}`;
  const tab = window.open(url, "_blank", "noopener");
  if (!tab) {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.click();
  }
}

function agentForCardKey(key) {
  if (!key) return null;
  return state.agents.find((agent) => readKeyForAgent(agent) === key) || null;
}

// File paths are also linkified inside the transcript sheet and the
// response-fullscreen overlay; wire those to the viewer using the agent that
// opened each view (cards handle their own clicks in the list handler below).
function fileSpanClickHandler(getAgent) {
  return (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const span = target?.closest(".pane-file");
    if (!span) return;
    event.preventDefault();
    const agent = getAgent();
    if (agent) openFileViewer(agent, span.dataset.filePath);
  };
}
els.transcriptBody?.addEventListener("click", fileSpanClickHandler(() => state.transcriptAgent));
els.responseFullscreenBody?.addEventListener(
  "click",
  fileSpanClickHandler(() => state.fullscreenAgent),
);

els.refresh.addEventListener("click", () => loadAgents());
els.list.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const card = target.closest(".cc-card[data-card-key]");
  const interactive = target.closest(
    "button, a, select, input, textarea, summary, [contenteditable='true']",
  );
  if (card) updateSelectedCard(card.dataset.cardKey, { focus: !interactive });

  // A detected file path opens the artifact viewer, scoped to this card's agent.
  const fileSpan = target.closest(".pane-file");
  if (fileSpan && card) {
    event.preventDefault();
    const agent = agentForCardKey(card.dataset.cardKey);
    if (agent) openFileViewer(agent, fileSpan.dataset.filePath);
    return;
  }

  const updateButton = target.closest("[data-update-machine]");
  if (updateButton) {
    const machine = state.machines.find(
      (item) => machineKey(item) === updateButton.dataset.updateMachine,
    );
    if (machine) updateConnector(machine);
    return;
  }
  const interactButton = target.closest("[data-interact-key]");
  if (interactButton) {
    const agent = state.agents.find((item) => readKeyForAgent(item) === interactButton.dataset.interactKey);
    if (agent) openInteract(agent);
    return;
  }
  const transcriptButton = target.closest("[data-transcript-key]");
  if (transcriptButton) {
    const agent = state.agents.find(
      (item) => transcriptKeyForAgent(item) === transcriptButton.dataset.transcriptKey,
    );
    if (agent) openAgentTranscript(agent);
    return;
  }
  const shareButton = target.closest("[data-rmux-share-key]");
  if (shareButton) {
    const agent = state.agents.find(
      (item) => shareKeyForAgent(item) === shareButton.dataset.rmuxShareKey,
    );
    if (agent) shareRmuxAgent(agent);
    return;
  }
  const deleteButton = target.closest("[data-delete-window-key]");
  if (deleteButton) {
    const agent = state.agents.find((item) => deleteKeyForAgent(item) === deleteButton.dataset.deleteWindowKey);
    if (agent) openDeleteWindowDialog(agent);
    return;
  }
  const button = target.closest("[data-read-key]");
  if (!button) return;
  const agent = state.agents.find((item) => readKeyForAgent(item) === button.dataset.readKey);
  if (agent) readAgent(agent);
});
els.interactSend?.addEventListener("click", () =>
  sendInteractText({ keepFocus: false }),
);
if (els.interactAttachButton && els.interactFileInput) {
  els.interactAttachButton.addEventListener("click", () => els.interactFileInput.click());
  els.interactFileInput.addEventListener("change", async () => {
    const files = Array.from(els.interactFileInput.files || []);
    els.interactFileInput.value = "";
    await uploadInteractFiles(files);
  });
}
els.interactKeys?.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest("[data-interact-key]");
  if (!button) return;
  sendInteractKey(button.dataset.interactKey);
});
els.interactSnippetChips?.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const chip = target?.closest("[data-snippet-index]");
  if (!chip) return;
  insertInteractSnippet(Number(chip.dataset.snippetIndex));
});
els.interactManageSnippets?.addEventListener("click", openSnippetManager);
els.snippetClose?.addEventListener("click", closeSnippetManager);
els.snippetBackdrop?.addEventListener("click", closeSnippetManager);
els.snippetAdd?.addEventListener("click", addSnippet);
els.snippetNewText?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  addSnippet();
});
els.interactClose?.addEventListener("click", closeInteract);
els.interactBackdrop?.addEventListener("click", closeInteract);
els.interactVoiceButton?.addEventListener("click", toggleInteractVoiceRecording);
els.interactSubmitVoice?.addEventListener("click", submitInteractVoiceRecording);
els.interactCancelVoice?.addEventListener("click", cancelInteractVoiceRecording);
els.startAgentOpen?.addEventListener("click", () => openStartAgent());
els.startAgentBackdrop?.addEventListener("click", closeStartAgent);
els.startAgentClose?.addEventListener("click", closeStartAgent);
els.startAgentCancel?.addEventListener("click", closeStartAgent);
els.startAgentMachine?.addEventListener("change", handleStartAgentMachineChange);
els.startAgentLoadDir?.addEventListener("click", () =>
  loadStartAgentDirectories().catch((error) => {
    setStartAgentStatus(error.message || "Directory unavailable", { error: true });
  }),
);
els.startAgentSubmit?.addEventListener("click", submitStartAgent);
els.startAgentPath?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }
  event.preventDefault();
  loadStartAgentDirectories().catch((error) => {
    setStartAgentStatus(error.message || "Directory unavailable", { error: true });
  });
});
for (const button of els.startAgentKindButtons) {
  button.addEventListener("click", () => setStartAgentKind(button.dataset.startAgentKind));
}
for (const button of els.startAgentMuxButtons) {
  button.addEventListener("click", () => setStartAgentMux(button.dataset.startAgentMux));
}
els.startAgentDirectoryList?.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest("[data-start-agent-cwd]");
  if (!button) return;
  state.startAgent.cwd = button.dataset.startAgentCwd || "";
  if (els.startAgentPath) els.startAgentPath.value = state.startAgent.cwd;
  loadStartAgentDirectories({ path: state.startAgent.cwd }).catch((error) => {
    setStartAgentStatus(error.message || "Directory unavailable", { error: true });
  });
});
els.deleteCancel?.addEventListener("click", closeDeleteWindowDialog);
els.deleteConfirm?.addEventListener("click", confirmDeleteWindow);
els.responseFullscreenBackdrop?.addEventListener("click", closeResponseFullscreen);
els.responseFullscreenClose?.addEventListener("click", closeResponseFullscreen);
els.transcriptBackdrop?.addEventListener("click", closeAgentTranscript);
els.transcriptClose?.addEventListener("click", closeAgentTranscript);
els.cardSearchOpen?.addEventListener("click", openCardSearch);
els.cardSearchBackdrop?.addEventListener("click", closeCardSearch);
els.cardSearchClose?.addEventListener("click", closeCardSearch);
els.cardSearchInput?.addEventListener("input", () => {
  state.cardSearchQuery = els.cardSearchInput.value || "";
  state.cardSearchIndex = 0;
  renderCardSearchResults();
});
els.cardSearchInput?.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    selectCardSearchIndex(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    selectCardSearchIndex(-1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    submitCardSearch();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeCardSearch();
  }
});
els.interactInput?.addEventListener("input", () => {
  els.interactInput.classList.toggle("empty", interactGetText().trim().length === 0);
});
els.interactInput?.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (state.interactVoice.status === "recording") {
      submitInteractVoiceRecording({ sendAfterTranscribe: true });
      return;
    }
    sendInteractText();
  }
});
els.interactInput?.addEventListener("beforeinput", (event) => {
  const type = event.inputType;
  if (type !== "insertParagraph" && type !== "insertLineBreak") return;
  if (event.shiftKey) return;
  event.preventDefault();
  if (state.interactVoice.status === "recording") {
    submitInteractVoiceRecording({ sendAfterTranscribe: true });
    return;
  }
  sendInteractText();
});
document.addEventListener("keydown", handleInteractVoiceShortcut, true);
document.addEventListener("keydown", handleCardSearchShortcut, true);

// Welcome block: hidden if the user dismissed it previously, recoverable
// via the "?" topbar button. Stored as a plain string flag in localStorage
// so we don't have to expand the prefs schema.
function showWelcome(visible) {
  els.welcome.hidden = !visible;
}
function closeMoreMenu() {
  els.moreMenu?.removeAttribute("open");
}
const WELCOME_KEY = "cc-welcome-dismissed";
showWelcome(localStorage.getItem(WELCOME_KEY) !== "1");
els.welcomeClose.addEventListener("click", () => {
  localStorage.setItem(WELCOME_KEY, "1");
  showWelcome(false);
});
els.welcomeShow.addEventListener("click", () => {
  // "?" reopens the block AND clears the dismissal so it sticks.
  closeMoreMenu();
  localStorage.removeItem(WELCOME_KEY);
  showWelcome(true);
  els.welcome.scrollIntoView({ behavior: "smooth", block: "start" });
});
document.addEventListener("click", (event) => {
  if (!els.moreMenu?.open) return;
  if (event.target.closest("#ccMoreMenu")) return;
  closeMoreMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.responseFullscreen?.hidden) {
    closeResponseFullscreen();
    return;
  }
  if (event.key === "Escape" && !els.transcriptSheet?.hidden) {
    closeAgentTranscript();
    return;
  }
  if (event.key === "Escape" && !els.cardSearchSheet?.hidden) {
    closeCardSearch();
    return;
  }
  if (event.key === "Escape" && !els.deleteDialog?.hidden) {
    closeDeleteWindowDialog();
    return;
  }
  if (event.key === "Escape" && !els.startAgentSheet?.hidden) {
    closeStartAgent();
    return;
  }
  if (event.key === "Escape" && !els.snippetSheet?.hidden) {
    closeSnippetManager();
    return;
  }
  if (event.key === "Escape" && !els.interactSheet?.hidden) closeInteract();
});
document.addEventListener("keydown", handleCardShortcuts);
els.filterRow?.addEventListener("keydown", handleMachineChipShortcuts);

for (const button of els.themeButtons) {
  button.addEventListener("click", () => {
    setTheme(button.dataset.ccTheme);
  });
}
els.fontDecrease?.addEventListener("click", () => stepCommandCenterFontSize(-1));
els.fontIncrease?.addEventListener("click", () => stepCommandCenterFontSize(+1));
window.addEventListener("tmux-mobile-theme-change", (event) => {
  const theme = event.detail?.theme;
  if (THEME_OPTIONS.includes(theme)) applyTheme(theme);
});
const themeMediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
themeMediaQuery?.addEventListener("change", () => {
  if (readTheme() === "auto") applyTheme("auto");
});

// Sort dropdown is intentionally in-memory only.
els.sortSelect.value = state.sortBy;
els.sortSelect.addEventListener("change", () => {
  state.sortBy = els.sortSelect.value;
  renderAgents();
});

// Pause polling when the tab is backgrounded — every poll fires N
// processTree + lsof calls on the host, no reason to keep doing that
// while the user can't see the result.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPolling();
  else { loadAgents(); startPolling(); }
});

loadAgents();
startPolling();

// SPA router hook. The Command Center's setInterval keeps ticking while
// hidden, but the displayed cards are at most POLL_MS stale — and "at most
// one tick stale" is what shows up as "old data on return". Fire one fresh
// loadAgents the moment the view becomes active so cards are current the
// frame the user looks at them.
export function resumeView() {
  loadAgents();
}

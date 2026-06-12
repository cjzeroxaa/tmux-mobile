import { closeRealtimeReadAudio, playRealtimeRead } from "./realtime-read.js";

// Command Center — separate top-level page. Polls /api/command-center on
// a slow cadence, drops non-agent windows, renders one card per agent
// with the last user prompt + last assistant response taken verbatim from
// the agent's JSONL transcript. No tmux capture, no LLM summary.

const POLL_MS = 4000;
const INTERACT_WAVEFORM_SAMPLES = 40;
const INTERACT_WAVEFORM_SAMPLE_INTERVAL_MS = 200;
const SNIPPETS_KEY = "tmux-mobile-snippets";
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
  delete:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
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
  interactSend: document.querySelector("#ccInteractSend"),
  interactStatus: document.querySelector("#ccInteractStatus"),
  interactSnippetChips: document.querySelector("#ccInteractSnippetChips"),
  interactKeys: document.querySelector("#ccInteractKeys"),
  interactVoiceButton: document.querySelector("#ccInteractVoiceButton"),
  interactVoiceWaveform: document.querySelector("#ccInteractVoiceWaveform"),
  interactSubmitVoice: document.querySelector("#ccInteractSubmitVoice"),
  interactCancelVoice: document.querySelector("#ccInteractCancelVoice"),
  deleteDialog: document.querySelector("#ccDeleteDialog"),
  deleteTarget: document.querySelector("#ccDeleteTarget"),
  deleteStatus: document.querySelector("#ccDeleteStatus"),
  deleteCancel: document.querySelector("#ccDeleteCancel"),
  deleteConfirm: document.querySelector("#ccDeleteConfirm"),
};

// Persisted view prefs — sort + status/machine filters stay across reloads
// so a user's "only show working on mac-mini" lens is sticky.
function loadPrefs() {
  try {
    const raw = localStorage.getItem("tmux-mobile-cc-prefs");
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch { return {}; }
}
function savePrefs(prefs) {
  try {
    localStorage.setItem("tmux-mobile-cc-prefs", JSON.stringify(prefs));
  } catch {}
}
const SAVED = loadPrefs();

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

function applyCommandCenterFontSize(px) {
  const clamped = clampCommandCenterFont(px);
  const root = document.documentElement.style;
  root.setProperty("--cc-card-title-size", `${clamped}px`);
  root.setProperty("--cc-chip-size", `${Math.max(8, clamped - 3.5)}px`);
  root.setProperty("--cc-machine-chip-size", `${Math.max(9, clamped - 2.5)}px`);
  root.setProperty("--cc-status-size", `${Math.max(8.5, clamped - 3)}px`);
  root.setProperty("--cc-cwd-size", `${Math.max(9, clamped - 2.5)}px`);
  root.setProperty("--cc-section-label-size", `${Math.max(8, clamped - 3.5)}px`);
  root.setProperty("--cc-section-text-size", `${Math.max(9.5, clamped - 1.5)}px`);
  root.setProperty("--cc-footer-size", `${Math.max(9, clamped - 2.5)}px`);
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
  // Track which (windowId, section) cards the user expanded so a refresh
  // doesn't collapse what they were reading.
  expanded: new Set(),
  pollTimer: null,
  lastError: "",
  // Filter sets are Sets of allowed values. Empty = "show all" for that
  // category. Hydrated from localStorage on boot.
  // Default to newest-first: it's what the user usually asks the dashboard
  // anyway ('what changed most recently?'). Existing pref values still win
  // when present, so anyone who explicitly chose 'status' keeps it.
  sortBy: SAVED.sortBy || "recent",
  filterMachines: new Set(SAVED.filterMachines || []),
  filterStatuses: new Set(SAVED.filterStatuses || []),
  interactAgent: null,
  interactSending: false,
  deleteAgent: null,
  deleteBusy: false,
  deletingWindows: new Set(),
  updatingMachines: new Set(),
  selectedCardKey: "",
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

function mainAppHref({ machineId, sessionName, sessionId, windowIndex, windowName }) {
  // Main app reads its URL target via session + window query params (see
  // public/app.js readUrlTarget). machineId comes along too so controller
  // mode lands on the right machine without an extra round-trip.
  const params = new URLSearchParams({
    session: sessionName || sessionId,
    window: String(windowIndex),
  });
  if (machineId && !isLocalMachineId(machineId)) params.set("machineId", machineId);
  if (windowName) params.set("windowName", windowName);
  return `/app/?${params.toString()}`;
}

async function api(path, options = {}) {
  const { machineId, headers: inputHeaders, ...requestOptions } = options;
  const headers = { accept: "application/json", ...(inputHeaders || {}) };
  const hasBody =
    requestOptions.body !== undefined && requestOptions.body !== null;
  const isRawBody =
    typeof Blob !== "undefined" && requestOptions.body instanceof Blob;
  if (hasBody && !isRawBody && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  if (!isLocalMachineId(machineId)) headers["x-machine-id"] = machineId;

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
    body: JSON.stringify({ paneId: agent.paneId, text, enter: true }),
  });
}

async function sendKeyToAgent(agent, key) {
  if (!agent?.paneId) throw new Error("No target");
  const machineId = agentMachineKey(agent);
  return api("/api/key", {
    method: "POST",
    machineId,
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

function renderInteractSnippets() {
  if (!els.interactSnippetChips) return;
  els.interactSnippetChips.replaceChildren();
  const snippets = loadSnippets();
  if (snippets.length === 0) {
    const empty = document.createElement("span");
    empty.className = "snippet-empty";
    empty.textContent = "No snippets";
    els.interactSnippetChips.append(empty);
    return;
  }
  for (const item of snippets) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "snippet-chip";
    chip.textContent = item.text;
    chip.addEventListener("click", () => interactAppendText(item.text));
    els.interactSnippetChips.append(chip);
  }
}

function setInteractStatus(text) {
  els.interactStatus.textContent = text;
}

function interactAgentLabel(agent) {
  const machine = agent.machineHostname ? `${agent.machineHostname} · ` : "";
  const windowLabel = `${agent.windowIndex}: ${agent.windowName || "(unnamed)"}`;
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
    setDeleteStatus("No tmux window target", true);
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
  if (state.filterStatuses.size > 0) {
    out = out.filter((a) => state.filterStatuses.has(STATUS_LABELS[a.status] ? a.status : "unverified"));
  }
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

// Rebuild the chip row whenever the agent list changes (e.g. a new
// machine came online). Status chips are stable; machine chips come from
// the distinct machineIds seen in the payload.
function renderFilterRow() {
  const row = els.filterRow;
  row.innerHTML = "";
  // Status chips first.
  for (const s of STATUS_ORDER) {
    const label = statusLabel(s);
    const active = state.filterStatuses.has(s);
    row.append(chipButton({
      label,
      active,
      kind: "status",
      onTap: () => toggleFilter("filterStatuses", s),
    }));
  }
  // Then per-machine chips. This is where agentless machines stay visible
  // without adding separate machine cards to the agent feed.
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
    for (const [id, hostname] of machines) {
      const active = state.filterMachines.has(id);
      row.append(chipButton({
        label: hostname,
        active,
        kind: "machine",
        onTap: () => toggleFilter("filterMachines", id),
      }));
    }
  }
}

function chipButton({ label, active, kind, onTap }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `cc-filter-chip cc-filter-chip-${kind}${active ? " is-active" : ""}`;
  btn.textContent = label;
  btn.addEventListener("click", onTap);
  return btn;
}

function toggleFilter(setName, value) {
  const s = state[setName];
  if (s.has(value)) s.delete(value);
  else s.add(value);
  persistPrefs();
  renderFilterRow();
  renderAgents();
}

function persistPrefs() {
  savePrefs({
    sortBy: state.sortBy,
    filterStatuses: [...state.filterStatuses],
    filterMachines: [...state.filterMachines],
  });
}

function renderEmpty() {
  els.list.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "cc-empty";
  empty.textContent = state.lastError
    ? `Couldn't load agents — ${state.lastError}`
    : "No machines online.";
  els.list.append(empty);
}

function renderSection({ className, label, text, expandedKey }) {
  const wrap = document.createElement("div");
  wrap.className = `cc-section ${className}`;
  if (state.expanded.has(expandedKey)) wrap.classList.add("is-expanded");

  const labelEl = document.createElement("div");
  labelEl.className = "cc-section-label";
  labelEl.textContent = label;

  const body = document.createElement("div");
  body.className = "cc-section-text";
  if (!text) {
    body.classList.add("is-empty");
    body.textContent = "(nothing yet)";
  } else {
    body.textContent = text;
  }

  body.addEventListener("click", () => {
    if (state.expanded.has(expandedKey)) state.expanded.delete(expandedKey);
    else state.expanded.add(expandedKey);
    wrap.classList.toggle("is-expanded");
  });

  wrap.append(labelEl, body);
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

function staleMachines() {
  return state.machines.filter((machine) => machine.stale);
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
        nodePath: machine.nodePath || "node",
        agentMachine: machine.machineAlias || machine.hostname || machine.machineId || "",
        machineLabel: machineLabel(machine),
      }),
    });
    setStatus(
      `Update started on ${machineLabel(machine)} in ${result.sessionName || "tmux"}.`,
    );
  } catch (error) {
    setStatus(`Update failed to start on ${machineLabel(machine)}: ${error.message}`);
  } finally {
    state.updatingMachines.delete(key);
    renderAgents();
  }
}

function readKeyForAgent(agent) {
  return `${agentMachineKey(agent)}::${agent.paneId || agent.windowId || ""}`;
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

function updateSelectedCard(key, { scroll = false } = {}) {
  if (!key) return;
  state.selectedCardKey = key;
  for (const card of cardElements()) {
    const selected = card.dataset.cardKey === key;
    card.classList.toggle("is-selected", selected);
    card.setAttribute("aria-selected", String(selected));
    card.tabIndex = selected ? 0 : -1;
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
  if (cards.length === 0) return;
  let index = cards.findIndex((card) => card.dataset.cardKey === state.selectedCardKey);
  if (index < 0) index = 0;
  const columns = cardColumnCount(cards);
  const deltas = {
    left: -1,
    right: 1,
    up: -columns,
    down: columns,
  };
  const nextIndex = Math.max(
    0,
    Math.min(cards.length - 1, index + (deltas[direction] || 0)),
  );
  updateSelectedCard(cards[nextIndex].dataset.cardKey, { scroll: true });
}

function openSelectedAgent() {
  const agent = selectedAgentFrom();
  if (!agent) return;
  const selectedLink = els.list.querySelector(".cc-card.is-selected .cc-open-button");
  if (selectedLink) {
    selectedLink.click();
    return;
  }
  window.location.href = mainAppHref(agent);
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
    !els.deleteDialog?.hidden ||
    els.moreMenu?.open
  ) {
    return;
  }

  const directions = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
  };
  if (directions[event.key]) {
    event.preventDefault();
    moveSelectedCard(directions[event.key]);
    return;
  }

  const key = event.key.toLowerCase();
  if (key === "i") {
    const agent = selectedAgentFrom();
    if (agent) {
      event.preventDefault();
      openInteract(agent);
    }
  } else if (key === "r") {
    const agent = selectedAgentFrom();
    if (agent) {
      event.preventDefault();
      readAgent(agent);
    }
  } else if (key === "o") {
    event.preventDefault();
    openSelectedAgent();
  }
}

function deleteKeyForAgent(agent) {
  return `${agentMachineKey(agent)}::${agent.windowId || ""}`;
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
  header.innerHTML = `
    ${machineChip}
    ${ownerChip}
    <span class="cc-card-title">
      <span>${agent.windowIndex}: ${escapeHtml(agent.windowName || "(unnamed)")}</span>
      <span class="cc-card-session">· ${escapeHtml(agent.sessionName || "")}</span>
    </span>
    <span class="cc-kind-chip">${escapeHtml(agent.kind)}</span>
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
      expandedKey: `${agentMachineKey(agent)}::${agent.windowId}::user`,
    }),
  );
  card.append(
    renderSection({
      className: "assistant",
      label: "Last response",
      text: agent.lastAssistantText,
      expandedKey: `${agentMachineKey(agent)}::${agent.windowId}::assistant`,
    }),
  );

  const footer = document.createElement("div");
  footer.className = "cc-card-footer";
  const readKey = readKeyForAgent(agent);
  const deleteKey = deleteKeyForAgent(agent);
  const readingThis = state.audio.busy && state.readingKey === readKey;
  const readDisabled = state.audio.busy && !readingThis;
  const deletingThis = state.deletingWindows.has(deleteKey);
  footer.innerHTML = `
    <span>${agent.turnCount} turn${agent.turnCount === 1 ? "" : "s"} · session <code>${escapeHtml((agent.agentSessionId || "").slice(0, 8))}</code></span>
    <span class="cc-card-actions">
      ${cardActionButton({
        className: "cc-interact-button",
        title: "Interact",
        dataAttrs: `data-interact-key="${escapeHtml(readKey)}"`,
        icon: ICONS.interact,
      })}
      ${cardActionButton({
        className: `cc-read-button${readingThis ? " is-reading" : ""}`,
        title: readingThis ? "Stop reading" : "Read aloud",
        dataAttrs: `data-read-key="${escapeHtml(readKey)}"`,
        disabled: readDisabled,
        icon: readingThis ? ICONS.stop : ICONS.read,
      })}
      ${cardActionLink({
        href: mainAppHref(agent),
        title: "Open in app",
        icon: ICONS.open,
      })}
      ${cardActionButton({
        className: "cc-delete-button",
        title: "Complete and delete tmux window",
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
  if (state.machines.length === 0 && state.agents.length === 0) {
    state.selectedCardKey = "";
    renderEmpty();
    return;
  }
  const filtered = filterAndSort(state.agents);
  ensureSelectedCard(filtered);
  els.list.innerHTML = "";
  for (const machine of staleMachines()) {
    els.list.append(renderStaleMachine(machine));
  }
  if (filtered.length === 0) {
    const note = document.createElement("div");
    note.className = "cc-empty";
    note.textContent = state.agents.length === 0 && state.machines.length > 0
      ? `${state.machines.length} machine${state.machines.length === 1 ? "" : "s"} online, no Codex or Claude Code agents running right now.`
      : "No agents match the current filters.";
    els.list.append(note);
    return;
  }
  for (const agent of filtered) {
    els.list.append(renderCard(agent));
  }
  syncSelectedCardDom();
}

async function loadAgents() {
  if (state.loading) return;
  state.loading = true;
  if (state.machines.length === 0 && state.agents.length === 0) setStatus("Loading…");
  try {
    const data = await api("/api/command-center");
    const agents = Array.isArray(data.agents) ? data.agents : [];
    const machines = Array.isArray(data.machines)
      ? normalizeMachines(data.machines, agents)
      : machinesFromAgents(agents);
    state.machines = machines;
    state.agents = agents;
    state.lastError = "";
    setStatus(
      `${state.machines.length} machine${state.machines.length === 1 ? "" : "s"} · ${state.agents.length} agent${state.agents.length === 1 ? "" : "s"} · refreshed ${nowLabel()}`,
    );
    renderFilterRow();
    renderAgents();
  } catch (error) {
    state.lastError = error.message || String(error);
    setStatus(`Refresh failed at ${nowLabel()}`);
    if (state.machines.length === 0 && state.agents.length === 0) renderEmpty();
  } finally {
    state.loading = false;
  }
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

els.refresh.addEventListener("click", () => loadAgents());
els.list.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const card = target.closest(".cc-card[data-card-key]");
  if (card) updateSelectedCard(card.dataset.cardKey);

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
els.interactKeys?.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest("[data-interact-key]");
  if (!button) return;
  sendInteractKey(button.dataset.interactKey);
});
els.interactClose?.addEventListener("click", closeInteract);
els.interactBackdrop?.addEventListener("click", closeInteract);
els.interactVoiceButton?.addEventListener("click", toggleInteractVoiceRecording);
els.interactSubmitVoice?.addEventListener("click", submitInteractVoiceRecording);
els.interactCancelVoice?.addEventListener("click", cancelInteractVoiceRecording);
els.deleteCancel?.addEventListener("click", closeDeleteWindowDialog);
els.deleteConfirm?.addEventListener("click", confirmDeleteWindow);
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
  if (event.key === "Escape" && !els.deleteDialog?.hidden) {
    closeDeleteWindowDialog();
    return;
  }
  if (event.key === "Escape" && !els.interactSheet?.hidden) closeInteract();
});
document.addEventListener("keydown", handleCardShortcuts);

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

// Sort dropdown — hydrate the persisted selection, fire on change.
els.sortSelect.value = state.sortBy;
els.sortSelect.addEventListener("change", () => {
  state.sortBy = els.sortSelect.value;
  persistPrefs();
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

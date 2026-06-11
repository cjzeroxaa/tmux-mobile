import { closeRealtimeReadAudio, playRealtimeRead } from "./realtime-read.js";

// Command Center — separate top-level page. Polls /api/command-center on
// a slow cadence, drops non-agent windows, renders one card per agent
// with the last user prompt + last assistant response taken verbatim from
// the agent's JSONL transcript. No tmux capture, no LLM summary.

const POLL_MS = 4000;
const INTERACT_WAVEFORM_SAMPLES = 40;
const INTERACT_WAVEFORM_SAMPLE_INTERVAL_MS = 200;
const SNIPPETS_KEY = "tmux-mobile-snippets";
const DEFAULT_SNIPPETS = [
  { text: "yes" },
  { text: "continue" },
  { text: "/clear" },
  { text: "/btw " },
  { text: "claude" },
  { text: "codex" },
  { text: "/goal " },
];

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
  interactSheet: document.querySelector("#ccInteractSheet"),
  interactBackdrop: document.querySelector("#ccInteractBackdrop"),
  interactClose: document.querySelector("#ccInteractClose"),
  interactTarget: document.querySelector("#ccInteractTarget"),
  interactInputArea: document.querySelector("#ccInteractInputArea"),
  interactInput: document.querySelector("#ccInteractInput"),
  interactSend: document.querySelector("#ccInteractSend"),
  interactStatus: document.querySelector("#ccInteractStatus"),
  interactSnippetChips: document.querySelector("#ccInteractSnippetChips"),
  interactVoiceButton: document.querySelector("#ccInteractVoiceButton"),
  interactVoiceWaveform: document.querySelector("#ccInteractVoiceWaveform"),
  interactSubmitVoice: document.querySelector("#ccInteractSubmitVoice"),
  interactCancelVoice: document.querySelector("#ccInteractCancelVoice"),
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
  const machineId = agentMachineKey(agent);
  try {
    await api("/api/send", {
      method: "POST",
      machineId,
      body: JSON.stringify({ paneId: agent.paneId, text, enter: true }),
    });
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

function submitInteractVoiceRecording() {
  const recorder = state.interactVoice.mediaRecorder;
  if (!recorder || recorder.state !== "recording") return;
  state.interactVoice.cancelRequested = false;
  stopInteractVoiceAnalysis({ clearWaveform: false });
  setInteractVoiceStatus("transcribing", "Transcribing...");
  recorder.stop();
}

function cancelInteractVoiceRecording() {
  const recorder = state.interactVoice.mediaRecorder;
  state.interactVoice.cancelRequested = true;
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    return;
  }
  resetInteractVoice();
  setInteractStatus("Discarded");
}

async function finishInteractVoiceRecording() {
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
}

async function toggleInteractVoiceRecording() {
  if (state.interactVoice.status !== "idle") return;
  try {
    await startInteractVoiceRecording();
  } catch (error) {
    resetInteractVoice();
    setInteractStatus(`Voice failed: ${error.message}`);
  }
}

// Apply filters + sort to the current agent list. Pure function — call
// before renderAgents and feed it the result.
function filterAndSort(agents) {
  let out = agents;
  if (state.filterStatuses.size > 0) {
    out = out.filter((a) => state.filterStatuses.has(a.status));
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
      // Working first, then by window index — keep the previous default.
      return (a, b) => {
        if (a.status === b.status) return a.windowIndex - b.windowIndex;
        return a.status === "running" ? -1 : 1;
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
  for (const s of ["running", "idle"]) {
    const label = s === "running" ? "Working" : "Idle";
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

function readKeyForAgent(agent) {
  return `${agentMachineKey(agent)}::${agent.paneId || agent.windowId || ""}`;
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
  const card = document.createElement("article");
  card.className = `cc-card${agent.status === "running" ? " is-running" : ""}`;

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
    <span class="cc-status-pill${agent.status === "running" ? " is-running" : ""}">
      ${agent.status === "running" ? "Working" : "Idle"}
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
  const readingThis = state.audio.busy && state.readingKey === readKey;
  const readDisabled = state.audio.busy && !readingThis;
  footer.innerHTML = `
    <span>${agent.turnCount} turn${agent.turnCount === 1 ? "" : "s"} · session <code>${escapeHtml((agent.agentSessionId || "").slice(0, 8))}</code></span>
    <span class="cc-card-actions">
      <button class="cc-interact-button" type="button" data-interact-key="${escapeHtml(readKey)}">Interact</button>
      <button class="cc-read-button${readingThis ? " is-reading" : ""}" type="button" data-read-key="${escapeHtml(readKey)}"${readDisabled ? " disabled" : ""}>${readingThis ? "Stop" : "Read"}</button>
      <a href="${escapeHtml(mainAppHref(agent))}">Open</a>
    </span>
  `;
  card.append(footer);

  return card;
}

function renderAgents() {
  if (state.machines.length === 0 && state.agents.length === 0) {
    renderEmpty();
    return;
  }
  const filtered = filterAndSort(state.agents);
  els.list.innerHTML = "";
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
  const interactButton = event.target.closest("[data-interact-key]");
  if (interactButton) {
    const agent = state.agents.find((item) => readKeyForAgent(item) === interactButton.dataset.interactKey);
    if (agent) openInteract(agent);
    return;
  }
  const button = event.target.closest("[data-read-key]");
  if (!button) return;
  const agent = state.agents.find((item) => readKeyForAgent(item) === button.dataset.readKey);
  if (agent) readAgent(agent);
});
els.interactSend?.addEventListener("click", () =>
  sendInteractText({ keepFocus: false }),
);
els.interactClose?.addEventListener("click", closeInteract);
els.interactBackdrop?.addEventListener("click", closeInteract);
els.interactVoiceButton?.addEventListener("click", toggleInteractVoiceRecording);
els.interactSubmitVoice?.addEventListener("click", submitInteractVoiceRecording);
els.interactCancelVoice?.addEventListener("click", cancelInteractVoiceRecording);
els.interactInput?.addEventListener("input", () => {
  els.interactInput.classList.toggle("empty", interactGetText().trim().length === 0);
});
els.interactInput?.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendInteractText();
  }
});

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
  if (event.key === "Escape" && !els.interactSheet?.hidden) closeInteract();
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

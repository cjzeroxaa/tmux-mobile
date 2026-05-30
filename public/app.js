const SNAPSHOT_BOTTOM_SLOP_PX = 8;
const MAX_WAVEFORM_SAMPLES = 40;
const WAVEFORM_SAMPLE_INTERVAL_MS = 200;

let screenWakeLock = null;

if (window.location.search) {
  const cleanUrl = new URL(window.location.href);
  cleanUrl.search = "";
  window.history.replaceState({}, "", cleanUrl);
}

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

const targetAtom = createPersistedAtom("tmux-mobile-target", {
  session: "0",
  windowIndex: "1",
});

// Remembers whether the user last used voice or the text composer. Default voice.
const composerAtom = createPersistedAtom("tmux-mobile-composer", {
  textMode: false,
});

// "kami" = Japanese washi-paper light theme (default), "dark" = original.
const themeAtom = createPersistedAtom("tmux-mobile-theme", { theme: "kami" });

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "dark" ? "" : "kami";
}

const state = {
  sessions: [],
  windows: [],
  windowSummaries: {},
  windowActivity: {},
  windowBranches: {},
  activityTimer: null,
  summariesLoading: false,
  panes: [],
  sessionId: "",
  windowId: "",
  paneId: "",
  lines: 500,
  autoRefreshTimer: null,
  chat: [],
  targetPickerOpen: false,
  directoryPickerOpen: false,
  actionsOpen: false,
  snapshotFullscreen: false,
  snapshotPinnedToBottom: true,
  pendingUrlTarget: readUrlTarget(),
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
    sampleTimer: null,
    stream: null,
    status: "idle",
    textMode: composerAtom.get().textMode,
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
  return targetAtom.get();
}

function hasUrlTarget(target = readUrlTarget()) {
  return Boolean(target.session || target.windowIndex);
}

function targetMatchesSession(target) {
  const session = selectedSession();
  return !target.session || session?.name === target.session;
}

function updateTargetUrl() {
  const session = selectedSession();
  const win = selectedWindow();
  if (!session || !win) return;
  targetAtom.set({
    session: session.name,
    windowIndex: String(win.index),
  });
}

const els = {
  mobileConnectionStatus: document.querySelector("#mobileConnectionStatus"),
  sessionNameInput: document.querySelector("#sessionNameInput"),
  createSession: document.querySelector("#createSession"),
  mobileWindows: document.querySelector("#mobileWindows"),
  mobileTargetLabel: document.querySelector("#mobileTargetLabel"),
  snapshot: document.querySelector("#snapshot"),
  chat: document.querySelector("#chat"),
  mobileRefreshTree: document.querySelector("#mobileRefreshTree"),
  mobileRefresh: document.querySelector("#mobileRefresh"),
  themeToggle: document.querySelector("#themeToggle"),
  refreshSnapshot: document.querySelector("#refreshSnapshot"),
  fullscreenSnapshot: document.querySelector("#fullscreenSnapshot"),
  fullscreenRead: document.querySelector("#fullscreenRead"),
  paneInput: document.querySelector("#paneInput"),
  renameWindow: document.querySelector("#renameWindow"),
  lineCount: document.querySelector("#lineCount"),
  autoRefresh: document.querySelector("#autoRefresh"),
  voiceEntry: document.querySelector("#voiceEntry"),
  voiceButton: document.querySelector("#voiceButton"),
  voiceTitle: document.querySelector("#voiceTitle"),
  voiceSubtitle: document.querySelector("#voiceSubtitle"),
  voiceStatus: document.querySelector("#voiceStatus"),
  voiceStatusRow: document.querySelector("#voiceStatusRow"),
  keyboardButton: document.querySelector("#keyboardButton"),
  actionsToggle: document.querySelector("#actionsToggle"),
  quickActions: document.querySelector("#quickActions"),
  textComposer: document.querySelector("#textComposer"),
  textInput: document.querySelector("#textInput"),
  submitText: document.querySelector("#submitText"),
  cancelText: document.querySelector("#cancelText"),
  voiceRecordingActions: document.querySelector("#voiceRecordingActions"),
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
  openTargetPicker: document.querySelector("#openTargetPicker"),
  closeTargetPicker: document.querySelector("#closeTargetPicker"),
  targetBackdrop: document.querySelector("#targetBackdrop"),
  targetSheet: document.querySelector("#targetSheet"),
  speakWindow: document.querySelector("#speakWindow"),
};

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const hasBody = options.body !== undefined && options.body !== null;
  const isRawBody =
    typeof Blob !== "undefined" && options.body instanceof Blob;
  if (hasBody && !isRawBody && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers,
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error || `HTTP ${response.status}`);
  }
  return json;
}

function logClientEvent(event, details = {}) {
  fetch("/api/client-log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event, details }),
  }).catch(() => {});
}

function selectedSession() {
  return state.sessions.find((item) => item.id === state.sessionId);
}

function selectedWindow() {
  return state.windows.find((item) => item.id === state.windowId);
}

function paneChatKey() {
  return state.paneId ? `tmux-chat-web:${state.paneId}` : "";
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

function empty(container, text) {
  container.innerHTML = `<div class="empty">${escapeHtml(text)}</div>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `${className || "item"}${active ? " active" : ""}`;
  button.innerHTML = `
    <div class="item-title">
      <span>${escapeHtml(title)}</span>
      ${badge ? `<span class="badge ${badgeGreen ? "green" : ""}">${escapeHtml(badge)}</span>` : ""}
    </div>
    ${branch ? `<div class="item-branch" title="${escapeHtml(branch)}">⎇ ${escapeHtml(branch)}</div>` : ""}
    ${cwd ? `<div class="item-cwd" title="${escapeHtml(cwd)}">${escapeHtml(cwd)}</div>` : ""}
    ${meta ? `<div class="item-meta ${escapeHtml(metaClassName)}">${escapeHtml(meta)}</div>` : ""}
  `;
  button.addEventListener("click", onClick);
  return button;
}

function windowsForSession(sessionId) {
  return state.windows.filter((win) => win.sessionId === sessionId);
}

// One flat list of every window, grouped under a session header — no session
// dropdown, so any window is one tap away.
function renderWindows() {
  els.mobileWindows.innerHTML = "";

  if (state.windows.length === 0) {
    empty(els.mobileWindows, "No windows");
    return;
  }

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
      const summary = state.windowSummaries[win.id];
      const live = Boolean(state.windowActivity[win.id]);
      els.mobileWindows.append(
        itemButton({
          active: win.id === state.windowId,
          title: `${win.index}: ${win.name}`,
          meta: summary || (state.summariesLoading ? "Summarizing..." : win.activeCommand || win.id),
          badge: live ? "live" : `${win.panes} pane`,
          badgeGreen: live,
          onClick: () => selectWindow(win.id),
          metaClassName: summary ? "summary" : "",
          cwd: abbrevHome(win.cwd),
          branch: state.windowBranches[win.id] || "",
        }),
      );
    }
  }
}

function renderTargetLabels() {
  const session = selectedSession();
  const win = selectedWindow();
  const branch = win ? state.windowBranches[win.id] : "";
  const label = session && win
    ? `${session.name} / ${win.index}:${win.name}${branch ? ` ⎇ ${branch}` : ""}`
    : "No window selected";
  els.mobileTargetLabel.textContent = label;
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
    state.targetPickerOpen || state.directoryPickerOpen,
  );
}

function openTargetPicker() {
  closeDirectoryPicker();
  state.targetPickerOpen = true;
  els.targetSheet.hidden = false;
  syncSheetOpenClass();
  startActivityPolling();
  loadWindowSummaries({ force: false });
  loadWindowBranches();
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

function composerFocus() {
  if (composerEditor) composerEditor.editor.focus();
  else els.textInput.focus();
}

function renderComposerMode() {
  const textMode = state.voice.textMode && state.voice.status === "idle";
  els.voiceEntry.hidden = textMode || state.voice.status === "recording";
  els.textComposer.hidden = !textMode;
  els.keyboardButton.disabled = state.voice.status !== "idle";
  els.actionsToggle.disabled = state.voice.status !== "idle";
  const showActions = state.actionsOpen && state.voice.status === "idle" && !textMode;
  els.quickActions.hidden = !showActions;
  els.actionsToggle.classList.toggle("active", showActions);
  els.actionsToggle.setAttribute("aria-expanded", String(showActions));
}

function showTextComposer() {
  if (state.voice.status !== "idle") return;
  state.voice.textMode = true;
  composerAtom.set({ textMode: true });
  renderComposerMode();
  requestAnimationFrame(() => composerFocus());
}

function hideTextComposer({ clear = false, persist = false } = {}) {
  state.voice.textMode = false;
  if (persist) composerAtom.set({ textMode: false });
  if (clear) {
    composerClear();
  }
  renderComposerMode();
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

function rememberPendingVoiceAudio(blob) {
  state.voice.pendingAudio = blob;
  state.voice.pendingMimeType = blob.type || "audio/webm";
  state.voice.pendingTranscript = "";
  state.voice.pendingError = "";
  renderVoiceRetry();
}

function clearPendingVoiceAudio() {
  state.voice.pendingAudio = null;
  state.voice.pendingMimeType = "";
  state.voice.pendingTranscript = "";
  state.voice.pendingError = "";
  renderVoiceRetry();
}

async function submitTextComposer(event) {
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

  els.submitText.disabled = true;
  try {
    await sendMessage(text, true);
    hideTextComposer({ clear: true });
  } catch (error) {
    addChat("system", error.message, "send error");
  } finally {
    els.submitText.disabled = false;
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
  const buttonLabel = status === "idle" ? "Record voice" : title;
  els.voiceButton.title = buttonLabel;
  els.voiceButton.setAttribute("aria-label", buttonLabel);
  els.voiceRecordingActions.hidden = status !== "recording";
  els.submitVoice.disabled = status !== "recording";
  els.cancelVoice.disabled = status !== "recording";
  els.voiceButton.classList.toggle("recording", status === "recording");
  els.voiceButton.classList.toggle(
    "busy",
    status === "transcribing" || status === "sending",
  );
  els.voiceButton.disabled = status !== "idle";
  if (status !== "idle") {
    state.voice.textMode = false;
  }
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
      "Record voice",
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
  setVoiceStatus("recording", "Recording", "Submit to send or cancel");
}

function submitVoiceRecording() {
  const recorder = state.voice.mediaRecorder;
  if (!recorder || recorder.state !== "recording") return;
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
  setVoiceStatus("idle", "Record voice", "Tap to record a voice command");
}

function cancelVoiceRecording() {
  const recorder = state.voice.mediaRecorder;
  state.voice.cancelRequested = true;
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    return;
  }
  discardVoiceRecording();
}

async function finishVoiceRecording() {
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
  await sendPendingVoiceWithRetry();
}

async function sendPendingVoiceRecording() {
  const blob = state.voice.pendingAudio;
  if (!blob) return;

  state.voice.pendingError = "";
  renderVoiceRetry();

  if (!state.paneId) {
    throw new Error("Select a window first.");
  }

  setVoiceStatus("sending", "Sending", "Sending voice command");
  const params = new URLSearchParams({
    paneId: state.paneId,
    enter: "1",
    submitNudge: "1",
  });
  const data = await api(`/api/voice-send?${params}`, {
    method: "POST",
    headers: { "content-type": state.voice.pendingMimeType || "audio/webm" },
    body: blob,
  });
  const transcript = String(data.text || "").trim();
  if (!transcript) {
    throw new Error("No speech detected");
  }
  state.voice.pendingTranscript = transcript;
  addChat("user", transcript, "voice send");
  window.setTimeout(() => refreshSnapshot(true), 350);
  clearPendingVoiceAudio();
  setVoiceStatus("idle", "Ready", "Tap mic to record");
  stopVoiceAnalysis({ clearWaveform: true });
}

const VOICE_SEND_MAX_ATTEMPTS = 10;
const VOICE_SEND_RETRY_DELAY_MS = 1200;

// These fail the same way on every attempt, so retrying is pointless.
function isRetryableVoiceError(error) {
  const message = (error?.message || "").toLowerCase();
  return !(
    message.includes("no speech") ||
    message.includes("select a window") ||
    message.includes("too large")
  );
}

// Voice sends usually fail on transient network/agent hiccups, and the user has
// to resend anyway — so auto-retry up to MAX times before surfacing failure.
async function sendPendingVoiceWithRetry() {
  for (let attempt = 1; attempt <= VOICE_SEND_MAX_ATTEMPTS; attempt += 1) {
    try {
      await sendPendingVoiceRecording();
      return;
    } catch (error) {
      if (!isRetryableVoiceError(error) || attempt >= VOICE_SEND_MAX_ATTEMPTS) {
        throw error;
      }
      setVoiceStatus(
        "sending",
        "Retrying",
        `Send failed, retry ${attempt + 1}/${VOICE_SEND_MAX_ATTEMPTS}`,
      );
      await new Promise((resolve) => setTimeout(resolve, VOICE_SEND_RETRY_DELAY_MS));
    }
  }
}

function handleVoiceSendError(error) {
  const message = error.message || "Voice send failed";
  addChat("system", message, "voice error");
  stopVoiceAnalysis({ clearWaveform: true });
  stopVoiceStream();
  state.voice.cancelRequested = false;
  state.voice.mediaRecorder = null;
  state.voice.chunks = [];
  if (state.voice.pendingAudio) {
    state.voice.pendingError = message;
    setVoiceStatus("idle", "Send failed", "Audio saved for retry");
    return;
  }
  setVoiceStatus("idle", "Ready", "Tap mic to record");
}

async function retryVoiceRecording() {
  if (state.voice.status !== "idle" || !state.voice.pendingAudio) return;
  try {
    await sendPendingVoiceWithRetry();
  } catch (error) {
    handleVoiceSendError(error);
  }
}

async function toggleVoiceRecording() {
  try {
    if (state.voice.status !== "idle") return;
    await startVoiceRecording();
  } catch (error) {
    stopVoiceAnalysis({ clearWaveform: true });
    stopVoiceStream();
    state.voice.cancelRequested = false;
    state.voice.mediaRecorder = null;
    setVoiceStatus(
      "idle",
      "Record voice",
      "Tap to record a voice command",
    );
    addChat("system", error.message, "voice error");
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
  const stopping = busy && state.audio.stopRequested;
  els.speakWindow.disabled = false;
  els.speakWindow.title = stopping
    ? "Stopping reading"
    : busy
      ? "Stop reading"
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
  els.fullscreenRead.textContent = busy ? "Stop" : "Read";
  els.fullscreenRead.classList.toggle("reading", busy);
  els.fullscreenRead.classList.toggle("stopping", stopping);
}

function isCurrentAudioRead(readId) {
  return state.audio.readId === readId;
}

function throwIfAudioReadStopped(readId) {
  if (!isCurrentAudioRead(readId) || state.audio.stopRequested) {
    throw new Error("Realtime read stopped");
  }
}

function closeRealtimeAudio() {
  if (state.audio.abortController) {
    state.audio.abortController.abort();
    state.audio.abortController = null;
  }
  if (state.audio.source) {
    try {
      state.audio.source.stop();
    } catch {
      // The previous source may already have ended.
    }
    state.audio.source = null;
  }
  if (state.audio.dataChannel) {
    try {
      state.audio.dataChannel.close();
    } catch {
      // Ignore cleanup errors from closed data channels.
    }
    state.audio.dataChannel = null;
  }
  if (state.audio.peerConnection) {
    state.audio.peerConnection.close();
    state.audio.peerConnection = null;
  }
  state.audio.remoteStream = null;
  state.audio.remoteTrack = null;
  if (state.audio.audioElement) {
    state.audio.audioElement.pause();
    state.audio.audioElement.srcObject = null;
    state.audio.audioElement.remove();
    state.audio.audioElement = null;
  }
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

function waitForDataChannelOpen(channel, timeoutMs = 10000) {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Realtime data channel timed out"));
    }, timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timeout);
      channel.removeEventListener("open", handleOpen);
      channel.removeEventListener("close", handleClose);
      channel.removeEventListener("error", handleError);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleClose = () => {
      cleanup();
      reject(new Error("Realtime data channel closed before opening"));
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Realtime data channel failed"));
    };
    channel.addEventListener("open", handleOpen);
    channel.addEventListener("close", handleClose);
    channel.addEventListener("error", handleError);
  });
}

function waitForIceGatheringComplete(peerConnection, timeoutMs = 1500) {
  if (peerConnection.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timeout);
      peerConnection.removeEventListener("icegatheringstatechange", handleChange);
    };
    const handleChange = () => {
      if (peerConnection.iceGatheringState !== "complete") return;
      cleanup();
      resolve();
    };
    peerConnection.addEventListener("icegatheringstatechange", handleChange);
  });
}

async function createRealtimeSdpAnswer(clientSecret, sdp, signal) {
  if (!clientSecret) {
    throw new Error("Realtime client secret is missing");
  }
  const response = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      authorization: `Bearer ${clientSecret}`,
      "content-type": "application/sdp",
    },
    body: sdp,
    signal,
  });
  const answerSdp = await response.text();
  if (!response.ok) {
    throw new Error(answerSdp || `Realtime WebRTC HTTP ${response.status}`);
  }
  return answerSdp;
}

function sendRealtimeEvent(channel, event) {
  if (channel.readyState !== "open") {
    throw new Error("Realtime data channel is not open");
  }
  channel.send(JSON.stringify(event));
}

function realtimeResponseEvent(data, inputText, chunkIndex, chunkCount) {
  return {
    type: "response.create",
    response: {
      conversation: "none",
      output_modalities: ["audio"],
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: inputText,
            },
          ],
        },
      ],
      audio: {
        output: {
          voice: data.voice,
        },
      },
      max_output_tokens: data.maxOutputTokens || "inf",
      metadata: {
        source: "tmux-mobile-read",
        chunk: String(chunkIndex + 1),
        chunks: String(chunkCount),
      },
    },
  };
}

function waitForRealtimeResponse(channel, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    let transcript = "";
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Realtime response timed out"));
    }, timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timeout);
      channel.removeEventListener("message", handleMessage);
      channel.removeEventListener("close", handleClose);
      channel.removeEventListener("error", handleError);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const handleClose = () => {
      fail(new Error("Realtime data channel closed"));
    };
    const handleError = () => {
      fail(new Error("Realtime data channel failed"));
    };
    const handleMessage = (message) => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }

      console.debug("Realtime event", event);
      if (event.type === "error") {
        logClientEvent("realtime_error", {
          message: event.error?.message || "Realtime API error",
          code: event.error?.code || "",
          type: event.error?.type || "",
        });
        fail(new Error(event.error?.message || "Realtime API error"));
        return;
      }
      if (event.type === "response.output_audio_transcript.delta") {
        transcript += event.delta || "";
        return;
      }
      if (event.type === "response.output_audio_transcript.done") {
        transcript = event.transcript || transcript;
        return;
      }
      if (event.type === "response.done") {
        const status = event.response?.status || "completed";
        if (status !== "completed") {
          const statusDetails = event.response?.status_details || {};
          const message =
            statusDetails.error?.message ||
            statusDetails.reason ||
            `Realtime response ${status}`;
          logClientEvent("realtime_response_failed", {
            status,
            message,
            statusDetails,
          });
          fail(new Error(message));
          return;
        }
        logClientEvent("realtime_response_done", {
          transcriptChars: transcript.length,
        });
        cleanup();
        resolve({ transcript });
      }
    };
    channel.addEventListener("message", handleMessage);
    channel.addEventListener("close", handleClose);
    channel.addEventListener("error", handleError);
  });
}

function estimateRealtimePlaybackMs(text) {
  const trimmed = text.trim();
  if (!trimmed) return 2500;
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  const wordBasedMs = (words / 150) * 60000;
  const charBasedMs = (trimmed.length / 13) * 1000;
  return Math.min(180000, Math.max(3500, Math.max(wordBasedMs, charBasedMs) + 2000));
}

function audioLevelFromAnalyser(analyser, samples) {
  analyser.getByteTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) {
    const value = (sample - 128) / 128;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

async function waitForRealtimePlaybackToFinish({
  audioElement,
  peerConnection,
  stream,
  track,
  transcript,
}) {
  const timeoutMs = estimateRealtimePlaybackMs(transcript);
  const startedAt = performance.now();
  const quietSettleMs = 2500;
  let lastSoundAt = startedAt;
  let sawSound = false;
  let context = null;
  let source = null;
  let analyser = null;
  let samples = null;

  if (stream) {
    try {
      context = await ensureAudioContext();
      if (context?.state === "running") {
        source = context.createMediaStreamSource(stream);
        analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        samples = new Uint8Array(analyser.fftSize);
        source.connect(analyser);
      }
    } catch (error) {
      console.warn("Realtime audio monitor failed.", error);
    }
  }

  return new Promise((resolve) => {
    let done = false;
    const cleanup = (reason) => {
      if (done) return;
      done = true;
      window.clearInterval(interval);
      window.clearTimeout(timeout);
      audioElement?.removeEventListener("ended", handleEnded);
      audioElement?.removeEventListener("error", handleEnded);
      track?.removeEventListener("ended", handleEnded);
      peerConnection?.removeEventListener("connectionstatechange", handleConnectionChange);
      try {
        source?.disconnect();
      } catch {
        // The monitor may already be disconnected.
      }
      logClientEvent("realtime_playback_finished", {
        reason,
        elapsedMs: Math.round(performance.now() - startedAt),
        transcriptChars: transcript.length,
      });
      resolve();
    };
    const handleEnded = () => cleanup("ended");
    const handleConnectionChange = () => {
      const stateName = peerConnection?.connectionState;
      if (stateName === "closed" || stateName === "failed") {
        cleanup(stateName);
      }
    };
    const checkPlayback = () => {
      if (state.audio.stopRequested) {
        cleanup("stopped");
        return;
      }
      if (track?.readyState === "ended" || audioElement?.ended) {
        cleanup("ended");
        return;
      }
      if (!analyser || !samples) return;
      const now = performance.now();
      const level = audioLevelFromAnalyser(analyser, samples);
      if (level > 0.012) {
        sawSound = true;
        lastSoundAt = now;
        return;
      }
      if (!sawSound) return;
      if (sawSound && now - lastSoundAt < quietSettleMs) return;
      cleanup("silence");
    };
    const timeout = window.setTimeout(() => cleanup("timeout"), timeoutMs);
    const interval = window.setInterval(checkPlayback, 150);

    audioElement?.addEventListener("ended", handleEnded, { once: true });
    audioElement?.addEventListener("error", handleEnded, { once: true });
    track?.addEventListener("ended", handleEnded, { once: true });
    peerConnection?.addEventListener("connectionstatechange", handleConnectionChange);
    checkPlayback();
  });
}

async function playWindowSummaryRealtime({ readId, windowId, paneId }) {
  if (!window.RTCPeerConnection) {
    throw new Error("Realtime audio is not supported in this browser");
  }

  closeRealtimeAudio();
  const abortController = new AbortController();
  state.audio.abortController = abortController;
  const peerConnection = new RTCPeerConnection();
  const dataChannel = peerConnection.createDataChannel("oai-events");
  const audioElement = new Audio();
  audioElement.autoplay = true;
  audioElement.playsInline = true;
  audioElement.hidden = true;
  audioElement.setAttribute("playsinline", "");
  document.body.append(audioElement);

  state.audio.peerConnection = peerConnection;
  state.audio.dataChannel = dataChannel;
  state.audio.audioElement = audioElement;

  peerConnection.addTransceiver("audio", { direction: "recvonly" });
  peerConnection.addEventListener("connectionstatechange", () => {
    setStatus(`realtime: ${peerConnection.connectionState}`);
    logClientEvent("realtime_connection_state", {
      state: peerConnection.connectionState,
    });
  });
  peerConnection.addEventListener("track", (event) => {
    const stream = event.streams[0] || new MediaStream([event.track]);
    state.audio.remoteStream = stream;
    state.audio.remoteTrack = event.track;
    audioElement.srcObject = stream;
    audioElement.play().catch((error) => {
      console.warn("Realtime audio playback was blocked.", error);
      logClientEvent("realtime_playback_blocked", {
        message: error.message,
      });
      addChat("system", error.message, "audio error");
    });
  });

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  await waitForIceGatheringComplete(peerConnection);
  throwIfAudioReadStopped(readId);

  const data = await api("/api/window-realtime-session", {
    method: "POST",
    signal: abortController.signal,
    body: JSON.stringify({
      windowId,
      paneId,
    }),
  });
  throwIfAudioReadStopped(readId);
  logClientEvent("realtime_client_secret_ready", {
    model: data.model,
    voice: data.voice,
    lines: data.lines,
    paneId: data.paneId || paneId,
    chunkCount: data.chunkCount,
    extractionModel: data.extractionModel || "",
    extractedChars: data.extractedChars || 0,
    clientSecretExpiresAt: data.clientSecretExpiresAt || null,
  });
  const answerSdp = await createRealtimeSdpAnswer(
    data.clientSecret,
    peerConnection.localDescription?.sdp || offer.sdp,
    abortController.signal,
  );
  throwIfAudioReadStopped(readId);

  await peerConnection.setRemoteDescription({
    type: "answer",
    sdp: answerSdp,
  });
  logClientEvent("realtime_remote_description_set", {
    model: data.model,
    voice: data.voice,
    lines: data.lines,
  });
  await waitForDataChannelOpen(dataChannel);
  throwIfAudioReadStopped(readId);
  logClientEvent("realtime_data_channel_open", {
    model: data.model,
    voice: data.voice,
  });
  const inputChunks =
    Array.isArray(data.inputChunks) && data.inputChunks.length > 0
      ? data.inputChunks
      : [data.input];
  const transcripts = [];
  for (let index = 0; index < inputChunks.length; index += 1) {
    throwIfAudioReadStopped(readId);
    logClientEvent("realtime_response_chunk_started", {
      chunk: index + 1,
      chunks: inputChunks.length,
      inputChars: inputChunks[index].length,
    });
    setStatus(`realtime: reading ${index + 1}/${inputChunks.length}`);
    const responseDone = waitForRealtimeResponse(dataChannel);
    sendRealtimeEvent(
      dataChannel,
      realtimeResponseEvent(data, inputChunks[index], index, inputChunks.length),
    );
    const result = await responseDone;
    throwIfAudioReadStopped(readId);
    if (result.transcript.trim()) {
      transcripts.push(result.transcript.trim());
    }
  }

  const transcript = transcripts.join("\n\n");
  setStatus("realtime: finishing audio");
  await waitForRealtimePlaybackToFinish({
    audioElement,
    peerConnection,
    stream: state.audio.remoteStream,
    track: state.audio.remoteTrack,
    transcript: transcript || inputChunks.join("\n\n"),
  });
  throwIfAudioReadStopped(readId);
  closeRealtimeAudio();
  return {
    transcript,
    model: data.model,
    voice: data.voice,
  };
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

// On the light terminal, darken raw RGB (cube / grayscale / truecolor) for contrast.
function ansiRgb(r, g, b) {
  if (ansiKami()) {
    r = Math.round(r * 0.55);
    g = Math.round(g * 0.55);
    b = Math.round(b * 0.55);
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

// Convert capture-pane -e output (text with SGR color/style codes) to safe HTML.
function ansiToHtml(text) {
  const input = String(text || "");
  const sgr = /\x1B\[([0-9;:]*)m/g;
  const state = freshAnsiState();
  let html = "";
  let last = 0;
  let m;
  const emit = (chunk) => {
    if (!chunk) return;
    const style = ansiStyle(state);
    html += style ? `<span style="${style}">${escapeHtml(chunk)}</span>` : escapeHtml(chunk);
  };
  while ((m = sgr.exec(input)) !== null) {
    emit(input.slice(last, m.index));
    applyAnsiSgr(state, m[1].replace(/:/g, ";"));
    last = sgr.lastIndex;
  }
  emit(input.slice(last));
  return html;
}

function stripAnsi(text) {
  return String(text || "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-9;:]*m/g, "");
}

function updateSnapshotText(text, { forceScrollBottom = false } = {}) {
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
  scrollSnapshotToBottom();
  if (enabled && isWideViewport()) {
    focusPaneInput();
  } else {
    els.paneInput.blur();
  }
}

function isWideViewport() {
  return window.matchMedia && window.matchMedia("(min-width: 600px)").matches;
}

function focusPaneInput() {
  els.paneInput.value = "";
  els.paneInput.focus({ preventScroll: true });
}

const paneKeyMap = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Enter: "Enter",
  Backspace: "BSpace",
  Tab: "Tab",
  Escape: "Escape",
};

function mapPaneKey(event) {
  if (event.ctrlKey && !event.altKey && !event.metaKey) {
    const k = event.key.toLowerCase();
    if (k === "c") return "C-c";
    if (k === "d") return "C-d";
    if (k === "z") return "C-z";
  }
  return paneKeyMap[event.key] || null;
}

let paneSnapshotRefreshTimer = null;
function schedulePaneSnapshotRefresh() {
  if (paneSnapshotRefreshTimer) return;
  paneSnapshotRefreshTimer = window.setTimeout(() => {
    paneSnapshotRefreshTimer = null;
    refreshSnapshot(true);
  }, 200);
}

async function sendPaneText(text) {
  if (!state.paneId || !text) return;
  await api("/api/send", {
    method: "POST",
    body: JSON.stringify({ paneId: state.paneId, text, enter: false }),
  });
  schedulePaneSnapshotRefresh();
}

async function sendPaneKey(key) {
  if (!state.paneId) return;
  await api("/api/key", {
    method: "POST",
    body: JSON.stringify({ paneId: state.paneId, key }),
  });
  schedulePaneSnapshotRefresh();
}

function resetWindowSummaryState() {
  state.windowSummaries = {};
  state.summariesLoading = false;
}

function pruneWindowSummaries() {
  const windowIds = new Set(state.windows.map((win) => win.id));
  state.windowSummaries = Object.fromEntries(
    Object.entries(state.windowSummaries).filter(([windowId]) =>
      windowIds.has(windowId),
    ),
  );
}

async function refreshTree({
  urlTarget = state.pendingUrlTarget || readUrlTarget(),
  forceUrlTarget = false,
  syncUrl = false,
} = {}) {
  try {
    state.sessions = await api("/api/sessions");
    await loadWindows({ urlTarget, forceUrlTarget });
    if (state.targetPickerOpen) {
      startActivityPolling();
    }
    if (syncUrl) {
      updateTargetUrl();
    }
    state.pendingUrlTarget = null;
    setStatus("localhost");
  } catch (error) {
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
    if (state.targetPickerOpen) {
      loadWindowSummaries({ force: true });
    }
  } catch (error) {
    setStatus(error.message, false);
  } finally {
    els.createSession.disabled = false;
  }
}

// Load windows for every session and flatten into one tagged list.
async function loadWindows({ urlTarget = readUrlTarget(), forceUrlTarget = false } = {}) {
  state.panes = [];
  if (state.sessions.length === 0) {
    state.windows = [];
    state.sessionId = "";
    state.windowId = "";
    resetWindowSummaryState();
    renderWindows();
    renderTargetLabels();
    return;
  }

  const lists = await Promise.all(
    state.sessions.map((session) =>
      api(`/api/windows?sessionId=${encodeURIComponent(session.id)}`)
        .then((wins) => wins.map((win) => ({ ...win, sessionId: session.id })))
        .catch(() => []),
    ),
  );
  state.windows = lists.flat();
  pruneWindowSummaries();

  const currentWindowExists = state.windows.some((item) => item.id === state.windowId);
  if (forceUrlTarget || !currentWindowExists) {
    let target = null;
    if (urlTarget.session && urlTarget.windowIndex) {
      const session = state.sessions.find((item) => item.name === urlTarget.session);
      if (session) {
        target = state.windows.find(
          (win) => win.sessionId === session.id && String(win.index) === urlTarget.windowIndex,
        );
      }
    }
    const chosen = target || state.windows.find((win) => win.active) || state.windows[0] || null;
    state.windowId = chosen?.id || "";
    state.sessionId = chosen?.sessionId || "";
  } else {
    state.sessionId =
      state.windows.find((win) => win.id === state.windowId)?.sessionId || state.sessionId;
  }

  renderWindows();
  renderTargetLabels();
  await loadPanes();
}

// Summaries for every session, merged by window id.
async function loadWindowSummaries({ force = false } = {}) {
  if (state.windows.length === 0) return;
  state.summariesLoading = true;
  renderWindows();
  try {
    const lists = await Promise.all(
      state.sessions.map((session) => {
        const params = new URLSearchParams({ sessionId: session.id, lines: "20" });
        if (force) params.set("refresh", "1");
        return api(`/api/window-summaries?${params}`)
          .then((data) => data.summaries || [])
          .catch(() => []);
      }),
    );
    const merged = {};
    for (const summaries of lists) {
      for (const item of summaries) merged[item.windowId] = item.summary;
    }
    state.windowSummaries = merged;
  } catch (error) {
    setStatus(`summary: ${error.message}`, false);
  } finally {
    state.summariesLoading = false;
    renderWindows();
  }
}

async function loadWindowBranches() {
  if (state.windows.length === 0) return;
  try {
    const lists = await Promise.all(
      state.sessions.map((session) =>
        api(`/api/window-branches?sessionId=${encodeURIComponent(session.id)}`).catch(() => ({})),
      ),
    );
    state.windowBranches = Object.assign({}, ...lists);
    renderWindows();
    renderTargetLabels();
  } catch {
    // ignore transient failures
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
  pollWindowActivity();
  state.activityTimer = window.setInterval(pollWindowActivity, 3000);
}

function stopActivityPolling() {
  if (state.activityTimer) {
    window.clearInterval(state.activityTimer);
    state.activityTimer = null;
  }
}

async function selectWindow(windowId) {
  const win = state.windows.find((item) => item.id === windowId);
  state.windowId = windowId;
  state.sessionId = win?.sessionId || state.sessionId;
  state.paneId = "";
  renderWindows();
  await loadPanes();
  updateTargetUrl();
  closeTargetPicker();
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

async function loadPanes() {
  const previousPaneId = state.paneId;
  state.panes = [];
  if (!state.windowId) {
    renderTargetLabels();
    resetDirectoryNavigator();
    return;
  }

  state.panes = await api(`/api/panes?windowId=${encodeURIComponent(state.windowId)}`);
  state.paneId = state.panes.find((pane) => pane.active)?.id || state.panes[0]?.id || "";
  loadChat();
  renderTargetLabels();
  renderChat();
  await loadDirectories({ clear: state.paneId !== previousPaneId });
  await refreshSnapshot(false, { forceScrollBottom: state.paneId !== previousPaneId });
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

async function refreshSnapshot(addToChat = false, { forceScrollBottom = false } = {}) {
  if (!state.paneId) {
    updateSnapshotText("Select a window.", { forceScrollBottom: true });
    return;
  }
  try {
    const params = new URLSearchParams({
      paneId: state.paneId,
      mode: "tail",
      lines: String(state.lines),
    });
    const data = await api(`/api/capture?${params}`);
    updateSnapshotText(data.text || "[no visible output]", { forceScrollBottom });
    if (addToChat) {
      addChat("pane", excerptForChat(data.text), "tmux output");
    }
  } catch (error) {
    updateSnapshotText(error.message, { forceScrollBottom });
    addChat("system", error.message, "error");
  }
}

async function sendMessage(text, enter, { submitNudge = false } = {}) {
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

async function runActionCommand(command) {
  await sendMessage(command, true);
}

function setAutoRefresh(enabled) {
  if (state.autoRefreshTimer) {
    window.clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }
  if (enabled) {
    state.autoRefreshTimer = window.setInterval(() => {
      refreshTree();
      refreshSnapshot();
    }, 3000);
  }
}

els.mobileRefreshTree.addEventListener("click", async () => {
  await refreshTree();
  await loadWindowSummaries({ force: true });
});
els.mobileRefresh.addEventListener("click", async () => {
  await refreshTree();
  await refreshSnapshot();
});
els.themeToggle.addEventListener("click", () => {
  const next = themeAtom.get().theme === "dark" ? "kami" : "dark";
  themeAtom.set({ theme: next });
  applyTheme(next);
});
els.refreshSnapshot.addEventListener("click", () => refreshSnapshot());
els.fullscreenSnapshot.addEventListener("click", () => {
  setSnapshotFullscreen(!state.snapshotFullscreen);
});

els.snapshot.addEventListener("click", () => {
  if (state.snapshotFullscreen && isWideViewport()) focusPaneInput();
});

els.paneInput.addEventListener("beforeinput", (event) => {
  if (!state.snapshotFullscreen) return;
  if (event.inputType === "insertText" && event.data) {
    event.preventDefault();
    sendPaneText(event.data).catch(() => {});
  } else if (event.inputType === "insertLineBreak") {
    event.preventDefault();
    sendPaneKey("Enter").catch(() => {});
  } else if (event.inputType === "deleteContentBackward") {
    event.preventDefault();
    sendPaneKey("BSpace").catch(() => {});
  }
});

els.paneInput.addEventListener("keydown", (event) => {
  if (!state.snapshotFullscreen) return;
  const key = mapPaneKey(event);
  if (!key) return;
  event.preventDefault();
  event.stopPropagation();
  sendPaneKey(key).catch(() => {});
});

els.paneInput.addEventListener("input", () => {
  els.paneInput.value = "";
});

els.snapshot.addEventListener(
  "scroll",
  () => {
    state.snapshotPinnedToBottom = isSnapshotAtBottom();
  },
  { passive: true },
);
els.renameWindow.addEventListener("click", renameSelectedWindow);
els.lineCount.addEventListener("change", () => {
  state.lines = Number(els.lineCount.value);
  refreshSnapshot();
});
els.autoRefresh.addEventListener("change", () => setAutoRefresh(els.autoRefresh.checked));
els.sessionNameInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  createTmuxSession();
});
els.createSession.addEventListener("click", createTmuxSession);
els.openTargetPicker.addEventListener("click", openTargetPicker);
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
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && shouldHoldScreenAwake()) {
    requestScreenWakeLock();
  }
});
els.voiceButton.addEventListener("click", toggleVoiceRecording);
els.keyboardButton.addEventListener("click", showTextComposer);
els.actionsToggle.addEventListener("click", () => {
  state.actionsOpen = !state.actionsOpen;
  renderComposerMode();
});
els.textComposer.addEventListener("submit", submitTextComposer);
els.cancelText.addEventListener("click", () => hideTextComposer({ persist: true }));
els.textInput.addEventListener("input", () => {
  if (!composerEditor) {
    els.textInput.classList.toggle("empty", els.textInput.innerText.trim().length === 0);
  }
});
els.textInput.addEventListener("keydown", (event) => {
  if (composerEditor) return; // Lexical handles Enter via KEY_ENTER_COMMAND
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitTextComposer();
  }
});
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
els.fullscreenRead.addEventListener("click", () => els.speakWindow.click());

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
      await runActionCommand(button.dataset.command);
    } catch (error) {
      addChat("system", error.message, "error");
    }
  });
}

for (const button of document.querySelectorAll("[data-send-text]")) {
  button.addEventListener("click", async () => {
    try {
      await sendMessage(button.dataset.sendText || "", button.dataset.sendEnter === "true");
    } catch (error) {
      addChat("system", error.message, "error");
    }
  });
}

window.addEventListener("popstate", () => {
  refreshTree({
    urlTarget: readUrlTarget(),
    forceUrlTarget: true,
  });
});

renderComposerMode();
initComposerEditor();

refreshTree({
  urlTarget: state.pendingUrlTarget,
  forceUrlTarget: hasUrlTarget(state.pendingUrlTarget),
  syncUrl: true,
}).then(() => {
  els.autoRefresh.checked = true;
  setAutoRefresh(true);
});

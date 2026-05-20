const state = {
  sessions: [],
  windows: [],
  windowSummaries: {},
  summariesLoading: false,
  panes: [],
  sessionId: "",
  windowId: "",
  paneId: "",
  captureMode: "tail",
  lines: 120,
  autoRefreshTimer: null,
  chat: [],
  targetPickerOpen: false,
  snapshotFullscreen: false,
  pendingUrlTarget: readUrlTarget(),
  voice: {
    chunks: [],
    mediaRecorder: null,
    stream: null,
    status: "idle",
  },
  audio: {
    context: null,
    source: null,
    busy: false,
  },
};

function readUrlTarget() {
  const params = new URLSearchParams(window.location.search);
  return {
    session: params.get("session") || "",
    windowIndex: params.get("window") || "",
  };
}

function hasUrlTarget(target = readUrlTarget()) {
  return Boolean(target.session || target.windowIndex);
}

function targetMatchesSession(target) {
  const session = selectedSession();
  return !target.session || session?.name === target.session;
}

function updateTargetUrl({ replace = false } = {}) {
  const session = selectedSession();
  const win = selectedWindow();
  if (!session || !win) return;

  const url = new URL(window.location.href);
  url.searchParams.set("session", session.name);
  url.searchParams.set("window", String(win.index));

  if (url.toString() === window.location.href) return;
  const method = replace ? "replaceState" : "pushState";
  window.history[method]({}, "", url);
}

const els = {
  mobileConnectionStatus: document.querySelector("#mobileConnectionStatus"),
  mobileSessionSelect: document.querySelector("#mobileSessionSelect"),
  mobileWindows: document.querySelector("#mobileWindows"),
  mobilePanes: document.querySelector("#mobilePanes"),
  mobileTargetLabel: document.querySelector("#mobileTargetLabel"),
  snapshot: document.querySelector("#snapshot"),
  chat: document.querySelector("#chat"),
  mobileRefreshTree: document.querySelector("#mobileRefreshTree"),
  mobileRefresh: document.querySelector("#mobileRefresh"),
  refreshSnapshot: document.querySelector("#refreshSnapshot"),
  fullscreenSnapshot: document.querySelector("#fullscreenSnapshot"),
  newWindow: document.querySelector("#newWindow"),
  killWindow: document.querySelector("#killWindow"),
  lineCount: document.querySelector("#lineCount"),
  autoRefresh: document.querySelector("#autoRefresh"),
  voiceButton: document.querySelector("#voiceButton"),
  voiceTitle: document.querySelector("#voiceTitle"),
  voiceSubtitle: document.querySelector("#voiceSubtitle"),
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
    ...options,
    headers,
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error || `HTTP ${response.status}`);
  }
  return json;
}

function selectedSession() {
  return state.sessions.find((item) => item.id === state.sessionId);
}

function selectedWindow() {
  return state.windows.find((item) => item.id === state.windowId);
}

function selectedPane() {
  return state.panes.find((item) => item.id === state.paneId);
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
}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `${className || "item"}${active ? " active" : ""}`;
  button.innerHTML = `
    <div class="item-title">
      <span>${escapeHtml(title)}</span>
      ${badge ? `<span class="badge ${badgeGreen ? "green" : ""}">${escapeHtml(badge)}</span>` : ""}
    </div>
    ${meta ? `<div class="item-meta ${escapeHtml(metaClassName)}">${escapeHtml(meta)}</div>` : ""}
  `;
  button.addEventListener("click", onClick);
  return button;
}

function renderSessions() {
  els.mobileSessionSelect.innerHTML = "";
  if (state.sessions.length === 0) {
    els.mobileSessionSelect.disabled = true;
    els.mobileSessionSelect.append(new Option("No tmux sessions", ""));
    empty(els.mobileWindows, "No windows");
    empty(els.mobilePanes, "No panes");
    return;
  }

  for (const session of state.sessions) {
    const label = `${session.name} (${session.windows} win${session.windows === 1 ? "" : "s"})`;
    const option = new Option(label, session.id);
    option.selected = session.id === state.sessionId;
    els.mobileSessionSelect.append(option);
  }
  els.mobileSessionSelect.disabled = false;
}

function renderWindows() {
  els.mobileWindows.innerHTML = "";
  els.newWindow.disabled = !state.sessionId;
  els.killWindow.disabled = !state.windowId || state.windows.length <= 1;

  if (state.windows.length === 0) {
    empty(els.mobileWindows, "No windows");
    return;
  }

  for (const win of state.windows) {
    const summary = state.windowSummaries[win.id];
    const config = {
      active: win.id === state.windowId,
      title: `${win.index}: ${win.name}`,
      meta: summary || (state.summariesLoading ? "Summarizing..." : win.activeCommand || win.id),
      badge: win.active ? "active" : `${win.panes} pane`,
      badgeGreen: win.active,
      onClick: () => selectWindow(win.id),
      metaClassName: summary ? "summary" : "",
    };
    els.mobileWindows.append(itemButton(config));
  }
}

function renderPanes() {
  els.mobilePanes.innerHTML = "";
  if (state.panes.length === 0) {
    empty(els.mobilePanes, "No panes");
    return;
  }

  for (const pane of state.panes) {
    const config = {
      active: pane.id === state.paneId,
      title: `Pane ${pane.index}`,
      meta: `${pane.command || "unknown"} | ${pane.cwd || pane.title || pane.id}`,
      badge: pane.active ? "active" : `${pane.width}x${pane.height}`,
      badgeGreen: pane.active,
      className: "pane-item",
      onClick: () => selectPane(pane.id),
    };
    els.mobilePanes.append(itemButton(config));
  }
}

function renderTargetLabels() {
  const session = selectedSession();
  const win = selectedWindow();
  const pane = selectedPane();
  const label =
    session && win && pane
      ? `${session.name} / ${win.index}:${win.name} / pane ${pane.index}`
      : "No pane selected";
  els.mobileTargetLabel.textContent = label;
}

function openTargetPicker() {
  state.targetPickerOpen = true;
  els.targetSheet.hidden = false;
  document.body.classList.add("sheet-open");
  loadWindowSummaries({ force: false });
}

function closeTargetPicker() {
  state.targetPickerOpen = false;
  els.targetSheet.hidden = true;
  document.body.classList.remove("sheet-open");
}

function setVoiceStatus(status, title, subtitle) {
  state.voice.status = status;
  els.voiceTitle.textContent = title;
  els.voiceSubtitle.textContent = subtitle;
  els.voiceButton.classList.toggle("recording", status === "recording");
  els.voiceButton.classList.toggle(
    "busy",
    status === "transcribing" || status === "sending",
  );
  els.voiceButton.disabled = status === "transcribing" || status === "sending";
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
    addChat("system", "Select a pane first.", "system");
    return;
  }
  if (!window.isSecureContext) {
    setVoiceStatus(
      "idle",
      "Start Recording",
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
  const mimeType = chooseAudioMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  state.voice.chunks = [];
  state.voice.stream = stream;
  state.voice.mediaRecorder = recorder;

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data?.size > 0) {
      state.voice.chunks.push(event.data);
    }
  });
  recorder.addEventListener("stop", () => {
    finishVoiceRecording().catch((error) => {
      addChat("system", error.message, "voice error");
      setVoiceStatus(
        "idle",
        "Start Recording",
        "Tap again to stop, transcribe, and send Enter",
      );
    });
  });

  recorder.start();
  setVoiceStatus("recording", "Recording", "Tap to stop and send");
}

function stopVoiceRecording() {
  const recorder = state.voice.mediaRecorder;
  if (!recorder || recorder.state !== "recording") return;
  setVoiceStatus("transcribing", "Transcribing", "Converting speech to text");
  recorder.stop();
}

async function finishVoiceRecording() {
  const mimeType = state.voice.mediaRecorder?.mimeType || "audio/webm";
  stopVoiceStream();
  const blob = new Blob(state.voice.chunks, { type: mimeType });
  state.voice.chunks = [];
  state.voice.mediaRecorder = null;

  if (blob.size === 0) {
    throw new Error("No audio captured");
  }

  const data = await api("/api/transcribe", {
    method: "POST",
    headers: { "content-type": blob.type || "audio/webm" },
    body: blob,
  });

  setVoiceStatus("sending", "Sending", data.text);
  await sendMessage(data.text, true, { submitNudge: true });
  setVoiceStatus(
    "idle",
    "Start Recording",
    "Tap again to stop, transcribe, and send Enter",
  );
}

async function toggleVoiceRecording() {
  try {
    if (state.voice.status === "recording") {
      stopVoiceRecording();
      return;
    }
    if (state.voice.status !== "idle") return;
    await startVoiceRecording();
  } catch (error) {
    stopVoiceStream();
    state.voice.mediaRecorder = null;
    setVoiceStatus(
      "idle",
      "Start Recording",
      "Tap again to stop, transcribe, and send Enter",
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
  els.speakWindow.disabled = busy;
  els.speakWindow.textContent = busy ? "..." : "Read";
}

async function playAudioBase64(base64, mimeType) {
  const bytes = audioBytesFromBase64(base64);
  const context = await ensureAudioContext();
  if (context) {
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
  }

  const blob = new Blob([bytes], { type: mimeType || "audio/mpeg" });
  const audioUrl = URL.createObjectURL(blob);
  const audio = new Audio(audioUrl);
  audio.addEventListener("ended", () => URL.revokeObjectURL(audioUrl), {
    once: true,
  });
  await audio.play();
}

async function speakWindowSummary() {
  if (!state.windowId) {
    addChat("system", "Select a window first.", "system");
    return;
  }

  setSpeakWindowBusy(true);
  const audioReady = ensureAudioContext().catch(() => null);
  addChat("system", "Summarizing current window for audio.", "audio");

  try {
    const data = await api("/api/window-audio-summary", {
      method: "POST",
      body: JSON.stringify({ windowId: state.windowId, lines: 100 }),
    });
    await audioReady;
    addChat("system", data.summary, "AI voice summary");
    await playAudioBase64(data.audioBase64, data.mimeType);
    setStatus(`voice: ${data.speechModel}`);
  } finally {
    setSpeakWindowBusy(false);
  }
}

function renderChat() {
  els.chat.innerHTML = "";
  if (!state.paneId) {
    empty(els.chat, "Select a pane");
    return;
  }
  if (state.chat.length === 0) {
    empty(els.chat, "No messages for this pane");
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
  const trimmed = text.trimEnd();
  if (trimmed.length <= 4500) return trimmed || "[no visible output]";
  return `${trimmed.slice(-4500)}\n\n[showing last 4500 chars]`;
}

function scrollSnapshotToBottom() {
  requestAnimationFrame(() => {
    els.snapshot.scrollTop = els.snapshot.scrollHeight;
  });
}

function setSnapshotFullscreen(enabled) {
  state.snapshotFullscreen = enabled;
  document.body.classList.toggle("snapshot-fullscreen", enabled);
  els.fullscreenSnapshot.textContent = enabled ? "Exit" : "FS";
  els.fullscreenSnapshot.setAttribute("aria-pressed", String(enabled));
  scrollSnapshotToBottom();
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
    const sessions = await api("/api/sessions");
    state.sessions = sessions;
    const previousSessionId = state.sessionId;
    const currentSessionExists = state.sessions.some((item) => item.id === state.sessionId);
    if (forceUrlTarget || !currentSessionExists) {
      const targetSession = urlTarget.session
        ? state.sessions.find((item) => item.name === urlTarget.session)
        : null;
      state.sessionId = targetSession?.id || state.sessions[0]?.id || "";
    }
    if (state.sessionId !== previousSessionId) {
      resetWindowSummaryState();
    }
    renderSessions();
    await loadWindows({ urlTarget, forceUrlTarget });
    if (syncUrl) {
      updateTargetUrl({ replace: true });
    }
    state.pendingUrlTarget = null;
    setStatus("localhost");
  } catch (error) {
    setStatus(error.message, false);
  }
}

async function selectSession(sessionId) {
  state.sessionId = sessionId;
  state.windowId = "";
  state.paneId = "";
  resetWindowSummaryState();
  renderSessions();
  await loadWindows();
  updateTargetUrl();
  if (state.targetPickerOpen) {
    await loadWindowSummaries({ force: true });
  }
}

async function loadWindows({ urlTarget = readUrlTarget(), forceUrlTarget = false } = {}) {
  state.windows = [];
  state.panes = [];
  if (!state.sessionId) {
    resetWindowSummaryState();
    renderWindows();
    renderPanes();
    renderTargetLabels();
    return;
  }

  state.windows = await api(`/api/windows?sessionId=${encodeURIComponent(state.sessionId)}`);
  pruneWindowSummaries();
  const currentWindowExists = state.windows.some((item) => item.id === state.windowId);
  if (forceUrlTarget || !currentWindowExists) {
    const targetWindow =
      targetMatchesSession(urlTarget) && urlTarget.windowIndex
        ? state.windows.find((item) => String(item.index) === urlTarget.windowIndex)
        : null;
    state.windowId =
      targetWindow?.id ||
      state.windows.find((item) => item.active)?.id ||
      state.windows[0]?.id ||
      "";
  }
  renderWindows();
  await loadPanes();
}

async function loadWindowSummaries({ force = false } = {}) {
  if (!state.sessionId || state.windows.length === 0) return;
  const sessionId = state.sessionId;
  state.summariesLoading = true;
  renderWindows();

  try {
    const params = new URLSearchParams({
      sessionId,
      lines: "20",
    });
    if (force) {
      params.set("refresh", "1");
    }
    const data = await api(`/api/window-summaries?${params}`);
    if (state.sessionId !== sessionId) return;

    state.windowSummaries = Object.fromEntries(
      (data.summaries || []).map((item) => [item.windowId, item.summary]),
    );
    setStatus(`summaries: ${data.model}`);
  } catch (error) {
    if (state.sessionId === sessionId) {
      setStatus(`summary: ${error.message}`, false);
    }
  } finally {
    if (state.sessionId === sessionId) {
      state.summariesLoading = false;
      renderWindows();
    }
  }
}

async function selectWindow(windowId) {
  state.windowId = windowId;
  state.paneId = "";
  renderWindows();
  await loadPanes();
  updateTargetUrl();
}

async function createTmuxWindow() {
  if (!state.sessionId) {
    setStatus("Select a session first", false);
    return;
  }

  els.newWindow.disabled = true;
  setStatus("creating window...");
  try {
    const win = await api("/api/windows", {
      method: "POST",
      body: JSON.stringify({ sessionId: state.sessionId }),
    });
    resetWindowSummaryState();
    await loadWindows();
    if (win?.id && state.windows.some((item) => item.id === win.id)) {
      await selectWindow(win.id);
    }
    updateTargetUrl();
    setStatus(`new window: ${win.index}`);
    if (state.targetPickerOpen) {
      loadWindowSummaries({ force: true });
    }
  } catch (error) {
    setStatus(error.message, false);
  } finally {
    renderWindows();
  }
}

async function killSelectedWindow() {
  const win = selectedWindow();
  if (!win) {
    setStatus("Select a window first", false);
    return;
  }
  if (state.windows.length <= 1) {
    setStatus("Cannot kill the last window", false);
    return;
  }

  const label = `${win.index}: ${win.name}`;
  if (!window.confirm(`Kill tmux window ${label}?`)) return;

  els.killWindow.disabled = true;
  setStatus("killing window...");
  try {
    await api("/api/windows", {
      method: "DELETE",
      body: JSON.stringify({ windowId: win.id }),
    });
    state.windowId = "";
    state.paneId = "";
    resetWindowSummaryState();
    await loadWindows();
    updateTargetUrl();
    setStatus(`killed window: ${label}`);
    if (state.targetPickerOpen) {
      loadWindowSummaries({ force: true });
    }
  } catch (error) {
    setStatus(error.message, false);
  } finally {
    renderWindows();
  }
}

async function loadPanes() {
  state.panes = [];
  if (!state.windowId) {
    renderPanes();
    renderTargetLabels();
    return;
  }

  state.panes = await api(`/api/panes?windowId=${encodeURIComponent(state.windowId)}`);
  if (!state.panes.some((item) => item.id === state.paneId)) {
    state.paneId = state.panes.find((item) => item.active)?.id || state.panes[0]?.id || "";
  }
  renderPanes();
  loadChat();
  renderTargetLabels();
  renderChat();
  await refreshSnapshot();
}

async function selectPane(paneId) {
  state.paneId = paneId;
  renderPanes();
  loadChat();
  renderTargetLabels();
  renderChat();
  await refreshSnapshot();
  closeTargetPicker();
}

async function refreshSnapshot(addToChat = false) {
  if (!state.paneId) {
    els.snapshot.textContent = "Select a pane.";
    return;
  }
  try {
    const params = new URLSearchParams({
      paneId: state.paneId,
      mode: state.captureMode,
      lines: String(state.lines),
    });
    const data = await api(`/api/capture?${params}`);
    els.snapshot.textContent = data.text || "[no visible output]";
    scrollSnapshotToBottom();
    if (addToChat) {
      addChat("pane", excerptForChat(data.text), "tmux output");
    }
  } catch (error) {
    els.snapshot.textContent = error.message;
    scrollSnapshotToBottom();
    addChat("system", error.message, "error");
  }
}

async function sendMessage(text, enter, { submitNudge = false } = {}) {
  if (!state.paneId) {
    addChat("system", "Select a pane first.", "system");
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
    addChat("system", "Select a pane first.", "system");
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

function setCaptureMode(mode) {
  state.captureMode = mode;
  for (const button of document.querySelectorAll("[data-mode]")) {
    button.classList.toggle("active", button.dataset.mode === mode);
  }
  refreshSnapshot();
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
els.refreshSnapshot.addEventListener("click", () => refreshSnapshot());
els.fullscreenSnapshot.addEventListener("click", () => {
  setSnapshotFullscreen(!state.snapshotFullscreen);
});
els.newWindow.addEventListener("click", createTmuxWindow);
els.killWindow.addEventListener("click", killSelectedWindow);
els.lineCount.addEventListener("change", () => {
  state.lines = Number(els.lineCount.value);
  refreshSnapshot();
});
els.autoRefresh.addEventListener("change", () => setAutoRefresh(els.autoRefresh.checked));
els.mobileSessionSelect.addEventListener("change", () => {
  selectSession(els.mobileSessionSelect.value);
});
els.openTargetPicker.addEventListener("click", openTargetPicker);
els.closeTargetPicker.addEventListener("click", closeTargetPicker);
els.targetBackdrop.addEventListener("click", closeTargetPicker);
els.voiceButton.addEventListener("click", toggleVoiceRecording);
els.speakWindow.addEventListener("click", async () => {
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
  }
});

for (const button of document.querySelectorAll("[data-mode]")) {
  button.addEventListener("click", () => setCaptureMode(button.dataset.mode));
}

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

window.addEventListener("popstate", () => {
  refreshTree({
    urlTarget: readUrlTarget(),
    forceUrlTarget: true,
  });
});

refreshTree({
  urlTarget: state.pendingUrlTarget,
  forceUrlTarget: hasUrlTarget(state.pendingUrlTarget),
  syncUrl: true,
}).then(() => {
  els.autoRefresh.checked = true;
  setAutoRefresh(true);
});

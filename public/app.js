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
  actionSheetOpen: false,
  voice: {
    chunks: [],
    mediaRecorder: null,
    stream: null,
    status: "idle",
  },
};

const els = {
  connectionStatus: document.querySelector("#connectionStatus"),
  mobileConnectionStatus: document.querySelector("#mobileConnectionStatus"),
  sessions: document.querySelector("#sessions"),
  mobileSessions: document.querySelector("#mobileSessions"),
  windows: document.querySelector("#windows"),
  mobileWindows: document.querySelector("#mobileWindows"),
  panes: document.querySelector("#panes"),
  mobilePanes: document.querySelector("#mobilePanes"),
  targetLabel: document.querySelector("#targetLabel"),
  mobileTargetLabel: document.querySelector("#mobileTargetLabel"),
  chatTarget: document.querySelector("#chatTarget"),
  inspect: document.querySelector("#inspect"),
  snapshot: document.querySelector("#snapshot"),
  chat: document.querySelector("#chat"),
  refreshTree: document.querySelector("#refreshTree"),
  mobileRefreshTree: document.querySelector("#mobileRefreshTree"),
  mobileRefresh: document.querySelector("#mobileRefresh"),
  summarize: document.querySelector("#summarize"),
  refreshSnapshot: document.querySelector("#refreshSnapshot"),
  lineCount: document.querySelector("#lineCount"),
  autoRefresh: document.querySelector("#autoRefresh"),
  composer: document.querySelector("#composer"),
  messageInput: document.querySelector("#messageInput"),
  sendEnter: document.querySelector("#sendEnter"),
  voiceButton: document.querySelector("#voiceButton"),
  voiceTitle: document.querySelector("#voiceTitle"),
  voiceSubtitle: document.querySelector("#voiceSubtitle"),
  clearChat: document.querySelector("#clearChat"),
  openTargetPicker: document.querySelector("#openTargetPicker"),
  closeTargetPicker: document.querySelector("#closeTargetPicker"),
  targetBackdrop: document.querySelector("#targetBackdrop"),
  targetSheet: document.querySelector("#targetSheet"),
  openActionSheet: document.querySelector("#openActionSheet"),
  closeActionSheet: document.querySelector("#closeActionSheet"),
  actionBackdrop: document.querySelector("#actionBackdrop"),
  actionSheet: document.querySelector("#actionSheet"),
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
  els.connectionStatus.textContent = text;
  els.mobileConnectionStatus.textContent = text;
  els.connectionStatus.style.color = ok ? "" : "#a73535";
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
  els.sessions.innerHTML = "";
  els.mobileSessions.innerHTML = "";
  if (state.sessions.length === 0) {
    empty(els.sessions, "No tmux sessions");
    empty(els.mobileSessions, "No tmux sessions");
    return;
  }

  for (const session of state.sessions) {
    const config = {
      active: session.id === state.sessionId,
      title: session.name,
      meta: session.created || session.id,
      badge: `${session.windows} win`,
      badgeGreen: session.attached,
      onClick: () => selectSession(session.id),
    };
    els.sessions.append(itemButton(config));
    els.mobileSessions.append(itemButton(config));
  }
}

function renderWindows() {
  els.windows.innerHTML = "";
  els.mobileWindows.innerHTML = "";
  if (state.windows.length === 0) {
    empty(els.windows, "No windows");
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
    els.windows.append(itemButton(config));
    els.mobileWindows.append(itemButton(config));
  }
}

function renderPanes() {
  els.panes.innerHTML = "";
  els.mobilePanes.innerHTML = "";
  if (state.panes.length === 0) {
    empty(els.panes, "No panes");
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
    els.panes.append(itemButton(config));
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
  els.targetLabel.textContent = label;
  els.mobileTargetLabel.textContent = label;
  els.chatTarget.textContent = label;
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

function openActionSheet() {
  state.actionSheetOpen = true;
  els.actionSheet.hidden = false;
}

function closeActionSheet() {
  state.actionSheetOpen = false;
  els.actionSheet.hidden = true;
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
  await sendMessage(data.text, true);
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
      <div class="message-meta">${escapeHtml(message.label || message.role)} · ${escapeHtml(message.time || "")}</div>
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

async function refreshTree() {
  try {
    const sessions = await api("/api/sessions");
    state.sessions = sessions;
    if (!state.sessions.some((item) => item.id === state.sessionId)) {
      state.sessionId = state.sessions[0]?.id || "";
    }
    renderSessions();
    await loadWindows();
    setStatus("localhost");
  } catch (error) {
    setStatus(error.message, false);
  }
}

async function selectSession(sessionId) {
  state.sessionId = sessionId;
  state.windowId = "";
  state.paneId = "";
  renderSessions();
  await loadWindows();
  if (state.targetPickerOpen) {
    await loadWindowSummaries({ force: true });
  }
}

async function loadWindows() {
  state.windows = [];
  state.windowSummaries = {};
  state.summariesLoading = false;
  state.panes = [];
  if (!state.sessionId) {
    renderWindows();
    renderPanes();
    renderTargetLabels();
    return;
  }

  state.windows = await api(`/api/windows?sessionId=${encodeURIComponent(state.sessionId)}`);
  if (!state.windows.some((item) => item.id === state.windowId)) {
    state.windowId = state.windows.find((item) => item.active)?.id || state.windows[0]?.id || "";
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
  await Promise.all([refreshSnapshot(), refreshInspect()]);
}

async function selectPane(paneId) {
  state.paneId = paneId;
  renderPanes();
  loadChat();
  renderTargetLabels();
  renderChat();
  await Promise.all([refreshSnapshot(), refreshInspect()]);
  if (window.matchMedia("(max-width: 720px)").matches) {
    closeTargetPicker();
  }
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
    if (addToChat) {
      addChat("pane", excerptForChat(data.text), "tmux output");
    }
  } catch (error) {
    els.snapshot.textContent = error.message;
    addChat("system", error.message, "error");
  }
}

async function refreshInspect() {
  if (!state.paneId) {
    empty(els.inspect, "Select a pane");
    return;
  }
  try {
    const params = new URLSearchParams({
      paneId: state.paneId,
      lines: String(state.lines),
    });
    const data = await api(`/api/inspect?${params}`);
    const errors = data.summary.errors.length
      ? data.summary.errors.map((line) => `<div>${escapeHtml(line)}</div>`).join("")
      : "None";
    els.inspect.innerHTML = `
      <div class="inspect-row">
        <div class="inspect-label">Command</div>
        <div class="inspect-value">${escapeHtml(data.command || "unknown")}</div>
      </div>
      <div class="inspect-row">
        <div class="inspect-label">Directory</div>
        <div class="inspect-value">${escapeHtml(data.cwd || "")}</div>
      </div>
      <div class="inspect-row">
        <div class="inspect-label">Last line</div>
        <div class="inspect-value">${escapeHtml(data.summary.lastLine || "")}</div>
      </div>
      <div class="inspect-row">
        <div class="inspect-label">Recent errors</div>
        <div class="inspect-value">${errors}</div>
      </div>
      <div class="inspect-row">
        <div class="inspect-label">Pane</div>
        <div class="inspect-value">${escapeHtml(data.paneId)} · pid ${escapeHtml(data.pid)}</div>
      </div>
    `;
  } catch (error) {
    els.inspect.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

async function sendMessage(text, enter) {
  if (!state.paneId) {
    addChat("system", "Select a pane first.", "system");
    return;
  }

  addChat("user", text || "[Enter]", enter ? "send + Enter" : "send");
  await api("/api/send", {
    method: "POST",
    body: JSON.stringify({ paneId: state.paneId, text, enter }),
  });
  window.setTimeout(() => refreshSnapshot(true), 350);
  window.setTimeout(refreshInspect, 500);
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
  window.setTimeout(refreshInspect, 500);
}

async function runActionCommand(command) {
  closeActionSheet();
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
      refreshInspect();
    }, 3000);
  }
}

els.refreshTree.addEventListener("click", refreshTree);
els.mobileRefreshTree.addEventListener("click", async () => {
  await refreshTree();
  await loadWindowSummaries({ force: true });
});
els.mobileRefresh.addEventListener("click", () => {
  refreshTree();
  refreshSnapshot();
  refreshInspect();
});
els.summarize.addEventListener("click", refreshInspect);
els.refreshSnapshot.addEventListener("click", () => refreshSnapshot());
els.lineCount.addEventListener("change", () => {
  state.lines = Number(els.lineCount.value);
  refreshSnapshot();
  refreshInspect();
});
els.autoRefresh.addEventListener("change", () => setAutoRefresh(els.autoRefresh.checked));
els.clearChat.addEventListener("click", () => {
  state.chat = [];
  saveChat();
  renderChat();
});
els.openTargetPicker.addEventListener("click", openTargetPicker);
els.closeTargetPicker.addEventListener("click", closeTargetPicker);
els.targetBackdrop.addEventListener("click", closeTargetPicker);
els.voiceButton.addEventListener("click", toggleVoiceRecording);
els.openActionSheet.addEventListener("click", openActionSheet);
els.closeActionSheet.addEventListener("click", closeActionSheet);
els.actionBackdrop.addEventListener("click", closeActionSheet);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.targetPickerOpen) {
    closeTargetPicker();
  } else if (event.key === "Escape" && state.actionSheetOpen) {
    closeActionSheet();
  }
});

for (const button of document.querySelectorAll("[data-mode]")) {
  button.addEventListener("click", () => setCaptureMode(button.dataset.mode));
}

for (const button of document.querySelectorAll("[data-key]")) {
  button.addEventListener("click", async () => {
    try {
      if (button.closest("#actionSheet")) {
        closeActionSheet();
      }
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

els.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = els.messageInput.value;
  if (!text && !els.sendEnter.checked) return;
  els.messageInput.value = "";
  try {
    await sendMessage(text, els.sendEnter.checked);
  } catch (error) {
    addChat("system", error.message, "error");
  }
});

els.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    els.composer.requestSubmit();
  }
});

refreshTree();

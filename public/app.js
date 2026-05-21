const SNAPSHOT_BOTTOM_SLOP_PX = 8;
const MAX_WAVEFORM_SAMPLES = 40;
const WAVEFORM_SAMPLE_INTERVAL_MS = 200;

const state = {
  sessions: [],
  windows: [],
  windowSummaries: {},
  summariesLoading: false,
  panes: [],
  sessionId: "",
  windowId: "",
  paneId: "",
  lines: 120,
  autoRefreshTimer: null,
  chat: [],
  targetPickerOpen: false,
  snapshotFullscreen: false,
  snapshotPinnedToBottom: true,
  pendingUrlTarget: readUrlTarget(),
  voice: {
    analyser: null,
    audioContext: null,
    chunks: [],
    cancelRequested: false,
    mediaRecorder: null,
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
  sessionNameInput: document.querySelector("#sessionNameInput"),
  createSession: document.querySelector("#createSession"),
  renameSession: document.querySelector("#renameSession"),
  mobileWindows: document.querySelector("#mobileWindows"),
  mobileTargetLabel: document.querySelector("#mobileTargetLabel"),
  snapshot: document.querySelector("#snapshot"),
  chat: document.querySelector("#chat"),
  mobileRefreshTree: document.querySelector("#mobileRefreshTree"),
  mobileRefresh: document.querySelector("#mobileRefresh"),
  refreshSnapshot: document.querySelector("#refreshSnapshot"),
  fullscreenSnapshot: document.querySelector("#fullscreenSnapshot"),
  windowActivityStatus: document.querySelector("#windowActivityStatus"),
  newWindow: document.querySelector("#newWindow"),
  killWindow: document.querySelector("#killWindow"),
  lineCount: document.querySelector("#lineCount"),
  autoRefresh: document.querySelector("#autoRefresh"),
  voiceButton: document.querySelector("#voiceButton"),
  voiceTitle: document.querySelector("#voiceTitle"),
  voiceSubtitle: document.querySelector("#voiceSubtitle"),
  voiceRecordingActions: document.querySelector("#voiceRecordingActions"),
  voiceWaveform: document.querySelector("#voiceWaveform"),
  submitVoice: document.querySelector("#submitVoice"),
  cancelVoice: document.querySelector("#cancelVoice"),
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
  const session = selectedSession();
  if (!els.sessionNameInput.matches(":focus")) {
    els.sessionNameInput.value = session?.name || "";
  }
  els.createSession.disabled = false;
  els.renameSession.disabled = !state.sessionId;

  if (state.sessions.length === 0) {
    els.mobileSessionSelect.disabled = true;
    els.mobileSessionSelect.append(new Option("No tmux sessions", ""));
    els.renameSession.disabled = true;
    empty(els.mobileWindows, "No windows");
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

function renderTargetLabels() {
  const session = selectedSession();
  const win = selectedWindow();
  const label =
    session && win ? `${session.name} / ${win.index}:${win.name}` : "No window selected";
  els.mobileTargetLabel.textContent = label;
  renderWindowActivityStatus();
}

function renderWindowActivityStatus() {
  const win = selectedWindow();
  const autoEnabled = Boolean(state.autoRefreshTimer);
  const status = win?.active ? "active" : win ? "background" : "idle";
  const text =
    status === "active" ? "Active" : status === "background" ? "Bg" : "Idle";
  const title = win
    ? `${win.index}:${win.name} is ${win.active ? "active" : "in the background"}; auto refresh is ${autoEnabled ? "on" : "off"}`
    : `No active window selected; auto refresh is ${autoEnabled ? "on" : "off"}`;

  els.windowActivityStatus.textContent = text;
  els.windowActivityStatus.title = title;
  els.windowActivityStatus.setAttribute("aria-label", title);
  els.windowActivityStatus.classList.toggle("active", status === "active");
  els.windowActivityStatus.classList.toggle("background", status === "background");
  els.windowActivityStatus.classList.toggle("idle", status === "idle");
  els.windowActivityStatus.classList.toggle("auto-off", !autoEnabled);
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
  els.voiceRecordingActions.hidden = status !== "recording";
  els.voiceButton.hidden = status === "recording";
  els.submitVoice.disabled = status !== "recording";
  els.cancelVoice.disabled = status !== "recording";
  els.voiceButton.classList.toggle("recording", status === "recording");
  els.voiceButton.classList.toggle(
    "busy",
    status === "transcribing" || status === "sending",
  );
  els.voiceButton.disabled = status !== "idle";
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
      addChat("system", error.message, "voice error");
      stopVoiceAnalysis({ clearWaveform: true });
      state.voice.cancelRequested = false;
      state.voice.mediaRecorder = null;
      state.voice.chunks = [];
      setVoiceStatus(
        "idle",
        "Start Recording",
        "Tap to record a voice command",
      );
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
  setVoiceStatus("idle", "Start Recording", "Tap to record a voice command");
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
    "Tap to record a voice command",
  );
  stopVoiceAnalysis({ clearWaveform: true });
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
      "Start Recording",
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
  const stopping = busy && state.audio.stopRequested;
  els.speakWindow.disabled = false;
  els.speakWindow.textContent = busy ? "Stop" : "Read";
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
      lines: Math.min(state.lines, 500),
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
  const trimmed = text.trimEnd();
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

function updateSnapshotText(text, { forceScrollBottom = false } = {}) {
  const shouldScrollToBottom =
    forceScrollBottom || state.snapshotPinnedToBottom || isSnapshotAtBottom();
  const previousScrollTop = els.snapshot.scrollTop;

  els.snapshot.textContent = text;

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
    state.sessionId = session.id;
    state.windowId = "";
    state.paneId = "";
    resetWindowSummaryState();
    await refreshTree();
    updateTargetUrl();
    setStatus(`new session: ${session.name}`);
    if (state.targetPickerOpen) {
      loadWindowSummaries({ force: true });
    }
  } catch (error) {
    setStatus(error.message, false);
  } finally {
    renderSessions();
  }
}

async function renameTmuxSession() {
  const session = selectedSession();
  const name = sessionNameInputValue();
  if (!session) {
    setStatus("Select a session first", false);
    return;
  }
  if (!name) {
    setStatus("Enter a session name", false);
    els.sessionNameInput.focus();
    return;
  }
  if (name === session.name) {
    setStatus(`session: ${session.name}`);
    return;
  }

  els.renameSession.disabled = true;
  setStatus("renaming session...");
  try {
    const renamed = await api("/api/sessions", {
      method: "PATCH",
      body: JSON.stringify({ sessionId: session.id, name }),
    });
    state.sessionId = renamed.id;
    resetWindowSummaryState();
    await refreshTree();
    updateTargetUrl();
    setStatus(`renamed session: ${renamed.name}`);
    if (state.targetPickerOpen) {
      loadWindowSummaries({ force: true });
    }
  } catch (error) {
    setStatus(error.message, false);
  } finally {
    renderSessions();
  }
}

async function loadWindows({ urlTarget = readUrlTarget(), forceUrlTarget = false } = {}) {
  state.windows = [];
  state.panes = [];
  if (!state.sessionId) {
    resetWindowSummaryState();
    renderWindows();
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
  closeTargetPicker();
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
  const previousPaneId = state.paneId;
  state.panes = [];
  if (!state.windowId) {
    renderTargetLabels();
    return;
  }

  state.panes = await api(`/api/panes?windowId=${encodeURIComponent(state.windowId)}`);
  state.paneId = state.panes.find((pane) => pane.active)?.id || state.panes[0]?.id || "";
  loadChat();
  renderTargetLabels();
  renderChat();
  await refreshSnapshot(false, { forceScrollBottom: state.paneId !== previousPaneId });
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
  renderWindowActivityStatus();
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
els.snapshot.addEventListener(
  "scroll",
  () => {
    state.snapshotPinnedToBottom = isSnapshotAtBottom();
  },
  { passive: true },
);
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
els.sessionNameInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  if (state.sessionId) {
    renameTmuxSession();
    return;
  }
  createTmuxSession();
});
els.createSession.addEventListener("click", createTmuxSession);
els.renameSession.addEventListener("click", renameTmuxSession);
els.openTargetPicker.addEventListener("click", openTargetPicker);
els.windowActivityStatus.addEventListener("click", openTargetPicker);
els.closeTargetPicker.addEventListener("click", closeTargetPicker);
els.targetBackdrop.addEventListener("click", closeTargetPicker);
els.voiceButton.addEventListener("click", toggleVoiceRecording);
els.submitVoice.addEventListener("click", submitVoiceRecording);
els.cancelVoice.addEventListener("click", cancelVoiceRecording);
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

refreshTree({
  urlTarget: state.pendingUrlTarget,
  forceUrlTarget: hasUrlTarget(state.pendingUrlTarget),
  syncUrl: true,
}).then(() => {
  els.autoRefresh.checked = true;
  setAutoRefresh(true);
});

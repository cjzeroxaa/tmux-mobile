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
  if (peerConnection.iceGatheringState === "complete") return Promise.resolve();
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
  if (!clientSecret) throw new Error("Realtime client secret is missing");
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
  if (!response.ok) throw new Error(answerSdp || `Realtime WebRTC HTTP ${response.status}`);
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
          content: [{ type: "input_text", text: inputText }],
        },
      ],
      audio: { output: { voice: data.voice } },
      max_output_tokens: data.maxOutputTokens || "inf",
      metadata: {
        source: "tmux-mobile-read",
        chunk: String(chunkIndex + 1),
        chunks: String(chunkCount),
      },
    },
  };
}

function waitForRealtimeResponse(channel, { logClientEvent = () => {} } = {}, timeoutMs = 90000) {
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
    const handleClose = () => fail(new Error("Realtime data channel closed"));
    const handleError = () => fail(new Error("Realtime data channel failed"));
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
          const statusMessage =
            statusDetails.error?.message ||
            statusDetails.reason ||
            `Realtime response ${status}`;
          logClientEvent("realtime_response_failed", {
            status,
            message: statusMessage,
            statusDetails,
          });
          fail(new Error(statusMessage));
          return;
        }
        logClientEvent("realtime_response_done", { transcriptChars: transcript.length });
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

async function ensureAudioContext(audioState) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return null;
  if (!audioState.context) audioState.context = new AudioContextCtor();
  if (audioState.context.state === "suspended") await audioState.context.resume();
  return audioState.context;
}

async function waitForRealtimePlaybackToFinish({
  audioState,
  audioElement,
  peerConnection,
  stream,
  track,
  transcript,
  logClientEvent = () => {},
}) {
  const timeoutMs = estimateRealtimePlaybackMs(transcript);
  const startedAt = performance.now();
  const quietSettleMs = 2500;
  let lastSoundAt = startedAt;
  let sawSound = false;
  let source = null;
  let analyser = null;
  let samples = null;

  if (stream) {
    try {
      const context = await ensureAudioContext(audioState);
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
      } catch {}
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
      if (stateName === "closed" || stateName === "failed") cleanup(stateName);
    };
    const checkPlayback = () => {
      if (audioState.stopRequested) {
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
      if (!sawSound || now - lastSoundAt < quietSettleMs) return;
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

export function closeRealtimeReadAudio(audioState) {
  if (audioState.abortController) {
    audioState.abortController.abort();
    audioState.abortController = null;
  }
  if (audioState.source) {
    try {
      audioState.source.stop();
    } catch {}
    audioState.source = null;
  }
  if (audioState.dataChannel) {
    try {
      audioState.dataChannel.close();
    } catch {}
    audioState.dataChannel = null;
  }
  if (audioState.peerConnection) {
    audioState.peerConnection.close();
    audioState.peerConnection = null;
  }
  audioState.remoteStream = null;
  audioState.remoteTrack = null;
  if (audioState.audioElement) {
    audioState.audioElement.pause();
    audioState.audioElement.srcObject = null;
    audioState.audioElement.remove();
    audioState.audioElement = null;
  }
}

function throwIfAudioReadStopped(audioState, readId) {
  if (audioState.readId !== readId || audioState.stopRequested) {
    throw new Error("Realtime read stopped");
  }
}

export async function playRealtimeRead({
  audioState,
  api,
  readId,
  windowId,
  paneId,
  machineId = "",
  mux = "",
  logClientEvent = () => {},
  setStatus = () => {},
  onPlaybackBlocked = () => {},
}) {
  if (!window.RTCPeerConnection) {
    throw new Error("Realtime audio is not supported in this browser");
  }

  closeRealtimeReadAudio(audioState);
  const abortController = new AbortController();
  audioState.abortController = abortController;
  const peerConnection = new RTCPeerConnection();
  const dataChannel = peerConnection.createDataChannel("oai-events");
  const audioElement = new Audio();
  audioElement.autoplay = true;
  audioElement.playsInline = true;
  audioElement.hidden = true;
  audioElement.setAttribute("playsinline", "");
  document.body.append(audioElement);

  audioState.peerConnection = peerConnection;
  audioState.dataChannel = dataChannel;
  audioState.audioElement = audioElement;

  peerConnection.addTransceiver("audio", { direction: "recvonly" });
  peerConnection.addEventListener("connectionstatechange", () => {
    setStatus(`realtime: ${peerConnection.connectionState}`);
    logClientEvent("realtime_connection_state", { state: peerConnection.connectionState });
  });
  peerConnection.addEventListener("track", (event) => {
    const stream = event.streams[0] || new MediaStream([event.track]);
    audioState.remoteStream = stream;
    audioState.remoteTrack = event.track;
    audioElement.srcObject = stream;
    audioElement.play().catch((error) => {
      console.warn("Realtime audio playback was blocked.", error);
      logClientEvent("realtime_playback_blocked", { message: error.message });
      onPlaybackBlocked(error);
    });
  });

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  await waitForIceGatheringComplete(peerConnection);
  throwIfAudioReadStopped(audioState, readId);

  const data = await api("/api/window-realtime-session", {
    method: "POST",
    signal: abortController.signal,
    machineId,
    mux,
    body: JSON.stringify({ windowId, paneId }),
  });
  throwIfAudioReadStopped(audioState, readId);
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
  throwIfAudioReadStopped(audioState, readId);

  await peerConnection.setRemoteDescription({ type: "answer", sdp: answerSdp });
  logClientEvent("realtime_remote_description_set", {
    model: data.model,
    voice: data.voice,
    lines: data.lines,
  });
  await waitForDataChannelOpen(dataChannel);
  throwIfAudioReadStopped(audioState, readId);
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
    throwIfAudioReadStopped(audioState, readId);
    logClientEvent("realtime_response_chunk_started", {
      chunk: index + 1,
      chunks: inputChunks.length,
      inputChars: inputChunks[index].length,
    });
    setStatus(`realtime: reading ${index + 1}/${inputChunks.length}`);
    const responseDone = waitForRealtimeResponse(dataChannel, { logClientEvent });
    sendRealtimeEvent(
      dataChannel,
      realtimeResponseEvent(data, inputChunks[index], index, inputChunks.length),
    );
    const result = await responseDone;
    throwIfAudioReadStopped(audioState, readId);
    if (result.transcript.trim()) transcripts.push(result.transcript.trim());
  }

  const transcript = transcripts.join("\n\n");
  setStatus("realtime: finishing audio");
  await waitForRealtimePlaybackToFinish({
    audioState,
    audioElement,
    peerConnection,
    stream: audioState.remoteStream,
    track: audioState.remoteTrack,
    transcript: transcript || inputChunks.join("\n\n"),
    logClientEvent,
  });
  throwIfAudioReadStopped(audioState, readId);
  closeRealtimeReadAudio(audioState);
  return {
    transcript,
    model: data.model,
    voice: data.voice,
  };
}

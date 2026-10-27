import {
  createStreamingAsrSession,
  createPcmResampler,
  dictationText,
  streamingDictationControl,
} from "./streaming-asr-session.js";

// One explicit button; stopping adds text but never sends the Agent a message.
export function bindStreamingDictation({
  button,
  getText,
  setText,
  setStatus,
  isBlocked = () => false,
  onActive = () => {},
  controls = [],
  input,
  getStreamUrl = () => "/api/asr/stream",
  disableWhenBlocked = false,
}) {
  // An already open page may still have the previous HTML during a rollout.
  if (!button) return { cancel() {}, refresh() {}, active: false };
  let current = null;
  button.classList.add("streaming-dictation");
  const saved = new Map();
  let savedReadOnly;
  const setActive = (active) => {
    if (active) {
      for (const el of controls.filter(Boolean)) {
        saved.set(el, el.disabled);
        el.disabled = true;
      }
      if (input) {
        if ("readOnly" in input) { savedReadOnly = input.readOnly; input.readOnly = true; }
        input.contentEditable = "false";
        input.setAttribute("aria-busy", "true");
      }
    } else {
      for (const [el, disabled] of saved) el.disabled = disabled;
      saved.clear();
      if (input) {
        if ("readOnly" in input) input.readOnly = savedReadOnly;
        input.contentEditable = "true";
        input.removeAttribute("aria-busy");
      }
    }
    onActive(active);
  };
  const render = () => {
    const mode = !current
      ? "idle"
      : current.starting
        ? "connecting"
        : current.finishing
          ? "finishing"
          : "recording";
    const control = streamingDictationControl(mode);
    button.dataset.streamingState = mode;
    button.classList.toggle("recording", mode === "recording");
    button.setAttribute("aria-pressed", String(mode === "recording"));
    button.title = control.hint;
    button.setAttribute("aria-label", control.hint);
    button.disabled = control.disabled || (disableWhenBlocked && !current && isBlocked());
    const icons = {
      wave: '<path d="M2 10v4M6 6v12M10 3v18M14 8v8M18 5v14M22 10v4"/>',
      stop: '<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none"/>',
      cancel: '<path d="m6 6 12 12M18 6 6 18"/>',
      spinner: '<path d="M12 3a9 9 0 1 1-9 9"/>',
    };
    button.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">${icons[control.icon]}</svg><span>${control.label}</span>`;
  };
  const cleanup = async (state) => {
    state.closed = true;
    state.stream?.getTracks().forEach((track) => track.stop());
    state.node?.disconnect();
    state.source?.disconnect();
    await state.context?.close().catch(() => {});
  };
  const cancel = () => {
    const state = current;
    if (!state) return;
    current = null;
    state.closed = true;
    state.session?.cancel();
    void cleanup(state);
    setActive(false);
    render();
    setStatus("Live dictation stopped. Your current text was kept.");
  };
  const start = async () => {
    if (isBlocked()) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
      setStatus(
        "Live dictation is unavailable in this browser. You can still type.",
      );
      return;
    }
    const state = {
      base: getText(),
      starting: true,
      closed: false,
      finishing: false,
    };
    current = state;
    render();
    setActive(true);
    setStatus("Connecting live dictation…");
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      if (state.closed) {
        await cleanup(state);
        return;
      }
      state.context = new AudioContext();
      await state.context.resume();
      await state.context.audioWorklet.addModule("/streaming-asr-worklet.js");
      if (state.closed) {
        await cleanup(state);
        return;
      }
      const url = new URL(getStreamUrl(), location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      state.session = createStreamingAsrSession({
        url: url.href,
        onTranscript: (text) => {
          if (current === state) {
            setText(dictationText(state.base, text));
            setStatus(
              state.finishing
                ? "Microphone off · Finishing transcription…"
                : "Listening · Tap Stop to finish",
            );
          }
        },
        onEnd: (error) => {
          if (current !== state) return;
          current = null;
          void cleanup(state);
          setActive(false);
          render();
          setStatus(error || "Voice added");
        },
      });
      await state.session.start();
      if (state.closed) return;
      const resample = createPcmResampler(state.context.sampleRate);
      state.source = state.context.createMediaStreamSource(state.stream);
      state.node = new AudioWorkletNode(
        state.context,
        "tmax-streaming-microphone",
      );
      const silent = state.context.createGain();
      silent.gain.value = 0;
      state.node.port.onmessage = (event) => {
        if (state.closed) return;
        if (event.data.samples)
          state.session.audio(resample(event.data.samples));
        if (event.data.done) {
          void cleanup(state);
          state.session.finish();
        }
      };
      state.source.connect(state.node);
      state.node.connect(silent).connect(state.context.destination);
      state.starting = false;
      render();
      setStatus("Listening · Tap Stop to finish");
    } catch (error) {
      if (current === state) {
        cancel();
        setStatus(
          error.name === "NotAllowedError"
            ? "Microphone permission denied."
            : error.message || "Live dictation failed.",
        );
      } else await cleanup(state);
    }
  };
  button.addEventListener("click", () => {
    if (current) {
      if (current.starting) {
        cancel();
        return;
      }
      if (current.finishing) return;
      current.finishing = true;
      // Stop capture immediately; the worklet flushes only its buffered samples.
      current.stream?.getTracks().forEach((track) => track.stop());
      render();
      setStatus("Microphone off · Finishing transcription…");
      current.node.port.postMessage("finish");
    } else void start();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancel();
  });
  window.addEventListener("pagehide", cancel);
  render();
  return {
    cancel,
    refresh: render,
    get active() {
      return !!current;
    },
  };
}

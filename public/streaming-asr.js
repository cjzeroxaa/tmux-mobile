import {
  createStreamingAsrSession,
  createPcmResampler,
  dictationText,
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
}) {
  // An already open page may still have the previous HTML during a rollout.
  if (!button) return { cancel() {}, active: false };
  let current = null;
  const saved = new Map();
  const setActive = (active) => {
    if (active) {
      for (const el of controls.filter(Boolean)) {
        saved.set(el, el.disabled);
        el.disabled = true;
      }
      if (input) {
        input.contentEditable = "false";
        input.setAttribute("aria-busy", "true");
      }
    } else {
      for (const [el, disabled] of saved) el.disabled = disabled;
      saved.clear();
      if (input) {
        input.contentEditable = "true";
        input.removeAttribute("aria-busy");
      }
    }
    onActive(active);
  };
  const render = () => {
    button.classList.toggle("recording", !!current);
    button.setAttribute("aria-pressed", String(!!current));
    const label = current ? "Stop live dictation" : "Live dictation (Free ASR)";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.disabled = !!current?.finishing || !!current?.starting;
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
        "Live dictation is unavailable in this browser. Use the regular microphone.",
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
      const url = new URL("/api/asr/stream", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      state.session = createStreamingAsrSession({
        url: url.href,
        onTranscript: (text) => {
          if (current === state) {
            setText(dictationText(state.base, text));
            setStatus(
              state.finishing
                ? "Finishing live dictation…"
                : "Listening · Free ASR",
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
      setStatus("Listening · Free ASR");
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
      if (current.starting || current.finishing) return;
      current.finishing = true;
      render();
      setStatus("Finishing live dictation…");
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
    get active() {
      return !!current;
    },
  };
}

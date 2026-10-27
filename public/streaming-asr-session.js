// Shared Web/native transport. Audio is sent only after explicit microphone start.
export function streamingDictationControl(mode) {
  const controls = {
    idle: {
      label: "Start",
      hint: "Start live dictation",
      icon: "wave",
      disabled: false,
    },
    connecting: {
      label: "Cancel",
      hint: "Cancel live dictation connection",
      icon: "cancel",
      disabled: false,
    },
    recording: {
      label: "Stop",
      hint: "Stop live dictation",
      icon: "stop",
      disabled: false,
    },
    finishing: {
      label: "Wait",
      hint: "Microphone off. Finishing transcription",
      icon: "spinner",
      disabled: true,
    },
  };
  return controls[mode] || controls.idle;
}

export function dictationText(base, text) {
  return base + (base && text && !/\s$/.test(base) ? " " : "") + text;
}
export function createPcmResampler(sampleRate, channels = 1) {
  if (
    !Number.isFinite(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 192000 ||
    ![1, 2].includes(channels)
  )
    throw new Error("Unsupported microphone format");
  const ratio = sampleRate / 16000;
  let fill = 0,
    sum = 0;
  return (samples) => {
    const out = [];
    for (let i = 0; i < samples.length; i += channels) {
      let sample = 0;
      for (let ch = 0; ch < channels; ch++) sample += samples[i + ch] || 0;
      sample /= channels;
      let remaining = 1;
      while (remaining > 1e-9) {
        const take = Math.min(remaining, ratio - fill);
        sum += sample * take;
        fill += take;
        remaining -= take;
        if (fill >= ratio - 1e-9) {
          const value = Math.max(-1, Math.min(1, sum / ratio));
          out.push(Math.round(value * (value < 0 ? 32768 : 32767)));
          fill = 0;
          sum = 0;
        }
      }
    }
    const bytes = new ArrayBuffer(out.length * 2),
      view = new DataView(bytes);
    out.forEach((value, index) => view.setInt16(index * 2, value, true));
    return bytes;
  };
}
export function createStreamingAsrSession({
  url,
  format = "pcm16",
  createSocket = (url) => new WebSocket(url),
  onTranscript = () => {},
  onEnd = () => {},
}) {
  let socket,
    ended = false,
    ready = false,
    finishing = false,
    resolveReady,
    rejectReady,
    timer;
  const end = (error) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    if (!ready) rejectReady?.(new Error(error || "Streaming input cancelled"));
    socket?.close();
    onEnd(error);
  };
  return {
    start() {
      return new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
        try {
          socket = createSocket(url);
        } catch (error) {
          end(error.message);
          return;
        }
        timer = setTimeout(
          () =>
            end(
              "Streaming speech did not connect. Try the regular microphone.",
            ),
          20000,
        );
        socket.onopen = () => {
          if (!ended) socket.send(JSON.stringify({ type: "start", format }));
        };
        socket.onmessage = (event) => {
          if (ended) return;
          try {
            const value = JSON.parse(event.data);
            if (value.type === "ready") {
              ready = true;
              clearTimeout(timer);
              resolveReady();
            } else if (
              value.type === "transcript" &&
              typeof value.text === "string"
            )
              onTranscript(value.text, value.final === true);
            else if (value.type === "done") end();
            else if (value.type === "error")
              end(
                value.message ||
                  "Streaming input failed. Your current text was kept.",
              );
          } catch {
            end("Invalid speech response. Your current text was kept.");
          }
        };
        socket.onerror = () =>
          end(
            "Streaming speech connection failed. Your current text was kept.",
          );
        socket.onclose = () =>
          end("Streaming speech disconnected. Your current text was kept.");
      });
    },
    audio(bytes) {
      if (!ready || ended || finishing) return;
      if (socket.bufferedAmount > 256 * 1024) {
        end("Connection is too slow. Your current text was kept.");
        return;
      }
      try {
        for (let offset = 0; offset < bytes.byteLength; offset += 32768)
          socket.send(bytes.slice(offset, offset + 32768));
      } catch {
        end("Streaming speech disconnected. Your current text was kept.");
      }
    },
    finish() {
      if (!ready || ended || finishing) return;
      finishing = true;
      timer = setTimeout(
        () => end("Final transcription timed out. Your current text was kept."),
        20000,
      );
      try {
        socket.send(JSON.stringify({ type: "finish" }));
      } catch {
        end("Streaming speech disconnected. Your current text was kept.");
      }
    },
    cancel(error) {
      if (socket?.readyState === 1) {
        try {
          socket.send(JSON.stringify({ type: "cancel" }));
        } catch {}
      }
      end(error);
    },
  };
}

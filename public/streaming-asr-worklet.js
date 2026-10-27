class StreamingMicrophone extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
    this.active = true;
    this.port.onmessage = (event) => {
      if (event.data === "finish") {
        this.flush();
        this.active = false;
        this.port.postMessage({ done: true });
      }
    };
  }
  flush() {
    if (!this.offset) return;
    const data = this.buffer.slice(0, this.offset);
    this.port.postMessage({ samples: data }, [data.buffer]);
    this.offset = 0;
  }
  process(inputs) {
    if (!this.active) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] || 0;
      this.buffer[this.offset++] = value / channels.length;
      if (this.offset === this.buffer.length) this.flush();
    }
    return true;
  }
}
registerProcessor("tmax-streaming-microphone", StreamingMicrophone);

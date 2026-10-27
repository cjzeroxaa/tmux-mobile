// Protocol source: https://github.com/nomoat/free-asr/blob/main/PROTOCOL.md
// Keep the provider wire format on the Controller; clients send audio only.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

function varint(value) {
  const out = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    out.push(byte | (value ? 128 : 0));
  } while (value);
  return Buffer.from(out);
}
export function encodeAsrRequest({
  event,
  taskId,
  payload = "",
  data,
  seq = 0,
}) {
  const parts = [];
  for (const [field, value] of [
    [2, "OrnqKvSSrs"],
    [3, "ASR"],
    [5, event],
    [6, payload],
    [7, data],
    [8, taskId],
  ]) {
    if (!value?.length) continue;
    const bytes = Buffer.from(value);
    parts.push(varint(field * 8 + 2), varint(bytes.length), bytes);
  }
  if (seq) parts.push(varint(72), varint(seq));
  return Buffer.concat(parts);
}
export function decodeAsrResponse(bytes) {
  const fields = {};
  let offset = 0;
  const read = () => {
    let n = 0,
      multiplier = 1;
    for (let count = 0; count < 8 && offset < bytes.length; count++) {
      const b = bytes[offset++];
      n += (b & 127) * multiplier;
      if (!(b & 128)) return n;
      multiplier *= 128;
    }
    throw new Error("Invalid ASR frame");
  };
  while (offset < bytes.length) {
    const tag = read(),
      field = Math.floor(tag / 8),
      wire = tag % 8;
    if (wire === 0) fields[field] = read();
    else if (wire === 2) {
      const size = read();
      if (offset + size > bytes.length) throw new Error("Truncated ASR frame");
      fields[field] = bytes.subarray(offset, offset + size).toString();
      offset += size;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.length) throw new Error("Truncated ASR frame");
    } else throw new Error("Invalid ASR frame");
  }
  return {
    event: fields[4] || "",
    status: fields[5],
    message: fields[6],
    payload: fields[7] || "",
  };
}

export class FreeAsrSession extends EventEmitter {
  constructor({ deviceId, Socket = WebSocket }) {
    super();
    this.deviceId = deviceId;
    this.Socket = Socket;
    this.taskId = randomUUID().replaceAll("-", "");
    this.seq = 0;
    this.carry = Buffer.alloc(0);
    this.ended = false;
  }
  start() {
    const url = new URL(
      "wss://frontier-audio-ime-ws.doubao.com/ocean/api/v1/ws",
    );
    for (const [key, value] of Object.entries({
      aid: "685343",
      device_id: this.deviceId,
      app_name: "oime_macos",
      channel: "release",
      device_platform: "mac",
      device_type: "mac",
      device_brand: "Apple",
      os: "macOS",
      os_version: "15.6.0",
      version_code: "1.0.2",
      version_name: "1.0.2",
      app_version: "1.0.2",
    }))
      url.searchParams.set(key, value);
    this.ws = new this.Socket(url, {
      handshakeTimeout: 10000,
      maxPayload: 1024 * 1024,
      headers: {
        "proto-version": "v2",
        "sdk-version": "2",
        "x-tt-token": "",
        "x-tt-e-k": this.deviceId + "+W",
        "x-custom-keepalive": "true",
      },
    });
    this.ws.on("open", () => {
      this.send("StartTask");
      this.send("StartSession", {
        audio_info: { channel: 1, format: "pcm", sample_rate: 16000 },
        enable_punctuation: true,
        enable_speech_rejection: false,
        extra: {
          app_name: "oime_macos",
          app_version: "1.0.2",
          device_id: this.deviceId,
          enable_asr_format: true,
          enable_asr_threepass: true,
          enable_asr_twopass: true,
          enable_print_chinese: true,
          enable_text_filter: true,
          finish_wait_offline_time: 1000,
          input_mode: "wave",
          join_user_experience_improve_program: false,
          remove_space_between_han_eng: false,
          remove_space_between_han_num: true,
          strong_ddc: true,
          use_twopass_retry: true,
        },
      });
    });
    this.ws.on("message", (bytes, binary) => {
      if (!binary) {
        if (bytes.toString() === "ping") this.ws.send("pong");
        return;
      }
      try {
        const frame = decodeAsrResponse(bytes);
        if (frame.status && frame.status !== 20000000)
          throw new Error(
            "Streaming speech service rejected this session. Try the regular microphone.",
          );
        if (/Failed$/.test(frame.event))
          throw new Error(
            "Streaming speech service failed. Try the regular microphone.",
          );
        if (frame.event === "SessionStarted") this.emit("ready");
        if (frame.payload) {
          const payload = JSON.parse(frame.payload),
            result = payload.results?.[0];
          if (typeof result?.text === "string")
            this.emit("transcript", {
              text: result.text,
              final: result.is_interim === false,
            });
        }
        if (frame.event === "SessionFinished") {
          this.ended = true;
          this.send("FinishTask");
          this.emit("done");
          this.close();
        }
      } catch (error) {
        this.emit("error", error);
        this.close();
      }
    });
    this.ws.on("error", () =>
      this.emit(
        "error",
        new Error(
          "Could not connect to streaming speech. Try the regular microphone.",
        ),
      ),
    );
    this.ws.on("close", () => {
      if (!this.ended)
        this.emit(
          "error",
          new Error(
            "Streaming speech disconnected. Your current text was kept.",
          ),
        );
    });
  }
  send(event, payload, data, seq) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      encodeAsrRequest({
        event,
        taskId: this.taskId,
        payload: payload ? JSON.stringify(payload) : "",
        data,
        seq,
      }),
    );
  }
  audio(bytes) {
    if (this.ended) return;
    if (this.ws.bufferedAmount > 256 * 1024)
      throw new Error(
        "Streaming speech connection is too slow. Your current text was kept.",
      );
    this.carry = Buffer.concat([this.carry, bytes]);
    while (this.carry.length >= 3200) {
      this.send(
        "TaskRequest",
        { timestamp_ms: Date.now() },
        this.carry.subarray(0, 3200),
        ++this.seq,
      );
      this.carry = this.carry.subarray(3200);
    }
  }
  finish() {
    if (this.carry.length) {
      this.send(
        "TaskRequest",
        { timestamp_ms: Date.now() },
        this.carry,
        ++this.seq,
      );
      this.carry = Buffer.alloc(0);
    }
    this.send("FinishSession");
  }
  close() {
    this.ended = true;
    this.ws?.terminate();
  }
}

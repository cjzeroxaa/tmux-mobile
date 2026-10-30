import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { FailoverAsrSession } from "./asr-failover.mjs";

export const ASR_PATH = "/api/asr/stream";
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export function decoderArguments(format) {
  if (!["wav", "aac"].includes(format))
    throw new Error("Unsupported streaming audio format");
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-protocol_whitelist",
    "pipe",
    "-f",
    format,
    "-probesize",
    "32",
    "-analyzeduration",
    "0",
    ...(format === "wav" ? ["-ignore_length", "1"] : []),
    "-i",
    "pipe:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    "-f",
    "s16le",
    "-flush_packets",
    "1",
    "pipe:1",
  ];
}
export function attachStreamingAsr(
  server,
  {
    authenticate,
    origin,
    secret,
    createSession = (options) => new FailoverAsrSession(options),
    spawnDecoder = (format) =>
      spawn("ffmpeg", decoderArguments(format), {
        stdio: ["pipe", "pipe", "pipe"],
      }),
  },
) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  const owners = new Map();
  let total = 0;
  const reject = (socket, status) =>
    socket.end(
      `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  server.on("upgrade", (req, socket, head) => {
    let path;
    try {
      path = new URL(req.url, "http://localhost").pathname;
    } catch {
      return;
    }
    if (path !== ASR_PATH) return;
    const viewer = authenticate(req);
    if (!viewer?.userId) return reject(socket, "401 Unauthorized");
    if (req.headers.origin && req.headers.origin !== origin(req))
      return reject(socket, "403 Forbidden");
    if ((owners.get(viewer.userId) || 0) >= 2 || total >= 16)
      return reject(socket, "429 Too Many Requests");
    wss.handleUpgrade(req, socket, head, (client) => {
      owners.set(viewer.userId, (owners.get(viewer.userId) || 0) + 1);
      total++;
      const deviceId = (
        (BigInt(
          "0x" +
            createHmac("sha256", secret || "local-asr")
              .update(viewer.userId)
              .digest("hex")
              .slice(0, 15),
        ) %
          9000000000000000n) +
        1000000000000000n
      ).toString();
      let session,
        decoder,
        started = false,
        ready = false,
        finishing = false,
        closed = false,
        inputBytes = 0,
        pcmBytes = 0;
      let finishTimer, idleTimer;
      const send = (value) => {
        if (client.readyState === WebSocket.OPEN)
          client.send(JSON.stringify(value));
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearTimeout(connectTimer);
        clearTimeout(limitTimer);
        clearTimeout(finishTimer);
        clearTimeout(idleTimer);
        session?.close();
        decoder?.kill("SIGKILL");
        const count = (owners.get(viewer.userId) || 1) - 1;
        if (count) owners.set(viewer.userId, count);
        else owners.delete(viewer.userId);
        total--;
      };
      const fail = (message) => {
        if (closed) return;
        send({ type: "error", message });
        cleanup();
        client.close(1000);
      };
      const connectTimer = setTimeout(
        () =>
          fail("Streaming speech did not connect. Try the regular microphone."),
        15000,
      );
      const limitTimer = setTimeout(
        () =>
          fail(
            "Streaming input reached ten minutes. Your text was kept; start again to continue.",
          ),
        600000,
      );
      const touch = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => fail("No audio received. Your current text was kept."),
          30000,
        );
      };
      const pcm = (bytes) => {
        if (closed) return;
        pcmBytes += bytes.length;
        if (pcmBytes > MAX_AUDIO_BYTES)
          return fail(
            "Streaming audio is too long. Your current text was kept.",
          );
        try {
          session.audio(bytes);
        } catch (error) {
          fail(error.message);
        }
      };
      client.on("error", cleanup);
      client.on("close", cleanup);
      client.on("message", (bytes, binary) => {
        if (closed) return;
        try {
          if (binary) {
            if (!ready || finishing)
              throw new Error("Audio arrived outside the recording session");
            inputBytes += bytes.length;
            if (inputBytes > MAX_AUDIO_BYTES)
              throw new Error("Streaming audio is too long");
            touch();
            if (decoder) {
              if (decoder.stdin.writableLength > 256 * 1024)
                throw new Error(
                  "Audio processing is too slow. Your current text was kept.",
                );
              decoder.stdin.write(bytes);
            } else {
              if (bytes.length % 2) throw new Error("Invalid PCM audio");
              pcm(bytes);
            }
            return;
          }
          if (bytes.length > 512) throw new Error("Invalid streaming request");
          const message = JSON.parse(bytes.toString());
          if (message.type === "start" && !started) {
            if (!["pcm16", "wav", "aac"].includes(message.format))
              throw new Error("Unsupported streaming audio format");
            started = true;
            if (message.provider !== undefined && !["doubao", "wetype"].includes(message.provider))
              throw new Error("Unsupported speech provider");
            session = createSession({ deviceId, providers: message.provider === "wetype" ? ["wetype", "doubao"] : ["doubao", "wetype"] });
            session.on("error", (error) => fail(error.message));
            session.on("transcript", (result) =>
              send({ type: "transcript", ...result }),
            );
            session.on("done", () => {
              send({ type: "done" });
              cleanup();
              client.close(1000);
            });
            session.on("ready", () => {
              if (closed) return;
              if (message.format !== "pcm16") {
                decoder = spawnDecoder(message.format);
                decoder.on("error", () =>
                  fail(
                    "Audio decoder is unavailable. Try the regular microphone.",
                  ),
                );
                decoder.stdin.on("error", () => {
                  if (!closed)
                    fail(
                      "Could not decode microphone audio. Your current text was kept.",
                    );
                });
                decoder.stderr.on("data", () => {});
                decoder.stdout.on("data", pcm);
                decoder.on("close", (code) => {
                  if (closed) return;
                  if (code !== 0 || !finishing)
                    return fail(
                      "Could not decode microphone audio. Your current text was kept.",
                    );
                  session.finish();
                });
              }
              ready = true;
              clearTimeout(connectTimer);
              touch();
              send({ type: "ready" });
            });
            session.start();
          } else if (message.type === "finish" && ready && !finishing) {
            finishing = true;
            clearTimeout(idleTimer);
            finishTimer = setTimeout(
              () =>
                fail(
                  "Final transcription timed out. Your current text was kept.",
                ),
              15000,
            );
            if (decoder) decoder.stdin.end();
            else session.finish();
          } else if (message.type === "cancel") {
            cleanup();
            client.close(1000);
          } else throw new Error("Invalid streaming request");
        } catch (error) {
          fail(error.message || "Streaming input failed");
        }
      });
    });
  });
  return wss;
}

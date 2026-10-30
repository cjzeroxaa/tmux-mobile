# Live dictation (Free ASR)

The waveform button streams speech into the composer.
The button says Start when idle, Cancel while connecting, and a red Stop while recording. Press Stop to turn off the microphone immediately. Wait indicates finalization with the microphone off.
The final result replaces the interim text. The original draft stays before the
new dictation. Send remains a separate action. The old complete-recording microphone button is hidden. Keyboard dictation shortcuts use the same streaming toggle.

The input and send/edit controls are locked during capture and finalization.
Errors retain the latest text. Vision Pro uses the same compact controls and text fields as the other native clients; old Vision-only preferences are ignored and its chooser/settings entry are removed. Closing the composer, switching sessions, leaving
the page or backgrounding the mobile app stops capture and cancels the stream.
Late results must never modify another session's draft.

## Transport

The Controller hosts authenticated WebSocket `/api/asr/stream`. Browsers use the
existing session cookie and an exact same-origin check; native uses the existing
Bearer header. No token goes in a URL. This endpoint never sends a terminal
command or Agent message. The client sends `{type:"start", format:"pcm16"}`,
waits for `{type:"ready"}`, then sends binary audio chunks. Supported formats are
16 kHz mono signed little-endian PCM, WAV and AAC ADTS. `{type:"finish"}` flushes
audio and waits for final text; `{type:"cancel"}` discards the active stream.
Responses are `transcript` (`text`, `final`), `done`, or `error` (`message`).

The Controller implements the protocol documented in the owner's
[nomoat/free-asr](https://github.com/nomoat/free-asr), source revision
`8e0a8b0ed73b27949e3a3d98f3706e394c3d5a98`. Doubao is the default primary;
WeChat Input Method (WeType) is the automatic backup. An authenticated start
request may select `provider:"wetype"` to reverse that order. Each provider is
attempted at most once per recording. Connection errors, disconnects and final
response timeouts trigger the other provider. The Controller retains at most
20 MiB of PCM in memory for replay, then releases it on completion/cancellation.
Backup partials replace the current dictation only after catching up in length;
the final corrected text always replaces it. Both providers failing returns an
error and preserves the latest draft. Existing client deadlines still apply,
so an unusually long/slow replay may time out instead of recovering.

WeType uses OpenSSL-backed Node crypto for ECDH/AES and the existing FFmpeg
installation (`libopus`, 20 ms frames) for live PCM-to-Opus encoding. It works on
Linux and macOS; no Apple audio tools are used on the Controller. Anonymous
WeType identity/key state is cached in process memory and refreshed on expiry.
Device codes are stable per user, derived from the existing HMAC device ID.
Neither provider's identifiers are rotated to evade limits. Audio and text are
never written to disk or logs. These reverse-engineered consumer interfaces can
change independently.

Web uses an AudioWorklet and continuous resampling. Current native binaries use
Expo AudioStream directly, with conversion from the actual hardware sample rate.
Older binaries use the existing Expo recorder and read only new file bytes every
150 ms: WAV PCM on iOS and streaming AAC ADTS on Android. They keep one continuous
recording and one recognition session. Temporary recording files are deleted
when capture ends. MP4 recordings are unsuitable here because their required
metadata may only become available after stopping.

The Controller image includes FFmpeg to decode WAV/AAC streams to PCM. Inputs
are fixed formats on stdin; the decoder can use only the pipe protocol, and
output is mono 16 kHz PCM. Limits are 64 KiB per frame, 20 MiB audio, ten minutes,
30 seconds without audio, 15 seconds to connect/finalize, two streams per user,
and 16 streams per Controller process. Client/provider queues are bounded.
Disconnects terminate both the provider socket and decoder process.

The shared terminal viewer also uses this recorder through its same-origin
share-scoped ASR relay. It requires active terminal control. Transcription stays
in a local draft until Insert; Enter is separate. The Worker sends a short-lived
service assertion only to the Controller, retaining the owner's stable ASR identity
and limits. Main-app browser cookies and native Bearer authentication are unchanged.

No Connector protocol or native module changed. Publish Web before runtime 7
(iOS/Android) and the runtime 6 Android OTA, using each runtime's own dependencies.
Tests: `node test/asr-failover.mjs`, `node test/streaming-asr.mjs`, native `streaming-asr.test.ts`, full suites,
and synthetic live PCM/WAV/AAC plus actual browser-button canaries. A microphone
must never be activated automatically for a test; use synthetic audio instead.

Live provider/failover canary (synthetic audio only):
`node test/asr-live.mjs /path/to/synthetic-16k-mono.pcm`.
The fixture sentence is documented in that script. It tests both services,
startup failure and forced midstream socket failures in both directions.
This backend-only change needs a Controller release; existing Web, iOS,
Android, Vision Pro and shared-terminal clients use it without an OTA.

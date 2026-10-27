# Live dictation (Free ASR)

The waveform button next to the microphone streams speech into the composer.
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
`80efa236954bbc265a0d59a19815e76268250972`. Audio is forwarded to the Doubao IME ASR
service, which supplies interim and final transcripts. This is the project's
reverse-engineered consumer interface; availability can change. Keep the regular
microphone working independently. Do not rotate device identifiers to evade
provider limits: the Controller derives one stable identifier per user from its
session secret. It never logs or stores audio or recognition text.

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

No Connector protocol or native module changed. Publish Web before runtime 7
(iOS/Android) and the runtime 6 Android OTA, using each runtime's own dependencies.
Tests: `node test/streaming-asr.mjs`, native `streaming-asr.test.ts`, full suites,
and synthetic live PCM/WAV/AAC plus actual browser-button canaries. A microphone
must never be activated automatically for a test; use synthetic audio instead.

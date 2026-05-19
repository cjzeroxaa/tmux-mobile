# tmux Chat Web

A local browser UI for selecting tmux sessions, windows, and panes, then reading snapshots or sending text without a terminal emulator.

## Run

```bash
cd tmux-chat-web
npm start
```

Open http://127.0.0.1:3737.

## Scope

- Lists tmux sessions, windows, and panes.
- Captures the selected pane as visible screen, tail, or full scrollback.
- Summarizes each window's active pane from its last 20 lines when the target picker is opened or refreshed, using `gpt-5.4-mini` by default.
- Sends literal text to the selected pane, optionally followed by Enter.
- Sends a small set of whitelisted keys such as Enter, Ctrl-C, and Ctrl-D.
- Stores chat history per pane in browser local storage.
- On phone-width screens, switches to an attached-pane layout with a top target picker and bottom composer.
- On phone-width screens, the composer becomes a voice button: tap to record, tap again to transcribe, then send the text with Enter.
- On phone-width screens, six compact quick-action buttons sit under the voice button for Esc, Ctrl-C, Claude, Codex, AGR, and reading the current window.
- Encodes the selected session/window in the URL as `?session=<name>&window=<index>`.
- Auto refresh is enabled by default for the selected pane view.

## Voice transcription

Voice mode uses the OpenAI transcription API from the local server. Set an API key before starting the server:

```bash
export OPENAI_API_KEY=...
npm start
```

The default transcription model is `gpt-4o-mini-transcribe`. Override it with:

```bash
OPENAI_TRANSCRIBE_MODEL=gpt-4o-transcribe npm start
```

Window summaries use `gpt-5.4-mini` by default. Override them with:

```bash
OPENAI_SUMMARY_MODEL=gpt-5.4-mini npm start
```

Summaries are requested only from the target picker: opening the picker, selecting a session inside it, or tapping its Refresh button. The server caches summaries for 60 seconds unless Refresh forces a new one.

Window audio summaries use the summary model above, then the OpenAI speech API. Defaults:

```bash
OPENAI_SPEECH_MODEL=gpt-4o-mini-tts-2025-12-15
OPENAI_SPEECH_VOICE=cedar
```

The server binds to `127.0.0.1` by default because it can control local shells.

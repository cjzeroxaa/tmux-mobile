# tmux Chat Web

A mobile browser UI for selecting tmux sessions, windows, and panes, then reading snapshots or sending voice commands without a terminal emulator.

## Run

```bash
cd tmux-chat-web
npm start
```

Open http://127.0.0.1:3737.

## Network access

This app is meant to be used through a private Tailscale tailnet. It controls local tmux panes, so do not expose it directly to the public internet.

The server binds to `127.0.0.1` by default. To use it from a phone or another device, keep the app local and publish it through Tailscale Serve:

```bash
tailscale serve --bg 3737
```

Only devices that are signed in to the same tailnet should be able to reach that Tailscale HTTPS URL. Without Tailscale or another private network proxy, other devices cannot access the default localhost server.

## Scope

- Uses a mobile-only attached-pane layout.
- Selects one tmux session from a dropdown, then lists that session's windows and panes.
- Captures the selected pane as visible screen, tail, or full scrollback.
- Summarizes each window's active pane from its last 20 lines when the target picker is opened or refreshed, using `gpt-5.4-mini` by default.
- Sends voice transcription directly to the selected pane with Enter.
- Sends compact actions for Esc, Ctrl-C, Claude, Codex, AGR, and reading the current window.
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

Text is pasted into tmux first, then Enter is sent after a short delay so terminal UIs have time to accept the paste. The default delay is 180 ms. Override it with:

```bash
TMUX_ENTER_AFTER_TEXT_DELAY_MS=250 npm start
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

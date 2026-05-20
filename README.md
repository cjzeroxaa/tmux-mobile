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
- Expands the terminal output to a larger fullscreen reading view.
- Summarizes each window's active pane from its last 20 lines when the target picker is opened or refreshed, using `gpt-5.4-mini` by default.
- Sends voice transcription directly to the selected pane with Enter.
- Sends compact actions for Enter, q, Esc, Ctrl-C, Claude, Codex, AGR, and reading the current window.
- Encodes the selected session/window in the URL as `?session=<name>&window=<index>`.
- Auto refresh is enabled by default for the selected pane view.

## Voice transcription

Voice mode uses the OpenAI transcription API from the local server. Set an API key before starting the server:

```bash
export OPENAI_API_KEY=...
npm start
```

You can also put the key in a local `.env` file:

```bash
OPENAI_API_KEY=...
```

The `.env` file is ignored by git and is loaded automatically on server startup.

The default transcription model is `gpt-4o-mini-transcribe`. Override it with:

```bash
OPENAI_TRANSCRIBE_MODEL=gpt-4o-transcribe npm start
```

Voice sends include one delayed extra Enter as a submit nudge for terminal UIs that sometimes keep pasted text in the prompt. The default delay is 700 ms. Override it with:

```bash
TMUX_SUBMIT_NUDGE_DELAY_MS=1000 npm start
```

Window summaries use `gpt-5.4-mini` by default. Override them with:

```bash
OPENAI_SUMMARY_MODEL=gpt-5.4-mini npm start
```

Summaries are requested only from the target picker: opening the picker, selecting a session inside it, or tapping its Refresh button. The server caches summaries for 60 seconds unless Refresh forces a new one.

Window audio summaries use the OpenAI Realtime API over WebRTC. The server
captures the tmux output and mints a short-lived Realtime client secret. The
browser uses that token to connect directly to OpenAI and sends the captured
tmux output over the Realtime data channel.
Defaults:

```bash
OPENAI_REALTIME_MODEL=gpt-realtime
OPENAI_REALTIME_VOICE=cedar
OPENAI_REALTIME_CLIENT_SECRET_TTL_SECONDS=600
OPENAI_REALTIME_WINDOW_BRIEFING_MAX_OUTPUT_TOKENS=inf
OPENAI_REALTIME_WINDOW_BRIEFING_CHUNK_LINES=12
OPENAI_REALTIME_WINDOW_BRIEFING_CHUNK_CHARS=1200
```

The legacy non-streaming endpoint can still be configured with
`OPENAI_WINDOW_BRIEFING_MODEL`, `OPENAI_SPEECH_MODEL`, and `OPENAI_SPEECH_VOICE`.

The server binds to `127.0.0.1` by default because it can control local shells.

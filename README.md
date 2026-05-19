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
- Sends literal text to the selected pane, optionally followed by Enter.
- Sends a small set of whitelisted keys such as Enter, Ctrl-C, and Ctrl-D.
- Stores chat history per pane in browser local storage.
- On phone-width screens, switches to an attached-pane layout with a top target picker and bottom composer.
- On phone-width screens, the composer becomes a voice button: tap to record, tap again to transcribe, then send the text with Enter.

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

The server binds to `127.0.0.1` by default because it can control local shells.

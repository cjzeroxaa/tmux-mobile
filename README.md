# tmux Chat Web

A mobile browser UI for selecting tmux sessions and windows, then reading snapshots or sending voice commands without a terminal emulator.

It runs in two modes that share the exact same browser UI: **local mode**
(controls this machine's tmux directly, the original behavior) and **cloud
mode** (a hub serves the UI and brokers commands to lightweight agents running
on each of your machines). See [Cloud mode](#cloud-mode-hub--agents).

## Run (local mode)

```bash
cd tmux-chat-web
npm start
```

Open http://127.0.0.1:3737. This serves the UI and controls this machine's
tmux directly — nothing about the single-machine app changed.

## Network access

This app is meant to be used through a private Tailscale tailnet. It controls local tmux panes, so do not expose it directly to the public internet.

The server binds to `127.0.0.1` by default. To use it from a phone or another device, keep the app local and publish it through Tailscale Serve:

```bash
tailscale serve --bg 3737
```

Only devices that are signed in to the same tailnet should be able to reach that Tailscale HTTPS URL. Without Tailscale or another private network proxy, other devices cannot access the default localhost server.

## Cloud mode (hub + agents)

The same `server.mjs` runs in three roles, chosen by flags. The browser UI is
identical in every case — it just talks to whichever server it connects to.

Cloud mode splits the server into a **hub** (serves the UI, calls OpenAI, brokers
commands) and one **agent** per machine (`--register`, runs locally, executes
tmux). The browser reaches the hub; the hub reaches each machine over an outbound
WebSocket the agent opens, so no machine needs an inbound port.

```
browser ──HTTPS──► hub (--hub) ──WebSocket──► agent (--register) ──► local tmux
```

Run a hub anywhere on your tailnet (it does not need tmux itself):

```bash
PORT=4000 node server.mjs --hub
```

On every machine you want to control, run an agent pointing at the hub:

```bash
node server.mjs --register http://HUB_HOST:4000
# or, over Tailscale:
node server.mjs --register https://hub.your-tailnet.ts.net:8449
```

The agent identifies the machine by hostname and reconnects automatically with
backoff.

Expose the hub on your tailnet with a **dedicated** HTTPS port — pick one not
already listed by `tailscale serve status` so you do not clobber existing
proxies:

```bash
tailscale serve --bg --https=8449 http://127.0.0.1:4000
```

Then open `https://<your-machine>.<tailnet>.ts.net:8449`.

### Trust model

There is no application-level auth: anyone who can reach the hub on the tailnet
can control every registered machine. This is intentional — the Tailscale
tailnet is the security boundary. As defense in depth, agents only run a fixed
allowlist of tmux subcommands, so even a misbehaving hub cannot make an agent
run arbitrary tmux (e.g. `kill-server`).

### Hub endpoints

- `GET /api/runtime` → `{ "mode": "local" | "hub" }` (lets the UI know whether to
  offer a machine picker).
- `GET /api/machines` → registered machines and online status.
- Every other `/api/*` call routes to the machine named in the `x-machine-id`
  header (or `?machineId=`). With exactly one machine online the hub auto-selects
  it, so the current frontend works unchanged; a browser machine picker for the
  multi-machine case is still TODO.

### Code layout

- `server.mjs` — entry point and HTTP/API handlers (shared by all modes).
- `lib/backend.mjs` — the `Backend` seam: every local op (tmux/readdir) goes
  through it, selected per request via `AsyncLocalStorage`. Local mode uses the
  in-process backend; the hub injects a remote one.
- `lib/protocol.mjs` — the hub↔agent wire protocol and tmux allowlist.
- `lib/hub.mjs` — agent registry, command broker, per-machine remote backend.
- `lib/agent.mjs` — outbound connection, request serving, reconnect.

## Scope

- Uses a mobile-only attached-window layout.
- Selects one tmux session from a dropdown, then lists that session's windows.
- Uses the first pane in the selected window automatically.
- Captures the selected window's first pane as visible screen, tail, or full scrollback.
- Expands the terminal output to a larger fullscreen reading view.
- Summarizes each window's active pane from its last 20 lines when the target picker is opened or refreshed, using `gpt-5.4-mini` by default.
- Sends voice transcription directly to the selected window with Enter.
- Sends compact actions for Enter, q, Esc, Ctrl-C, Claude, Codex, AGR, and reading the current window.
- Encodes the selected session/window in the URL as `?session=<name>&window=<index>`.
- Auto refresh is enabled by default for the selected window view.

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

Window audio reads use a two-step OpenAI flow. The server captures the last
100 tmux lines, uses a text model to extract the latest user-facing agent
response verbatim, then mints a short-lived Realtime client secret. The browser
uses that token to connect directly to OpenAI and sends only the extracted
response over the Realtime data channel for reading.
Defaults:

```bash
OPENAI_AGENT_RESPONSE_EXTRACT_MODEL=gpt-5.4-mini
OPENAI_AGENT_RESPONSE_EXTRACT_MAX_OUTPUT_TOKENS=4096
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

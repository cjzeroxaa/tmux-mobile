# tmux Chat Web

A mobile browser UI for selecting tmux sessions and windows, then reading snapshots or sending voice commands without a terminal emulator.

It runs in two modes that share the exact same browser UI: **local mode**
(controls this machine's tmux directly, the original behavior) and **controller
mode** (a Cloud Run service serves the UI and brokers commands to a lightweight
agent running on this machine). See [Cloud Run controller](#cloud-run-controller).

## Run (local mode)

```bash
cd tmux-chat-web
npm start
```

Open http://127.0.0.1:3737. This serves the UI and controls this machine's
tmux directly — nothing about the single-machine app changed.

## Network access

The local server binds to `127.0.0.1` by default because it controls local tmux
panes. For the existing Tailscale setup, keep the app local and publish it
through Tailscale Serve:

```bash
tailscale serve --bg 3737
```

Only devices that are signed in to the same tailnet should be able to reach that
Tailscale HTTPS URL.

## Cloud Run controller

Controller mode removes the Tailscale requirement for browser access. The same
`server.mjs` runs in three roles, chosen by flags:

- local: `npm start`, the original single-machine app.
- controller: `node server.mjs --controller`, a public Cloud Run service that
  serves the UI, calls OpenAI, and brokers tmux commands.
- agent: `node server.mjs --register <controller-url>`, the local process that
  opens an outbound WebSocket to the controller and executes tmux.

The browser reaches the Cloud Run controller over HTTPS; the controller reaches
this machine over the outbound WebSocket opened by the agent, so this machine
does not need an inbound port or Tailscale.

```
browser ──HTTPS──► Cloud Run controller ──WebSocket──► agent ──► local tmux
```

Controller mode supports multiple Google users. Browser access uses the web
Google OAuth client. Agent registration uses a controller-mediated Google
device-login flow, then the controller issues a local agent token scoped to that
Google user.

```bash
export GOOGLE_OAUTH_CLIENT_ID='...apps.googleusercontent.com'
export GOOGLE_OAUTH_CLIENT_SECRET='...'
export GOOGLE_DEVICE_CLIENT_ID='...apps.googleusercontent.com'
export GOOGLE_DEVICE_CLIENT_SECRET='...'
export GOOGLE_OAUTH_REDIRECT_URI='https://YOUR-CLOUD-RUN-URL/auth/google/callback'
export ALLOWED_GOOGLE_DOMAINS='sycamore.so'
export OPENAI_API_KEY='sk-...'
export OPENAI_SECRET_NAME='tmux-mobile-openai-api-key'
export SESSION_SECRET="$(openssl rand -hex 32)"
```

You can use `ALLOWED_GOOGLE_EMAILS` instead of, or in addition to,
`ALLOWED_GOOGLE_DOMAINS`. Browsers only see machines registered by the same
verified Google email, and API requests cannot route to another user's machine
id.

Controller mode requires `OPENAI_API_KEY` because voice transcription, target
summaries, and realtime audio reads all call OpenAI from the controller. Store
the key in Secret Manager and grant the Cloud Run runtime service account access:

```bash
gcloud secrets describe "${OPENAI_SECRET_NAME}" >/dev/null 2>&1 || \
  gcloud secrets create "${OPENAI_SECRET_NAME}" --replication-policy=automatic
printf '%s' "${OPENAI_API_KEY}" | \
  gcloud secrets versions add "${OPENAI_SECRET_NAME}" --data-file=-

PROJECT_NUMBER="$(gcloud projects describe "$(gcloud config get-value project)" --format='value(projectNumber)')"
gcloud secrets add-iam-policy-binding "${OPENAI_SECRET_NAME}" \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role='roles/secretmanager.secretAccessor'
```

Deploy the controller:

```bash
gcloud run deploy tmux-mobile-controller \
  --source . \
  --region us-central1 \
  --no-invoker-iam-check \
  --max-instances=1 \
  --timeout=3600 \
  --set-env-vars "\
GOOGLE_OAUTH_CLIENT_ID=${GOOGLE_OAUTH_CLIENT_ID},\
GOOGLE_OAUTH_CLIENT_SECRET=${GOOGLE_OAUTH_CLIENT_SECRET},\
GOOGLE_DEVICE_CLIENT_ID=${GOOGLE_DEVICE_CLIENT_ID},\
GOOGLE_DEVICE_CLIENT_SECRET=${GOOGLE_DEVICE_CLIENT_SECRET},\
GOOGLE_OAUTH_REDIRECT_URI=${GOOGLE_OAUTH_REDIRECT_URI},\
ALLOWED_GOOGLE_DOMAINS=${ALLOWED_GOOGLE_DOMAINS},\
SESSION_SECRET=${SESSION_SECRET}" \
  --set-secrets "OPENAI_API_KEY=${OPENAI_SECRET_NAME}:latest"
```

Cloud Run must allow HTTP to reach the app so normal browsers and the local
agent can connect. App-owned Google OAuth is the browser security boundary, and
controller-issued agent tokens are required for agent WebSocket registration.
The controller keeps agent connections in memory, so keep `--max-instances=1`.

If source deploy is blocked by Cloud Build permissions, build and push the
Dockerfile locally, then rerun the same `gcloud run deploy` command with
`--image <artifact-registry-image>` instead of `--source .`.

After deploy, copy the service URL and start the local agent:

```bash
node server.mjs --register https://YOUR-CLOUD-RUN-URL
```

If no token is stored yet, the agent prints a Google device-login URL and user
code, then stores the controller-issued token in
`~/.config/tmux-mobile/agent.json`. Future starts reuse the stored token. Add
`--login` only when you want to force a fresh login.

Set `AGENT_MACHINE` only if you need to override the machine id shown in the UI;
otherwise the agent uses the host name. To register multiple machines for the
same user, run the device login on each machine with the same Google account.

Open the Cloud Run URL in a browser and sign in with an allowed Google account.

### Local controller test

Run the local end-to-end test:

```bash
npm test
```

It starts a controller with a fake Google OAuth server, signs in two browser
users, performs device login for multiple agents, verifies each user sees only
their own machines, checks cross-user machine access is rejected, creates real
tmux sessions through the controller API, sends text into panes, and verifies
captured pane output comes back through the correct user route.

### Controller endpoints

- `GET /api/runtime` → `{ "mode": "local" | "hub" }`.
- `GET /api/machines` → registered machines and online status.
- Every other `/api/*` call routes to the machine named in the `x-machine-id`
  header (or `?machineId=`). With exactly one machine online the hub auto-selects
  it, so the current frontend works unchanged.

### Code layout

- `server.mjs` — entry point and HTTP/API handlers (shared by all modes).
- `lib/backend.mjs` — the `Backend` seam: every local op (tmux/readdir) goes
  through it, selected per request via `AsyncLocalStorage`. Local mode uses the
  in-process backend; the hub injects a remote one.
- `lib/protocol.mjs` — the hub↔agent wire protocol and tmux allowlist.
- `lib/hub.mjs` — agent registry, command broker, per-machine remote backend.
- `lib/agent.mjs` — outbound connection, request serving, reconnect.
- `Dockerfile` — Cloud Run controller image.

### Window operations

The topbar **More** menu has window management: **New window** (fresh window in
the current session), **Duplicate window** (a new window in the same session
with the same working directory, re-running the command the source used —
`pane_start_command` if the window was launched with one, else the running
program name, falling back to a plain shell), and **Close window** (kills the
window after a confirmation). Server side: `POST /api/windows {sessionId}` to
create, `POST /api/windows {duplicateFrom: windowId}` to duplicate, and
`DELETE /api/windows {windowId}` to close (refuses to kill the last window in a
session).

### Window annotations

Each window in the target picker has a free-text **follow-up note** (e.g.
"waiting on CI #4567, check ~3pm") — handy after kicking off a long-running task
in that window. Tap the note row under a window to edit it. The note is stored
on the tmux window itself as the window-scoped `@tm_annotation` user option
(`set-option -w`), so it travels with the window across devices and controller
restarts, is returned inline by `GET /api/windows`, set via
`PATCH /api/windows {windowId, annotation}` (empty clears it), and disappears
when the window is closed.

### Smart content viewer

URLs in the pane are clickable. File paths ending in an image extension
(`.png/.jpg/.jpeg/.gif/.svg/.webp/.bmp/.ico`) or a markdown extension
(`.md/.markdown/.mdown/.mkd`) are also clickable and open an in-app viewer:
images render inline, markdown renders to formatted HTML, and video/HTML
(`.webm/.mp4/.m4v/.mov/.html`) open in an external browser tab (fetched as a
blob, so native playback/rendering applies). Markdown
` ```mermaid ` blocks render as diagrams — Mermaid is lazy-loaded from a CDN only
when a file actually contains one (so plain markdown loads nothing extra) and
runs with `securityLevel: 'strict'`; if it can't load, the diagram source stays
visible. The file is read on the agent's machine via a new `readfile` protocol
op and `GET /api/file`. A relative path resolves against the pane's working
directory; absolute and `~` paths resolve as given. There is **no directory
confinement** — the boundary is the OS file permissions of the user the agent
runs as, so the viewer can open any file that user can read (and gets EACCES for
ones it can't). Reads are capped (5 MB for inline image/markdown, 50 MB for
external media/HTML) and limited to the viewable extensions. Browser access is
gated by Google OAuth, so in practice this is "an authenticated user reading
their own machine's files."

On top of OS permissions, a **configurable denylist** blocks sensitive files
even when the user could read them (SSH/cloud keys, `.env`, shell history, etc.).
It's matched against the resolved real path (so a symlink can't slip past).
Configure with `TMUX_MOBILE_READFILE_DENY` — a `:`-separated list of glob
patterns (`*`, `**`, `?`); each pattern is tested against the full path and the
basename. Setting it (even to empty) replaces the built-in defaults (empty
disables the denylist); `TMUX_MOBILE_READFILE_DENY_EXTRA` appends to the
defaults instead. Defaults live in `lib/readfile-deny.mjs` (`DEFAULT_DENY`).

### Agent reconnect and revision migration

The agent keeps its WebSocket alive with a ping/pong liveness check and
terminates a dead socket to force a reconnect (env: `AGENT_PING_INTERVAL_MS`,
`AGENT_PONG_TIMEOUT_MS`, `AGENT_MAX_BACKOFF_MS`).

A Cloud Run deploy is a special case: the agent's live socket keeps the *old*
instance alive, so the controller never gets SIGTERM and never closes the agent,
which would otherwise leave it pinned to stale code. To handle this the agent
polls the controller's public `/api/health` revision and re-dials when it
changes, migrating itself onto the new revision (env: `AGENT_REVISION_POLL_MS`,
default 15000; set `0` to disable). The controller also closes agent sockets on
SIGTERM as a secondary path, for the cases where the old instance is torn down.

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

The voice models (transcription, read-aloud TTS, and realtime) can also be
changed at runtime from the web app: open the topbar **More → Voice settings**
sheet and pick a model/voice per field. Configuration is **per-user** — on the
multi-user controller each Google-authenticated user has their own voice
settings, and one user's choice never affects another's. The `OPENAI_*` env vars
above act as the per-field defaults; a choice made in the UI takes precedence
until cleared back to the default. Overrides are saved (keyed by user id) to
`~/.config/tmux-mobile/voice.json` (override the path with
`TMUX_MOBILE_VOICE_CONFIG`). Selections are validated against a curated
allowlist, so the API can't be used to inject an arbitrary model name. Each
voice picker has a **▶ Sample** button that plays a short clip in the selected
voice (via the TTS sample endpoint) so you can compare voices before saving. On
Cloud Run the home dir is ephemeral, so overrides live in memory for the
instance's lifetime and reset to defaults when the single instance recycles.

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

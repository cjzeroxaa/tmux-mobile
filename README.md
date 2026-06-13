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

> **Want to join an already-running controller (e.g. https://eng.impo.ai)?**
> Skip everything below — see [docs/join-network.md](docs/join-network.md)
> for the one-command device-login flow.

Controller mode removes the Tailscale requirement for browser access. The same
A short screen recording of the core flow (window switching, snippet send, PR
links, the smart content viewer rendering a Mermaid diagram) is at
[`docs/demo.mp4`](docs/demo.mp4). A captioned walkthrough focused on the
AskUserQuestion answer flow, quick snippets, and the notification sound is at
[`docs/demo-walkthrough.mp4`](docs/demo-walkthrough.mp4).

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
export ALLOW_ALL_GOOGLE_USERS='1'
export SUPER_ADMIN_EMAILS='sonicgg@gmail.com'
export OPENAI_API_KEY='sk-...'
export OPENAI_SECRET_NAME='tmux-mobile-openai-api-key'
export SESSION_SECRET="$(openssl rand -hex 32)"
```

By default, any verified Google account can sign in (`ALLOW_ALL_GOOGLE_USERS=1`).
Machine visibility is separate from login permission: super-admin emails can
see every machine, Google Workspace users share machines with users from the
same `hd` hosted domain, and consumer Google accounts without `hd` only see
their own machines. Set `ALLOW_ALL_GOOGLE_USERS=0` with `ALLOWED_GOOGLE_EMAILS`
and/or `ALLOWED_GOOGLE_DOMAINS` for a closed controller.

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
ALLOW_ALL_GOOGLE_USERS=${ALLOW_ALL_GOOGLE_USERS},\
SUPER_ADMIN_EMAILS=${SUPER_ADMIN_EMAILS},\
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

It starts a controller with a fake Google OAuth server, signs in Workspace,
consumer, and super-admin browser users, performs device login for multiple
agents, verifies Workspace-domain sharing plus consumer isolation, creates real
tmux sessions through the controller API, sends text into panes, and verifies
captured pane output comes back through the correct user route.

### Controller endpoints

- `GET /api/runtime` → `{ "mode": "local" | "hub" }`.
- `GET /api/machines` → registered machines and online status.
- Every other `/api/*` call routes to the machine id returned by
  `GET /api/machines` in the `x-machine-id` header (or `?machineId=`). The raw
  hostname is still returned as `machineId`/`hostname` for display; the routed
  `id` stays unambiguous when two visible users register the same hostname. With
  exactly one visible machine online the hub auto-selects it.

### Code layout

- `server.mjs` — entry point and HTTP/API handlers (shared by all modes).
- `lib/backend.mjs` — the `Backend` seam: every local op (tmux/readdir) goes
  through it, selected per request via `AsyncLocalStorage`. Local mode uses the
  in-process backend; the hub injects a remote one.
- `lib/protocol.mjs` — the hub↔agent wire protocol and tmux allowlist.
- `lib/hub.mjs` — agent registry, command broker, per-machine remote backend.
- `lib/agent.mjs` — outbound connection, request serving, reconnect.
- `lib/ask-question.mjs` / `lib/ask-question-keys.mjs` — parse Claude's
  AskUserQuestion TUI, and compute the keystrokes that answer it.
- `Dockerfile` — Cloud Run controller image.

### Window operations

The topbar **More** menu has window management: **New window** (fresh window in
the current session), **Duplicate window** (opens a
confirmation pre-filled with the source window's title and start command — and
its working directory — so you can adjust before creating; the new window opens
in the same cwd and switches to it. The suggested command is `pane_start_command`
if the window was launched with one, else the running program name, else a plain
shell), and **Close window** (kills the
window after a confirmation). Server side: `POST /api/windows {sessionId}` to
create, `POST /api/windows {duplicateFrom: windowId}` to duplicate, and
`DELETE /api/windows {windowId}` to close (refuses to kill the last window in a
session).

### Answering AskUserQuestion prompts

Claude Code's `AskUserQuestion` renders an interactive TUI (a tab bar, `❯`
cursor, checkboxes for multi-select, a free-form "Type something" escape, and a
review screen) that's awkward to drive key-by-key from a phone. An overlay turns
it into tappable cards. Open it two ways: the topbar **More → Answer question**,
or **long-press the pane** (the gesture you reach for when you spot Claude
waiting). The long-press fires after ~500ms held still and cancels on
scroll/selection, so it never shadows tapping a link or selecting text.

The same overlay also handles Claude's **exit-plan-mode** confirmation ("Claude
has written up a plan and is ready to execute. Would you like to proceed?") — a
numbered single-select with a "Tell Claude what to change" free-form option. It's
detected separately (no tab bar / no AskUserQuestion footer) but parses into the
same single-select shape, so the cards + the keystroke driver work unchanged. It
also counts as `waitingForInput`, so a plan-waiting window shows the ❓ chip and
the needs-attention indicators.

It is **user-triggered and on-demand** — nothing scans for prompts in the
background. When you trigger it, the server captures the active pane *once*,
parses the prompt (`lib/ask-question.mjs`), and renders it: one chip per question
(✓ = answered), the question text, and an option card each — radio-style for
single-select, checkboxes for multi-select — plus a free-form input.

Choosing an answer always shows an **inline confirmation** ("Send this answer to
Claude? …") with Confirm / Back before anything is sent — Back returns to the
picker with your selections intact. Confirming applies the answer by **driving
the real TUI with keystrokes** (`lib/ask-question-keys.mjs`): single-select moves
the cursor and hits Enter (auto-advancing to the next question); multi-select
toggles the chosen boxes then selects Submit; multi-select/multi-question prompts
then reach Claude's own review screen, which the overlay surfaces as a final
Submit; the free-form input declines the prompt and sends your text as a normal
reply. After each step the server re-parses and returns the next state, so
multi-question prompts walk forward in place and the overlay closes when the
prompt is gone.

Server side (both local and controller mode — everything routes through the
backend seam, so a remote agent's pane is driven the same way):
`GET /api/ask-question?paneId=` returns `{ active, question }`;
`POST /api/ask-answer {paneId, action, …}` with `action` of `single`
(`optionIndex`), `multi` (`checked: number[]`), `free` (`text`), `reviewSubmit`,
or `cancel`. Inter-keystroke delay is `TMUX_ASK_KEY_DELAY_MS` (default 140ms).

### Window metadata

Each window carries derived metadata (`lib/window-metadata.mjs`), exposed via
`GET /api/window-metadata?sessionId=` as `{ [windowId]: { agentType, repo, git } }`:

- **agentType** — `claude` / `codex` / `gemini` / null. Cheap when the foreground
  command is the agent directly; when it's an interpreter (e.g. `node`, because
  codex/claude/gemini are node CLIs run as `node /usr/bin/codex`), it resolves
  the full command line via `ps` on the agent's tty and matches the agent there.
  The `ps` lookup runs only for interpreter windows and is cached per tty (~15s).
- **repo** — `{ host, owner, name }` from the git `origin` remote of the window's
  cwd (for turning `PR #N` into a GitHub link). A *cwd-scoped* field: resolved on
  the agent and cached by cwd with a 10-minute TTL (re-resolves when the cwd
  changes; staleness is fine).
- **git** — `{ branch, worktree }` (also cwd-scoped, short TTL).
- **turn** — `working` / `idle` / null: has the agent's turn ended? Per agent:
  claude from its pane title (a braille-spinner prefix = working, steady
  `✳ Claude Code` = idle); codex from its pane footer (`Worked for…` = working,
  `Goal achieved` / idle prompt = idle).
- **waitingForInput** — `true` when the pane is blocked on an AskUserQuestion
  prompt. Cheap: the `isAskQuestion()` detector's two regex tests over the screen
  already captured for `turn`/`contentHash` (the full parse stays on-demand). This
  is the strongest "needs you" signal — distinct from a turn that merely ended.
- **contentHash** — a short hash of the visible pane, used by the client for
  **unread** detection: a window whose hash differs from what it had at your last
  visit is flagged with a dot ("new since last visit"); unchanged = nothing to
  revisit. Visiting a window (or viewing it) updates its baseline.
- **inCopyMode** — `true` when the active pane is in tmux's **scrollback pager**.
  That has two `pane_mode` names that both swallow input: `copy-mode` (interactive)
  and `view-mode` (read-only — what Claude Code's Ctrl+O output expansion / a
  scroll-up actually lands in); both count (`isScrollbackMode`). This matters
  because the pager intercepts keystrokes, so input sent while it's active never
  reaches the program — the text sits in the prompt unsubmitted and the window
  looks dead. `/api/send` and `/api/key` **auto-exit the pager** before delivering
  input (`-X cancel`, which doesn't disturb the command line), so a stuck pane
  self-heals on the next keystroke. The client also shows a "Scroll mode is on"
  banner with an `/api/exit-copy-mode` button — but only after the pane has stayed
  in the pager past a short grace period (~2s), since briefly entering it
  (scrolling up to read) is intentional; re-entering restarts the grace clock.

The window list shows a compact agent chip — a brand **icon** (claude / codex /
gemini) rather than the agent's name, to save horizontal space — tinted by turn
state (working pulses, idle dimmed, `❓ ask` when waiting on a question) plus an
unread dot.

**"Needs you" indicators.** A window *needs you* when its agent is waiting on a
question, or its turn ended (idle) and its content changed since you last looked
(idle + unread). This spans **all online machines, not just the focused one**: a
single `GET /api/attention` (one request per poll regardless of machine count)
has the controller sweep every machine — for each window it returns
`turn`/`waitingForInput`/`contentHash` plus the stable identity (machine + session
name + window index); the client applies its own local unread comparison against
that hash. The poll runs every 5s (12s when hidden), even with no machine focused.
It reflects the result three ways: an always-visible topbar **pill** (`● N
waiting`, or a louder pulsing `❓ N needs answer` when any is a question) that
**jumps to the first such window on tap — switching machines if it's on another**
(auto-opening the answer overlay for a question); the browser **tab title**
(`(N) …`) and a badged **favicon**, so a backgrounded tab/PWA still shows the
count; and the per-window chip in the picker. The current window never counts
itself.

The metadata is a small **registry of descriptors** — each field is either `live`
(computed from the window row) or `cwdScoped` (resolved via the agent + cached),
so adding a field is one entry. Consumers today: an agent-type chip in the window
list, and PR-reference linking (`PR #1234` → `github.com/owner/repo/issues/1234`
for the active window's repo; bare `#1234` is deliberately not linked). Future
uses: agent-specific mode switching and turn detection.

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
blob, so native playback/rendering applies). The markdown renderer
(`public/markdown.js`, dependency-free and HTML-escape-first) covers headings,
bold/italic/code, fenced code, links/images, lists, blockquotes, hr, and
GitHub-flavored **tables** (with per-column `:--`/`:-:`/`--:` alignment; tables
scroll horizontally on narrow screens). Markdown
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

That handles the *controller* updating. The other skew is the **connector process
itself** running older code than the controller — e.g. the agent was started
before a new op (`PANECMD`) existed, so it can't answer that request and newer
features (here, agent-type detection for interpreter-launched agents) silently
fail. The agent advertises its supported ops in the hello frame; the controller
compares them against its current `AGENT_OPS` and marks the machine **stale**
(with the missing ops) in `GET /api/machines`. The web app shows a "Connector out
of date" banner with the restart command when the connected machine is stale; it
clears automatically once the connector is restarted on current code. (Restarting
the connector is also the fix — the running process keeps its old code until then;
the on-disk checkout being current isn't enough.)

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

## Composer

The composer is built around one rule: **the message box is the staging area for
everything except raw terminal keys.** Snippets, voice dictation, typing, and
recent history all populate the box; you review, then **Send** it to the pane.

- **Message box** — a spacious Lexical contenteditable (falls back to a plain
  contenteditable if the CDN fails). Enter sends, Shift+Enter newlines. The
  **mic** dictates into it; **Send** submits.
- **Tactical snippets** — a horizontal chip row of reusable text (`yes`,
  `continue`, `/clear`, `/btw `, `claude`, `codex`, `/goal ` by default). Tapping
  a chip **inserts** its text into the box (it doesn't send). The list icon opens
  the **Insert picker** with two sections: **Snippets** (curated; add/edit/reorder/
  delete) and **Recent** (auto-collected from what you've sent). Snippets are
  `{ text }` in localStorage (`tmux-mobile-snippets`).
- **History as auto snippets** — every Send is recorded to
  `tmux-mobile-composer-history` (bounded 100, newest-first, deduped) and shown in
  the Insert picker's **Recent** section; tap to insert for edit/resend.
- **Direct keys** — a high-contrast row (`Ent Esc ^C Tab ↑ ↓`) that sends raw
  terminal signals straight to the pane (the only controls that bypass the box).
- **File upload (📎)** — attach a file from your phone; it's written to a temp
  directory on the **target machine** (`$TMUX_MOBILE_UPLOAD_DIR`, or
  `<os tmpdir>/tmux-mobile-uploads` by default) and its absolute path is inserted
  into the box to reference. Goes through `POST /api/upload` → the backend seam's
  `writeTempFile` (a new `WRITEFILE` agent op, so a controller brokers it to the
  registered machine; capped at 25 MiB; the filename is sanitized to a basename).
- **Global actions** in the topbar: **Read** (TTS of the window) and the
  **needs-attention** pill.

## Agent notifications

For Claude Code / Codex phone notification hooks, see
[`docs/agent-notification-hooks.md`](docs/agent-notification-hooks.md).

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

Dictation is **transcribe-then-review**, not auto-send: tapping the mic enters a
**listening** state (waveform across the box, glowing border, pulsing controls);
**Keep (✓)** transcribes via `/api/transcribe` and **appends the text to the
message box** for you to edit and Send, while **Discard (✕)** throws the audio
away. (`/api/voice-send`, which transcribed *and* sent in one step, is no longer
used by the client.) To drop a `/btw ` side-note, tap the `/btw ` snippet — it
prefixes the box like any other snippet.

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

# Product Context — tmux-mobile

> Living product context for tmux-mobile. This document describes what the
> product is for, what the shipped product does today, what information each
> surface communicates, and the design direction implied by recent product
> feedback.
>
> It is based on the current implementation in `public/`, `server.mjs`, and
> `lib/`. Constants below are real code values.

---

## 1. High-level Product Goal

**Drive a fleet of coding agents running in tmux from a phone, without turning the
phone into a cramped terminal emulator.**

The user has long-running Claude Code, Codex, and sometimes other agent windows in
tmux. They are away from the keyboard and need to keep the work moving:

- know which agents need them,
- scan what every active agent is doing,
- read the latest output and the files agents produce,
- answer questions, approve/continue, interrupt, or send a follow-up,
- switch, annotate, branch, fork, duplicate, and close windows.

The product's north star is **time-to-unblock**: minimize the time from "an agent
needs me" to "I resolved it," while keeping enough context to avoid accidental
approvals or replies.

Two principles drive the UI:

1. **Glanceability:** the most important question is "who needs me?", across every
   visible machine.
2. **Thumb-reachable action:** the common operations must be reachable one-handed,
   with typing treated as the scarce resource.

### Runtime Models

- **Local mode:** `node server.mjs` controls local tmux directly and is usually
  reached over Tailscale.
- **Controller mode:** a hosted controller serves the same UI and brokers commands
  to lightweight agents connected from each dev machine.

Controller access is intentionally open at login and scoped at machine visibility:

- `ALLOW_ALL_GOOGLE_USERS=1` allows any verified Google account to sign in.
- super admins see every connected machine,
- Google Workspace users share machines within the same hosted domain,
- consumer Google accounts see only their own machines.

The UI is the same in both modes. Machine controls appear only when more than one
machine is visible.

Agent identity is stable across restarts. The agent uses `AGENT_MACHINE` when set,
otherwise it stores the first resolved hostname in its local config and reuses it
on later starts. The browser also keeps last-known hostnames so reconnect/waiting
messages say "Waiting for <host>" instead of exposing the controller's raw route id.

Controller deploys include a graceful handoff path: health reports how many agents
are connected to the current revision, and an admin redial endpoint can ask live
agents to reconnect immediately after rollout. From the user's point of view, a
short deploy/network blip should look like "Reconnecting..." while the current
window stays on screen, not like the machine vanished.

---

## 2. Core Mental Model

```
machine  ->  session  ->  window  ->  pane
             tmux        primary unit  usually one active pane
```

- The **window** is the unit users think in: one agent, one worktree/branch, one
  stream of work.
- The **pane** is the terminal target used for capture, input, transcript lookup,
  and process inspection.
- **Attention** cuts across all windows and all visible machines.
- Stable identity matters. The implementation keys windows by machine/session/window
  index so recents, unread state, notes, and deep links survive renames.

---

## 3. Current Surfaces

There are two top-level surfaces:

1. **Command Center** (`/`, `/command-center`): the default landing page and fleet
   scanner.
2. **Window driver** (`/app`): the focused work surface for one selected tmux
   window.

### 3a. Command Center — Fleet Scan

Command Center is the default page. It shows one card per detected Codex/Claude
agent across every accessible online machine. It uses structured agent transcripts,
not terminal screenshots or LLM summaries.

```
Command Center                          refreshed 12:04:03   [Refresh] [Logout] [Main app]
[Working] [Idle]   [mac-mini] [linux-box]                         Sort: Working first

+ mac-mini   owner: alice        1:deploy · work       codex   Working
| ~/src/app
| Last prompt    Fix failing migration tests...
| Last response  I updated the migration and reran...
| 18 turns · session 7ab91e2c                                      Open ->

+ linux-box  owner: bob          4:review · main       claude  Idle
| ~/repo
| Last prompt    Review PR 142
| Last response  No blocking issues. One test gap remains...
| 6 turns · session 31af80d1                                       Open ->
```

What it communicates:

- machine, owner, tmux session/window, cwd, agent kind, transcript session id,
- last user prompt and last assistant response,
- turn count and status,
- enough context to decide which agent to open.

Current behavior:

- polls `/api/command-center` every **4s** while visible and pauses while hidden,
- `Working` means the latest transcript turn is from the user,
- `Idle` means the latest transcript turn is from the assistant,
- filters by status and machine,
- sorts by Working first, machine, recent activity, or window name,
- persists filters/sort in localStorage,
- lets prompt/response blocks expand and keeps that expansion across refresh,
- deep-links to `/app` with `machineId`, session, and window identity.

Limit: Command Center currently detects structured Codex/Claude sessions. Other
agent windows may still exist in `/app`, but they are not first-class transcript
cards until transcript detection supports them.

### 3b. Window Driver — Focused Work Surface

`/app` is a full-height single-window driver. It is optimized for reading the
active pane and sending targeted input, not for general terminal emulation.

```
+------------------------------------------------+
| [mac · 1:deploy · ~/proj ⎇ main] [recent] [Read] [2 waiting] [more]
+------------------------------------------------+
| Lines [500] [+ note] Auto [Refresh] [Read] [Full]
| +--------------------------------------------+
| | terminal snapshot with ANSI styling         |
| | URLs, files, and PR refs are tappable       |
| | latest agent output scrolls here            |
| +--------------------------------------------+
+------------------------------------------------+
| [yes] [continue] [/clear] [/btw ] [claude] [list]
| Message, dictate, or paste a file path... [file] [mode] [mic] [Send]
| [Ent] [Esc] [^C] [Tab] [Up] [Backspace] [Del line] [Down]
+------------------------------------------------+
```

The screen has three regions:

- **Topbar:** identity, recents, read-aloud, attention, and More.
- **Snapshot:** live pane output and output-related controls.
- **Composer:** staged message input, mode control, voice, upload, snippets, and raw
  terminal keys.

The body does not scroll; the snapshot owns the main scrolling region. This keeps
the composer stable and makes the layout viable in a single mobile browser window
or a narrow desktop/tmux split.

### 3c. Topbar

| Element | Current role |
|---|---|
| **Target pill** | Shows `machine · index:name · cwd ⎇ branch`. Session name and worktree flag are omitted from visible text to save space; the hover/copy descriptor includes stable id and fuller context. Tapping opens the full target picker. |
| **Global recents** | A compact adaptive-width popup beside the target pill. It stores up to **20** recently visited windows across machines, renders each item in the same title format as the topbar, shows note/agent/activity detail on hover, and switches machines before selecting the target window. It prunes closed windows only after a complete trustworthy window load, so transient partial loads do not erase useful recents. |
| **Read** | Reads the current agent's latest assistant response using its structured transcript. Disabled when the pane is not a detected Codex/Claude agent. |
| **Attention pill** | Shows confirmed waiting/finished counts plus any unverified count. Tapping jumps to the highest-ranked pending window and auto-opens Answer only for confident question prompts. |
| **More** | Long-tail actions and settings. It is highlighted when the active window has a confident pending question. |

The full target picker and global recents popup are mutually exclusive. The picker
is the complete all-window list; recents are only in the small topbar popup.

Current More menu:

- Answer question,
- Copy window id,
- Rename window,
- New window,
- Duplicate window,
- New branch,
- Fork agent,
- Close window,
- Directories,
- Refresh,
- Toggle theme,
- Transcript,
- Command Center,
- Logout,
- Voice settings,
- Notification sound,
- Terminal font size.

### 3d. Snapshot

The snapshot is the primary reading surface for the selected pane.

Toolbar:

- line depth: 50 / 120 / 250 / 500 / 1000, default **500**,
- current window note immediately after Lines; `+ note` if empty,
- Auto refresh, on by default,
- manual Refresh,
- fullscreen,
- fullscreen/topbar Read.

Behavior:

- auto-refreshes every **3s**,
- auto-scrolls to bottom after sends and refreshes,
- respects active text selection so copying is not broken by refresh,
- unpins when the user scrolls up,
- shows a stale indicator when refresh fails,
- shows a copy/view-mode banner after a short grace period when tmux scrollback is
  active; Exit scroll mode sends input back to the program,
- keeps the current snapshot visible during transient machine disconnects and shows
  a reconnecting banner for up to **12s**, retrying every **1s**.

Tappable content:

- URLs open in a new tab,
- GitHub PR refs open when the repo can be resolved,
- file paths open real authenticated server URLs:
  - Markdown -> `/api/file-view` as standalone rendered HTML with tables and
    mermaid blocks,
  - other artifacts -> `/api/file-raw` inline with filename/content type.

There is no longer a centered in-app file viewer modal. Opening a real tab is more
compatible with mobile browser controls, sharing, zooming, and native media.

#### Pinned artifacts

A viewed artifact can be **pinned**: its current bytes are snapshotted into artifact
storage and given a stable, shareable link that keeps working even after the origin
machine goes offline. The Pin control is a small overlay on the app-rendered viewer
pages (rendered markdown and an image/HTML viewer-wrapper); raw media pins from the
file chip (right-click / long-press). Pins are content-addressed: re-pinning
unchanged content dedups, changed content creates a new version of the same
artifact. Each pin has a share scope — private, specific users, or all logged-in
users — enforced per request, so re-scoping or unpinning takes effect immediately.
More -> Pinned artifacts lists everything the viewer can access and lets the owner
open, copy the link, re-scope, or unpin. Storage is local-disk by default (no new
infra) and can be pointed at GCS or S3 for cloud deploys, where the share link
redirects to a short-lived presigned URL.

### 3e. Composer

The composer rule is simple: **everything that creates text stages it in the
message box; raw terminal keys bypass the box.**

Text sources:

- typed input,
- snippet chips,
- Insert picker snippets,
- recent message history,
- voice transcription,
- uploaded file paths.

Send behavior:

- Send writes the staged text to the pane and submits it,
- tapping Send clears the box and blurs the editor so the mobile keyboard retracts,
- Enter-to-send keeps focus for continued typing,
- snippets insert text; they do not auto-send.

Current default snippets:

`yes`, `continue`, `/clear`, `/btw `, `claude`, `codex`, `/goal `

Direct keys:

`Ent`, `Esc`, `^C`, `Tab`, `Up`, `Backspace`, `Del line`, `Down`

These send raw tmux/program input and never touch the message box.

### 3f. Mode And Effort

When the active pane is a recognized agent, a compact mode pill appears between
attach and mic/send.

- The pill shows parsed mode and effort from the agent footer/status.
- Tapping the pill cycles mode with Shift+Tab (`BTab`).
- The caret opens a Mode & effort sheet.
- The sheet can jump to a specific mode by cycling and re-reading the real footer.
- For Claude, effort is set by driving the `/effort` slider.

Recognized modes:

- Claude: normal, auto, accept edits, plan, bypass; UI cycle offers normal, auto,
  accept edits, and plan.
- Claude effort: low, medium, high, xhigh, max, ultracode.
- Codex: full access, plan, read-only, auto. Codex effort is parsed but not yet a
  first-class effort control.

### 3g. Structured Answer Overlay

Answer is for structured prompts where key-by-key TUI driving is too slow or
fragile on a phone.

Entry points:

- attention pill when the target is a confident question,
- More -> Answer question,
- two-finger hold on touch screens; mouse long-press on desktop.

Current scope:

- Claude AskUserQuestion prompts,
- Claude exit-plan confirmation,
- recognized waiting prompts in detection include Codex approval/update/continue
  prompts, but Codex approvals are not yet the same rich answer form.

The overlay parses the visible pane once, renders options/free-form fields, asks
for confirmation, then drives the real TUI with keystrokes. It is contextual and
should not permanently reserve vertical space in the default window view.

### 3h. Target Picker And Window Management

The full target picker is an all-window sheet:

- machine picker in controller mode,
- session groups,
- compact window rows with live/unread/agent/turn state, branch/cwd signal, summary,
  and note,
- no Recent section; recents live only in the topbar popup,
- create new session/window affordances.

Window actions:

- New window,
- Duplicate window with editable name/start command/cwd,
- New branch for bare-repo-backed git worktrees,
- Rename,
- Close with confirmation,
- Note editing from picker or snapshot toolbar,
- Directories picker to `cd`,
- Fork agent.

Fork agent detects a forkable Claude process and opens an adjacent tmux window in
the same cwd with `claude --continue --fork-session`. If the active pane is not
forkable, the action reports that no fork was made.

New branch is shown only when the current window is a linked worktree backed by a
bare repo. It creates a new git worktree and branch at the authoritative worktree
root, preserves slashes in branch names as real subdirectories, pre-fills the start
command from the current window, opens a new tmux window in the new worktree, and
switches to it. The sheet includes a live path preview so the user sees exactly
where the worktree will be created before confirming.

### 3i. Transcript

More -> Transcript opens a modal backed by `/api/agent-transcript`.

It reads the agent's own JSONL transcript, filters out tool calls, tool results,
thinking/reasoning blocks, system reminders, environment context, and empty rows,
then shows clean user/assistant dialogue.

The response is capped at the last **40** parsed turns. The modal shows kind,
session id, transcript file path, and turn count. It is intentionally separate
from snapshot reading: snapshot is live terminal state; transcript is clean dialogue
history.

### 3j. Notification Sound

Notification sound is optional and off by default.

- More -> Notification sound opens settings.
- LocalStorage key: `tmux-mobile-notify-sound`.
- Bundled sound: `/sounds/notify.wav`.
- Chimes only when a confirmed window newly needs attention or escalates
  finished -> question.
- Does not chime for unverified state.
- Rate limited to once per **10s**.
- Sample sound both previews the sound and unlocks browser audio playback.

### 3k. Themes And Font

- Theme choices: `kami`, `dark`, `auto`.
- `auto` follows `prefers-color-scheme`.
- Terminal snapshot font size is adjustable from More and persisted locally.
- Font size clamp: **10px** to **22px**, default **13px**.

---

## 4. Attention Model

Attention is the product spine. A window is pending when it is not the current
window and one of these is true:

1. **Question:** `waitingForInput` is true with non-low confidence.
2. **Finished:** turn is confidently idle and content changed since the user last
   saw it.
3. **Unverified:** detection is unsure but there is enough signal that hiding the
   window would be dishonest.

Rank order:

`question -> finished -> unverified`

Detection inputs:

- `/api/attention` sweeps every **5s** while visible and **12s** while hidden.
- In controller mode the controller aggregates every visible online machine.
- Descriptors include stable machine/session/window identity, agent type, turn,
  `turnConfidence`, `waitingForInput`, `waitingConfidence`, and `contentHash`.
- The client computes unread locally from `contentHash`, keyed by stable window id.

Honest state rules:

- uncertain windows are visible as **unverified**,
- unverified is ranked below confirmed needs,
- unverified never claims "needs answer",
- notification sound ignores unverified,
- tab title/favicon still count pending unverified windows so the user knows to
  check.

Surface vocabulary:

- Topbar pill: `N waiting`, `N finished`, `N waiting +M unverified`, or neutral
  `N unverified`.
- Agent chip: working / idle / waiting / unverified.
- More button: dot/highlight only when the active window confidently has a question.
- Attention tap: jumps to confirmed question first, then finished, then unverified.

This model is deliberately conservative. A false "all clear" breaks trust faster
than a visible "unverified" hedge.

---

## 5. Key User Journeys

### J1 — Triage The Fleet

Goal: see what every agent is doing and decide where to spend attention.

Current flow: open `/` -> Command Center lists detected Codex/Claude agents ->
filter/sort by status or machine -> expand only the prompt/response that needs
inspection -> Open the relevant window in `/app`.

### J2 — Unblock A Waiting Agent

Goal: notice a question/approval and answer it.

Current flow: notification sound / tab badge / topbar pill / Command Center ->
open the window -> Answer opens automatically for confident question prompts or is
reachable through More -> review the terminal context -> confirm answer.

### J3 — Read What An Agent Produced

Goal: understand output and inspect artifacts.

Current flow: read the snapshot -> tap files/URLs/PR refs -> Markdown opens as a
rendered page; images/HTML open in a viewer-wrapper page; other files open via raw
authenticated URL -> optionally Pin an artifact for a durable, shareable link ->
use Read or Transcript when audio or clean dialogue is better than terminal output.

### J4 — Send A Quick Reply

Goal: respond with minimal typing.

Current flow: tap a snippet or recent item -> optionally dictate or attach files ->
edit staged text -> Send. For terminal control, use direct keys.

### J5 — Switch Context

Goal: move between windows without losing orientation.

Current flow: tap global recents for a fast MRU switch, or tap the target pill for
the full picker grouped by session. In controller mode, global recents and the
attention pill can switch machines and land directly on the intended session/window
once that machine's window list loads.

### J6 — Manage Work

Goal: keep the tmux fleet organized.

Current flow: More -> new, duplicate, new branch, rename, close, directories, note,
fork agent. Notes are server-backed and visible both in the picker and snapshot
toolbar. New branch appears only for bare-repo-backed worktrees and creates a new
worktree+branch before opening a tmux window there.

### J7 — Inspect History

Goal: see the clean prompt/response dialogue without terminal noise.

Current flow: More -> Transcript -> read parsed user/assistant turns from the
agent transcript.

### J8 — Configure The Control Surface

Goal: tune the phone workflow.

Current flow: More -> theme, font size, voice settings, notification sound;
Insert -> snippets and recent history.

### J9 — Connect Or Reconnect Machines

Goal: make machines available from the phone.

Current flow: in controller mode, visible machines appear in Command Center and the
picker. If no machine is online, the connector help panel gives copyable setup
commands. Temporary drops preserve the current window for a reconnect grace period.
Out-of-date connectors show a restart banner when newer protocol operations are
missing. Agents persist machine identity across restarts, and controller deploys
can trigger immediate agent redial so rollout windows behave like short reconnects
instead of losing every machine until each agent notices the new revision.

---

## 6. Overlay And Popup Inventory

| Surface | Purpose | Notes |
|---|---|---|
| **Global recents popup** | Fast cross-machine MRU window switch | Up to 20 entries; mutually exclusive with full picker |
| **Target picker** | Full machine/session/window selection | All-window list, no Recent section |
| **Answer question** | Structured AskUserQuestion / plan answer | Contextual; opens only when requested or routed with intent |
| **Insert picker** | Snippets and Recent message history | Inserts into composer; does not auto-send |
| **Mode & effort** | Agent permission mode and Claude effort | Uses real agent footer/status as source of truth |
| **Directories** | Change pane cwd | Sends `cd` into the pane |
| **Duplicate window** | Clone context into a new tmux window | Editable title/start command/cwd |
| **New branch** | Create a branch worktree and window | Bare-repo-backed worktrees only; live path preview |
| **Transcript** | Clean user/assistant dialogue | Centered modal, last 40 turns |
| **Voice settings** | STT/TTS/realtime model and voice settings | Includes previews |
| **Notification sound** | Enable/sample chime | Off by default |
| **Pinned artifacts** | List/manage pinned artifacts and their sharing | More-menu sheet; owner-only re-scope/unpin |

File viewing is no longer a modal. It hands off to real browser tabs. A viewer
page can pin its artifact to a shareable, scope-controlled link via an overlay.

---

## 7. Information Catalog

A redesign can change presentation, but should preserve this information.

**Attention / status**

- per-window turn: working, idle, waiting, unverified,
- unread since last visit,
- aggregate pending count across machines,
- active question state,
- copy/view-mode state,
- stale snapshot,
- reconnecting/offline/out-of-date connector state.

**Identity / context**

- machine, owner, session, window index/name,
- stable window descriptor for copying/debugging,
- cwd, branch, worktree signal where useful,
- bare-repo-backed worktree eligibility for New branch,
- agent kind and mode/effort,
- user note.

**Content**

- live ANSI terminal snapshot,
- structured transcript last prompt/response,
- clean transcript history,
- tappable URLs, PR refs, and files,
- uploaded file paths inserted into the composer.

**Response affordances**

- staged message box,
- snippets,
- recent message history,
- voice dictation,
- file upload,
- raw keys,
- structured answer overlay,
- mode/effort switching.

---

## 8. Constants And Cadences

| Thing | Value |
|---|---|
| Command Center poll | 4s while visible |
| Snapshot auto-refresh | 3s |
| Window activity poll while picker open | 3s |
| Attention/metadata poll | 5s visible / 12s hidden |
| Reconnect grace / retry | 12s / 1s |
| Post-send snapshot refresh | 350ms |
| Answer hold gesture | 500ms |
| Ask-key inter-keystroke delay | 140ms default |
| Voice waveform sample | 200ms |
| Voice transcription retry | up to 3 attempts, 1.2s apart |
| Notification sound rate limit | 10s |
| Agent revision poll | 15s by default; REDIAL can force immediate reconnect |
| Agent WebSocket ping / pong timeout | 5s / 12s |
| Agent fast reconnect after controller close/redial | 250ms |
| Default line depth | 500 |
| Line depth choices | 50 / 120 / 250 / 500 / 1000 |
| Composer history | up to 100 entries |
| Global recent windows | up to 20 entries |
| Unread-hash baselines | up to 200 |
| Transcript view | last 40 parsed turns |
| Upload max size | 25 MiB |
| Rendered file-view max size | 5 MiB |
| External media/HTML max size | 50 MiB |
| Pinnable artifact max size | 5 MiB (markdown/image) / 50 MiB (media/HTML); truncated reads rejected |
| Pin presigned-URL TTL (cloud) | 300s default |
| Snapshot font size | 10-22px, default 13px |
| Phone frame width cap | about 560px; wider screens use full width |

---

## 9. Current Visual System

- **Aesthetic:** "kami" light theme by default, with warm paper grounds, dark ink,
  indigo accent, vermillion danger, and subtle paper texture. Dark mode keeps the
  same product structure with warm-dark surfaces.
- **Type:** Inter for UI, monospace for terminal/code.
- **Controls:** pills, chips, icon buttons, compact menus, banners, sheets, and
  modal panels.
- **Layout:** Command Center is a full-width responsive dashboard. `/app` is a
  three-region full-height work surface.
- **Density:** repeated information should be removed unless it changes the
  decision. The UI should prefer one strong status line over showing the same
  status/cwd/branch/question in multiple places.
- **Mobile navigation:** no persistent bottom tab bar. Navigation belongs in the
  fleet surface, header, and contextual panels so input space stays available.
- **Emoji:** not primary controls or state. Use icons, labels, and accessible names
  because emoji are inconsistent and imprecise for a tool surface.

---

## 10. Design Direction From Recent Feedback

Command Center has already moved the product from "single terminal viewer first"
toward "fleet first." The next design step is not to add more chrome; it is to make
the fleet view a better prioritized worklist.

### Direction

**Command Center should evolve from transcript dashboard into triage inbox.**

Ranking should follow:

`waiting -> finished/unread -> working -> unverified -> idle`

Cards should carry only what helps choose the next action:

- window identity,
- machine when relevant,
- agent kind and state,
- branch/cwd only when it disambiguates,
- last prompt/response or pending question preview,
- one Open action.

Do not duplicate the same fact in card header, body, and footer. Space efficiency
is a product feature on a phone.

### Window View Direction

`/app` remains the place where action happens. Routing into it should carry intent:

- question -> open Answer affordance,
- finished/unread -> focus composer or latest response,
- unverified -> open output for inspection,
- normal switch -> just show the window.

The answer UI should be contextual. It should not permanently consume the bottom
of the screen. The bottom area is primarily for input: text, snippets, voice,
upload, mode, and raw keys.

### Virtual Keyboard Strategy

Browsers cannot place arbitrary app UI inside the native keyboard. The product
should instead use a keyboard-adjacent accessory tray:

- use `navigator.virtualKeyboard.overlaysContent = true` where supported,
- track `geometrychange` and `keyboard-inset-*` CSS env values,
- fall back to `visualViewport` and sticky positioning on Safari/iOS,
- put snippets, history, and raw keys directly above the keyboard while text input
  is focused,
- avoid summoning the keyboard for voice/snippet-only actions unless the user enters
  text mode.

Desired input states:

1. **Default compact composer:** snippets, voice, file, mode, Send, and raw keys.
2. **Keyboard-visible composer:** text field plus accessory tray.
3. **Answer-expanded composer:** structured answer controls only for a pending
   prompt, with terminal context still visible.

### Non-goals

- Not a full terminal emulator.
- Not a passive monitoring dashboard.
- No inline approve/answer from fleet cards in v1; open the window for context.
- No "magic" adaptive home that changes navigation rules.
- No persistent mobile bottom tabs.
- No emoji as primary controls.

---

## 11. Open Product Risks

1. **Detection trust:** attention is only valuable if users believe it. `unverified`
   is the right hedge, but too much unverified noise will still push users back to
   manually opening windows.
2. **Command Center vs. attention model:** Command Center currently uses transcript
   last role for Working/Idle, while the attention pill uses turn/waiting/content
   confidence. These should converge visually as the inbox matures.
3. **More menu breadth:** More now holds management, branch creation, navigation,
   configuration, transcript, notification, and destructive actions. It is
   functional but still a mixed-intent list.
4. **Input density:** the staged composer works, but snippets/history/raw keys/mode/
   voice/upload compete for scarce vertical space. The keyboard accessory tray is
   the likely pressure release.
5. **Agent coverage:** structured transcript features are strongest for Codex and
   Claude. Gemini/other agents need explicit detection before they can be equally
   represented in Command Center, Read, Transcript, and honest attention states.
6. **Branch/worktree actions are powerful:** New branch is useful for bare-repo
   worktree workflows, but it creates real git refs and directories. The live path
   preview and strict branch-name validation are necessary guardrails; the UI should
   keep this action gated and explicit.

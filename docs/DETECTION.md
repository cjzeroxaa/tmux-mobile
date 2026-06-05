# Detection & honest state (Wave 1)

> Status as of 2026-06-05. Branch: `wave1-detection-confidence` (6 commits, not
> yet pushed/merged). This doc is the place to start when iterating on turn /
> `waitingForInput` detection — it records *why* the code is shaped the way it is
> and the traps that cost time to find, so we don't relearn them.

## Why this exists

The triage-inbox redesign (`docs/PRODUCT_CONTEXT.md` → "Honest state language")
has a hard prerequisite: **the queue must never lie.** The cardinal sins are
(1) hiding a window that needed you and (2) showing false confidence ("done" when
it might still be working). Detection reliability is a *definition-of-done*
prerequisite for the redesign, not a follow-up — if the ranked inbox is built on
flaky detection, users stop trusting it and revert to opening every window by
hand, which defeats the whole point.

Wave 1 makes **confidence a first-class output** of detection and introduces a
visible **`unverified`** state for "we don't know," so uncertain windows are
ranked *below* confirmed ones rather than dropped or misreported.

## The model

Detection answers two questions per window, each now with a confidence:

- **turn** — is the agent working, idle, or unknown? `lib/turn-detection.mjs`
- **waitingForInput** — is it blocked on an AskUserQuestion / exit-plan prompt?
  `lib/ask-question.mjs`

```
detectTurn(agentType, {title, paneTail})  -> {state, confidence} | null
    state      = "working" | "idle" | "unverified"
    confidence = "high" | "low"          (unverified is ALWAYS low)
    null       = no agent in the window at all

detectAskQuestion(screen)                 -> {waiting, confidence}
    waiting:true,  high  -> strict signal: definitely a prompt
    waiting:true,  low   -> ambiguous chrome -> surfaced as "unverified"
    waiting:false, high  -> confidently not a prompt
```

### Per-agent signals (unchanged from before Wave 1)

- **Claude turn**: the **pane title** (set by Claude via OSC 2). Leading braille
  spinner glyph = working; steady `✳ Claude Code` = idle.
- **Codex turn**: the **pane footer/tail** (codex puts no glyph in its title).
  `Worked for` / `Esc to interrupt` = working; `Goal achieved` / `Context N% left`
  / idle `›` prompt = idle. Read from the **last 12 lines** of the clean capture.
- **AskUserQuestion**: prompt chrome in the body — checkbox tab bar + footer, or
  the review screen, or the exit-plan prompt with a `❯` cursor.
- **Gemini and any other agent**: not implemented → `unverified` (visible, never
  dropped).

## Key design decisions (and the alternatives we rejected)

1. **`null` turn → `unverified`, not silence.** Before Wave 1, "I can't read this"
   returned `null`, stored as `turn:""`, which the client treated as "fine." A
   Claude window with an unreadable title (might be blocked!) silently looked
   healthy. Now it's a visible `unverified`.

2. **Strict detection stays strict; only the *loosened* path produces `low`.**
   `isAskQuestion()` is unchanged (still a boolean, still requires structure not
   just phrases — all the false-positive guards from commit `4740ce2` intact).
   `detectAskQuestion()` *wraps* it and adds a loosened "maybe blocked" heuristic
   (tab bar without footer = mid-redraw; cursor option without footer/plan
   header). **The loosened branch can only ever return `low` confidence** →
   surfaced as `unverified`, never a confident ❓. This preserves the discipline
   that keeps Claude's own prose ("ready to submit your answers…") from
   registering as a prompt. *Decision was explicitly "conservative" (user-chosen).*

3. **Unverified ranks last and never auto-acts.** Client rank order is
   `question → finished → unverified` (`ATTENTION_RANK` in `public/app.js`).
   Tapping the pill jumps to confirmed needs first, and **never auto-opens the
   answer overlay for a low-confidence guess** (only `reason === "question"` does).

4. **Pill splits confirmed from unverified.** The topbar pill shows
   `"N waiting +M unverified"`; an *only-unverified* set uses neutral copy and a
   `?` glyph — it never claims "needs answer." Unverified still counts toward the
   tab/favicon badge (nothing that might need you is hidden), it's just never
   *misrepresented* as confirmed.

5. **No agent-protocol / caps change needed.** Detection runs **controller-side**
   on raw pane output proxied over the WebSocket (`capturePane`/`listPanes` go
   through `currentBackend()`). An older agent just ships raw tmux text as before;
   the controller computes confidence with current code. The only back-compat
   concern is the *client* reading `state.attention`: a descriptor from before
   Wave 1 has no `*Confidence` fields, so the client defaults a `waitingForInput`
   with missing `waitingConfidence` to `"high"` (old behavior) and missing
   `turnConfidence` to `""` — no regression.

## Where the code lives

| Concern | File / location |
|---|---|
| Turn detection | `lib/turn-detection.mjs` |
| Ask/plan detection + confidence | `lib/ask-question.mjs` (`detectAskQuestion`) |
| Server: compute + store both confidences | `server.mjs` `getSessionWindowMetadata` (~L996) |
| Server: attention descriptor fields | `server.mjs` `collectMachineAttention` (~L1057) |
| Server: detection runs controller-side | `/api/attention` handler (~L3055), via `withBackend` |
| Client: attention reason + rank | `public/app.js` `descriptorNeedsAttention`, `ATTENTION_RANK` |
| Client: chip rendering | `public/app.js` `itemButton` (`turn-unverified`) |
| Client: pill split copy | `public/app.js` `updateAttentionIndicators` |
| Chip / pill styles | `public/styles.css` `.agent-chip.turn-unverified`, `.needs-attention.unverified` |

## Tests

- `test/turn-detection.mjs` — unit, incl. invariant: an unrecognized agent never
  yields a confident state; `unverified` is always `low`.
- `test/ask-question.mjs` — unit, incl. `detectAskQuestion` confidence cases and
  the prose false-positive guards.
- `test/detection-fixtures.mjs` — fixture-driven over **real** `capture-pane -p`
  output in `test/fixtures/` (claude-idle, codex-idle). Grow this corpus when you
  hit a state detection gets wrong.
- `test/live-sim.mjs` — **live tmux integration** (manual; spins up a scratch
  session). 12 cases covering working/idle/unverified/ask/ambiguous/prose/
  copy-mode/gemini. **Not in `npm test`** because it needs real tmux. Run with
  `node test/live-sim.mjs` (exit 0 = all pass, cleans up its own session).

All unit tests are wired into `npm test`. `test/fixtures/*.txt` are real captures
trimmed of trailing whitespace; they contain only repo paths (no secrets).

## Gotchas — the expensive-to-rediscover stuff

These bit us building the live harness. They're about *simulating/parsing* tmux,
not about the detection logic (which was correct throughout) — but they'll bite
again if we extend the harness or touch pane-format parsing.

1. **A bare `printf` OSC title does NOT stick.** When a foreground command sets
   the pane title and then exits, tmux re-derives `pane_title` from the now-idle
   shell and resets it to `""`. A *real* agent holds its title because it's a
   long-running foreground process. To simulate faithfully, set the OSC then
   **block** (`{ printf '\033]2;TITLE\007'; sleep 30; }`) and capture while it
   holds; release with Ctrl-C before the next case.

2. **tmux `-F` with an empty FIRST field + `.trim()` silently drops the field.**
   `#{pane_mode}\t#{pane_title}` renders `\t<title>` when not in a pager (mode
   empty); trimming the whole line eats the **leading tab**, so a split-on-tab
   puts the title into the mode slot and the title reads `""`. **The real server
   is immune** — its pane format anchors on the always-present `pane_id` first
   (`formats.panes` in `server.mjs`). Lesson: never put an optionally-empty field
   first in a delimited format you'll trim. (The harness now reads each field on
   its own line to sidestep this.)

3. **Codex turn reads the LAST 12 lines — content must reach the bottom.** A real
   codex pane pins its footer to the bottom row. Echoing text into a shell leaves
   the cursor (and blank rows) *below* the text, so `slice(-12)` lands on blanks
   and detection correctly returns `unverified`. The harness normalizes by
   dropping trailing blank rows before slicing (`codexTail`), reproducing the real
   bottom-pinned footer. If you add codex cases, use `codexTail`, not a raw slice.

4. **`send-keys -l` does not interpret `\n`.** Multi-line pane input must be sent
   one line at a time (each followed by `Enter`), or rendered via a single shell
   command (heredoc/`printf` chain). A `\n` inside `-l` lands as literal
   backslash-n.

5. **`execFileSync("sleep", …)` raced; use `Atomics.wait`.** For deterministic
   synchronous delays in the harness, `Atomics.wait(new Int32Array(new
   SharedArrayBuffer(4)), 0, 0, ms)` blocks the thread reliably. And poll for the
   expected state (`waitFor`) rather than trusting a fixed sleep — `send-keys` is
   async and the redraw lags.

## Open items / next iterations

- **Gemini turn detection is still unimplemented** (deferred by design — it
  yields `unverified`, which is honest). Implement `detectGeminiTurn()` when we
  have a reliable corpus of real Gemini pane samples. Add fixtures + a live-sim
  case.
- **Grow the fixture corpus** whenever a real window is mis-detected. Each real
  capture that exposes a gap is worth more than synthetic strings.
- **Wave 2 (triage home) consumes this.** The ranked inbox should use
  `ATTENTION_RANK` and render the `unverified` state as the doc's "honest hedge"
  row. Don't let Wave 2 collapse `unverified` back into idle/working — that
  reintroduces the cardinal sin.
- **Watch the loosened ask heuristic for false positives in the wild.** It's
  conservative (low-confidence only), but if real panes trip it often, tighten the
  signatures rather than promoting it to high confidence.

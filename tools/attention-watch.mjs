// attention-watch.mjs — a faithful, local SHADOW of the controller's attention
// detection, for collecting false-positive evidence on each machine.
//
// WHY: detection runs centrally in the Cloud Run controller
// (server.mjs getSessionWindowMetadata), as a pure function of each window's
// (pane title, last-12 clean lines, full clean screen). This watcher imports the
// SAME lib/ functions and runs them against THIS machine's local tmux, so its
// verdicts match what the controller would compute for this machine — without
// auth, without the controller, with the log landing locally for manual
// collection. (See docs/DETECTION.md → "Where detection runs".)
//
// WHAT IT DOES, each tick (default 3s, matching the controller's snapshot
// cadence): for every window running a known agent, classify turn + waiting
// exactly as the controller does, decide whether the window "needs attention"
// (would contribute to the top-right pill), and on a RISING EDGE (a window that
// newly needs attention) capture the full pane and write an evidence record.
// It also applies cheap false-positive heuristics and flags suspicious records
// so they're easy to review later.
//
// OUTPUT: a JSONL log + a captures/ dir of full pane snapshots, under
//   ~/.config/tmux-mobile/attention-watch/<runId>/
// Each JSONL line is one rising-edge attention event with the evidence needed to
// judge true vs false positive offline.
//
// RUN:  node tools/attention-watch.mjs            (60 min, 3s tick)
//       node tools/attention-watch.mjs --minutes 30 --interval 2
//       node tools/attention-watch.mjs --once      (single sweep, then exit)
//
// This is a READ-ONLY observer: it only runs `tmux list-* / capture-pane`
// (never send-keys), so it cannot perturb any agent.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { detectTurn } from "../lib/turn-detection.mjs";
import { detectAskQuestion } from "../lib/ask-question.mjs";
import { isScrollbackMode } from "../lib/pane-mode.mjs";
import {
  detectAgentType,
  detectAgentFromCommandLine,
  isInterpreter,
} from "../lib/window-metadata.mjs";

const execFileP = promisify(execFile);

// ---- args -------------------------------------------------------------------
function parseArgs(argv) {
  const a = { minutes: 60, interval: 3, once: false };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === "--minutes") a.minutes = Number(argv[++i]);
    else if (v === "--interval") a.interval = Number(argv[++i]);
    else if (v === "--once") a.once = true;
  }
  return a;
}
const ARGS = parseArgs(process.argv.slice(2));

// ---- tmux helpers (read-only) ----------------------------------------------
async function tmux(args, { maxBuffer = 8 * 1024 * 1024 } = {}) {
  const { stdout } = await execFileP("tmux", args, { maxBuffer });
  return stdout;
}

// Mirror server.mjs cleanTerminalText closely enough for detection inputs: strip
// OSC/CSI escapes, normalize CR, drop control chars, trim trailing space, and
// collapse runs of blank lines. (Detection only cares about text content + a few
// glyphs, all preserved here.)
function cleanTerminalText(text) {
  const lines = String(text || "")
    .replace(/\x1B\][^\x07]*?(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""));
  const kept = [];
  let lastBlank = false;
  for (const line of lines) {
    const blank = line.length === 0;
    if (blank && lastBlank) continue;
    kept.push(line);
    lastBlank = blank;
  }
  return kept.join("\n").replace(/\s+$/, "");
}

// list-panes for a window, with the fields detection needs. pane_mode can be
// empty (no pager) so we put the always-present pane_id FIRST and split
// positionally — never trim the whole line (a leading empty field + trim drops
// the field; this is the trap documented in docs/DETECTION.md).
const PANE_FMT =
  "#{pane_id}\t#{pane_index}\t#{pane_active}\t#{pane_current_command}\t#{pane_tty}\t#{pane_mode}\t#{pane_title}";

async function listPanes(windowId) {
  const out = await tmux(["list-panes", "-t", windowId, "-F", PANE_FMT]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const [id, index, active, command, tty, mode, ...titleParts] = row.split("\t");
      return {
        id,
        index: Number(index),
        active: active === "1",
        command,
        tty,
        mode,
        title: titleParts.join("\t"),
      };
    });
}

const WIN_FMT =
  "#{window_id}\t#{window_index}\t#{window_name}\t#{pane_current_command}";

async function listSessions() {
  const out = await tmux(["list-sessions", "-F", "#{session_id}\t#{session_name}"]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((r) => {
      const [id, name] = r.split("\t");
      return { id, name };
    });
}

async function listWindows(sessionId) {
  const out = await tmux(["list-windows", "-t", sessionId, "-F", WIN_FMT]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((r) => {
      const [id, index, name, command] = r.split("\t");
      return { id, index: Number(index), name, command };
    });
}

// Resolve the full argv of the foreground process on a tty (for agents launched
// via an interpreter, e.g. `node /usr/bin/codex`), mirroring the controller's
// PANECMD path. Best-effort; "" if it can't be determined.
async function paneCommandLine(tty) {
  if (!tty) return "";
  const dev = tty.startsWith("/dev/") ? tty.slice(5) : tty;
  try {
    const { stdout } = await execFileP("ps", ["-t", dev, "-o", "args="], {
      maxBuffer: 1024 * 1024,
    });
    // The deepest/last non-shell line is the foreground program; take the last.
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines[lines.length - 1] || "";
  } catch {
    return "";
  }
}

async function resolveAgentType(pane) {
  const direct = detectAgentType(pane.command);
  if (direct) return direct;
  if (isInterpreter(pane.command)) {
    const argv = await paneCommandLine(pane.tty);
    return detectAgentFromCommandLine(argv) || null;
  }
  return null;
}

// ---- false-positive heuristics ---------------------------------------------
// These do NOT change the verdict — they annotate a record with reasons it might
// be a false positive, so review/refinement can focus. Each returns a short tag
// when it fires.
function falsePositiveSignals({ reason, waitingConfidence, turn, clean, inCopyMode }) {
  const tags = [];
  // A low-confidence "maybe blocked" is, by design, the most FP-prone path.
  if (reason === "unverified" && waitingConfidence === "low") tags.push("low-conf-waiting");
  // copy-mode panes are frozen scrollback — content is stale; a "waiting" here is
  // suspect (the live prompt may be off-screen).
  if (inCopyMode) tags.push("in-copy-mode");
  // The classic prose false positives the strict guards target — if any of these
  // phrases are present but we still flagged waiting, worth a look.
  if (/needs answer|waiting|question/i.test(reason) || reason === "question") {
    if (/review your answers|ready to submit|would you like to proceed/i.test(clean)
      && !/^\s*❯/m.test(clean)) {
      tags.push("prose-phrase-no-cursor");
    }
  }
  // A bottom screen that's just an empty composer (❯ with nothing after) often
  // means idle, not waiting.
  const tail = clean.split("\n").slice(-6).join("\n");
  if (reason === "unverified" && /^\s*❯\s*$/m.test(tail)) tags.push("empty-composer-tail");
  return tags;
}

// The client's "needs attention" decision, replicated. Returns a reason or null.
// (We can't compute cross-session "unread" the way the browser does without its
// persisted seen-hash baseline, so the watcher tracks its OWN baseline: a window
// counts as finished-unread when its content hash changed since we last saw it
// idle. Question/unverified-waiting don't depend on unread.)
function needsAttention({ turn, turnConfidence, waiting, waitingConfidence, changedSinceSeen }) {
  if (waiting) return waitingConfidence === "low" ? "unverified" : "question";
  if (turn === "idle" && changedSinceSeen) return "finished";
  if (turn === "unverified" && changedSinceSeen) return "unverified";
  return null;
}

// ---- run state --------------------------------------------------------------
function isoNow() {
  return new Date().toISOString();
}

const HOSTNAME = os.hostname();
const RUN_ID = `${isoNow().replace(/[:.]/g, "-")}_${HOSTNAME}`;
const OUT_DIR = path.join(os.homedir(), ".config", "tmux-mobile", "attention-watch", RUN_ID);
const LOG_PATH = path.join(OUT_DIR, "events.jsonl");
const CAPTURES_DIR = path.join(OUT_DIR, "captures");

// Per-window memory across ticks, keyed by stable identity.
//   lastHash      — last content hash seen (for changed-since-seen)
//   lastSeenIdle  — hash at the last time turn was idle (unread baseline)
//   attending     — currently in a needs-attention state? (edge detection)
const memory = new Map();
function winKey(sessionName, win) {
  return `${sessionName}::${win.index}`;
}

let eventCount = 0;
let tickCount = 0;
let suspectCount = 0;

async function sweep(prime = false) {
  tickCount += 1;
  let sessions;
  try {
    sessions = await listSessions();
  } catch (e) {
    return; // tmux hiccup
  }

  for (const session of sessions) {
    let windows;
    try {
      windows = await listWindows(session.id);
    } catch {
      continue;
    }
    for (const win of windows) {
      let panes;
      try {
        panes = await listPanes(win.id);
      } catch {
        continue;
      }
      const pane = panes.find((p) => p.active) || panes[0];
      if (!pane) continue;

      const agentType = await resolveAgentType(pane);
      if (!agentType) continue; // controller only detects turn for agent windows

      let screen;
      try {
        screen = await tmux(["capture-pane", "-p", "-t", pane.id]);
      } catch {
        continue;
      }
      const clean = cleanTerminalText(screen);
      const lines = clean.split("\n");
      const contentHash = createHash("sha1").update(clean).digest("hex").slice(0, 16);
      const inCopyMode = isScrollbackMode(pane.mode);

      const t = detectTurn(agentType, {
        title: pane.title,
        paneTail: lines.slice(-12).join("\n"),
      });
      const ask = detectAskQuestion(clean);

      const key = winKey(session.name, win);
      const mem = memory.get(key) || { lastHash: null, lastSeenIdle: null, attending: false };

      // changed-since-seen: content differs from the baseline captured when this
      // window was last idle (the watcher's stand-in for the browser's unread).
      const changedSinceSeen =
        mem.lastSeenIdle !== null && mem.lastSeenIdle !== contentHash;

      const reason = needsAttention({
        turn: t ? t.state : "",
        turnConfidence: t ? t.confidence : "",
        waiting: ask.waiting,
        waitingConfidence: ask.confidence,
        changedSinceSeen,
      });

      // Update unread baseline when idle (mirrors the browser marking a window
      // seen once you've looked — here, an idle steady state resets the baseline).
      if (t && t.state === "idle" && !ask.waiting) mem.lastSeenIdle = contentHash;

      const nowAttending = reason !== null;
      // RISING EDGE: window newly needs attention -> this is when the pill would
      // light up / a notification would be "generated". Log evidence. On the
      // priming sweep we only seed baselines (so windows already attending at
      // startup aren't logged as fresh edges).
      if (nowAttending && !mem.attending && !prime) {
        eventCount += 1;
        const fpTags = falsePositiveSignals({
          reason,
          waitingConfidence: ask.confidence,
          turn: t ? t.state : "",
          clean,
          inCopyMode,
        });
        if (fpTags.length) suspectCount += 1;

        const record = {
          ts: isoNow(),
          host: HOSTNAME,
          session: session.name,
          windowIndex: win.index,
          windowName: win.name,
          agentType,
          paneTitle: pane.title,
          turn: t ? t.state : "",
          turnConfidence: t ? t.confidence : "",
          waiting: ask.waiting,
          waitingConfidence: ask.confidence,
          reason,
          changedSinceSeen,
          inCopyMode,
          contentHash,
          // Suspected false positive if any heuristic fired.
          suspectFalsePositive: fpTags.length > 0,
          fpTags,
          // Pointer to the full pane capture for offline cross-check.
          captureFile: `captures/${eventCount}_${session.name}_${win.index}.txt`,
          // Inline the tail so the log is self-contained for quick scanning.
          tail: lines.slice(-16).join("\n"),
        };
        await appendFile(LOG_PATH, JSON.stringify(record) + "\n");
        // Full capture (raw + clean) as the authoritative evidence.
        await writeFile(
          path.join(OUT_DIR, record.captureFile),
          `# ${record.ts}  ${record.host}  ${record.session}:${record.windowIndex} (${record.windowName})\n` +
            `# agent=${agentType} reason=${reason} turn=${record.turn}/${record.turnConfidence} ` +
            `waiting=${record.waiting}/${record.waitingConfidence} suspectFP=${record.suspectFalsePositive} [${fpTags.join(",")}]\n` +
            `# paneTitle=${JSON.stringify(pane.title)}\n` +
            `\n===== CLEAN =====\n${clean}\n\n===== RAW =====\n${screen}\n`,
        );
        const flag = record.suspectFalsePositive ? `  ⚠ SUSPECT[${fpTags.join(",")}]` : "";
        console.log(
          `${record.ts}  ${session.name}:${win.index} ${agentType} -> ${reason}` +
            ` (turn=${record.turn}/${record.turnConfidence} wait=${record.waiting}/${record.waitingConfidence})${flag}`,
        );
      }

      mem.lastHash = contentHash;
      mem.attending = nowAttending;
      memory.set(key, mem);
    }
  }
}

async function main() {
  await mkdir(CAPTURES_DIR, { recursive: true });
  await writeFile(
    path.join(OUT_DIR, "meta.json"),
    JSON.stringify(
      {
        runId: RUN_ID,
        host: HOSTNAME,
        startedAt: isoNow(),
        minutes: ARGS.minutes,
        intervalSec: ARGS.interval,
        note: "Faithful shadow of controller attention detection (lib/ functions). Read-only.",
      },
      null,
      2,
    ),
  );
  console.log(`attention-watch: run ${RUN_ID}`);
  console.log(`  output: ${OUT_DIR}`);
  console.log(`  ${ARGS.once ? "single sweep" : `${ARGS.minutes} min @ ${ARGS.interval}s tick`}`);
  console.log("  logging RISING-EDGE attention events; ⚠ = suspected false positive\n");

  if (ARGS.once) {
    await sweep();
  } else {
    const deadline = Date.now() + ARGS.minutes * 60 * 1000;
    // Prime baselines on the first sweep WITHOUT emitting (so we don't log every
    // already-attending window as a fresh edge at startup).
    await sweep(true);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, ARGS.interval * 1000));
      try {
        await sweep();
      } catch (e) {
        console.error("sweep error:", e.message);
      }
    }
  }

  const summary = {
    finishedAt: isoNow(),
    ticks: tickCount,
    events: eventCount,
    suspectedFalsePositives: suspectCount,
  };
  await writeFile(path.join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(
    `\nattention-watch done: ${eventCount} events over ${tickCount} ticks, ` +
      `${suspectCount} suspected false positives.`,
  );
  console.log(`  collect: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error("attention-watch fatal:", e);
  process.exit(1);
});

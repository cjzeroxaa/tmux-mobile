// Synthesized notification sounds for the "an agent needs you" chime. No audio
// files / no dependencies (keeps the app boring + offline-capable) — each sound
// is built from Web Audio oscillators + noise. Exposes a tiny API:
//
//   NOTIFY_SOUNDS         -> [{ id, label }]   for the settings <select>
//   playNotifySound(id)   -> plays the sound (resumes a suspended context first)
//
// Sounds are intentionally short (<~1s) and distinct so they read as a glanceable
// "who needs me" cue, not a long jingle.

let audioCtx = null;
function ctx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  // Autoplay policies suspend the context until a user gesture; resume best-effort.
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

// A short burst of filtered noise — the building block for breathy/percussive
// textures (the wolf's rasp, the train's chuff).
function noiseBurst(ac, { start, dur, type = "bandpass", freq = 800, q = 1, gain = 0.3 }) {
  const frames = Math.max(1, Math.floor(ac.sampleRate * dur));
  const buffer = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const g = ac.createGain();
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + dur * 0.2);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  src.connect(filter).connect(g).connect(ac.destination);
  src.start(start);
  src.stop(start + dur);
}

// A pitched tone with an envelope. The pitch glide (f0 -> f1) shapes the
// "voice" of each animal/vehicle.
function tone(ac, { start, dur, f0, f1 = f0, type = "sawtooth", gain = 0.25, glideShape = "exp" }) {
  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, start);
  if (glideShape === "exp") osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), start + dur);
  else osc.frequency.linearRampToValueAtTime(f1, start + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + Math.min(0.04, dur * 0.2));
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(start);
  osc.stop(start + dur);
}

// --- the sounds --------------------------------------------------------------

// Wolf: a rising-then-falling howl — a slow pitch glide up to a sustained peak,
// then a fall, with a touch of breathy noise for the rasp.
function wolf(ac) {
  const t = ac.currentTime + 0.02;
  tone(ac, { start: t, dur: 0.45, f0: 300, f1: 620, type: "sawtooth", gain: 0.22 });
  tone(ac, { start: t + 0.4, dur: 0.55, f0: 620, f1: 340, type: "sawtooth", gain: 0.2 });
  // light overtone for body
  tone(ac, { start: t, dur: 0.9, f0: 600, f1: 680, type: "sine", gain: 0.06 });
  noiseBurst(ac, { start: t, dur: 0.9, type: "bandpass", freq: 900, q: 0.7, gain: 0.05 });
}

// Frog: a couple of short, low "ribbit" croaks — a fast downward chirp with a
// gravelly square wave.
function frog(ac) {
  const t = ac.currentTime + 0.02;
  for (const offset of [0, 0.22]) {
    tone(ac, { start: t + offset, dur: 0.14, f0: 240, f1: 110, type: "square", gain: 0.28 });
    noiseBurst(ac, { start: t + offset, dur: 0.14, type: "lowpass", freq: 500, q: 1, gain: 0.08 });
  }
}

// Train: two "choo" chuffs (filtered noise) followed by a two-tone whistle
// (the classic minor-third "choo-CHOO").
function train(ac) {
  const t = ac.currentTime + 0.02;
  // chuffs
  noiseBurst(ac, { start: t, dur: 0.18, type: "bandpass", freq: 320, q: 0.6, gain: 0.32 });
  noiseBurst(ac, { start: t + 0.26, dur: 0.18, type: "bandpass", freq: 320, q: 0.6, gain: 0.32 });
  // whistle: two stacked tones for a chordy steam-whistle, low then high
  const w = t + 0.52;
  tone(ac, { start: w, dur: 0.5, f0: 520, f1: 520, type: "triangle", gain: 0.16 });
  tone(ac, { start: w, dur: 0.5, f0: 660, f1: 660, type: "triangle", gain: 0.12 });
  tone(ac, { start: w + 0.5, dur: 0.45, f0: 700, f1: 700, type: "triangle", gain: 0.16 });
  tone(ac, { start: w + 0.5, dur: 0.45, f0: 880, f1: 880, type: "triangle", gain: 0.12 });
}

// A neutral fallback "ding" (default), in case someone wants something subtle.
function ding(ac) {
  const t = ac.currentTime + 0.02;
  tone(ac, { start: t, dur: 0.5, f0: 880, f1: 880, type: "sine", gain: 0.25 });
  tone(ac, { start: t + 0.08, dur: 0.5, f0: 1320, f1: 1320, type: "sine", gain: 0.12 });
}

const PLAYERS = { ding, wolf, frog, train };

// Ordered list for the settings dropdown. `ding` is the default.
export const NOTIFY_SOUNDS = [
  { id: "ding", label: "Ding (subtle)" },
  { id: "wolf", label: "Wolf howl" },
  { id: "frog", label: "Frog croak" },
  { id: "train", label: "Train choo-choo" },
];

export const DEFAULT_NOTIFY_SOUND = "ding";

// Pure decision logic for the attention chime, extracted so it can be unit-tested
// without a browser/audio. Given the previous edge state and the current set of
// "needs you" items, decide whether to chime now.
//
//   prev   = { keys: Set<string>, lastAt: number }  (state across ticks)
//   items  = [{ key: string, reason: string }]      (current needs-attention set)
//   opts   = { enabled, now, minIntervalMs }
//
// Returns { chime: boolean, keys: Set<string>, lastAt: number } — the caller
// persists keys/lastAt for the next tick. Rules:
//   - Only CONFIRMED needs (reason !== "unverified") count — the low-confidence
//     hedge must never nag.
//   - chime only on a RISING EDGE: a (key::reason) present now but not last tick.
//   - suppressed when disabled or within minIntervalMs of the last chime.
//   - edge state ALWAYS advances (even when suppressed) so a held-waiting window
//     doesn't re-chime once the rate-limit window passes.
export function shouldChime(prev, items, opts) {
  const { enabled = true, now = 0, minIntervalMs = 10000 } = opts || {};
  const prevKeys = (prev && prev.keys) || new Set();
  // null = never chimed yet (distinct from lastAt 0, so the first chime isn't
  // gated by the rate limit even when `now` is small, e.g. in tests).
  const lastAt = prev && prev.lastAt != null ? prev.lastAt : null;

  const keys = new Set();
  for (const it of items || []) {
    if (!it || it.reason === "unverified") continue;
    keys.add(`${it.key}::${it.reason}`);
  }
  let hasNewEdge = false;
  for (const k of keys) {
    if (!prevKeys.has(k)) {
      hasNewEdge = true;
      break;
    }
  }
  // lastAt == null means we've never chimed -> the very first chime is always
  // rate-OK (otherwise a window waiting within the first minIntervalMs after load
  // is mute).
  const rateOk = lastAt == null || now - lastAt >= minIntervalMs;
  const chime = hasNewEdge && enabled && rateOk;
  return { chime, keys, lastAt: chime ? now : lastAt };
}

// Play a sound by id. No-ops gracefully if Web Audio is unavailable or the id is
// unknown. Returns true if it attempted to play.
export function playNotifySound(id) {
  const ac = ctx();
  if (!ac) return false;
  const play = PLAYERS[id] || PLAYERS[DEFAULT_NOTIFY_SOUND];
  try {
    play(ac);
    return true;
  } catch {
    return false;
  }
}

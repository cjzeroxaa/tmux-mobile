// Notification sound for the "an agent needs you" chime. Plays a bundled WAV —
// the Ubuntu "Yaru" *complete* notification sound (public/sounds/notify.wav; see
// public/sounds/CREDITS.md for license/attribution). Replaces the earlier
// synthesized oscillator sounds, which sounded artificial.
//
//   playNotifySound()  -> plays the chime (best-effort; no-ops if blocked)
//   shouldChime(...)    -> pure decision logic (unit-tested; unchanged)

// The bundled chime, served from the app origin. A single shared HTMLAudioElement
// is reused so repeated chimes don't spin up new decoders.
const NOTIFY_SOUND_URL = "/sounds/notify.wav";
let audioEl = null;

function getAudio() {
  if (typeof Audio === "undefined") return null;
  if (!audioEl) {
    audioEl = new Audio(NOTIFY_SOUND_URL);
    audioEl.preload = "auto";
  }
  return audioEl;
}

// Play the chime. Best-effort: browsers may reject playback until the user has
// interacted with the page (autoplay policy). The settings "Sample" button is a
// user gesture that satisfies this, after which auto-chimes are allowed. Returns
// true if playback was attempted.
export function playNotifySound() {
  const a = getAudio();
  if (!a) return false;
  try {
    a.currentTime = 0;
    const p = a.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
    return true;
  } catch {
    return false;
  }
}

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

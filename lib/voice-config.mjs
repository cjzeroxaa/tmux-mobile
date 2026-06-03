// Per-user, runtime-mutable voice model configuration.
//
// The server used to hardcode every voice model as a module-level const seeded
// from env vars (OPENAI_TRANSCRIBE_MODEL, OPENAI_REALTIME_MODEL, …). This module
// keeps those env values as the *defaults* but lets each authenticated user pick
// their own models at runtime via /api/voice-config, persisting overrides to a
// small JSON file keyed by user id so choices survive a server restart.
//
// The controller is multi-user (Google-authenticated), so configuration is
// per-user: user A changing their realtime voice never affects user B. In
// single-user local mode everything runs under one synthetic user id, so the
// same code path works unchanged.
//
// Deep call sites (transcribeAudio, createSpeechAudio, …) don't carry the user
// id, so the request layer establishes it once via withVoiceUser() (an
// AsyncLocalStorage scope) and getVoiceConfig() reads it back. Endpoints that
// already hold the user id can pass it explicitly.

import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Curated option lists. These drive the dropdowns in the web app and gate what
// the API will accept — an arbitrary string can't be injected as a model name.
export const VOICE_OPTIONS = {
  transcribeModel: [
    "gpt-4o-mini-transcribe",
    "gpt-4o-transcribe",
    "whisper-1",
  ],
  realtimeModel: ["gpt-realtime", "gpt-realtime-mini"],
  speechModel: ["gpt-4o-mini-tts-2025-12-15", "gpt-4o-mini-tts", "tts-1", "tts-1-hd"],
  // Voices are shared between the realtime and TTS APIs.
  voice: ["cedar", "marin", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"],
};

// Maps each editable field to its option list, so validation stays in one place.
const FIELD_OPTIONS = {
  transcribeModel: VOICE_OPTIONS.transcribeModel,
  realtimeModel: VOICE_OPTIONS.realtimeModel,
  speechModel: VOICE_OPTIONS.speechModel,
  realtimeVoice: VOICE_OPTIONS.voice,
  speechVoice: VOICE_OPTIONS.voice,
};

export const VOICE_FIELDS = Object.keys(FIELD_OPTIONS);

const DEFAULT_USER = "default";
const userStore = new AsyncLocalStorage();

// Run `fn` with `userId` as the active voice-config user for everything it
// (a)waits on. The request layer wraps handler invocations in this.
export function withVoiceUser(userId, fn) {
  return userStore.run(userId || DEFAULT_USER, fn);
}

function activeUser(explicit) {
  return explicit || userStore.getStore() || DEFAULT_USER;
}

function configPath() {
  return (
    process.env.TMUX_MOBILE_VOICE_CONFIG ||
    path.join(os.homedir(), ".config", "tmux-mobile", "voice.json")
  );
}

// The env-seeded defaults. Mirrors what server.mjs used to compute inline.
function envDefaults() {
  return {
    transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
    realtimeModel: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
    speechModel: process.env.OPENAI_SPEECH_MODEL || "gpt-4o-mini-tts-2025-12-15",
    realtimeVoice:
      process.env.OPENAI_REALTIME_VOICE || process.env.OPENAI_SPEECH_VOICE || "cedar",
    speechVoice: process.env.OPENAI_SPEECH_VOICE || "cedar",
  };
}

// In-memory override layer, lazily hydrated from disk on first read. Shape on
// disk and in memory is { byUser: { [userId]: { field: value, … } } }.
let store = null;

function loadStore() {
  if (store) return store;
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw || "{}");
    store = sanitizeStore(parsed);
  } catch {
    store = { byUser: {} };
  }
  return store;
}

// Keep only known users → known fields whose values are in the allowed option
// list. This gates a bad persisted file (or API payload) from setting an
// arbitrary model string. Also tolerates the pre-per-user flat shape by
// folding it under the default user.
function sanitizeStore(input) {
  const clean = { byUser: {} };
  if (!input || typeof input !== "object") return clean;
  // Migrate the old flat single-user shape ({ transcribeModel: … }).
  const flat = sanitizeFields(input);
  if (Object.keys(flat).length) clean.byUser[DEFAULT_USER] = flat;
  const byUser = input.byUser;
  if (byUser && typeof byUser === "object") {
    for (const [userId, fields] of Object.entries(byUser)) {
      const cleanFields = sanitizeFields(fields);
      if (Object.keys(cleanFields).length) clean.byUser[String(userId)] = cleanFields;
    }
  }
  return clean;
}

function sanitizeFields(input) {
  const clean = {};
  if (!input || typeof input !== "object") return clean;
  for (const field of VOICE_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && FIELD_OPTIONS[field].includes(value)) {
      clean[field] = value;
    }
  }
  return clean;
}

function userOverrides(userId) {
  return loadStore().byUser[activeUser(userId)] || {};
}

// The effective config = env defaults with this user's overrides layered on top.
export function getVoiceConfig(userId) {
  return { ...envDefaults(), ...userOverrides(userId) };
}

// Returns the full shape the web app needs for the active user: current
// effective values, the per-field default (so the UI can show "(default)"), and
// the option lists.
export function describeVoiceConfig(userId) {
  const defaults = envDefaults();
  const current = getVoiceConfig(userId);
  return {
    current,
    defaults,
    overrides: { ...userOverrides(userId) },
    options: {
      transcribeModel: VOICE_OPTIONS.transcribeModel,
      realtimeModel: VOICE_OPTIONS.realtimeModel,
      speechModel: VOICE_OPTIONS.speechModel,
      realtimeVoice: VOICE_OPTIONS.voice,
      speechVoice: VOICE_OPTIONS.voice,
    },
  };
}

// Apply a partial update for the active user. A field set to null/"" clears the
// override (revert to default); any other value must be in the allowed list.
// Throws on an invalid value so the API can return 400. Returns the new
// effective config for that user.
export function updateVoiceConfig(patch, userId) {
  if (!patch || typeof patch !== "object") {
    const error = new Error("Voice config payload must be an object");
    error.status = 400;
    throw error;
  }
  const id = activeUser(userId);
  const current = loadStore();
  const next = { ...(current.byUser[id] || {}) };
  for (const [field, value] of Object.entries(patch)) {
    if (!VOICE_FIELDS.includes(field)) {
      const error = new Error(`Unknown voice config field: ${field}`);
      error.status = 400;
      throw error;
    }
    if (value === null || value === "") {
      delete next[field]; // revert to env/default
      continue;
    }
    if (typeof value !== "string" || !FIELD_OPTIONS[field].includes(value)) {
      const error = new Error(
        `Invalid value for ${field}: ${value}. Allowed: ${FIELD_OPTIONS[field].join(", ")}`,
      );
      error.status = 400;
      throw error;
    }
    next[field] = value;
  }
  if (Object.keys(next).length) {
    current.byUser[id] = next;
  } else {
    delete current.byUser[id]; // fully default → drop the user entry
  }
  persist(current);
  return getVoiceConfig(id);
}

function persist(value) {
  const filePath = configPath();
  try {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    // Persistence is best-effort: on Cloud Run the home dir may be read-only.
    // The in-memory override still applies for the life of the process.
    const wrapped = new Error(`Voice config saved in memory but not persisted: ${error.message}`);
    wrapped.persisted = false;
    throw wrapped;
  }
}

// Test/reset hook: drop the in-memory cache so the next read re-hydrates.
export function _resetVoiceConfigCache() {
  store = null;
}

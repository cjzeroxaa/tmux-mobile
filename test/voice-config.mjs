// Unit tests for the per-user, runtime-configurable voice model layer
// (lib/voice-config.mjs). Covers: env-seeded defaults, per-user isolation,
// valid overrides persisting across a cache reset, rejection of unknown fields
// and out-of-allowlist values, clearing back to default, the withVoiceUser()
// AsyncLocalStorage scope, and migration of the old flat single-user file shape.
// Uses a throwaway config file via TMUX_MOBILE_VOICE_CONFIG.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "tmux-mobile-voice-"));
const cfgPath = path.join(dir, "voice.json");
process.env.TMUX_MOBILE_VOICE_CONFIG = cfgPath;
// Pin env so defaults are deterministic regardless of the host environment.
delete process.env.OPENAI_TRANSCRIBE_MODEL;
delete process.env.OPENAI_SPEECH_VOICE;

const {
  describeVoiceConfig,
  updateVoiceConfig,
  getVoiceConfig,
  withVoiceUser,
  _resetVoiceConfigCache,
  VOICE_OPTIONS,
} = await import("../lib/voice-config.mjs");

try {
  // Defaults reflect the documented env fallbacks.
  const described = describeVoiceConfig("alice");
  assert.equal(described.current.transcribeModel, "gpt-4o-mini-transcribe");
  assert.equal(described.defaults.speechVoice, "cedar");
  assert.ok(VOICE_OPTIONS.voice.includes("cedar"));
  assert.ok(described.options.speechVoice.includes("cedar"));

  // Per-user isolation: alice's override must not leak to bob.
  updateVoiceConfig({ transcribeModel: "gpt-4o-transcribe", speechVoice: "marin" }, "alice");
  assert.equal(getVoiceConfig("alice").transcribeModel, "gpt-4o-transcribe");
  assert.equal(getVoiceConfig("alice").speechVoice, "marin");
  assert.equal(getVoiceConfig("bob").transcribeModel, "gpt-4o-mini-transcribe");
  assert.equal(getVoiceConfig("bob").speechVoice, "cedar");

  // Persists across a cold cache (re-read file).
  _resetVoiceConfigCache();
  assert.equal(getVoiceConfig("alice").transcribeModel, "gpt-4o-transcribe");
  assert.equal(getVoiceConfig("bob").transcribeModel, "gpt-4o-mini-transcribe");

  // withVoiceUser() scope: the no-arg deep-call-site form resolves the user.
  await withVoiceUser("alice", async () => {
    assert.equal(getVoiceConfig().speechVoice, "marin");
  });
  await withVoiceUser("bob", async () => {
    assert.equal(getVoiceConfig().speechVoice, "cedar");
    updateVoiceConfig({ realtimeVoice: "verse" }); // userId implied by scope
  });
  assert.equal(getVoiceConfig("bob").realtimeVoice, "verse");
  assert.equal(getVoiceConfig("alice").realtimeVoice, "cedar"); // unaffected

  // An out-of-allowlist value is rejected with a 400.
  assert.throws(() => updateVoiceConfig({ transcribeModel: "evil" }, "alice"), (e) => e.status === 400);
  // An unknown field is rejected.
  assert.throws(() => updateVoiceConfig({ bogus: "x" }, "alice"), (e) => e.status === 400);

  // Clearing a field reverts to the env/default; other override untouched.
  updateVoiceConfig({ transcribeModel: null }, "alice");
  assert.equal(getVoiceConfig("alice").transcribeModel, "gpt-4o-mini-transcribe");
  assert.equal(getVoiceConfig("alice").speechVoice, "marin");

  // Migration: an old flat single-user file folds under the default user.
  _resetVoiceConfigCache();
  writeFileSync(cfgPath, JSON.stringify({ speechVoice: "shimmer" }));
  _resetVoiceConfigCache();
  assert.equal(getVoiceConfig("default").speechVoice, "shimmer");

  console.log("voice-config unit tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

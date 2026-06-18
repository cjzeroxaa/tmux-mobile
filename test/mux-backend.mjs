import assert from "node:assert/strict";
import {
  muxCommandFromEnv,
  muxKindFromCommand,
} from "../lib/backend.mjs";

assert.equal(muxCommandFromEnv({}), "tmux");
assert.equal(muxCommandFromEnv({ TMUX_MOBILE_MUX: "rmux" }), "rmux");
assert.equal(
  muxCommandFromEnv({ TMUX_MOBILE_MUX_COMMAND: "/opt/homebrew/bin/rmux" }),
  "/opt/homebrew/bin/rmux",
);
assert.equal(muxKindFromCommand("tmux"), "tmux");
assert.equal(muxKindFromCommand("/opt/homebrew/bin/rmux"), "rmux");

assert.throws(
  () => muxCommandFromEnv({ TMUX_MOBILE_MUX: "screen" }),
  /Unsupported mux command/,
);

console.log("mux-backend unit tests passed");

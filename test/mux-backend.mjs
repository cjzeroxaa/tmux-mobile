import assert from "node:assert/strict";
import {
  muxCommandFromEnv,
  muxKindsFromEnv,
  muxKindFromCommand,
} from "../lib/backend.mjs";

assert.equal(muxCommandFromEnv({}), "tmux");
assert.equal(muxCommandFromEnv({ TMUX_MOBILE_MUX: "rmux" }), "rmux");
assert.deepEqual(muxKindsFromEnv({}), ["tmux"]);
assert.deepEqual(muxKindsFromEnv({ TMUX_MOBILE_MUXES: "tmux,rmux,tmux" }), [
  "tmux",
  "rmux",
]);
assert.equal(
  muxCommandFromEnv({ TMUX_MOBILE_MUX_COMMAND: "/opt/homebrew/bin/rmux" }),
  "/opt/homebrew/bin/rmux",
);
assert.equal(
  muxCommandFromEnv({ TMUX_MOBILE_RMUX_COMMAND: "/opt/homebrew/bin/rmux" }, "rmux"),
  "/opt/homebrew/bin/rmux",
);
assert.equal(muxKindFromCommand("tmux"), "tmux");
assert.equal(muxKindFromCommand("/opt/homebrew/bin/rmux"), "rmux");

assert.throws(
  () => muxCommandFromEnv({ TMUX_MOBILE_MUX: "screen" }),
  /Unsupported mux command/,
);

console.log("mux-backend unit tests passed");

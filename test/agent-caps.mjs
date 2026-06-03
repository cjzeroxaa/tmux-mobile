// Test for agent capability advertisement + version-skew handling. An agent
// declares its supported ops in the hello frame; the controller checks before
// brokering so an older connector (no readfile) yields a clear "out of date"
// message instead of a raw "unknown op: readfile".

import assert from "node:assert/strict";
import {
  AGENT_OPS,
  LEGACY_AGENT_OPS,
  OP,
  helloFrame,
} from "../lib/protocol.mjs";
import { localBackend } from "../lib/backend.mjs";

// 1. helloFrame advertises the full current op set, including readfile.
const hello = helloFrame({ machine: "m1" });
assert.ok(Array.isArray(hello.ops), "1 ops present");
assert.ok(hello.ops.includes(OP.READFILE), "1 advertises readfile");
assert.deepEqual(hello.ops, AGENT_OPS, "1 ops === AGENT_OPS");

// 2. legacy op set does NOT include readfile (the skew case).
assert.ok(!LEGACY_AGENT_OPS.includes(OP.READFILE), "2 legacy lacks readfile");

// 3. localBackend reports supportsOp(true) for everything (runs current code).
assert.equal(localBackend.supportsOp(OP.READFILE), true, "3 local supports readfile");
assert.equal(localBackend.supportsOp(OP.TMUX), true, "3 local supports tmux");

// 4. Simulate the hub's agentSupportsOp logic for a current vs. legacy agent.
//    (Mirror of lib/hub.mjs agentSupportsOp: missing `ops` => LEGACY set.)
function agentSupportsOp(info, op) {
  const ops = Array.isArray(info?.ops) ? info.ops : LEGACY_AGENT_OPS;
  return ops.includes(op);
}
// current agent (advertises ops)
assert.equal(agentSupportsOp(helloFrame({ machine: "m" }), OP.READFILE), true, "4 current ok");
// legacy agent (hello frame without ops)
const legacyHello = { t: "hello", v: 1, machine: "m" };
assert.equal(agentSupportsOp(legacyHello, OP.READFILE), false, "4 legacy no readfile");
assert.equal(agentSupportsOp(legacyHello, OP.TMUX), true, "4 legacy still has tmux");

console.log("agent-caps unit tests passed");

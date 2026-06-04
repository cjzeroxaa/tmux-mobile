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

// 1b. helloFrame also advertises writefile (the upload op).
assert.ok(hello.ops.includes(OP.WRITEFILE), "1b advertises writefile");

// 2. legacy op set does NOT include readfile/writefile (the skew cases).
assert.ok(!LEGACY_AGENT_OPS.includes(OP.READFILE), "2 legacy lacks readfile");
assert.ok(!LEGACY_AGENT_OPS.includes(OP.WRITEFILE), "2 legacy lacks writefile");

// 3. localBackend reports supportsOp(true) for everything (runs current code).
assert.equal(localBackend.supportsOp(OP.READFILE), true, "3 local supports readfile");
assert.equal(localBackend.supportsOp(OP.WRITEFILE), true, "3 local supports writefile");
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

// 5. Version-skew "stale" computation (mirror of lib/hub.mjs listMachines): a
//    machine is stale when its advertised ops miss any current AGENT_OP.
function staleness(info) {
  const advertised = Array.isArray(info?.ops) ? info.ops : LEGACY_AGENT_OPS;
  const missingOps = AGENT_OPS.filter((op) => !advertised.includes(op));
  return { stale: missingOps.length > 0, missingOps };
}

// current agent -> not stale, nothing missing.
let s = staleness(helloFrame({ machine: "m" }));
assert.equal(s.stale, false, "5 current agent not stale");
assert.deepEqual(s.missingOps, [], "5 current agent missing nothing");

// legacy agent (no ops) -> stale, missing the post-legacy ops (incl. PANECMD).
s = staleness({ t: "hello", v: 1, machine: "m" });
assert.equal(s.stale, true, "5 legacy agent stale");
assert.ok(s.missingOps.includes(OP.PANECMD), "5 legacy missing panecmd");
assert.ok(s.missingOps.includes(OP.READFILE), "5 legacy missing readfile");

// agent that has everything EXCEPT the newest op (the exact codex-skew case:
// it predates PANECMD) -> stale, missing only that op.
const almostCurrent = AGENT_OPS.filter((op) => op !== OP.PANECMD);
s = staleness({ ops: almostCurrent, machine: "m" });
assert.equal(s.stale, true, "5 missing-one stale");
assert.deepEqual(s.missingOps, [OP.PANECMD], "5 missing only panecmd");

console.log("agent-caps unit tests passed");

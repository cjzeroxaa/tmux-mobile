// Test for agent capability advertisement + version-skew handling. An agent
// declares its supported ops in the hello frame; the controller checks before
// brokering so an older connector (no readfile) yields a clear "out of date"
// message instead of a raw "unknown op: readfile".

import assert from "node:assert/strict";
import {
  AGENT_FEATURES,
  AGENT_OPS,
  CONNECTOR_COMPAT_VERSION,
  LEGACY_AGENT_OPS,
  OP,
  helloFrame,
  isAllowedTmux,
} from "../lib/protocol.mjs";
import { localBackend } from "../lib/backend.mjs";

// 1. helloFrame advertises the full current op set, including readfile.
const hello = helloFrame({ machine: "m1" });
assert.ok(Array.isArray(hello.ops), "1 ops present");
assert.ok(hello.ops.includes(OP.READFILE), "1 advertises readfile");
assert.deepEqual(hello.ops, AGENT_OPS, "1 ops === AGENT_OPS");
assert.equal(hello.connectorVersion, CONNECTOR_COMPAT_VERSION, "1 connector version present");
assert.deepEqual(hello.features, AGENT_FEATURES, "1 connector features present");
assert.equal(hello.features.commandCenterInventory, true, "1 advertises inventory snapshots");

// 1b. helloFrame also advertises writefile (the upload op).
assert.ok(hello.ops.includes(OP.WRITEFILE), "1b advertises writefile");
assert.ok(hello.ops.includes(OP.RMUX_WEB_SHARE), "1b advertises rmux web share");

// 2. legacy op set does NOT include readfile/writefile (the skew cases).
assert.ok(!LEGACY_AGENT_OPS.includes(OP.READFILE), "2 legacy lacks readfile");
assert.ok(!LEGACY_AGENT_OPS.includes(OP.WRITEFILE), "2 legacy lacks writefile");
assert.ok(!LEGACY_AGENT_OPS.includes(OP.RMUX_WEB_SHARE), "2 legacy lacks rmux web share");

// 3. localBackend reports supportsOp(true) for everything (runs current code).
assert.equal(localBackend.supportsOp(OP.READFILE), true, "3 local supports readfile");
assert.equal(localBackend.supportsOp(OP.WRITEFILE), true, "3 local supports writefile");
assert.equal(localBackend.supportsOp(OP.TMUX), true, "3 local supports tmux");
assert.equal(localBackend.supportsOp(OP.RMUX_WEB_SHARE), true, "3 local supports rmux web share");
assert.equal(isAllowedTmux(["load-buffer", "-b", "name", "-"]), true, "3 load-buffer allowed");

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
//    machine is stale when its advertised ops miss any current AGENT_OP, or when
//    its connector compatibility version is older. Raw git revision is
//    diagnostic only so controller/frontend-only deploys do not force updates.
function staleness(info, currentConnectorVersion = CONNECTOR_COMPAT_VERSION) {
  const advertised = Array.isArray(info?.ops) ? info.ops : LEGACY_AGENT_OPS;
  const missingOps = AGENT_OPS.filter((op) => !advertised.includes(op));
  const connectorStatus = !currentConnectorVersion || currentConnectorVersion === "dev"
    ? "unverified"
    : !info?.connectorVersion
      ? String(currentConnectorVersion) === "1"
        ? "compatible"
        : "missing"
      : String(info.connectorVersion) === String(currentConnectorVersion)
        ? "current"
        : "outdated";
  return {
    stale: missingOps.length > 0 || ["missing", "outdated"].includes(connectorStatus),
    missingOps,
    connectorStatus,
  };
}

// current agent -> not stale, nothing missing.
let s = staleness(helloFrame({ machine: "m", revision: "abc1234" }));
assert.equal(s.stale, false, "5 current agent not stale");
assert.deepEqual(s.missingOps, [], "5 current agent missing nothing");
assert.equal(s.connectorStatus, "current", "5 current connector version matches");

// legacy agent (no ops) -> stale, missing the post-legacy ops (incl. PANECMD).
s = staleness({ t: "hello", v: 1, machine: "m" });
assert.equal(s.stale, true, "5 legacy agent stale");
assert.ok(s.missingOps.includes(OP.PANECMD), "5 legacy missing panecmd");
assert.ok(s.missingOps.includes(OP.READFILE), "5 legacy missing readfile");
assert.equal(s.connectorStatus, "missing", "5 legacy connector version is missing after v1");

s = staleness({ t: "hello", v: 1, machine: "m" }, "1");
assert.equal(s.connectorStatus, "compatible", "5 v1 legacy connector version is tolerated");

// Agent with the current op surface but no connectorVersion predates the field;
// v1 tolerated that shape to avoid a needless update banner at introduction.
s = staleness({ t: "hello", v: 1, ops: AGENT_OPS, machine: "m", revision: "3c95be7" }, "1");
assert.equal(s.stale, false, "5 full-op v1 agent without connectorVersion is compatible");
assert.equal(s.connectorStatus, "compatible", "5 full-op v1 agent tolerated");

s = staleness({ t: "hello", v: 1, ops: AGENT_OPS, machine: "m" });
assert.equal(s.stale, true, "5 missing connectorVersion is stale after v1");
assert.equal(s.connectorStatus, "missing", "5 newer connector version must be reported");

// agent that has everything EXCEPT the newest op (the exact codex-skew case:
// it predates PANECMD) -> stale, missing only that op.
const almostCurrent = AGENT_OPS.filter((op) => op !== OP.PANECMD);
s = staleness(helloFrame({ ops: almostCurrent, machine: "m", revision: "abc1234" }));
assert.equal(s.stale, true, "5 missing-one stale");
assert.deepEqual(s.missingOps, [OP.PANECMD], "5 missing only panecmd");

// agent with the current op surface but older raw git revision is not stale.
s = staleness(helloFrame({ machine: "m", revision: "def5678" }));
assert.equal(s.stale, false, "5 raw revision mismatch is diagnostic only");
assert.equal(s.connectorStatus, "current", "5 connector version still current");

s = staleness(
  { ...helloFrame({ machine: "m", revision: "abc1234" }), connectorVersion: "old" },
);
assert.equal(s.stale, true, "5 old connector version is stale");
assert.equal(s.connectorStatus, "outdated", "5 old connector version detected");

console.log("agent-caps unit tests passed");

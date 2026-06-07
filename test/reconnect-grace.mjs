// Verification of the reconnect-grace DECISION logic in refreshTree (public/app.js).
// When the focused machine momentarily drops (Cloud Run deploy / wifi blip / agent
// restart), the client keeps the current window and retries for a grace window
// instead of instantly wiping to "no machine". This test mirrors that branch as a
// pure decision: given (wasLive, priorMachineId, machines/machineId after the
// load, in-grace?), it returns ENTER_GRACE / STAY_GRACE / RESET / LIVE.
//
// IMPORTANT: `priorMachineId` is captured BEFORE loadRuntimeAndMachines() runs
// (which may clear state.machineId when the machine vanishes) — the test models
// that ordering via applyLoad(). Keep this in sync with refreshTree() if its
// grace branch changes.
import assert from "node:assert/strict";

let now = 1_000_000;
const RECONNECT_GRACE_MS = 12000;

function makeState() {
  return { reconnectUntil: 0, reconnectMachineId: "", windowId: "", machineId: "", machines: [], runtimeMode: "hub" };
}
const inGrace = (s) => s.reconnectUntil > now;
function enterGrace(s, m) {
  if (!inGrace(s) || s.reconnectMachineId !== m) { s.reconnectUntil = now + RECONNECT_GRACE_MS; s.reconnectMachineId = m; }
  return "GRACE";
}
function clearGrace(s){ s.reconnectUntil = 0; s.reconnectMachineId = ""; }

// The exact branch from refreshTree (machine-absent path). `applyLoad` mutates
// s to reflect what loadRuntimeAndMachines() would set (machines list + possibly
// clearing machineId) — but priorMachineId is captured BEFORE that, exactly as
// the real code does (it reads state.machineId before calling loadRuntime...).
function decide(s, applyLoad) {
  const wasLive = Boolean(s.windowId);
  const priorMachineId = s.machineId || s.reconnectMachineId; // BEFORE load
  applyLoad(s); // <- loadRuntimeAndMachines() side effects happen here
  if (s.runtimeMode === "hub" && (!s.machineId || !s.machines.some(m=>m.id===s.machineId))) {
    const droppedMachine = priorMachineId && !s.machines.some((m) => m.id === priorMachineId);
    if (droppedMachine) {
      if (inGrace(s)) { enterGrace(s, priorMachineId); return "STAY_GRACE"; }
      if (s.reconnectMachineId) { clearGrace(s); /* expired -> reset */ }
      else if (wasLive) { enterGrace(s, priorMachineId); return "ENTER_GRACE"; }
    }
    return "RESET";
  }
  if (inGrace(s)) clearGrace(s);
  return "LIVE";
}

const dropBlip = (s) => { s.machines = []; s.machineId = ""; }; // load during blip
const backOnline = (id) => (s) => { s.machines = [{id}]; s.machineId = id; };

// 1. Live on claw1, machine drops (machines empty, machineId cleared to "").
let s = makeState();
s.windowId = "@1"; s.machineId = "claw1"; // was live
assert.equal(decide(s, dropBlip), "ENTER_GRACE", "1 first drop enters grace");
assert.equal(s.reconnectMachineId, "claw1", "1 remembers the machine");
assert.ok(inGrace(s), "1 grace deadline set");

// 2. Next poll, still gone, still within grace -> STAY (keep window).
assert.equal(decide(s, dropBlip), "STAY_GRACE", "2 stays in grace while within window");

// 3. Machine comes back within grace -> LIVE + grace cleared.
s.machineId = "claw1"; // user/atom still points here
assert.equal(decide(s, backOnline("claw1")), "LIVE", "3 recovers to live");
assert.ok(!inGrace(s), "3 grace cleared on recovery");

// 4. Drop again, then grace EXPIRES -> RESET.
s = makeState(); s.windowId="@1"; s.machineId="claw1";
assert.equal(decide(s, dropBlip), "ENTER_GRACE", "4 enters grace");
now += RECONNECT_GRACE_MS + 1; // time passes beyond the window
assert.equal(decide(s, dropBlip), "RESET", "4 resets after grace expires");
assert.ok(!inGrace(s), "4 grace cleared on reset");

// 5. Never live, no machine picked yet (genuine "select a machine") -> RESET, no grace.
now += 100;
s = makeState(); s.windowId=""; s.machineId="";
assert.equal(decide(s, (st)=>{st.machines=[{id:"a"},{id:"b"}]; st.machineId="";}), "RESET", "5 not-live shows reset, not grace");
assert.ok(!inGrace(s), "5 no grace when never live");

console.log("grace-logic decision tests passed");

import assert from "node:assert/strict";
import { commandCenterDataFingerprint } from "../public/command-center-render.mjs";

const first = {
  machines: [
    {
      id: "machine-b",
      hostname: "Beta",
      connectorStatus: "current",
      lastSeen: 100,
      inventoryAgeMs: 20,
      inventoryObservedAt: 80,
      inventoryDurationMs: 5,
    },
    { id: "machine-a", hostname: "Alpha", connectorStatus: "current" },
  ],
  agents: [
    { machineId: "machine-b", windowId: "@2", status: "idle", lastUserText: "two" },
    { machineId: "machine-a", windowId: "@1", status: "working", lastUserText: "one" },
  ],
};

const sameVisibleData = {
  machines: [
    { connectorStatus: "current", hostname: "Alpha", id: "machine-a" },
    {
      inventoryDurationMs: 99,
      inventoryObservedAt: 900,
      inventoryAgeMs: 1,
      lastSeen: 901,
      connectorStatus: "current",
      hostname: "Beta",
      id: "machine-b",
    },
  ],
  agents: [...first.agents].reverse(),
};

assert.equal(
  commandCenterDataFingerprint(first),
  commandCenterDataFingerprint(sameVisibleData),
  "ordering and volatile inventory timing do not invalidate the rendered cards",
);

assert.notEqual(
  commandCenterDataFingerprint(first),
  commandCenterDataFingerprint({
    ...sameVisibleData,
    agents: sameVisibleData.agents.map((agent) =>
      agent.windowId === "@1" ? { ...agent, status: "idle" } : agent,
    ),
  }),
  "a visible agent status change invalidates the rendered cards",
);

assert.notEqual(
  commandCenterDataFingerprint(first),
  commandCenterDataFingerprint({
    ...sameVisibleData,
    machines: sameVisibleData.machines.map((machine) =>
      machine.id === "machine-a" ? { ...machine, stale: true } : machine,
    ),
  }),
  "a visible machine state change invalidates the rendered cards",
);

console.log("command-center render fingerprint tests passed");

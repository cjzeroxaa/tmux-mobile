import assert from "node:assert/strict";
import {
  compareMachinesByOwnerAndName,
  PRIORITY_MACHINE_OWNER_EMAIL,
} from "../public/machine-order.js";

const machines = [
  { id: "z-other", hostname: "Zulu", ownerEmail: "zoe@example.com" },
  { id: "b-admin", hostname: "Beta", ownerEmail: PRIORITY_MACHINE_OWNER_EMAIL.toUpperCase() },
  { id: "a-other", hostname: "Alpha", ownerEmail: "amy@example.com" },
  { id: "a-admin", hostname: "Alpha", ownerEmail: PRIORITY_MACHINE_OWNER_EMAIL },
  { id: "b-amy", hostname: "Beta", ownerEmail: "amy@example.com" },
  { id: "unknown", hostname: "Aardvark" },
];

assert.deepEqual(
  machines.slice().sort(compareMachinesByOwnerAndName).map((machine) => machine.id),
  ["a-admin", "b-admin", "a-other", "b-amy", "z-other", "unknown"],
);

assert.deepEqual(
  machines.slice().reverse().sort(compareMachinesByOwnerAndName).map((machine) => machine.id),
  ["a-admin", "b-admin", "a-other", "b-amy", "z-other", "unknown"],
);

console.log("machine-order tests passed");

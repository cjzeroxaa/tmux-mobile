import assert from "node:assert/strict";
import {
  exclusiveMachineFilterValue,
  setExclusiveMachineFilter,
} from "../public/machine-filter.js";

const selected = new Set();
assert.equal(exclusiveMachineFilterValue(selected), "", "empty means all machines");

setExclusiveMachineFilter(selected, "machine-a");
assert.deepEqual([...selected], ["machine-a"], "selects one machine");

setExclusiveMachineFilter(selected, "machine-b");
assert.deepEqual([...selected], ["machine-b"], "machine selection is mutually exclusive");

setExclusiveMachineFilter(selected, "machine-b");
assert.deepEqual([...selected], ["machine-b"], "reselecting keeps the machine selected");

setExclusiveMachineFilter(selected, "");
assert.deepEqual([...selected], [], "selecting All clears the machine filter");

console.log("machine filter tests passed");

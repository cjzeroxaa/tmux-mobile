import assert from "node:assert/strict";
import {
  SNAPSHOT_FOLLOW_PAUSE_DISTANCE_PX,
  SNAPSHOT_FOLLOW_RESUME_DISTANCE_PX,
  nextSnapshotFollowState,
} from "../public/snapshot-follow.js";

assert.equal(
  nextSnapshotFollowState({
    following: true,
    distanceFromBottom: SNAPSHOT_FOLLOW_PAUSE_DISTANCE_PX - 1,
  }),
  true,
  "a small upward movement keeps following",
);
assert.equal(
  nextSnapshotFollowState({
    following: true,
    distanceFromBottom: SNAPSHOT_FOLLOW_PAUSE_DISTANCE_PX,
  }),
  false,
  "a deliberate upward scroll pauses following",
);
assert.equal(
  nextSnapshotFollowState({
    following: false,
    distanceFromBottom: SNAPSHOT_FOLLOW_RESUME_DISTANCE_PX + 1,
  }),
  false,
  "paused follow stays paused until the viewport reaches the bottom",
);
assert.equal(
  nextSnapshotFollowState({
    following: false,
    distanceFromBottom: SNAPSHOT_FOLLOW_RESUME_DISTANCE_PX,
  }),
  true,
  "returning to the bottom resumes following",
);
assert.equal(
  nextSnapshotFollowState({
    following: false,
    distanceFromBottom: 0,
    userInitiated: false,
  }),
  false,
  "programmatic scrolling does not change the user's follow preference",
);
assert.equal(
  nextSnapshotFollowState({
    following: true,
    distanceFromBottom: 500,
    userInitiated: false,
  }),
  true,
  "programmatic layout movement cannot pause follow",
);

console.log("snapshot-follow.mjs: all assertions passed");

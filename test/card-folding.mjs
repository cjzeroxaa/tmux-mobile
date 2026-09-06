import assert from "node:assert/strict";
import {
  isRecentActivity,
  RECENT_ACTIVITY_WINDOW_MS,
  sessionCardFoldState,
} from "../public/card-folding.js";

const NOW = Date.parse("2026-09-06T12:00:00.000Z");

assert.equal(
  isRecentActivity(new Date(NOW - RECENT_ACTIVITY_WINDOW_MS).toISOString(), NOW),
  true,
  "activity at the eight-hour boundary is recent",
);
assert.equal(
  isRecentActivity(new Date(NOW - RECENT_ACTIVITY_WINDOW_MS - 1).toISOString(), NOW),
  false,
  "activity older than eight hours is stale",
);
assert.equal(isRecentActivity(new Date(NOW + 1).toISOString(), NOW), false);
assert.equal(isRecentActivity("not-a-date", NOW), false);

assert.deepEqual(
  sessionCardFoldState({
    foldSessionCards: true,
    recentActivity: true,
    manuallyExpanded: false,
  }),
  { collapsible: false, expanded: true },
  "recent phone cards stay expanded",
);
assert.deepEqual(
  sessionCardFoldState({
    foldSessionCards: true,
    recentActivity: false,
    manuallyExpanded: false,
  }),
  { collapsible: true, expanded: false },
  "stale phone cards start folded",
);
assert.deepEqual(
  sessionCardFoldState({
    foldSessionCards: true,
    recentActivity: false,
    manuallyExpanded: true,
  }),
  { collapsible: true, expanded: true },
  "one stale phone card may be manually expanded",
);
assert.deepEqual(
  sessionCardFoldState({
    foldSessionCards: false,
    recentActivity: false,
    manuallyExpanded: false,
  }),
  { collapsible: false, expanded: true },
  "desktop and tablet cards stay expanded",
);

console.log("card folding tests passed");

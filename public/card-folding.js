export const RECENT_ACTIVITY_WINDOW_MS = 8 * 60 * 60 * 1_000;

export function isRecentActivity(value, nowMs = Date.now()) {
  const activityMs = Date.parse(value || "");
  if (!Number.isFinite(activityMs) || !Number.isFinite(nowMs)) return false;
  const ageMs = nowMs - activityMs;
  return ageMs >= 0 && ageMs <= RECENT_ACTIVITY_WINDOW_MS;
}

export function sessionCardFoldState({
  foldSessionCards,
  recentActivity,
  manuallyExpanded,
}) {
  const collapsible = Boolean(foldSessionCards && !recentActivity);
  return {
    collapsible,
    expanded: !collapsible || Boolean(manuallyExpanded),
  };
}

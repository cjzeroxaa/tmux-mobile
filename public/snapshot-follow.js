export const SNAPSHOT_FOLLOW_PAUSE_DISTANCE_PX = 48;
export const SNAPSHOT_FOLLOW_RESUME_DISTANCE_PX = 8;

// Follow is a user preference, not another spelling of "currently at bottom".
// A small dead zone keeps touch jitter and fractional layout changes from
// pausing a live terminal. Once paused, use the tighter bottom threshold before
// resuming so the state cannot flap around one boundary.
export function nextSnapshotFollowState({
  following,
  distanceFromBottom,
  userInitiated = true,
}) {
  if (!userInitiated || !Number.isFinite(distanceFromBottom)) return following;

  if (following) {
    return distanceFromBottom < SNAPSHOT_FOLLOW_PAUSE_DISTANCE_PX;
  }
  return distanceFromBottom <= SNAPSHOT_FOLLOW_RESUME_DISTANCE_PX;
}

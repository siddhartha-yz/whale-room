const DEG = Math.PI / 180;
const TURN_THRESHOLD = 0.32;
const finitePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.z);
const result = (ok, reason, turnYaw = null) => ({ ok, turnYaw, reason });

/** Decide whether an external horizontal look request can be attempted.
 * This is not proof of eye contact: the caller must wait for visible settling
 * and separately report the observed gaze. No posture, prop, or camera changes
 * are made here. canTurn must already include the room's safety constraints.
 */
export function classifyLookAction({ position, yaw, target, canTurn = false, activity = null, calibrated = false } = {}) {
  if (!finitePoint(target)) return result(false, 'invalid-target');
  if (!finitePoint(position) || !Number.isFinite(yaw)) return result(false, 'invalid-pose');
  const dx = target.x - position.x, dz = target.z - position.z;
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return result(false, 'invalid-target');

  const name = typeof activity === 'string' ? activity : activity?.name ?? activity?.kind;
  const holding = activity?.holdingProp === true || activity?.holding === true || activity?.held === true
    || (typeof activity?.heldObject === 'string' && activity.heldObject !== '' && activity.heldObject !== 'none');
  if (name === 'drink' || name === 'move_cup' || activity?.blocked === true || holding) {
    return result(false, 'activity-owns-gaze');
  }
  if (Math.hypot(dx, dz) <= 1e-6) return result(false, 'coincident-target');

  const bearing = Math.atan2(dx, dz);
  const delta = Math.atan2(Math.sin(bearing - yaw), Math.cos(bearing - yaw));
  // An active reading or stretch pose must not rotate just because a caller
  // accidentally leaves the free-standing flag enabled.
  if (canTurn === true && !activity) {
    return Math.abs(delta) > TURN_THRESHOLD
      ? result(true, 'turn-required', yaw + delta)
      : result(true, 'within-cone');
  }
  const limit = (name === 'read' ? 22 : calibrated === true ? 30 : 24) * DEG;
  return Math.abs(delta) <= limit + 1e-12
    ? result(true, 'within-cone') : result(false, 'outside-cone');
}

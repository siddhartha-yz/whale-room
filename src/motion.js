const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mix = (a, b, weight) => a + (b - a) * weight;
export const angleDelta = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
const approach = (value, target, step) => value + clamp(target - value, -step, step);
const distance = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);
const smooth = (value) => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };

/**
 * Advance only on the original collision-checked path segments. Steering changes
 * the speed, not the path geometry, so slowing for a corner cannot cut through it.
 * A finite facingYaw holds the body's heading for station entry/backsteps while
 * the path still determines translation. Omit it for ordinary forward walking.
 */
export function stepRoute({ position, path, index = 0, yaw = 0, speed = 0 }, rawDt, {
  maxSpeed = 0.45, acceleration = 1.1, braking = 1.35, turnSpeed = 3.8, stopping = false, facingYaw,
} = {}) {
  const dt = clamp(rawDt, 0, 0.05);
  const next = { position: { x: position.x, z: position.z }, index, yaw, speed, done: false };
  if (index >= path.length) return { ...next, speed: 0, done: true };
  while (next.index < path.length && distance(next.position, path[next.index]) < 1e-7) next.index++;
  if (next.index >= path.length) return { ...next, speed: 0, done: true };
  const target = path[next.index];
  const dx = target.x - next.position.x, dz = target.z - next.position.z;
  const segmentDistance = Math.hypot(dx, dz);
  const travelYaw = Math.atan2(dx, dz);
  const desiredYaw = Number.isFinite(facingYaw) ? facingYaw : travelYaw;
  next.yaw += clamp(angleDelta(next.yaw, desiredYaw), -turnSpeed * dt, turnSpeed * dt);
  const headingError = Math.abs(angleDelta(next.yaw, desiredYaw));
  const alignment = Math.max(0, Math.cos(headingError));
  let remaining = segmentDistance;
  for (let i = next.index + 1; i < path.length; i++) remaining += distance(path[i - 1], path[i]);
  let targetSpeed = Math.min(maxSpeed, Math.sqrt(2 * braking * remaining));
  if (next.index + 1 < path.length) {
    const following = path[next.index + 1];
    const nextYaw = Math.atan2(following.x - target.x, following.z - target.z);
    const cornerAngle = Math.abs(angleDelta(travelYaw, nextYaw));
    const cornerSpeed = maxSpeed * Math.pow(Math.max(0, Math.cos(cornerAngle / 2)), 3);
    targetSpeed = Math.min(targetSpeed, Math.sqrt(cornerSpeed * cornerSpeed + 2 * braking * segmentDistance));
  }
  targetSpeed *= alignment * alignment;
  if (stopping) targetSpeed = 0;
  const deceleration = stopping ? Math.max(braking, 2.1) : braking;
  next.speed = approach(speed, targetSpeed, (targetSpeed < speed ? deceleration : acceleration) * dt);
  // Trapezoidal integration eases into and out of a stride without overshooting.
  const travel = Math.min(segmentDistance, (speed + next.speed) * 0.5 * dt * alignment);
  if (segmentDistance > 0) {
    next.position.x += dx / segmentDistance * travel;
    next.position.z += dz / segmentDistance * travel;
  }
  if (travel >= segmentDistance - 1e-7) {
    next.position = { x: target.x, z: target.z };
    next.index++;
  }
  if (next.index >= path.length || (stopping && next.speed <= 1e-4)) {
    next.speed = 0;
    next.done = true;
  }
  return next;
}

/** Turn first, then lift clear of the cushion before shifting onto it. */
export function createPostureMotion({ from, to, fromPosition, toPosition, fromYaw, recovery = false, seatContactCurve = true }) {
  const yawDistance = Math.abs(angleDelta(fromYaw, 0));
  // Smoothstep's peak derivative is 1.5; use the same 2rad/s peak as
  // calibrated locomotion instead of whipping through a half-turn.
  const turnDuration = recovery ? 0 : seatContactCurve ? 1.5 * yawDistance / 2 : Math.min(0.7, yawDistance / 4.3);
  const motion = {
    from, to,
    fromPosition: { x: fromPosition.x, z: fromPosition.z },
    toPosition: { x: toPosition.x, z: toPosition.z },
    fromYaw,
    turnDuration,
    duration: recovery ? Math.max(0.22, Math.abs(to - from) * 0.9) : 1.45,
    elapsed: 0,
    recovery, seatContactCurve: Boolean(seatContactCurve),
  };
  if (seatContactCurve) {
    // Calibrated for the current short-legged avatar. Callers select the old
    // simultaneous path for replacement models without this calibration.
    const stageDuration = 1.9 * .55;
    if (recovery) {
      const distance = Math.hypot(toPosition.x - fromPosition.x, toPosition.z - fromPosition.z);
      const poseDistance = Math.abs(to - from);
      motion.poseDuration = poseDistance > 1e-6 ? Math.max(.22, stageDuration * Math.sqrt(poseDistance)) : 0;
      motion.moveDuration = distance > 1e-6 ? Math.max(.22, stageDuration * distance / .46) : 0;
      // A cancellation must not shortcut diagonally through the cushion.
      // Full seated blend can still occur in front of the final seat position.
      motion.poseStart = to ? 0 : motion.moveDuration;
      motion.moveStart = to ? motion.poseDuration : 0;
      motion.duration = Math.max(.22, motion.poseDuration + motion.moveDuration);
    } else {
      motion.duration = 1.9;
      motion.poseDuration = motion.moveDuration = stageDuration;
      motion.poseStart = to ? 0 : motion.duration * .45;
      motion.moveStart = to ? motion.duration * .45 : 0;
    }
  }
  return motion;
}

export function samplePosture(motion, elapsed) {
  const turned = motion.turnDuration ? smooth(elapsed / motion.turnDuration) : 1;
  const localTime = elapsed - motion.turnDuration;
  const amount = smooth(localTime / motion.duration);
  const stage = (start, duration) => duration > 0 ? smooth((localTime - start) / duration) : (localTime >= start ? 1 : 0);
  const poseAmount = motion.seatContactCurve ? stage(motion.poseStart, motion.poseDuration) : amount;
  const moveAmount = motion.seatContactCurve ? stage(motion.moveStart, motion.moveDuration) : amount;
  return {
    blend: mix(motion.from, motion.to, poseAmount),
    position: {
      x: mix(motion.fromPosition.x, motion.toPosition.x, moveAmount),
      z: mix(motion.fromPosition.z, motion.toPosition.z, moveAmount),
    },
    yaw: motion.recovery ? motion.fromYaw : motion.fromYaw + angleDelta(motion.fromYaw, 0) * turned,
    done: elapsed >= motion.turnDuration + motion.duration,
  };
}

/** Completion follows actual avatar animation state, never wall-clock time. */
export function createGestureCompletion(name) {
  let observed = false;
  let settled = false;
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return {
    promise,
    update(actualGesture, visible = true) {
      if (settled || !visible) return;
      if (actualGesture === name) observed = true;
      else if (observed) { settled = true; resolve(true); }
    },
    cancel() {
      if (settled) return;
      settled = true;
      resolve(false);
    },
  };
}

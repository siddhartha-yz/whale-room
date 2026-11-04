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

/** Turn in place before sitting, then blend from the exact current pose. */
export function createPostureMotion({ from, to, fromPosition, toPosition, fromYaw, recovery = false }) {
  const yawDistance = Math.abs(angleDelta(fromYaw, 0));
  const turnDuration = recovery ? 0 : Math.min(0.7, yawDistance / 4.3);
  return {
    from, to,
    fromPosition: { x: fromPosition.x, z: fromPosition.z },
    toPosition: { x: toPosition.x, z: toPosition.z },
    fromYaw,
    turnDuration,
    duration: recovery ? Math.max(0.22, Math.abs(to - from) * 0.9) : 1.45,
    elapsed: 0,
    recovery,
  };
}

export function samplePosture(motion, elapsed) {
  const turned = motion.turnDuration ? smooth(elapsed / motion.turnDuration) : 1;
  const amount = smooth((elapsed - motion.turnDuration) / motion.duration);
  return {
    blend: mix(motion.from, motion.to, amount),
    position: {
      x: mix(motion.fromPosition.x, motion.toPosition.x, amount),
      z: mix(motion.fromPosition.z, motion.toPosition.z, amount),
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

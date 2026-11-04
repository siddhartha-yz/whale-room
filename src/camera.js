const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const mix = (a, b, t) => a + (b - a) * t;
const DEFAULT_BOUNDS = { minX: -3.42, minZ: -3.04 };
const orbitBranches = new WeakMap();

// Keep one fixed angular chart [-pi/2, pi], sacrificing the rear-left corner.
// Its bounds remain continuous when a wall stops constraining the orbit.
function roomArc(target, radius, { minX, minZ }) {
  if (radius < 1e-8) return { low: -Math.PI / 2, high: Math.PI };
  const x = (minX - target.x) / radius, z = (minZ - target.z) / radius;
  return {
    low: Math.asin(Math.max(-1, Math.min(1, x))),
    high: Math.acos(Math.max(-1, Math.min(1, z))),
  };
}

function projectAngle(angle, arc, reference = angle) {
  if (!arc) return { angle: reference + wrap(angle - reference), source: reference + wrap(angle - reference) };
  let best;
  for (let turn = -2; turn <= 2; turn++) {
    const source = angle + turn * Math.PI * 2;
    const value = Math.max(arc.low, Math.min(arc.high, source));
    const cost = Math.abs(source - value);
    if (!best || cost < best.cost - 1e-9 || Math.abs(cost - best.cost) < 1e-9 && Math.abs(source - reference) < Math.abs(best.source - reference)) {
      best = { angle: value, source, cost };
    }
  }
  return best;
}

export function constrainRoomCamera(position, target, bounds = DEFAULT_BOUNDS) {
  const dx = position.x - target.x, dz = position.z - target.z;
  const radius = Math.hypot(dx, dz);
  if (radius < 1e-8) return { ...position, x: Math.max(bounds.minX, position.x), z: Math.max(bounds.minZ, position.z) };
  const desiredAngle = Math.atan2(dx, dz);
  const angle = projectAngle(desiredAngle, roomArc(target, radius, bounds)).angle;
  return {
    x: Math.max(bounds.minX, target.x + radius * Math.sin(angle)),
    y: position.y,
    z: Math.max(bounds.minZ, target.z + radius * Math.cos(angle)),
  };
}

// Preserve a legal connected arc, including its longer direction when the
// shorter half-turn goes through a wall. No linear path through the head.
export function sampleCameraOrbit(motion, progress, bounds = DEFAULT_BOUNDS) {
  const { from, to, fromTarget, toTarget } = motion;
  const t = Math.max(0, Math.min(1, progress));
  const target = {
    x: mix(fromTarget.x, toTarget.x, t),
    y: mix(fromTarget.y, toTarget.y, t),
    z: mix(fromTarget.z, toTarget.z, t),
  };
  const fromAngle = Math.atan2(from.x - fromTarget.x, from.z - fromTarget.z);
  const toAngle = Math.atan2(to.x - toTarget.x, to.z - toTarget.z);
  const fromRadius = Math.hypot(from.x - fromTarget.x, from.z - fromTarget.z);
  const toRadius = Math.hypot(to.x - toTarget.x, to.z - toTarget.z);
  const radius = mix(fromRadius, toRadius, t);
  let branches = orbitBranches.get(motion);
  if (!branches) {
    const initialFrom = projectAngle(fromAngle, roomArc(fromTarget, fromRadius, bounds));
    const initialTo = projectAngle(toAngle, roomArc(toTarget, toRadius, bounds), initialFrom.source);
    const inChart = value => Math.max(-Math.PI / 2, Math.min(Math.PI, value));
    branches = { from: inChart(initialFrom.source), to: inChart(initialTo.source) };
    orbitBranches.set(motion, branches);
  }
  const arc = roomArc(target, radius, bounds);
  // Main translates this same motion while the character moves. Do not choose
  // new equivalent angles as its radius or target approaches a wall.
  // Clamp the interpolated angle, not both endpoints: an endpoint constraint
  // becoming inactive must not accelerate an already legal camera position.
  const angle = Math.max(arc.low, Math.min(arc.high, mix(branches.from, branches.to, t)));
  return { target, position: {
    x: target.x + radius * Math.sin(angle),
    y: target.y + mix(from.y - fromTarget.y, to.y - toTarget.y, t),
    z: target.z + radius * Math.cos(angle),
  } };
}

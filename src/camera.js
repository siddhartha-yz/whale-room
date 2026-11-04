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

// A padded segment/AABB test approximates sweeping the camera's small near-plane
// volume, rather than allowing a centre ray to scrape through furniture.
function firstCameraHit(start, end, boxes, padding) {
  let closest = null;
  for (const box of boxes) {
    let enter = 0, leave = 1;
    for (const axis of ['X', 'Y', 'Z']) {
      const key = axis.toLowerCase(), direction = end[key] - start[key];
      const low = box[`min${axis}`] - padding, high = box[`max${axis}`] + padding;
      if (Math.abs(direction) < 1e-10) {
        if (start[key] < low || start[key] > high) { enter = Infinity; break; }
      } else {
        const a = (low - start[key]) / direction, b = (high - start[key]) / direction;
        enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
        if (enter > leave) break;
      }
    }
    if (enter <= leave && enter <= 1 && leave >= 0) closest = closest === null ? enter : Math.min(closest, enter);
  }
  return closest;
}

/**
 * Pure furniture-aware close-camera correction. Feed the desired orbit position,
 * never last frame's corrected position; pass the previous result for soft
 * release. Furniture uses flat { minX, maxX, minY, maxY, minZ, maxZ } bounds.
 * A target inside padded furniture is unsolvable and is reported as `blocked`.
 */
function resolveSpringArm(desiredPosition, target, boxes = [], {
  previous = null, deltaSeconds = 1 / 60, padding = .10, maxLift = .65,
  releaseRate = 5, bounds = DEFAULT_BOUNDS,
} = {}) {
  const desired = desiredPosition.x >= bounds.minX && desiredPosition.z >= bounds.minZ
    ? { x: desiredPosition.x, y: desiredPosition.y, z: desiredPosition.z }
    : constrainRoomCamera(desiredPosition, target, bounds);
  const dx = desired.x - target.x, dy = desired.y - target.y, dz = desired.z - target.z;
  const radius = Math.hypot(dx, dy, dz), horizontal = Math.hypot(dx, dz);
  const dt = Math.max(0, Math.min(.1, Number.isFinite(deltaSeconds) ? deltaSeconds : 0));
  const clearance = Math.max(0, padding);
  const hit = firstCameraHit(target, desired, boxes, clearance);
  if (radius < 1e-8 || hit === 0) {
    return { position: desired, lift: 0, distance: radius, fraction: 1, occluded: hit !== null, mode: hit === 0 ? 'blocked' : 'clear' };
  }
  const liftLimit = Math.max(0, Math.min(maxLift, radius * .98 - dy));
  function liftedPosition(lift) {
    if (lift === 0 || horizontal < 1e-8) return { ...desired };
    const y = dy + lift;
    const horizontalScale = Math.sqrt(Math.max(0, radius * radius - y * y)) / horizontal;
    return { x: target.x + dx * horizontalScale, y: target.y + y, z: target.z + dz * horizontalScale };
  }
  let neededLift = 0;
  if (hit !== null && horizontal >= 1e-8) {
    // Search upwards first to retain subject size. Refine the first clear band
    // instead of jumping between coarse elevation steps as the subject moves.
    let low = 0, high = liftLimit;
    let found = false;
    for (let step = 1; step <= 16; step++) {
      high = liftLimit * step / 16;
      if (firstCameraHit(target, liftedPosition(high), boxes, clearance) === null) { found = true; break; }
      low = high;
    }
    if (found) {
      for (let iteration = 0; iteration < 16; iteration++) {
        const middle = (low + high) / 2;
        if (firstCameraHit(target, liftedPosition(middle), boxes, clearance) === null) high = middle;
        else low = middle;
      }
      neededLift = high;
    } else neededLift = liftLimit;
  }
  const previousLift = Math.min(liftLimit, Math.max(0, previous?.lift ?? 0));
  const release = 1 - Math.exp(-Math.max(0, releaseRate) * dt);
  // Catch an obstruction immediately; retain a decaying correction when it
  // clears so walking along a furniture edge does not pump the camera.
  let lift = neededLift >= previousLift ? neededLift : mix(previousLift, neededLift, release);
  if (neededLift === 0 && lift < 1e-4) lift = 0;
  const elevated = liftedPosition(lift);
  const elevatedHit = firstCameraHit(target, elevated, boxes, clearance);
  const safeFraction = elevatedHit === null ? 1 : Math.max(0, elevatedHit - .015 / radius);
  const previousFraction = Math.max(0, Math.min(1, previous?.fraction ?? 1));
  let fraction = Math.min(safeFraction, mix(previousFraction, 1, release));
  if (safeFraction === 1 && fraction > 1 - 1e-4) fraction = 1;
  const position = lift === 0 && fraction === 1 ? desired : {
    x: mix(target.x, elevated.x, fraction),
    y: mix(target.y, elevated.y, fraction),
    z: mix(target.z, elevated.z, fraction),
  };
  return {
    position, lift, distance: radius * fraction, fraction, occluded: hit !== null,
    mode: fraction < 1 ? 'compressed' : lift > 0 ? (hit === null ? 'releasing' : 'lifted') : 'clear',
  };
}

/**
 * Opt in to a minimum subject distance with `minimumFramingDistance`.
 * The rendered camera keeps its last reachable angular corridor when a drag
 * crosses furniture. Its desired orbit remains entirely owned by the caller.
 * `framingJump` identifies an initial/forced safety correction; an enclosed
 * target with no feasible ray is explicitly `framingUnresolved`.
 */
export function resolveCameraOcclusion(desiredPosition, target, boxes = [], options = {}) {
  const minimum = Math.max(0, options.minimumFramingDistance ?? 0);
  if (!minimum) return resolveSpringArm(desiredPosition, target, boxes, options);
  const bounds = options.bounds ?? DEFAULT_BOUNDS;
  const previous = options.previous;
  const dt = Math.max(0, Math.min(.1, Number.isFinite(options.deltaSeconds) ? options.deltaSeconds : 1 / 60));
  const speed = Math.max(.1, options.framingAngularSpeed ?? 1.8);
  // Near a cabinet corner, the nearest angular solution can abruptly switch
  // from going around its side to going over its top. Keep that elevation
  // change bounded; the angular search can retain the visible side corridor.
  const framingOptions = { ...options, maxLift: previous
    ? Math.min(options.maxLift ?? .65, (previous.lift ?? 0) + 1.2 * dt)
    : options.maxLift ?? .65 };
  let desired = desiredPosition.x >= bounds.minX && desiredPosition.z >= bounds.minZ
    ? { x: desiredPosition.x, y: desiredPosition.y, z: desiredPosition.z }
    : constrainRoomCamera(desiredPosition, target, bounds);
  let dx = desired.x - target.x, dy = desired.y - target.y, dz = desired.z - target.z;
  let radius = Math.hypot(dx, dy, dz);
  if (radius < minimum) {
    const scale = radius > 1e-8 ? minimum / radius : 0;
    desired = constrainRoomCamera({ x: target.x + dx * scale, y: target.y + dy * scale,
      z: target.z + (radius > 1e-8 ? dz * scale : minimum) }, target, bounds);
    dx = desired.x - target.x; dy = desired.y - target.y; dz = desired.z - target.z;
    radius = Math.hypot(dx, dy, dz);
  }
  const horizontal = Math.hypot(dx, dz);
  const arc = roomArc(target, horizontal, bounds);
  const desiredAngle = projectAngle(Math.atan2(dx, dz), arc).angle;
  const pointAt = angle => angle === desiredAngle ? desired : ({
    x: target.x + horizontal * Math.sin(angle), y: target.y + dy,
    z: target.z + horizontal * Math.cos(angle) });
  // Probe geometric clearance without retaining an already unsafe short arm.
  // Retain lift, so leaving an occluder cannot abruptly drop the camera.
  const probePrevious = previous ? { ...previous, fraction: 1 } : null;
  const probes = new Map();
  const probe = angle => {
    if (!probes.has(angle)) probes.set(angle, resolveSpringArm(pointAt(angle), target, boxes,
      { ...framingOptions, previous: probePrevious }));
    return probes.get(angle);
  };
  // Prefer an adjacent angle over an abrupt zoom. A gradually shortened arm
  // may still be used, but it never crosses the configured framing floor.
  let requiredDistance = Math.max(minimum, Math.min(radius, (previous?.distance ?? minimum) - .9 * dt));
  const safe = result => result.mode !== 'blocked' && result.distance >= requiredDistance - 1e-8;
  const intended = probe(desiredAngle);
  let priorAngle = Number.isFinite(previous?.framingAngle) ? previous.framingAngle : null;
  let angle = priorAngle === null ? desiredAngle : Math.max(arc.low, Math.min(arc.high, priorAngle));
  let forced = false, reason = null;
  if (!safe(probe(angle))) {
    // Search outward from the previous corridor, not from the desired angle.
    // This prevents the two sides of a cabinet from exchanging priority midway
    // through a walk. Refine the nearest safe boundary after finding a band.
    const step = Math.PI / 180;
    function nearestSafe() {
      for (let amount = step; amount <= Math.PI * 2 + step; amount += step) {
        for (const sign of [1, -1]) {
          const candidate = Math.max(arc.low, Math.min(arc.high, angle + sign * amount));
          if (candidate === angle || !safe(probe(candidate))) continue;
          let low = Math.max(0, Math.abs(candidate - angle) - step), high = Math.abs(candidate - angle);
          for (let iteration = 0; iteration < 12; iteration++) {
            const middle = (low + high) / 2;
            if (safe(probe(angle + sign * middle))) high = middle; else low = middle;
          }
          return angle + sign * high;
        }
      }
      return null;
    }
    let found = nearestSafe();
    if (found === null && requiredDistance > minimum) {
      requiredDistance = minimum;
      found = nearestSafe();
    }
    if (found === null) {
      // There is no solution at the requested radius in the legal room arc.
      // Keep the camera out of the head and report the unresolved occlusion;
      // never silently claim that an impossible ray is safe.
      return { ...intended, position: desired, distance: radius, fraction: 1, mode: 'blocked',
        framingAngle: desiredAngle, framingTarget: { ...target }, framingFallback: true,
        framingJump: true, framingReason: 'no-safe-framing-ray', framingUnresolved: true };
    }
    forced = true;
    reason = priorAngle === null ? 'initial-unsafe-ray' : 'corridor-became-blocked';
    angle = found;
  }
  // Verify the whole angular move. A clear endpoint on the far side of a
  // cabinet does not authorize crossing its blocked sector during a drag.
  function reachable(from, to) {
    const count = Math.max(1, Math.ceil(Math.abs(to - from) / (Math.PI / 180)));
    let last = from;
    for (let index = 1; index <= count; index++) {
      const next = mix(from, to, index / count);
      if (!safe(probe(next))) {
        let low = last, high = next;
        for (let iteration = 0; iteration < 12; iteration++) {
          const middle = (low + high) / 2;
          if (safe(probe(middle))) low = middle; else high = middle;
        }
        return low;
      }
      last = next;
    }
    return to;
  }
  if (priorAngle === null && !forced) angle = desiredAngle;
  else {
    const direct = reachable(angle, desiredAngle);
    if (!previous?.framingFallback && !forced && direct === desiredAngle) angle = desiredAngle;
    else {
      const movement = Math.max(-speed * dt, Math.min(speed * dt, desiredAngle - angle));
      angle = reachable(angle, angle + movement);
    }
  }
  const geometric = probe(angle);
  const releasePrevious = previous ? { ...previous,
    fraction: Math.max(minimum / radius, previous.fraction ?? 1) } : null;
  const result = resolveSpringArm(pointAt(angle), target, boxes, { ...framingOptions, previous: releasePrevious });
  // Geometry was checked with this same retained lift. Rounding at a tangency
  // must not lower the framing bound through the smoothing path.
  const framed = safe(result) ? result : geometric;
  const displaced = Math.abs(angle - desiredAngle) > 1e-5;
  const previousTarget = previous?.framingTarget;
  const correctionStep = previousTarget ? Math.hypot(
    framed.position.x - previous.position.x - (target.x - previousTarget.x),
    framed.position.y - previous.position.y - (target.y - previousTarget.y),
    framed.position.z - previous.position.z - (target.z - previousTarget.z)) : 0;
  const jump = forced && priorAngle === null || forced && Math.abs(angle - priorAngle) > .12
    || (displaced || previous?.framingFallback) && correctionStep > .25;
  return { ...framed, framingAngle: angle, framingTarget: { ...target },
    framingFallback: displaced || !safe(intended), framingJump: Boolean(jump),
    framingReason: reason ?? (jump ? 'elevation-clearance' : null), framingUnresolved: false };
}

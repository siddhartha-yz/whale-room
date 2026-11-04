import test from 'node:test';
import assert from 'node:assert/strict';
import { findPath, isWalkable } from '../src/navigation.js';
import { stepRoute, createPostureMotion, samplePosture, createGestureCompletion, angleDelta } from '../src/motion.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const tick = 1 / 60;
function segmentDistance(point, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((point.x-a.x)*dx+(point.z-a.z)*dz)/(dx*dx+dz*dz)));
  return Math.hypot(point.x-a.x-t*dx, point.z-a.z-t*dz);
}
function step(input, dt = tick, options) { return stepRoute(input, dt, options); }

test('walking eases to a destination and finishes with zero translation speed', () => {
  const end = { x: 0, z: 1.8 }, path = [end];
  let motion = { position: { x: 0, z: 0 }, path, yaw: 0, speed: 0, index: 0 };
  let peak = 0, speedNearEnd = 1;
  for (let frame = 0; frame < 1200 && !motion.done; frame++) {
    motion = { ...step(motion), path };
    peak = Math.max(peak, motion.speed);
    if (dist(motion.position, end) < 0.015 && !motion.done) speedNearEnd = Math.min(speedNearEnd, motion.speed);
  }
  assert.equal(motion.done, true);
  assert.deepEqual(motion.position, end);
  assert.equal(motion.speed, 0);
  assert.ok(peak > 0.4, 'normal walking should still reach useful speed');
  assert.ok(speedNearEnd < 0.2, 'arrival slows before the endpoint, not only after freezing position');
});

test('a turn slows translation rather than sliding backwards at walking speed', () => {
  const path = [{ x: 0, z: -2 }];
  let motion = { position: { x: 0, z: 0 }, path, yaw: 0, speed: 0, index: 0 };
  for (let frame = 0; frame < 18; frame++) motion = { ...step(motion), path };
  assert.ok(Math.abs(motion.yaw) > 0.9, 'body begins turning');
  assert.ok(dist(motion.position, { x: 0, z: 0 }) < 0.002, 'feet wait while the body faces the wrong way');
  for (let frame = 0; frame < 1200 && !motion.done; frame++) motion = { ...step(motion), path };
  assert.equal(motion.done, true);
});

test('corner easing stays on every collision-checked segment around actual furniture', () => {
  const start = { x: 1.5, z: 1.6 }, end = { x: -3, z: -.5 };
  const path = findPath(start, end), points = [start, ...path];
  assert.ok(path.length > 1);
  let motion = { position: start, path, yaw: .3, speed: 0, index: 0 };
  for (let frame = 0; frame < 4000 && !motion.done; frame++) {
    const old = motion.position;
    motion = { ...step(motion), path };
    assert.ok(isWalkable(motion.position));
    assert.ok(points.slice(1).some((target, i) => segmentDistance(motion.position, points[i], target) < 1e-8), 'steering must not round a corner into furniture');
    for (let sample = 1; sample <= 3; sample++) {
      const t = sample/3;
      assert.ok(isWalkable({ x: old.x+(motion.position.x-old.x)*t, z: old.z+(motion.position.z-old.z)*t }));
    }
  }
  assert.equal(motion.done, true);
  assert.deepEqual(motion.position, end);
});

test('stop decelerates within a few centimetres without leaving the valid route', () => {
  const path = [{ x: 0, z: 2 }];
  let motion = { position: { x: 0, z: 0 }, path, yaw: 0, speed: .45, index: 0 };
  let previousSpeed = motion.speed;
  for (let frame = 0; frame < 100 && !motion.done; frame++) {
    motion = { ...step(motion, tick, { stopping: true }), path };
    assert.ok(motion.speed <= previousSpeed);
    previousSpeed = motion.speed;
  }
  assert.equal(motion.done, true);
  assert.equal(motion.speed, 0);
  assert.ok(motion.position.z > 0 && motion.position.z < .06);
  assert.equal(motion.position.x, 0);
});

test('sitting rotates continuously before changing the seated blend', () => {
  const motion = createPostureMotion({ from: 0, to: 1, fromPosition: { x: -.85, z: -1.25 }, toPosition: { x: -.85, z: -1.71 }, fromYaw: Math.PI });
  const initial = samplePosture(motion, 0), first = samplePosture(motion, tick);
  assert.equal(initial.yaw, Math.PI);
  assert.equal(initial.blend, 0);
  assert.deepEqual(initial.position, motion.fromPosition);
  assert.ok(Math.abs(angleDelta(initial.yaw, first.yaw)) < .05, 'no instant half-turn');
  assert.equal(first.blend, 0, 'turn before climbing onto the cushion');
  const final = samplePosture(motion, 3);
  assert.equal(final.done, true);
  assert.equal(final.blend, 1);
  assert.deepEqual(final.position, motion.toPosition);
  assert.ok(Math.abs(angleDelta(final.yaw, 0)) < 1e-9);
});

test('interrupted sitting and standing recover from the current pose without a first-frame jump', () => {
  const approach = { x: -.85, z: -1.25 }, seat = { x: -.85, z: -1.71 };
  for (const originalTo of [0, 1]) {
    const original = createPostureMotion({ from: 1-originalTo, to: originalTo, fromPosition: originalTo ? approach : seat, toPosition: originalTo ? seat : approach, fromYaw: 0 });
    for (const at of [.3, .7, 1.1]) {
      const interrupted = samplePosture(original, at);
      const to = interrupted.blend >= .5 ? 1 : 0;
      const recovery = createPostureMotion({ from: interrupted.blend, to, fromPosition: interrupted.position, toPosition: to ? seat : approach, fromYaw: interrupted.yaw, recovery: true });
      const start = samplePosture(recovery, 0);
      assert.equal(start.blend, interrupted.blend);
      assert.deepEqual(start.position, interrupted.position);
      const afterOneFrame = samplePosture(recovery, tick);
      assert.ok(Math.abs(afterOneFrame.blend-start.blend) < .02);
      assert.ok(dist(afterOneFrame.position,start.position) < .01);
      const end = samplePosture(recovery, 1);
      assert.equal(end.blend, to);
      assert.deepEqual(end.position, to ? seat : approach);
      assert.equal(end.done, true);
    }
  }
});

test('hidden time cannot complete a gesture that has not visibly finished', async () => {
  const completion = createGestureCompletion('wave');
  let result;
  completion.promise.then(value => { result = value; });
  completion.update('wave', true);
  completion.update(null, false); // wall-clock duration passed while the page was hidden
  await Promise.resolve();
  assert.equal(result, undefined);
  completion.update('wave', true); // rendering resumes the same gesture
  await Promise.resolve();
  assert.equal(result, undefined);
  completion.update(null, true);
  assert.equal(await completion.promise, true);
});

test('cancelled gestures never report completion after a later avatar update', async () => {
  const completion = createGestureCompletion('nod');
  completion.update('nod');
  completion.cancel();
  completion.update(null);
  assert.equal(await completion.promise, false);
});

test('fixed facing yaw permits a slow backstep out of either activity station without turning into the table', () => {
  for (const x of [-.36, .29]) {
    const path = [{ x, z: 1.62 }];
    let motion = { position: { x, z: 1.25 }, path, yaw: Math.PI, speed: 0, index: 0 };
    for (let frame = 0; frame < 600 && !motion.done; frame++) {
      motion = { ...step(motion, tick, { facingYaw: Math.PI, maxSpeed: .22 }), path };
      assert.equal(motion.yaw, Math.PI);
      assert.ok(motion.speed <= .22);
      assert.ok(isWalkable(motion.position, { clearance: 'body' }));
    }
    assert.equal(motion.done, true);
    assert.deepEqual(motion.position, path[0]);
    assert.equal(isWalkable(motion.position), true, 'turning is safe after leaving the interaction corridor');
  }
});

test('a cancelled fixed-yaw backstep brakes in its corridor and can resume to the same station', () => {
  const start = { x: -.36, z: 1.25 }, end = { x: -.36, z: 1.62 }, path = [end];
  let motion = { position: start, path, yaw: Math.PI, speed: 0, index: 0 };
  for (let frame = 0; frame < 30; frame++) motion = { ...step(motion, tick, { facingYaw: Math.PI, maxSpeed: .22 }), path };
  const atCancel = motion.position;
  for (let frame = 0; frame < 100 && !motion.done; frame++) {
    motion = { ...step(motion, tick, { facingYaw: Math.PI, maxSpeed: .22, stopping: true }), path };
    assert.equal(motion.yaw, Math.PI);
    assert.ok(isWalkable(motion.position, { clearance: 'body' }));
  }
  assert.equal(motion.done, true);
  assert.ok(dist(atCancel, motion.position) < .02);
  const returning = findPath(motion.position, start, { clearance: 'body' });
  motion = { position: motion.position, path: returning, yaw: Math.PI, speed: 0, index: 0 };
  for (let frame = 0; frame < 600 && !motion.done; frame++) motion = { ...step(motion, tick, { facingYaw: Math.PI, maxSpeed: .22 }), path: returning };
  assert.equal(motion.done, true); assert.deepEqual(motion.position, start);
});

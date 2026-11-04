import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLookAction } from '../src/look-action.js';

const radians = degrees => degrees * Math.PI / 180;
const targetAt = degrees => ({ x: 4 * Math.sin(radians(degrees)), z: 4 * Math.cos(radians(degrees)) });
const classify = options => classifyLookAction({ position: { x: 0, z: 0 }, yaw: 0, calibrated: true, ...options });

test('the real seated sofa-to-plant direction cannot be reported as an attainable constrained look', () => {
  const position = { x: -.85, z: -1.7096382098543147 }, target = { x: 3.03, z: -2.47 };
  const angle = Math.atan2(target.x - position.x, target.z - position.z) * 180 / Math.PI;
  assert.ok(Math.abs(angle - 101.088) < .002);
  assert.deepEqual(classify({ position, target, canTurn: false }), { ok: false, turnYaw: null, reason: 'outside-cone' });
});

test('free standing uses the current yaw and the shortest turn while retaining small glances', () => {
  assert.deepEqual(classify({ target: targetAt(18), canTurn: true }), { ok: true, turnYaw: null, reason: 'within-cone' });
  const behind = classify({ target: { x: 0, z: -4 }, canTurn: true });
  assert.equal(behind.ok, true);assert.equal(behind.reason, 'turn-required');assert.equal(behind.turnYaw, Math.PI);
  const yaw = radians(530), wrapped = classify({ yaw, target: targetAt(-170), canTurn: true });
  assert.equal(wrapped.reason, 'turn-required');
  assert.ok(Math.abs(wrapped.turnYaw - yaw - radians(20)) < 1e-12, '170 to -170 turns twenty degrees, not 340');
  const alreadyFacing = classify({ yaw: Math.PI, target: targetAt(180), canTurn: true });
  assert.equal(alreadyFacing.turnYaw, null);
});

test('constrained ordinary and reading poses use calibrated conservative cones on both sides', () => {
  for (const sign of [-1, 1]) {
    assert.equal(classify({ target: targetAt(sign * 30) }).ok, true);
    assert.equal(classify({ target: targetAt(sign * 30.01) }).ok, false);
    assert.equal(classify({ target: targetAt(sign * 24), calibrated: false }).ok, true);
    assert.equal(classify({ target: targetAt(sign * 24.01), calibrated: false }).ok, false);
    const read = classify({ target: targetAt(sign * 22), activity: { name: 'read' }, canTurn: true });
    assert.equal(read.ok, true);assert.equal(read.turnYaw, null);
    assert.equal(classify({ target: targetAt(sign * 22.01), activity: { kind: 'read' }, canTurn: true }).ok, false);
    assert.equal(classify({ target: targetAt(sign * 23), activity: 'read', calibrated: false }).ok, false);
  }
  assert.equal(classify({ target: targetAt(90), activity: { name: 'stretch' }, canTurn: true }).ok, false);
});

test('drink, cup transfer, or any held/blocked activity owns gaze even with free-turn permission', () => {
  for (const activity of ['drink', { name: 'move_cup' }, { kind: 'drink' }, { blocked: true },
    { name: 'read', holdingProp: true }, { holding: true }, { held: true }, { heldObject: 'cup' }]) {
    assert.deepEqual(classify({ target: targetAt(0), canTurn: true, activity }), {
      ok: false, turnYaw: null, reason: 'activity-owns-gaze',
    });
  }
});

test('unknown targets, invalid poses and coincident horizontal positions are explicit and inputs remain unchanged', () => {
  for (const target of [undefined, null, 'plant', {}, { x: NaN, z: 0 }, { x: 0, z: Infinity }]) {
    assert.equal(classify({ target }).reason, 'invalid-target');
  }
  assert.equal(classify({ target: targetAt(0), yaw: NaN }).reason, 'invalid-pose');
  assert.equal(classify({ target: targetAt(0), position: null }).reason, 'invalid-pose');
  const input = Object.freeze({ position: Object.freeze({ x: 1, z: 2 }), target: Object.freeze({ x: 1, z: 2 }), yaw: 0, canTurn: true });
  assert.deepEqual(classifyLookAction(input), { ok: false, turnYaw: null, reason: 'coincident-target' });
  assert.equal(classifyLookAction().reason, 'invalid-target');
});

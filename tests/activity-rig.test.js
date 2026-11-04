import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createActivityState, sampleActivity, stepActivity, cancelActivityState } from '../src/activity-rig.js';
import { createRoomActivities } from '../src/room-activities.js';
import { createAvatar } from '../src/avatar.js';
import { localModelSkip, loadLocalVrmFixture } from './vrm-fixture.js';

function advance(state, duration) {
  for (let i = 0; i < duration * 60; i++) state = stepActivity(state, 1 / 60);
  return state;
}

test('reading stays embodied until explicitly stopped and cancellation has a finite exit', () => {
  const state = advance(createActivityState('read'), 240);
  assert.equal(sampleActivity(state).done, false);
  assert.equal(sampleActivity(state).bookOpen, 1);
  const exiting = cancelActivityState(state);
  assert.equal(sampleActivity(exiting).bookOpen, sampleActivity(state).bookOpen);
  const ended = sampleActivity(advance(exiting, 1.2));
  assert.equal(ended.done, true);
  assert.equal(ended.bookOpen, 0);
  assert.equal(ended.leftWeight + ended.rightWeight, 0);
});

test('interrupting a drink preserves the current pose and returns directly without finishing its sip', () => {
  for (const time of [0.6, 1.9, 2.7, 4.4, 5.7, 6.9]) {
    const original = advance(createActivityState('drink'), time), before = sampleActivity(original);
    const cancelled = cancelActivityState(original), first = sampleActivity(cancelled);
    assert.deepEqual(first.rightWrist, before.rightWrist);
    assert.equal(first.shouldHoldCup, before.shouldHoldCup);
    const after = sampleActivity(advance(cancelled, 2));
    assert.equal(after.done, true);
    assert.equal(after.shouldHoldCup, false);
  }
});

test('a cup transfer anticipates its landing and returns its gaze with a cancelled hold', () => {
  const source = [-.035, .5525, .34], destination = [-.235, .5525, .34];
  const create = () => createActivityState('move_cup', { anchors: {
    cup: source, cupPickup: [-.035, .54, .16], cupDestination: [-.235, .54, .16],
  } });
  const near = (actual, expected) => assert.ok(Math.hypot(...actual.map((value, i) => value - expected[i])) < 1e-6);
  near(sampleActivity(advance(create(), 2.2)).lookAt, source);
  const beforeSlide = sampleActivity(advance(create(), 2.95));
  assert.equal(beforeSlide.phase, 'lifting-cup');
  near(beforeSlide.lookAt, destination);
  const returning = cancelActivityState(advance(create(), 3.6), { holdingProp: true });
  near(sampleActivity(returning).lookAt, destination);
  const returned = sampleActivity(advance(returning, .5));
  near(returned.lookAt, source);
  assert.equal(returned.shouldHoldCup, true);
  const alreadyPlaced = cancelActivityState(advance(create(), 6.6), { holdingProp: false });
  near(sampleActivity(alreadyPlaced).lookAt, destination);
});

async function avatarFixture() {
  const original = GLTFLoader.prototype.loadAsync;
  GLTFLoader.prototype.loadAsync = async () => loadLocalVrmFixture();
  const scene = new THREE.Scene();
  try {
    const avatar = await createAvatar(scene), props = createRoomActivities(scene);
    return { scene, avatar, props };
  } finally { GLTFLoader.prototype.loadAsync = original; }
}

function enterStation(avatar, props, name) {
  const point = props.stations[name];
  avatar.root.position.set(point.x, 0, point.z); avatar.root.rotation.y = point.yaw;
  for (let i = 0; i < 60; i++) avatar.update(1 / 60);
}

// Conservative front/back envelope of the actually deformed head triangles.
// This catches a cup handle or rim buried in the face; it is not a general
// watertight-mesh collision solver or a guarantee between sampled frames.
function cupFaceDepth(avatar, props) {
  let head;
  avatar.vrm.scene.traverse((object) => { if (object.name === 'head.001:head') head = object; });
  assert.ok(head);
  const inverse = avatar.root.matrixWorld.clone().invert(), vertices = [], triangles = [];
  const point = new THREE.Vector3(), index = head.geometry.index;
  for (let i = 0; i < head.geometry.attributes.position.count; i++) {
    head.getVertexPosition(i, point);
    vertices.push(point.clone().applyMatrix4(head.matrixWorld).applyMatrix4(inverse));
  }
  for (let i = 0; i < index.count; i += 3) {
    const [a, b, c] = [0, 1, 2].map((offset) => vertices[index.getX(i + offset)]);
    const determinant = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(determinant) < 1e-10) continue;
    triangles.push({ a, b, c, determinant, minX: Math.min(a.x, b.x, c.x), maxX: Math.max(a.x, b.x, c.x), minY: Math.min(a.y, b.y, c.y), maxY: Math.max(a.y, b.y, c.y) });
  }
  let maxDepth = 0;
  props.cup.updateWorldMatrix(true, true);
  props.cup.traverse((object) => {
    if (!object.isMesh) return;
    for (let vertex = 0; vertex < object.geometry.attributes.position.count; vertex++) {
      point.fromBufferAttribute(object.geometry.attributes.position, vertex).applyMatrix4(object.matrixWorld).applyMatrix4(inverse);
      let front = -Infinity, back = Infinity;
      for (const { a, b, c, determinant, minX, maxX, minY, maxY } of triangles) {
        if (point.x < minX || point.x > maxX || point.y < minY || point.y > maxY) continue;
        const u = ((b.y - c.y) * (point.x - c.x) + (c.x - b.x) * (point.y - c.y)) / determinant;
        const v = ((c.y - a.y) * (point.x - c.x) + (a.x - c.x) * (point.y - c.y)) / determinant;
        if (u < 0 || v < 0 || u + v > 1) continue;
        const z = u * a.z + v * b.z + (1 - u - v) * c.z;
        front = Math.max(front, z); back = Math.min(back, z);
      }
      if (point.z > back + .003 && point.z < front) maxDepth = Math.max(maxDepth, front - point.z);
    }
  });
  return maxDepth;
}

for (const floorHeight of [.0025, .0285]) test(`actual avatar carries one cup continuously on floor ${floorHeight} and returns it to the coaster`, { skip: localModelSkip }, async (t) => {
  const { avatar, props } = await avatarFixture();
  const update = avatar.update; avatar.update = (dt, context = {}) => update(dt, { ...context, groundHeightAt: () => floorHeight });
  enterStation(avatar, props, 'drink');
  const initial = props.cup.getWorldPosition(new THREE.Vector3());
  const handle = avatar.setActivity('drink', { props }); assert.ok(handle);
  let previous = initial.clone(), maxJump = 0, maxHandError = 0, moved = false, mouthGap = Infinity, maxFaceDepth = 0;
  for (let i = 0; i < 9 * 60; i++) {
    if (i === 210) avatar.setAttention('responding');
    avatar.update(1 / 60);
    assert.equal(avatar.getState().responseCuePitch, 0, 'a text response during drinking must not lower the head into the cup');
    const current = props.cup.getWorldPosition(new THREE.Vector3());
    maxJump = Math.max(maxJump, previous.distanceTo(current));
    if (current.distanceTo(initial) > .1) moved = true;
    const activity = avatar.getState().activity;
    if (activity?.holdingProp) maxHandError = Math.max(maxHandError, activity.handErrors.right);
    if (i >= 120 && i <= 390 && i % 12 === 0) maxFaceDepth = Math.max(maxFaceDepth, cupFaceDepth(avatar, props));
    if (i === 245) {
      let head;
      avatar.vrm.scene.traverse((object) => { if (object.name === 'head.001:head') head = object; });
      const position = head.geometry.attributes.position, vowel = head.geometry.morphAttributes.position[11];
      const mouth = new THREE.Vector3(), point = new THREE.Vector3(); let count = 0;
      for (let vertex = 0; vertex < position.count; vertex++) {
        if (Math.abs(position.getX(vertex)) < .04 && position.getY(vertex) < .52 && position.getZ(vertex) > .135
            && Math.hypot(vowel.getX(vertex), vowel.getY(vertex), vowel.getZ(vertex)) > .001) {
          head.getVertexPosition(vertex, point); point.applyMatrix4(head.matrixWorld); mouth.add(point); count++;
        }
      }
      assert.ok(count > 100, 'measure the real mouth region, not a hand-authored empty anchor');
      mouth.multiplyScalar(1 / count);
      mouthGap = mouth.distanceTo(props.cup.localToWorld(new THREE.Vector3(0, .06, .073)));
    }
    previous.copy(current);
  }
  const result = await handle.finished;
  t.diagnostic(JSON.stringify({ result, maxJump, maxHandError, mouthGap, maxFaceDepth }));
  assert.equal(await handle.started, true);
  assert.equal(result.status, 'completed');
  assert.equal(props.isCupHeld(), false);
  assert.equal(avatar.getState().activity, null);
  assert.ok(moved, 'the actual cup must leave its place');
  assert.ok(maxJump < .025, 'cup must not teleport between table and wrist');
  assert.ok(maxHandError < .015);
  assert.ok(result.placement.position < .012);
  assert.ok(mouthGap < .02, 'the real cup rim must reach the mouth region');
  assert.ok(maxFaceDepth < .003, `the cup body and handle must stay outside the face envelope: ${maxFaceDepth}`);
});

for (const floorHeight of [.0025, .0285]) test(`actual reading fingertips reach the page on floor ${floorHeight} and an interrupted read closes cleanly`, { skip: localModelSkip }, async () => {
  const { avatar, props } = await avatarFixture();
  const update = avatar.update; avatar.update = (dt, context = {}) => update(dt, { ...context, groundHeightAt: () => floorHeight });
  enterStation(avatar, props, 'read');
  const handle = avatar.setActivity('read', { props }); assert.ok(handle);
  for (let i = 0; i < 5 * 60; i++) avatar.update(1 / 60);
  assert.equal(await handle.started, true);
  assert.equal(avatar.getState().activity.phase, 'reading');
  assert.equal(props.getState().bookOpen, 1);
  for (const side of ['left', 'right']) {
    const finger = avatar.vrm.humanoid.getRawBoneNode(`${side}IndexDistal`).getWorldPosition(new THREE.Vector3());
    props.book.updateWorldMatrix(true, true);
    const page = props.book.getObjectByName(side === 'left' ? 'LeftPageBlock' : 'RightPageBlock');
    // Probe just inside the front edge, under the distal finger pad. This tests
    // actual raised page geometry, not a duplicated formula for its tilt.
    const ray = new THREE.Raycaster(new THREE.Vector3(finger.x, finger.y + .2, finger.z - .01), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObject(page)[0];
    assert.ok(hit && finger.distanceTo(hit.point) < .02, `${side} fingertip must touch the raised open page`);
    assert.ok(Math.abs(finger.z - (props.book.position.z + .107)) < .015);
    assert.ok(Math.abs(finger.x - props.book.position.x) < .155);
  }
  const head = avatar.vrm.humanoid.getRawBoneNode('head');
  const headBefore = head.getWorldQuaternion(new THREE.Quaternion());
  const handBefore = avatar.vrm.humanoid.getRawBoneNode('rightHand').getWorldPosition(new THREE.Vector3());
  const userTarget = avatar.root.localToWorld(new THREE.Vector3(.8, 1.05, 2));
  avatar.setAttention('responding');
  for (let i = 0; i < 60; i++) avatar.update(1 / 60, { lookTarget: userTarget });
  assert.equal(avatar.getState().responseCuePitch, 0, 'reading retains its own head and hand pose during a response');
  assert.ok(headBefore.angleTo(head.getWorldQuaternion(new THREE.Quaternion())) > .15, 'reading must permit a real head glance toward the supplied user target');
  assert.ok(handBefore.distanceTo(avatar.vrm.humanoid.getRawBoneNode('rightHand').getWorldPosition(new THREE.Vector3())) < .001, 'looking up must not move the supported hand off the page');
  const exit = avatar.cancelActivity();
  for (let i = 0; i < 80; i++) avatar.update(1 / 60);
  assert.equal((await exit).status, 'cancelled');
  assert.equal(props.getState().bookOpen, 0);
  assert.equal(avatar.getState().activity, null);
});

test('actual held-cup cancellation settles visibly before resolving', { skip: localModelSkip }, async (t) => {
  const { avatar, props } = await avatarFixture(); enterStation(avatar, props, 'drink');
  const handle = avatar.setActivity('drink', { props });
  for (let i = 0; i < 250; i++) avatar.update(1 / 60);
  assert.equal(props.isCupHeld(), true);
  const before = props.cup.getWorldPosition(new THREE.Vector3());
  const cancelled = avatar.cancelActivity();
  assert.equal(cancelled, handle.finished);
  assert.ok(props.cup.getWorldPosition(new THREE.Vector3()).distanceTo(before) < 1e-9);
  assert.equal(avatar.getState().activity.cancelling, true);
  let previous = before.clone(), maxJump = 0;
  for (let i = 0; i < 130; i++) {
    avatar.update(1 / 60);
    const current = props.cup.getWorldPosition(new THREE.Vector3());
    maxJump = Math.max(maxJump, current.distanceTo(previous)); previous.copy(current);
  }
  const result = await cancelled;
  t.diagnostic(JSON.stringify({ result, maxJump }));
  assert.equal(result.status, 'cancelled');
  assert.ok(result.placement.position < .012);
  assert.ok(maxJump < .025);
  assert.equal(props.isCupHeld(), false);
});

test('real drink cancellation is safe across grasp, lift, sip, release, and immediate reuse', { skip: localModelSkip }, async (t) => {
  const { avatar, props } = await avatarFixture(); enterStation(avatar, props, 'drink');
  const armNames = ['leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand', 'leftIndexProximal', 'rightIndexProximal'];
  const resting = Object.fromEntries(armNames.map((name) => [name, avatar.vrm.humanoid.getNormalizedBoneNode(name).quaternion.clone()]));
  const cancelTimes = [0, .3, 1.59, 1.79, 1.81, 1.99, 2.01, 2.6, 3.21, 4.99, 5.01, 6.49, 6.79, 6.81, 7.5];
  let worstReturn = 0, worstJump = 0, worstRestAngle = 0;
  for (const cancelAt of cancelTimes) {
    const handle = avatar.setActivity('drink', { props }); assert.ok(handle, `start at ${cancelAt}`);
    let previous = props.cup.getWorldPosition(new THREE.Vector3());
    const tick = () => {
      avatar.update(1 / 60);
      const current = props.cup.getWorldPosition(new THREE.Vector3());
      worstJump = Math.max(worstJump, current.distanceTo(previous)); previous.copy(current);
    };
    for (let frame = 0; frame < Math.round(cancelAt * 60); frame++) tick();
    const activeBefore = avatar.getState().activity;
    assert.ok(activeBefore);
    const before = props.cup.getWorldPosition(new THREE.Vector3());
    const finished = avatar.cancelActivity();
    assert.equal(finished, handle.finished);
    assert.equal(avatar.cancelActivity(), finished, 'repeated cancellation must share one exit');
    assert.ok(props.cup.getWorldPosition(new THREE.Vector3()).distanceTo(before) < 1e-9);
    for (let frame = 0; frame < 130; frame++) tick();
    assert.equal(avatar.getState().activity, null, `exit must complete at ${cancelAt}`);
    const result = await finished;
    assert.equal(result.status, 'cancelled');
    assert.equal(await handle.started, cancelAt >= .35, `started has the correct meaning at ${cancelAt}`);
    assert.equal(props.isCupHeld(), false);
    worstReturn = Math.max(worstReturn, props.getCupReturnError().position);
    // Allow the ordinary idle pose filter to finish its small visible settling.
    for (let frame = 0; frame < 90; frame++) tick();
    for (const name of armNames) worstRestAngle = Math.max(worstRestAngle, resting[name].angleTo(avatar.vrm.humanoid.getNormalizedBoneNode(name).quaternion));
  }
  t.diagnostic(JSON.stringify({ cancelledAt: cancelTimes, worstReturn, worstJump, worstRestAngle }));
  assert.ok(worstReturn < .012);
  assert.ok(worstJump < .025);
  assert.ok(worstRestAngle < .005, 'no grip or arm pose can remain latched for the next action');
});

test('real read cancellation closes the cover from entry, page-turn, and timed-exit phases', { skip: localModelSkip }, async (t) => {
  const { avatar, props } = await avatarFixture(); enterStation(avatar, props, 'read');
  const cancelTimes = [0, .7, 1.4, 1.8, 2.7, 3.1, 7.1, 7.35, 7.65, 7.95, 8.2, 11.4];
  let worstHandJump = 0;
  for (const cancelAt of cancelTimes) {
    const handle = avatar.setActivity('read', { props, durationSeconds: cancelAt > 11 ? 8 : null }); assert.ok(handle);
    let previous = avatar.vrm.humanoid.getRawBoneNode('rightHand').getWorldPosition(new THREE.Vector3());
    const tick = () => {
      avatar.update(1 / 60);
      const current = avatar.vrm.humanoid.getRawBoneNode('rightHand').getWorldPosition(new THREE.Vector3());
      worstHandJump = Math.max(worstHandJump, current.distanceTo(previous)); previous.copy(current);
    };
    for (let frame = 0; frame < Math.round(cancelAt * 60); frame++) tick();
    assert.ok(avatar.getState().activity, `activity should still exist at ${cancelAt}`);
    const before = props.getState().bookOpen;
    const exit = avatar.cancelActivity();
    assert.equal(props.getState().bookOpen, before, 'cancel must not snap the book closed');
    for (let frame = 0; frame < 140; frame++) tick();
    assert.equal(avatar.getState().activity, null);
    assert.equal((await exit).status, 'cancelled');
    assert.equal(await handle.started, cancelAt >= 3);
    assert.equal(props.getState().bookOpen, 0);
    assert.equal(props.book.getObjectByName('TurningPage').children[0].visible, false);
    assert.equal(props.isCupHeld(), false);
  }
  t.diagnostic(JSON.stringify({ cancelledAt: cancelTimes, worstHandJump }));
  assert.ok(worstHandJump < .035);
});

test('walking after a cancelled real stretch has no residual arm-layer rotation', { skip: localModelSkip }, async () => {
  const { avatar } = await avatarFixture();
  const { avatar: control } = await avatarFixture();
  for (const cancelAt of [.5, 2.2, 4.2]) {
    const handle = avatar.setActivity('stretch'); assert.ok(handle);
    for (let frame = 0; frame < Math.round(cancelAt * 60); frame++) avatar.update(1 / 60);
    avatar.cancelActivity();
    for (let frame = 0; frame < 50; frame++) avatar.update(1 / 60);
    assert.equal((await handle.finished).status, 'cancelled');
    assert.equal(avatar.getState().activity, null);
    for (const walkDirection of [1, -1]) {
      const context = { speed: walkDirection < 0 ? .22 : .45, walkDirection };
      for (let frame = 0; frame < 120; frame++) { avatar.update(1 / 60, context); control.update(1 / 60, context); }
      for (const name of ['leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand']) {
        assert.ok(avatar.vrm.humanoid.getNormalizedBoneNode(name).quaternion.angleTo(control.vrm.humanoid.getNormalizedBoneNode(name).quaternion) < .005, `${name}, direction ${walkDirection}`);
      }
    }
    for (let frame = 0; frame < 120; frame++) { avatar.update(1 / 60); control.update(1 / 60); }
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { VRMHumanoid } from '@pixiv/three-vrm';
import { GAIT, createGaitState, stepGait } from '../src/gait.js';

function settle(speed, seconds = 3, initial = createGaitState(), extra = {}) {
  let state = initial;
  for (let i = 0; i < seconds * 60; i++) state = stepGait(state, 1 / 60, { speed, ...extra });
  return state;
}

test('half travel speed halves stride rather than halving both stride and cadence', () => {
  const full = settle(0.45), half = settle(0.225);
  assert.ok(Math.abs(full.omega - 6.3) < 1e-6);
  assert.ok(Math.abs(half.omega - full.omega) < 1e-6);
  assert.ok(Math.abs(half.blend / full.blend - 0.5) < 1e-6);
  assert.ok(Math.abs(half.leftHip / full.leftHip - 0.5) < 1e-6);
  assert.ok(Math.abs(half.leftKnee / full.leftKnee - 0.5) < 1e-6);
});

test('stopping fades the pose before resetting phase, and sitting has no steady walking offset', () => {
  const walking = settle(0.45), before = structuredClone(walking);
  const firstStop = stepGait(walking, 1 / 60, { speed: 0 });
  assert.deepEqual(walking, before, 'update must not mutate its input');
  assert.ok(firstStop.blend > 0.85 && firstStop.blend < walking.blend);
  assert.ok(firstStop.omega > 0 && firstStop.omega < walking.omega);
  assert.deepEqual(settle(0, 1.5, walking), createGaitState());
  assert.deepEqual(settle(0.45, 1.5, walking, { sitBlend: 1 }), createGaitState());
});

test('gait remains finite and bounded across uneven frame times', () => {
  let state = createGaitState();
  for (const dt of [0, 0.008, 0.033, 2, -1, Number.NaN]) {
    state = stepGait(state, dt, { speed: 0.45 });
    assert.ok(Object.values(state).every(Number.isFinite));
    assert.ok(Math.abs(state.leftHip) <= GAIT.hipAmplitude);
    assert.ok(state.blend >= 0 && state.blend <= 1);
  }
});

test('backwards steps reverse cadence smoothly without reversing knee flexion', () => {
  let state = settle(.22, 3, createGaitState(), { direction: -1 });
  assert.ok(Math.abs(state.omega + GAIT.angularSpeed) < 1e-6);
  assert.ok(Math.abs(state.blend - .22 / GAIT.nominalSpeed) < 1e-6);
  for (let frame = 0; frame < 120; frame++) {
    state = stepGait(state, 1 / 60, { speed: .22, direction: -1 });
    assert.ok(state.phase >= 0 && state.phase < Math.PI * 2);
    assert.ok(state.leftKnee >= 0 && state.rightKnee >= 0);
    assert.ok(state.leftKnee <= .27 && state.rightKnee <= .27);
  }
  const forward = settle(.45), reverse = stepGait(forward, 1 / 60, { speed: .22, direction: -1 });
  assert.ok(reverse.omega > 0 && reverse.omega < forward.omega, 'direction changes decelerate before reversing');
  assert.ok(Math.abs(reverse.leftHip - forward.leftHip) < .06);
  assert.deepEqual(settle(0, 1.5, state), createGaitState());
});

const modelUrl = new URL('../public/assets/deepseek-chibi.vrm', import.meta.url);
function modelSkeleton() {
  const file = readFileSync(modelUrl), jsonSize = file.readUInt32LE(12);
  const json = JSON.parse(file.subarray(20, 20 + jsonSize)), binary = file.subarray(28 + jsonSize);
  const nodes = json.nodes.map((definition) => {
    const node = new THREE.Object3D();
    if (definition.translation) node.position.fromArray(definition.translation);
    if (definition.rotation) node.quaternion.fromArray(definition.rotation);
    if (definition.scale) node.scale.fromArray(definition.scale);
    return node;
  });
  json.nodes.forEach((definition, i) => { for (const child of definition.children ?? []) nodes[i].add(nodes[child]); });
  const scene = new THREE.Group();
  for (const index of json.scenes[json.scene ?? 0].nodes) scene.add(nodes[index]);
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3(), point = new THREE.Vector3();
  json.nodes.forEach((definition, i) => {
    if (definition.mesh === undefined) return;
    for (const primitive of json.meshes[definition.mesh].primitives) {
      const accessor = json.accessors[primitive.attributes.POSITION], view = json.bufferViews[accessor.bufferView];
      assert.equal(accessor.componentType, 5126);
      const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0), stride = view.byteStride ?? 12;
      for (let vertex = 0; vertex < accessor.count; vertex++) {
        const offset = start + stride * vertex;
        point.set(binary.readFloatLE(offset), binary.readFloatLE(offset + 4), binary.readFloatLE(offset + 8)).applyMatrix4(nodes[i].matrixWorld);
        bounds.expandByPoint(point);
      }
    }
  });
  const humanBones = Object.fromEntries(Object.entries(json.extensions.VRMC_vrm.humanoid.humanBones).map(([name, bone]) => [name, { node: nodes[bone.node] }]));
  const humanoid = new VRMHumanoid(humanBones);
  scene.add(humanoid.normalizedHumanBonesRoot);
  const scale = 1.35 / (bounds.max.y - bounds.min.y);
  scene.scale.setScalar(scale); scene.position.y = -bounds.min.y * scale;
  scene.updateMatrixWorld(true);
  return { humanoid, scene, scale };
}

function toeVelocityProxy(useNewGait, speed = .45, direction = 1) {
  const { humanoid, scene, scale } = modelSkeleton();
  const bone = (name) => humanoid.getNormalizedBoneNode(name);
  const hipRest = bone('hips').position.clone(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const dt = 1 / 60;
  let state = createGaitState(), oldPhase = 0, previousZ = null;
  const backwardVelocities = [];
  function pose(name, x = 0, y = 0, z = 0, rate = 16) {
    q.setFromEuler(e.set(x, y, z));
    bone(name).quaternion.slerp(q, 1 - Math.exp(-rate * dt));
  }
  for (let frame = 0; frame < 12 * 60; frame++) {
    state = stepGait(state, dt, { speed, direction });
    let current = state;
    if (!useNewGait) {
      // The former avatar.js curve: omega=10+speed*5, same amplitudes and
      // 16/s joint smoothing. Compare against this frozen regression baseline.
      oldPhase += dt * (10 + speed * 5);
      const g = Math.sin(oldPhase), left = Math.max(0, -g), right = Math.max(0, g);
      current = { leftHip: -g * .4, rightHip: g * .4, leftKnee: left * .55, rightKnee: right * .55,
        leftAnkle: -left * .17, rightAnkle: -right * .17, bob: Math.cos(oldPhase * 2) * .008, hipYaw: .025 * g, hipRoll: -.018 * g };
    }
    pose('leftUpperLeg', current.leftHip); pose('rightUpperLeg', current.rightHip);
    pose('leftLowerLeg', current.leftKnee); pose('rightLowerLeg', current.rightKnee);
    pose('leftFoot', current.leftAnkle); pose('rightFoot', current.rightAnkle);
    bone('hips').position.copy(hipRest); bone('hips').position.y += current.bob / scale;
    pose('hips', 0, current.hipYaw, current.hipRoll, 10);
    humanoid.update(); scene.updateMatrixWorld(true);
    const z = humanoid.getRawBoneNode('leftToes').getWorldPosition(new THREE.Vector3()).z;
    if (frame > 4 * 60 && previousZ !== null) {
      const localVelocity = (z - previousZ) / dt;
      if (localVelocity * direction < 0) backwardVelocities.push(speed * direction + localVelocity);
    }
    previousZ = z;
  }
  return backwardVelocities.reduce((sum, velocity) => sum + velocity, 0) / backwardVelocities.length;
}

test('actual chibi skeleton reduces average backward toe velocity mismatch', { skip: existsSync(modelUrl) ? false : 'Local-only whale VRM is not distributed; skipping calibrated gait geometry.' }, (t) => {
  const { humanoid } = modelSkeleton();
  const position = (name) => humanoid.getRawBoneNode(name).getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(position('leftUpperLeg').distanceTo(position('leftLowerLeg')) - .10964) < .0001);
  assert.ok(Math.abs(position('leftLowerLeg').distanceTo(position('leftFoot')) - .07600) < .0001);
  const before = toeVelocityProxy(false), after = toeVelocityProxy(true);
  t.diagnostic(`Backward toe velocity proxy: ${before.toFixed(3)} -> ${after.toFixed(3)} m/s`);
  assert.ok(before < -0.30, `old toe proxy should reproduce backward mismatch: ${before}`);
  assert.ok(Math.abs(after) < 0.10, `new toe proxy should be closer to stationary: ${after}`);
  assert.ok(Math.abs(after) < Math.abs(before) * 0.3);
  // This metric does not identify actual shoe-floor contact or guarantee foot
  // locking; browser side-view verification still decides whether it looks good.
});

test('actual chibi skeleton has a bounded stance-direction toe proxy for short backwards steps', { skip: existsSync(modelUrl) ? false : 'Local-only whale VRM is not distributed; skipping calibrated gait geometry.' }, (t) => {
  const proxy = toeVelocityProxy(true, .22, -1);
  t.diagnostic(`Backwards walking toe velocity proxy: ${proxy.toFixed(3)} m/s at -0.22 m/s travel`);
  assert.ok(Math.abs(proxy) < .08, `backwards toe proxy should be close to stationary: ${proxy}`);
});

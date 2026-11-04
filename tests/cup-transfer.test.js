import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createAvatar } from '../src/avatar.js';
import { createRoomActivities } from '../src/room-activities.js';
import { localModelSkip, loadLocalVrmFixture } from './vrm-fixture.js';
const skip = localModelSkip;

async function fixture(enabled = true, replacement = false) {
  const original = GLTFLoader.prototype.loadAsync, scene = new THREE.Scene();
  GLTFLoader.prototype.loadAsync = async () => {
    const gltf = loadLocalVrmFixture(), file = readFileSync(new URL('../public/assets/deepseek-chibi.vrm', import.meta.url));
    const json = JSON.parse(file.subarray(20, 20 + file.readUInt32LE(12)));
    gltf.userData.vrm.meta = { ...json.extensions.VRMC_vrm.meta, metaVersion: '1', ...(replacement ? { name: 'Replacement' } : {}) };
    return gltf;
  };
  let avatar;
  try { avatar = await createAvatar(scene); } finally { GLTFLoader.prototype.loadAsync = original; }
  const props = createRoomActivities(scene);if (enabled) props.enableCupTransfer();
  const tick = () => avatar.update(1 / 60, { groundHeightAt: () => .0285 });
  function enter(name) {
    assert.equal(props.isCupHeld(), false, 'never relocate a held cup by moving the fixture root');
    const station = props.stations[name];avatar.root.position.set(station.x, 0, station.z);avatar.root.rotation.y = station.yaw;
    for (let i = 0; i < 90; i++) tick();
  }
  return { scene, avatar, props, tick, enter };
}
function cupPosition(props) { return props.cup.getWorldPosition(new THREE.Vector3()); }
function gripDepth(avatar, props) {
  avatar.root.updateMatrixWorld(true);props.cup.updateWorldMatrix(true, true);
  const handle = props.cup.children.find(m => m.geometry?.type === 'TorusGeometry'), inverse = handle.matrixWorld.clone().invert();
  const { radius, tube } = handle.geometry.parameters;
  const names = ['rightHand', ...['Index', 'Middle', 'Ring', 'Little'].flatMap(f => ['Proximal', 'Intermediate', 'Distal'].map(j => `right${f}${j}`)), ...['Metacarpal', 'Proximal', 'Distal'].map(j => `rightThumb${j}`)];
  const bones = new Set(names.map(n => avatar.vrm.humanoid.getRawBoneNode(n)).filter(Boolean)), p = new THREE.Vector3();let depth = 0;
  avatar.vrm.scene.traverse(mesh => {
    if (!mesh.isSkinnedMesh) return;
    const joints = mesh.geometry.attributes.skinIndex, weights = mesh.geometry.attributes.skinWeight;
    for (let i = 0; i < joints.count; i++) {
      let sum = 0;for (let k = 0; k < 4; k++) if (bones.has(mesh.skeleton.bones[joints.getComponent(i, k)])) sum += weights.getComponent(i, k);
      if (sum < .5) continue;
      mesh.getVertexPosition(i, p);p.applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
      depth = Math.max(depth, tube - Math.hypot(Math.hypot(p.x, p.y) - radius, p.z));
    }
  });
  return depth;
}
function mouthGap(avatar, props) {
  let head;avatar.vrm.scene.traverse(m => { if (m.name === 'head.001:head') head = m; });
  const position = head.geometry.attributes.position, vowel = head.geometry.morphAttributes.position[11];
  const mouth = new THREE.Vector3(), p = new THREE.Vector3();let count = 0;
  for (let i = 0; i < position.count; i++) if (Math.abs(position.getX(i)) < .04 && position.getY(i) < .52 && position.getZ(i) > .135
    && Math.hypot(vowel.getX(i), vowel.getY(i), vowel.getZ(i)) > .001) { head.getVertexPosition(i, p);mouth.add(p.applyMatrix4(head.matrixWorld));count++; }
  assert.ok(count > 100);mouth.divideScalar(count);
  return mouth.distanceTo(props.cup.localToWorld(new THREE.Vector3(0, .06, .073)));
}
async function animate(f, name, options = {}, { cancelAt, inspect } = {}) {
  const h = f.avatar.setActivity(name, { props: f.props, ...options });assert.ok(h);
  let previous = cupPosition(f.props), maxJump = 0, cancelled = false;
  for (let i = 0; i < 900; i++) {
    if (cancelAt !== undefined && !cancelled && i / 60 >= cancelAt) {
      const before = cupPosition(f.props);assert.equal(f.avatar.cancelActivity(), h.finished);assert.equal(f.avatar.cancelActivity(), h.finished);
      assert.ok(cupPosition(f.props).distanceTo(before) < 1e-10);cancelled = true;
    }
    f.tick();const p = cupPosition(f.props);maxJump = Math.max(maxJump, previous.distanceTo(p));previous.copy(p);
    inspect?.(i / 60, f.avatar.getState().activity);
    if (!f.avatar.getState().activity || f.props.getCupState().blocked) break;
  }
  return { result: await h.finished, maxJump };
}

test('two cup places are opt-in and replacement models cannot enter the calibrated transfer', { skip }, async () => {
  const f = await fixture(false);
  try {
    f.enter('move_cup');assert.equal(f.avatar.setActivity('move_cup', { props: f.props, cupDestination: 'cup_edge' }), null);
    assert.equal(f.props.getCupState().supported, false);
    const before = cupPosition(f.props);assert.equal(f.props.enableCupTransfer(), true);assert.equal(f.props.enableCupTransfer(), true);
    assert.ok(cupPosition(f.props).distanceTo(before) < 1e-10);
    const pads = f.props.root.children.filter(o => /^CupCoaster/.test(o.name));assert.equal(pads.length, 2);
    assert.ok(pads[1].position.x - pads[0].position.x > pads[0].geometry.parameters.radiusTop + pads[1].geometry.parameters.radiusTop);
  } finally { f.avatar.dispose(); }
  const replacement = await fixture(true, true);
  try { replacement.enter('move_cup');assert.equal(replacement.avatar.setActivity('move_cup', { props: replacement.props, cupDestination: 'cup_edge' }), null); }
  finally { replacement.avatar.dispose(); }
});

test('deposit requires stable real support and commits at release, never from a target name alone', () => {
  const unsafe = createRoomActivities(new THREE.Scene());unsafe.enableCupTransfer();unsafe.cup.position.y += .1;
  assert.equal(unsafe.beginCupTransfer('cup_edge'), null, 'an unsupported source is not a calibrated pickup');
  const props = createRoomActivities(new THREE.Scene());props.enableCupTransfer();const tx = props.beginCupTransfer('cup_edge');
  props.attachCup(new THREE.Matrix4());
  for (let i = 0; i < 10; i++) props.updateHeldCup(new THREE.Matrix4().makeTranslation(.2, .1, 0));
  assert.equal(props.tryCupDeposit(tx), false);assert.equal(props.getCupState().spot, 'cup_inner');assert.equal(props.isCupHeld(), true);
  props.updateHeldCup(new THREE.Matrix4().makeTranslation(.2, 0, 0));assert.equal(props.tryCupDeposit(tx), false, 'one frame is not stable support');
  for (let i = 0; i < 4; i++) props.updateHeldCup(new THREE.Matrix4().makeTranslation(.2, 0, 0));
  assert.equal(props.tryCupDeposit(tx), true);assert.equal(props.getCupState().spot, 'cup_edge');assert.equal(props.isCupHeld(), false);
  assert.equal(props.requestCupReturn(tx), false, 'a deposited cup is not rolled back by cancellation');
  assert.deepEqual(tx.effect, { type: 'cup_moved', from: 'cup_inner', to: 'cup_edge' });props.finishCupTransfer(tx);
});

test('real cup transfers both ways, stays on the pads, and drinks return to the actual current place', { skip }, async t => {
  const f = await fixture();const summaries = [];
  try {
    for (const destination of ['cup_edge', 'cup_inner', 'cup_edge']) {
      f.enter('move_cup');let maxWrist = 0, maxGrip = 0, minTravelClearance = Infinity;
      const moved = await animate(f, 'move_cup', { cupDestination: destination }, { inspect(time, activity) {
        if (activity?.holdingProp) maxWrist = Math.max(maxWrist, activity.handErrors.right);
        if (activity?.holdingProp && Math.round(time * 60) % 15 === 0) maxGrip = Math.max(maxGrip, gripDepth(f.avatar, f.props));
        if (time > 3.05 && time < 4.45) minTravelClearance = Math.min(minTravelClearance, new THREE.Box3().setFromObject(f.props.cup).min.y - .4925);
      } });
      assert.equal(moved.result.status, 'completed');assert.equal(f.props.getCupState().spot, destination);assert.equal(f.props.isCupHeld(), false);
      assert.equal(moved.result.effect.to, destination);assert.ok(moved.result.placement.position < .012);assert.ok(moved.result.placement.supportMargin > .01);
      assert.ok(maxWrist < .015);assert.ok(maxGrip < .0045, `grip ${destination} ${maxGrip}`);assert.ok(minTravelClearance > .02);assert.ok(moved.maxJump < .01);
      const home = cupPosition(f.props);f.enter('drink');let sipGap = null;
      const drank = await animate(f, 'drink', {}, { inspect(time) { if (Math.abs(time - 245 / 60) < .001) sipGap = mouthGap(f.avatar, f.props); } });
      assert.equal(drank.result.status, 'completed');assert.ok(sipGap < .02);assert.ok(cupPosition(f.props).distanceTo(home) < .002);
      f.enter('drink');const cancelled = await animate(f, 'drink', {}, { cancelAt: 3.6 });
      assert.equal(cancelled.result.status, 'cancelled');assert.ok(cupPosition(f.props).distanceTo(home) < .004);assert.equal(f.props.getCupState().spot, destination);
      summaries.push({ destination, placement: moved.result.placement, maxWrist, maxGrip, minTravelClearance, sipGap });
    }
    // Repeating an already-achieved destination does not pick the cup up again.
    f.enter('move_cup');const before = cupPosition(f.props), unchanged = await animate(f, 'move_cup', { cupDestination: 'cup_edge' });
    assert.equal(unchanged.result.status, 'completed');assert.equal(unchanged.result.effect, null);assert.ok(cupPosition(f.props).distanceTo(before) < 1e-10);
  } finally { f.avatar.dispose(); }
  t.diagnostic(JSON.stringify(summaries));
});

test('transfer cancellation lifts back to source before release and never rolls back a completed deposit', { skip }, async () => {
  for (const cancelAt of [1, 1.79, 1.81, 3.75, 5.7, 6.45, 7.5]) {
    const f = await fixture();
    try {
      f.enter('move_cup');const source = cupPosition(f.props);let returnClearance = Infinity;
      const { result, maxJump } = await animate(f, 'move_cup', { cupDestination: 'cup_edge' }, { cancelAt, inspect(time, activity) {
        if (cancelAt === 5.7 && time > cancelAt + .5 && time < cancelAt + 1.25 && activity?.holdingProp)
          returnClearance = Math.min(returnClearance, new THREE.Box3().setFromObject(f.props.cup).min.y - .4925);
      } });
      assert.equal(result.status, 'cancelled');assert.equal(f.props.isCupHeld(), false);assert.equal(f.props.getCupState().blocked, false);assert.ok(maxJump < .015);
      if (cancelAt < 6.4) { assert.equal(f.props.getCupState().spot, 'cup_inner');assert.equal(result.effect, null);assert.ok(cupPosition(f.props).distanceTo(source) < .004); }
      else { assert.equal(f.props.getCupState().spot, 'cup_edge');assert.equal(result.effect.to, 'cup_edge');assert.ok(result.placement.supported); }
      if (cancelAt === 5.7) assert.ok(returnClearance > .02, `must lift before crossing back: ${returnClearance}`);
    } finally { f.avatar.dispose(); }
  }
});

test('failed target deposit returns safely; failed source deposit resolves failed while remaining held and blocked', { skip }, async () => {
  for (const sourceAlsoFails of [false, true]) {
    const f = await fixture();
    try {
      const tryDeposit = f.props.tryCupDeposit;
      f.props.tryCupDeposit = tx => sourceAlsoFails || !tx.returning ? false : tryDeposit(tx);
      f.enter('move_cup');const { result } = await animate(f, 'move_cup', { cupDestination: 'cup_edge' });
      assert.equal(result.status, 'failed');assert.equal(result.effect, null);assert.equal(f.props.getCupState().spot, 'cup_inner');
      assert.equal(f.props.getCupState().held, sourceAlsoFails);assert.equal(f.props.getCupState().blocked, sourceAlsoFails);
      if (sourceAlsoFails) {
        assert.equal(result.code, 'CUP_RETURN_BLOCKED');assert.equal(f.avatar.getState().activity.phase, 'holding-cup');
        assert.equal(f.avatar.setActivity('drink', { props: f.props }), null);assert.deepEqual(await f.avatar.cancelActivity(), result);
        const before = cupPosition(f.props);let previous = before.clone(), maxStep = 0;
        for (let i = 0; i < 120; i++) { f.tick();const p = cupPosition(f.props);maxStep = Math.max(maxStep, p.distanceTo(previous));previous.copy(p);assert.equal(f.props.isCupHeld(), true); }
        assert.ok(maxStep < .001, 'holding failure must not snap the cup');
        assert.ok(cupPosition(f.props).distanceTo(before) < .006, `failed held pose moved ${cupPosition(f.props).distanceTo(before)}: ${before.toArray()} -> ${cupPosition(f.props).toArray()}`);
      } else { assert.equal(f.avatar.getState().activity, null);assert.ok(result.placement.supported); }
    } finally { f.avatar.dispose(); }
  }
});

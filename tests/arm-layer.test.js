import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createAvatar } from '../src/avatar.js';
import { createRoomActivities } from '../src/room-activities.js';
import { localModelAvailable, loadLocalVrmFixture } from './vrm-fixture.js';

async function fixture(name) {
  const original = GLTFLoader.prototype.loadAsync;
  GLTFLoader.prototype.loadAsync = async () => {
    const gltf = loadLocalVrmFixture();
    const bytes = readFileSync(new URL('../public/assets/deepseek-chibi.vrm', import.meta.url));
    const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)));
    gltf.userData.vrm.meta = { ...json.extensions.VRMC_vrm.meta, metaVersion: '1' };
    return gltf;
  };
  const scene = new THREE.Scene();
  let avatar;
  try { avatar = await createAvatar(scene); } finally { GLTFLoader.prototype.loadAsync = original; }
  const props = createRoomActivities(scene);
  if (name === 'move_cup') props.enableCupTransfer();
  const station = props.stations[name];
  avatar.root.position.set(station.x, 0, station.z); avatar.root.rotation.y = station.yaw;
  // Include residual walking pose, as when the real route reaches the table.
  for (let i = 0; i < 90; i++) avatar.update(1 / 60, { groundHeightAt: () => .0285, speed: i > 60 ? .22 : 0 });
  return { avatar, props };
}

for (const name of ['drink', 'move_cup']) test(`uneven visible frames withdraw the real ${name} arm without bouncing back toward the cup`, { skip: !localModelAvailable }, async () => {
  for (const cancelAt of [null, 3.75]) {
    const { avatar, props } = await fixture(name);
    try {
      const hand = avatar.vrm.humanoid.getRawBoneNode('rightHand');
      const bones = ['rightUpperArm', 'rightLowerArm', 'rightHand'].map(n => avatar.vrm.humanoid.getRawBoneNode(n));
      const quaternions = () => bones.map(b => b.getWorldQuaternion(new THREE.Quaternion()));
      const handle = avatar.setActivity(name, { props, cupDestination: 'cup_edge' }); assert.ok(handle);
      const pattern = [.016, .033, .008, .05, .017, .025, .012];
      const frames = []; let time = 0, cancelled = false, maxDegrees = 0, previous = quaternions();
      for (let frame = 0; frame < 1000; frame++) {
        if (cancelAt !== null && !cancelled && time >= cancelAt) { avatar.cancelActivity(); cancelled = true; }
        const dt = pattern[frame % pattern.length]; time += dt;
        avatar.update(dt, { groundHeightAt: () => .0285 });
        const activity = avatar.getState().activity, current = quaternions();
        maxDegrees = Math.max(maxDegrees, ...current.map((q, i) => q.angleTo(previous[i]) * 180 / Math.PI)); previous = current;
        frames.push({ phase: activity?.phase, held: props.isCupHeld(), hand: hand.getWorldPosition(new THREE.Vector3()) });
        if (activity?.holdingProp) assert.ok(activity.handErrors.right < .015, 'weighted exit must preserve the full-weight grip');
        if (!activity || props.getCupState().blocked) break;
      }
      assert.equal(avatar.getState().activity, null, 'withdrawal must finish');
      const result = await handle.finished;
      assert.equal(result.status, cancelAt === null ? 'completed' : 'cancelled');
      assert.equal(props.isCupHeld(), false);
      assert.ok(result.placement.position < .012, 'actual cup placement must remain supported');
      if (name === 'move_cup') assert.equal(result.placement.supported, true);
      // The old feedback blend moved 13.43 mm back toward the cup on the 8 ms
      // frame after a 33 ms frame. Measure physical output, not a pose formula.
      const restingHand = frames.at(-1).hand; let largestBacktrack = 0;
      for (let i = 1; i < frames.length; i++) {
        const a = frames[i - 1], b = frames[i];
        if (b.phase !== 'withdrawing-hands' || a.held || b.held) continue;
        largestBacktrack = Math.max(largestBacktrack, b.hand.distanceTo(restingHand) - a.hand.distanceTo(restingHand));
      }
      assert.ok(largestBacktrack < .0005, `withdrawal reversed ${largestBacktrack} m`);
      assert.ok(maxDegrees < 18, `one arm step rotated ${maxDegrees} degrees`);
    } finally { avatar.dispose(); }
  }
});

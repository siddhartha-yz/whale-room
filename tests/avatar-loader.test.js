import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadAvatarModel, LOCAL_AVATAR_URL, PUBLIC_AVATAR_URL } from '../src/avatar-loader.js';
import { createAvatar } from '../src/avatar.js';
import { localModelSkip, loadLocalVrmFixture } from './vrm-fixture.js';
import { createRoomActivities } from '../src/room-activities.js';

test('local avatar wins; absent or invalid optional model falls back; total failure is explicit', async () => {
  const valid = { userData: { vrm: { humanoid: {}, expressionManager: {} } } };
  let paths = [];
  let result = await loadAvatarModel({ loadAsync: async path => { paths.push(path); return valid; } });
  assert.equal(result.usingFallback, false);
  assert.deepEqual(paths, [LOCAL_AVATAR_URL]);
  for (const first of [new Error('404'), { userData: {} }]) {
    paths = [];
    result = await loadAvatarModel({ loadAsync: async path => {
      paths.push(path);
      if (path === PUBLIC_AVATAR_URL) return valid;
      if (first instanceof Error) throw first;
      return first;
    } });
    assert.equal(result.usingFallback, true);
    assert.deepEqual(paths, [LOCAL_AVATAR_URL, PUBLIC_AVATAR_URL]);
  }
  await assert.rejects(loadAvatarModel({ loadAsync: async () => { throw new Error('missing'); } }), error => error instanceof AggregateError && error.errors.length === 2);
});

test('bundled pixiv skeleton supports finite basic poses without the private whale asset', async t => {
  const original = GLTFLoader.prototype.loadAsync;
  GLTFLoader.prototype.loadAsync = async path => {
    if (path === LOCAL_AVATAR_URL) throw new Error('Optional private model unavailable');
    return loadLocalVrmFixture(new URL('../public/assets/avatar.vrm', import.meta.url));
  };
  t.after(() => { GLTFLoader.prototype.loadAsync = original; });
  const scene = new THREE.Scene(), avatar = await createAvatar(scene, { tailGround: true });
  t.after(() => avatar.dispose());
  assert.equal(avatar.usingFallback, true);
  assert.equal(avatar.modelSource, PUBLIC_AVATAR_URL);
  assert.deepEqual(avatar.supportedActivities, ['stretch']);
  assert.equal(avatar.tabletopSupported, false);
  assert.equal(avatar.cupTransferSupported, false);
  assert.equal(avatar.getState().footPlacement.supported, false);
  assert.equal(avatar.getState().tailGround.enabled, false);
  assert.equal(scene.getObjectByName('CompanionTailGround'), undefined);
  assert.equal(avatar.setActivity('read'), null);
  assert.equal(avatar.setActivity('drink'), null);
  assert.equal(avatar.setActivity('move_cup'), null);
  const initialHead = avatar.vrm.humanoid.getRawBoneNode('head').getWorldPosition(new THREE.Vector3());
  const target = new THREE.Vector3(0, avatar.eyeHeight, 2);
  for (const expression of avatar.expressions) {
    avatar.setExpression(expression);
    for (let frame = 0; frame < 120; frame++) {
      const sitBlend = frame < 30 ? 0 : frame < 60 ? (frame - 30) / 30 : frame < 90 ? 1 : (120 - frame) / 30;
      avatar.update(1 / 60, { speed: frame < 30 ? .45 : 0, sitBlend, lookTarget: target });
      avatar.root.updateMatrixWorld(true);
      avatar.vrm.scene.traverse(object => {
        assert.ok(object.matrixWorld.elements.every(Number.isFinite), object.name);
        if (object.morphTargetInfluences) assert.ok(object.morphTargetInfluences.every(Number.isFinite));
      });
    }
  }
  avatar.setGesture('wave');
  for (let frame = 0; frame < 180; frame++) avatar.update(1 / 60, { sitBlend: 0 });
  assert.equal(avatar.getState().gesture, null);
  const stretch = avatar.setActivity('stretch');
  assert.ok(stretch);
  for (let frame = 0; frame < 600; frame++) avatar.update(1 / 60, { sitBlend: 0 });
  assert.equal((await stretch.finished).status, 'completed');
  assert.equal(avatar.getState().activity, null);
  assert.ok(initialHead.y > 1 && initialHead.y < 1.8);
});

async function localAvatarFixture(url, edit = () => {}) {
  const original = GLTFLoader.prototype.loadAsync, scene = new THREE.Scene();
  GLTFLoader.prototype.loadAsync = async path => {
    assert.equal(path, LOCAL_AVATAR_URL, 'replacement loads from the optional local filename');
    const gltf = loadLocalVrmFixture(url), bytes = readFileSync(url);
    const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)));
    gltf.userData.vrm.meta = { ...json.extensions.VRMC_vrm.meta, metaVersion: '1' };
    edit(gltf.userData.vrm);
    return gltf;
  };
  try { return { avatar: await createAvatar(scene), scene }; }
  finally { GLTFLoader.prototype.loadAsync = original; }
}

function assertTabletopUnavailable(avatar) {
  assert.equal(avatar.usingFallback, false, 'source selection and calibrated capability are separate');
  assert.equal(avatar.modelSource, LOCAL_AVATAR_URL);
  assert.equal(avatar.tabletopSupported, false);
  assert.equal(avatar.cupTransferSupported, false);
  assert.deepEqual(avatar.supportedActivities, ['stretch']);
  const props = { getAnchors() { assert.fail('uncalibrated models must be rejected before touching props'); } };
  for (const name of ['read', 'drink', 'move_cup']) assert.equal(avatar.setActivity(name, { props }), null);
  for (let frame = 0; frame < 60; frame++) avatar.update(1 / 60, { speed: .2 });
  assert.ok(avatar.vrm.humanoid.getRawBoneNode('leftFoot').matrixWorld.elements.every(Number.isFinite));
  const stretch = avatar.setActivity('stretch');assert.ok(stretch);
  return stretch;
}

test('a local replacement or metadata-only impostor retains basic actions without tabletop access', async () => {
  for (const edit of [() => {}, vrm => { vrm.meta.name = '蓝色小肥鱼Deepseek';vrm.meta.authors = ['木子恶魔']; }]) {
    const { avatar } = await localAvatarFixture(new URL('../public/assets/avatar.vrm', import.meta.url), edit);
    try {
      assert.equal(avatar.getState().footPlacement.supported, false);
      const stretch = assertTabletopUnavailable(avatar);
      for (let frame = 0; frame < 600; frame++) avatar.update(1 / 60);
      assert.equal((await stretch.finished).status, 'completed');
    } finally { avatar.dispose(); }
  }
});

test('the real calibrated whale keeps read/drink, but changed attribution cannot inherit those targets', { skip: localModelSkip }, async () => {
  const url = new URL('../public/assets/deepseek-chibi.vrm', import.meta.url);
  const { avatar, scene } = await localAvatarFixture(url);
  try {
    assert.equal(avatar.tabletopSupported, true);assert.equal(avatar.cupTransferSupported, true);
    assert.deepEqual(avatar.supportedActivities, ['read', 'drink', 'stretch', 'move_cup']);
    const props = createRoomActivities(scene);
    for (const name of ['read', 'drink']) {
      const station = props.stations[name];avatar.root.position.set(station.x, 0, station.z);avatar.root.rotation.y = station.yaw;
      for (let frame = 0; frame < 60; frame++) avatar.update(1 / 60);
      const handle = avatar.setActivity(name, { props });assert.ok(handle, name);
      const finished = avatar.cancelActivity();
      for (let frame = 0; frame < 300; frame++) avatar.update(1 / 60);
      assert.equal((await finished).status, 'cancelled');
    }
  } finally { avatar.dispose(); }
  for (const edit of [vrm => { vrm.meta.name = 'Replacement'; }, vrm => { vrm.meta.authors = ['Other author']; }]) {
    const { avatar: replacement } = await localAvatarFixture(url, edit);
    try {
      assert.equal(replacement.getState().footPlacement.supported, true, 'matching short legs alone is insufficient');
      assertTabletopUnavailable(replacement);
      replacement.cancelActivity();
      for (let frame = 0; frame < 300; frame++) replacement.update(1 / 60);
    } finally { replacement.dispose(); }
  }
});

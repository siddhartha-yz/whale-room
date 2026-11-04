import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadAvatarModel, LOCAL_AVATAR_URL, PUBLIC_AVATAR_URL } from '../src/avatar-loader.js';
import { createAvatar } from '../src/avatar.js';
import { loadLocalVrmFixture } from './vrm-fixture.js';

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

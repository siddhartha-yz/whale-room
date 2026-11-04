import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createTallPlantLeaves } from '../src/room.js';

// Preserve the unbatched room construction as a visual-equivalence fixture.
function legacyLeaves() {
  return Array.from({ length: 11 }, (_, i) => {
    const angle = i * 2.4, height = .7 + (i % 4) * .21;
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshStandardMaterial({ color: i % 2 ? '#7c9565' : '#5c7c4e', roughness: .85 }));
    leaf.scale.set(.13, .29, .04);
    leaf.position.set(3.03 + Math.cos(angle) * .25, .6 + height, -2.47 + Math.sin(angle) * .25);
    leaf.rotation.set(.5 + Math.sin(angle) * .8, angle, Math.cos(angle) * .8);
    leaf.castShadow = true;
    leaf.updateMatrixWorld();
    return leaf;
  });
}

function fixture() {
  const scene = new THREE.Scene();
  const batches = createTallPlantLeaves(scene);
  scene.updateMatrixWorld(true);
  return { batches, originals: legacyLeaves() };
}

function materialSettings(material) {
  const { uuid, metadata, ...settings } = material.toJSON();
  return settings;
}

function frustumFor(camera) {
  camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  return new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
}

function overview() {
  const camera = new THREE.PerspectiveCamera(38, 920 / 720, .05, 80);
  camera.position.set(7.2, 5.2, 9.7); camera.lookAt(-.15, .75, -.2);
  return camera;
}

function sunCamera() {
  const camera = new THREE.OrthographicCamera(-7, 7, 7, -7, .5, 500);
  camera.position.set(-4, 7, 2); camera.lookAt(0, 0, 0);
  return camera;
}

test('plant batching preserves mesh attributes, materials, transforms and shadow flags', () => {
  const { batches, originals } = fixture();
  assert.deepEqual(batches.map(batch => batch.count), [6, 5]);
  assert.equal(new Set(batches.map(batch => batch.geometry)).size, 1);
  assert.equal(new Set(batches.map(batch => batch.material)).size, 2);
  assert.equal(batches.reduce((sum, batch) => sum + batch.geometry.index.count / 3 * batch.count, 0), 3872);
  const matrix = new THREE.Matrix4();
  const originalVertex = new THREE.Vector3(), instanceVertex = new THREE.Vector3();
  originals.forEach((original, index) => {
    const batch = batches[index % 2];
    batch.getMatrixAt(Math.floor(index / 2), matrix);
    assert.deepEqual(materialSettings(batch.material), materialSettings(original.material));
    assert.equal(batch.castShadow, original.castShadow);
    assert.equal(batch.receiveShadow, original.receiveShadow);
    assert.equal(batch.material.transparent, false);
    assert.equal(batch.material.depthWrite, true);
    // Normal meshes upload Float32 matrices too. The instance upload is exact.
    assert.deepEqual(Array.from(new Float32Array(original.matrix.elements)), matrix.elements);
    assert.deepEqual(batch.geometry.index.array, original.geometry.index.array);
    assert.deepEqual(batch.geometry.groups, original.geometry.groups);
    for (const key of ['position', 'normal', 'uv']) {
      assert.deepEqual(batch.geometry.attributes[key].array, original.geometry.attributes[key].array);
    }
    const vertices = original.geometry.attributes.position;
    for (let vertex = 0; vertex < vertices.count; vertex++) {
      originalVertex.fromBufferAttribute(vertices, vertex).applyMatrix4(original.matrixWorld);
      instanceVertex.fromBufferAttribute(vertices, vertex).applyMatrix4(matrix);
      assert.ok(instanceVertex.distanceTo(originalVertex) < 2e-7);
      assert.ok(batch.boundingBox.containsPoint(instanceVertex));
      assert.ok(batch.boundingSphere.containsPoint(instanceVertex));
    }
  });
});

test('aggregate bounds retain every leaf visible in camera and sun-shadow sweeps', () => {
  const { batches, originals } = fixture();
  const cameras = [overview(), sunCamera()];
  for (let step = 0; step < 36; step++) {
    const angle = step / 36 * Math.PI * 2;
    const camera = new THREE.PerspectiveCamera(38, 920 / 720, .05, 80);
    camera.position.set(Math.cos(angle) * 8, 2.5, Math.sin(angle) * 8);
    camera.lookAt(0, .75, -.2); cameras.push(camera);
  }
  // Narrow nearby views also test a batch with only its edge leaves visible.
  for (const z of [-3.1, -1.7]) {
    const camera = new THREE.PerspectiveCamera(25, .8, .05, 80);
    camera.position.set(2.2, 1.4, z); camera.lookAt(3.03, 1.4, z); cameras.push(camera);
  }
  let observed = 0;
  for (const camera of cameras) {
    const frustum = frustumFor(camera);
    originals.forEach((leaf, index) => {
      if (!frustum.intersectsObject(leaf)) return;
      observed++;
      assert.ok(frustum.intersectsObject(batches[index % 2]));
    });
  }
  assert.ok(observed > 100);
});

test('overview predicts 18 fewer leaf draws across color and sun-shadow passes', () => {
  const { batches, originals } = fixture();
  // Frustum visibility plus one opaque material predicts calls; a real browser
  // must still verify renderer.info totals. This is not a GPU timing benchmark.
  const calls = objects => [overview(), sunCamera()].map(camera => {
    const frustum = frustumFor(camera);
    return objects.filter(object => frustum.intersectsObject(object)).length;
  });
  assert.deepEqual(calls(originals), [11, 11]);
  assert.deepEqual(calls(batches), [2, 2]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createBookcaseBooks } from '../src/room.js';

// Preserve the original unbatched construction as a visual-equivalence fixture.
function legacyBooks() {
  const books = [];
  for (let i = 0; i < 17; i++) {
    const z = -1.38 + i * .105;
    const h = .23 + (i % 4) * .045;
    const material = new THREE.MeshStandardMaterial({
      color: ['#c8c3a1', '#809585', '#bd927a', '#d8c9a6'][i % 4], roughness: .85,
    });
    const book = new THREE.Mesh(new THREE.BoxGeometry(.3, h, .068), material);
    book.position.set(3.12, .22 + h / 2, z);
    book.castShadow = true; book.receiveShadow = true;
    book.updateMatrixWorld();
    books.push(book);
  }
  return books;
}

function fixture() {
  const scene = new THREE.Scene();
  const groups = createBookcaseBooks(scene);
  scene.updateMatrixWorld(true);
  return { groups, originals: legacyBooks() };
}

function materialSettings(material) {
  const { uuid, metadata, ...settings } = material.toJSON();
  return settings;
}

function frustumFor(camera) {
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
}

test('book batching preserves geometry, UVs, normals, materials, transforms and shadow flags', () => {
  const { groups, originals } = fixture();
  assert.deepEqual(groups.map(group => group.count), [5, 4, 4, 4]);
  const matrix = new THREE.Matrix4();
  const originalVertex = new THREE.Vector3(), instanceVertex = new THREE.Vector3();
  for (let index = 0; index < originals.length; index++) {
    const original = originals[index], group = groups[index % 4];
    group.getMatrixAt(Math.floor(index / 4), matrix);
    assert.deepEqual(materialSettings(group.material), materialSettings(original.material));
    assert.equal(group.castShadow, original.castShadow);
    assert.equal(group.receiveShadow, original.receiveShadow);
    assert.equal(group.material.transparent, false, 'opaque books do not depend on transparent sorting');
    assert.equal(group.material.depthWrite, true);
    assert.deepEqual(group.geometry.index.array, original.geometry.index.array);
    assert.deepEqual(group.geometry.groups, original.geometry.groups);
    for (const attribute of ['position', 'normal', 'uv']) {
      assert.deepEqual(group.geometry.attributes[attribute].array, original.geometry.attributes[attribute].array);
    }
    const vertices = original.geometry.attributes.position;
    for (let vertex = 0; vertex < vertices.count; vertex++) {
      originalVertex.fromBufferAttribute(vertices, vertex).applyMatrix4(original.matrixWorld);
      instanceVertex.fromBufferAttribute(group.geometry.attributes.position, vertex).applyMatrix4(matrix);
      assert.ok(instanceVertex.distanceTo(originalVertex) < 2e-7,
        'instance Float32 matrices must reproduce the original vertex positions');
      assert.ok(group.boundingBox.containsPoint(instanceVertex));
      assert.ok(group.boundingSphere.containsPoint(instanceVertex));
    }
  }
  assert.equal(new Set(groups.map(group => group.geometry)).size, 4);
  assert.equal(new Set(groups.map(group => group.material)).size, 4);
  assert.equal(groups.reduce((sum, group) => sum + group.geometry.index.count / 3 * group.count, 0), 204);
});

test('aggregate culling never loses a book visible in a room camera or the sun shadow camera', () => {
  const { groups, originals } = fixture();
  const cameras = [];
  for (let step = 0; step < 36; step++) {
    const angle = step / 36 * Math.PI * 2;
    const camera = new THREE.PerspectiveCamera(38, 1.132, .05, 80);
    camera.position.set(Math.cos(angle) * 8, 2.5, Math.sin(angle) * 8);
    camera.lookAt(0, .75, -.2);
    cameras.push(camera);
  }
  // Include views where only one end of the row is inside the camera frustum.
  for (const z of [-1.7, .6]) {
    const camera = new THREE.PerspectiveCamera(25, .8, .05, 80);
    camera.position.set(2.5, .4, z); camera.lookAt(3.12, .4, z);
    cameras.push(camera);
  }
  const shadow = new THREE.OrthographicCamera(-7, 7, 7, -7, .5, 500);
  shadow.position.set(-4, 7, 2); shadow.lookAt(0, 0, 0); cameras.push(shadow);
  let visibleBooks = 0;
  for (const camera of cameras) {
    const frustum = frustumFor(camera);
    originals.forEach((book, index) => {
      if (!frustum.intersectsObject(book)) return;
      visibleBooks++;
      assert.ok(frustum.intersectsObject(groups[index % 4]), 'batch bounds must retain a visible member');
    });
  }
  assert.ok(visibleBooks > 100, 'the camera sweep must actually observe the books');
});

test('overview expects 26 fewer book draw calls across the main and sun-shadow passes', () => {
  const { groups, originals } = fixture();
  const camera = new THREE.PerspectiveCamera(38, 1.132, .05, 80);
  camera.position.set(7.2, 5.2, 9.7); camera.lookAt(-.15, .75, -.2);
  const shadow = new THREE.OrthographicCamera(-7, 7, 7, -7, .5, 500);
  shadow.position.set(-4, 7, 2); shadow.lookAt(0, 0, 0);
  // Three.js frustum tests plus one opaque material per object predict calls;
  // this is not a GPU benchmark. The browser's renderer.info verifies the total.
  const calls = objects => [camera, shadow].map(view => {
    const frustum = frustumFor(view);
    return objects.filter(object => frustum.intersectsObject(object)).length;
  });
  assert.deepEqual(calls(originals), [17, 17]);
  assert.deepEqual(calls(groups), [4, 4]);
});

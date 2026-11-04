import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMSpringBoneManager, VRMSpringBoneJoint } from '@pixiv/three-vrm';
import { createAvatar } from '../src/avatar.js';
import { createTailGround } from '../src/tail-ground.js';
import { createPostureMotion, samplePosture, stepRoute } from '../src/motion.js';
import { localModelSkip, loadLocalVrmFixture } from './vrm-fixture.js';

function springFixture() {
  const gltf = loadLocalVrmFixture(), vrm = gltf.userData.vrm;
  const file = readFileSync(new URL('../public/assets/deepseek-chibi.vrm', import.meta.url));
  const model = JSON.parse(file.subarray(20, 20 + file.readUInt32LE(12)));
  vrm.meta = { ...model.extensions.VRMC_vrm.meta, metaVersion: '1' };
  const manager = vrm.springBoneManager = new VRMSpringBoneManager();
  for (const chain of model.extensions.VRMC_springBone.springs.filter(c => c.name.startsWith('WeiBa'))) {
    for (let i = 0; i < chain.joints.length - 1; i++) {
      const spec = chain.joints[i];
      const joint = new VRMSpringBoneJoint(vrm.scene.getObjectByName(model.nodes[spec.node].name),
        vrm.scene.getObjectByName(model.nodes[chain.joints[i + 1].node].name),
        { ...spec, gravityDir: new THREE.Vector3(...spec.gravityDir) });
      joint.center = vrm.scene.getObjectByName(model.nodes[chain.center].name);
      manager.addJoint(joint);
    }
  }
  manager.setInitState();
  const original = vrm.update.bind(vrm);
  vrm.update = dt => { original(dt); manager.update(dt); };
  return gltf;
}
async function fixture(options, edit = () => {}) {
  const original = GLTFLoader.prototype.loadAsync, scene = new THREE.Scene();
  GLTFLoader.prototype.loadAsync = async () => { const gltf = springFixture(); edit(gltf.userData.vrm); return gltf; };
  try { return { avatar: await createAvatar(scene, options), scene }; }
  finally { GLTFLoader.prototype.loadAsync = original; }
}
function tailVertices(vrm) {
  const vertices = [];
  vrm.scene.traverse(mesh => {
    if (!mesh.isSkinnedMesh) return;
    const indices = mesh.geometry.attributes.skinIndex, weights = mesh.geometry.attributes.skinWeight;
    for (let vertex = 0; vertex < indices.count; vertex++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) if (mesh.skeleton.bones[indices.getComponent(vertex, k)].name.startsWith('WeiBa')) sum += weights.getComponent(vertex, k);
      if (sum > .05) vertices.push({ mesh, vertex });
    }
  });
  return vertices;
}

const skip = localModelSkip;
test('tail ground is off by default and does not alter native spring settings', { skip }, async () => {
  const { avatar, scene } = await fixture();
  try {
    assert.equal(avatar.getState().tailGround.enabled, false);
    assert.equal(scene.getObjectByName('CompanionTailGround'), undefined);
    assert.equal(avatar.vrm.springBoneManager.joints.size, 10);
    for (const joint of avatar.vrm.springBoneManager.joints) {
      assert.equal(joint.settings.hitRadius, 0); assert.equal(joint.colliderGroups.length, 0);
    }
  } finally { avatar.dispose(); }
});

test('replacement, changed chain, changed tail mesh and existing collision setup stay untouched', { skip }, async () => {
  const edits = [
    vrm => { vrm.meta.name = 'Replacement'; },
    vrm => { vrm.scene.getObjectByName('WeiBa.L.001').position.y *= 1.1; },
    vrm => { vrm.scene.traverse(mesh => { if (mesh.isSkinnedMesh && mesh.geometry.attributes.skinIndex.count === 2880) mesh.geometry.attributes.skinWeight.setXYZW(1986, 0, 0, 0, 0); }); },
    vrm => { [...vrm.springBoneManager.joints][0].settings.hitRadius = .01; },
  ];
  for (const edit of edits) {
    let before;
    const { avatar, scene } = await fixture({ tailGround: true }, vrm => { edit(vrm); before = [...vrm.springBoneManager.joints].map(j => ({ joint: j, radius: j.settings.hitRadius, groups: j.colliderGroups })); });
    try {
      assert.equal(avatar.getState().tailGround.enabled, false);
      assert.equal(scene.getObjectByName('CompanionTailGround'), undefined);
      for (const { joint, radius, groups } of before) { assert.equal(joint.settings.hitRadius, radius); assert.equal(joint.colliderGroups, groups); }
    } finally { avatar.dispose(); }
  }
});

test('one world plane survives root movement, restores original settings and leaves unrelated springs alone', { skip }, async () => {
  const { avatar, scene } = await fixture();
  const manager = avatar.vrm.springBoneManager, original = [...manager.joints].map(j => ({ joint: j, groups: j.colliderGroups }));
  const otherBone = new THREE.Bone(), otherChild = new THREE.Bone();otherChild.position.y = .1;otherBone.add(otherChild);scene.add(otherBone);
  const other = new VRMSpringBoneJoint(otherBone, otherChild, { hitRadius: .07 });other.setInitState();manager.addJoint(other);
  const rig = createTailGround(avatar.vrm, scene, { enabled: true });
  try {
    assert.equal(rig.getState().enabled, true); assert.equal(rig.getState().joints, 10);
    assert.equal(createTailGround(avatar.vrm, scene, { enabled: true }), rig);
    assert.equal(manager.joints.size, 11);
    avatar.root.position.set(-3, 0, -.5);avatar.root.rotation.y = Math.PI / 2;avatar.update(1 / 60);
    const collider = scene.getObjectByName('CompanionTailGround'), direction = new THREE.Vector3();
    assert.equal(collider.parent, scene);
    assert.ok(Math.abs(collider.shape.calculateCollision(collider.colliderMatrix, new THREE.Vector3(-3, .0025, -.5), 0, direction)) < 1e-9);
    assert.deepEqual(direction.toArray(), [0, 1, 0]);
    assert.equal(other.settings.hitRadius, .07);assert.equal(other.colliderGroups.length, 0);
    rig.dispose();rig.dispose();
    assert.equal(scene.getObjectByName('CompanionTailGround'), undefined);
    for (const { joint, groups } of original) { assert.equal(joint.settings.hitRadius, 0);assert.equal(joint.colliderGroups, groups); }
    // Dependency sorting also removes the detached collider from future updates.
    manager.update(1 / 60);assert.equal(manager.colliders.length, 0);
  } finally { rig.dispose();avatar.dispose(); }
});

test('real tail floor candidate removes measured penetration through stopping and sit/stand without large bends', { skip }, async t => {
  const results = [];
  for (const enabled of [false, true]) {
    const { avatar, scene } = await fixture({ tailGround: enabled });
    try {
      assert.equal(avatar.getState().tailGround.enabled, enabled);
      const vertices = tailVertices(avatar.vrm), point = new THREE.Vector3();
      const joints = [...avatar.vrm.springBoneManager.joints], previous = joints.map(j => j.bone.quaternion.clone());
      let maxDepth = 0, maxStep = 0;
      let route = { position: { x: -3, z: -.5 }, path: [{ x: -2.1, z: .8 }], yaw: Math.PI / 2, speed: 0, index: 0 };
      avatar.root.position.set(-3, 0, -.5);avatar.root.rotation.y = Math.PI / 2;
      for (let frame = 0; frame < 360; frame++) {
        const next = stepRoute(route, 1 / 60, { maxSpeed: avatar.preferredWalkSpeed, turnSpeed: avatar.preferredTurnSpeed, stopping: frame >= 200 });
        route = { ...next, path: route.path };avatar.root.position.set(next.position.x, 0, next.position.z);avatar.root.rotation.y = next.yaw;
        avatar.update(1 / 60, { speed: next.speed, groundHeightAt: () => .0025 });check(frame > 120);
      }
      const approach = { x: -.85, z: -1.25 }, seat = { x: -.85, z: -1.60 - avatar.thighLength };
      const down = createPostureMotion({ from: 0, to: 1, fromPosition: approach, toPosition: seat, fromYaw: 0 });
      const up = createPostureMotion({ from: 1, to: 0, fromPosition: seat, toPosition: approach, fromYaw: 0 });
      for (let frame = 0; frame < 360; frame++) {
        const seconds = frame / 60, pose = seconds < 3 ? samplePosture(down, seconds) : samplePosture(up, seconds - 3);
        avatar.root.position.set(pose.position.x, 0, pose.position.z);avatar.root.rotation.y = pose.yaw;
        avatar.update(1 / 60, { sitBlend: pose.blend, groundHeightAt: () => .0025 });check(frame > 1);
      }
      function check(measure) {
        avatar.root.updateMatrixWorld(true);
        for (let i = 0; i < joints.length; i++) {
          const step = joints[i].bone.quaternion.angleTo(previous[i]);assert.ok(Number.isFinite(step));
          if (measure) maxStep = Math.max(maxStep, step);previous[i].copy(joints[i].bone.quaternion);
        }
        if (!measure) return;
        for (const { mesh, vertex } of vertices) { mesh.getVertexPosition(vertex, point).applyMatrix4(mesh.matrixWorld);maxDepth = Math.max(maxDepth, .0025 - point.y); }
      }
      results.push({ enabled, maxDepth, maxStep });
      if (enabled) { assert.ok(maxDepth < .001, `floor penetration ${maxDepth}`);assert.ok(maxStep < .08, `joint step ${maxStep}`); }
    } finally { avatar.dispose();assert.equal(scene.getObjectByName('CompanionTailGround'), undefined); }
  }
  assert.ok(results[0].maxDepth > .008, 'baseline must reproduce the actual floor penetration');
  t.diagnostic(JSON.stringify(results));
});

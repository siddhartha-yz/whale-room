import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import { VRMExpression, VRMExpressionManager, VRMExpressionMorphTargetBind } from '@pixiv/three-vrm';
import { configureFacialRig } from '../src/facial-rig.js';

const modelUrl = new URL('../public/assets/deepseek-chibi.vrm', import.meta.url);
const modelAvailable = existsSync(modelUrl);

// Read the real, local-only VRM geometry without browser texture loading. The
// licensed binary is deliberately not required in public source checkouts.
function fixture() {
  const file = readFileSync(modelUrl);
  const jsonSize = file.readUInt32LE(12);
  const json = JSON.parse(file.subarray(20, 20 + jsonSize).toString());
  const binary = file.subarray(28 + jsonSize);
  const arrayTypes = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  function attribute(index) {
    const accessor = json.accessors[index], view = json.bufferViews[accessor.bufferView];
    assert.equal(view.byteStride, undefined);
    const Type = arrayTypes[accessor.componentType];
    const itemSize = components[accessor.type];
    const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const bytes = binary.subarray(offset, offset + accessor.count * itemSize * Type.BYTES_PER_ELEMENT);
    const result = new THREE.BufferAttribute(new Type(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), itemSize);
    return result;
  }
  const bones = json.nodes.map((node) => { const bone = new THREE.Bone(); bone.name = node.name; return bone; });
  const humanBones = json.extensions.VRMC_vrm.humanoid.humanBones;
  const scene = new THREE.Group();
  const manager = new VRMExpressionManager();
  const nodeMeshes = new Map();
  function meshesForNode(index) {
    if (nodeMeshes.has(index)) return nodeMeshes.get(index);
    const node = json.nodes[index], source = json.meshes[node.mesh];
    const meshes = source.primitives.map((primitive) => {
      const geometry = new THREE.BufferGeometry();
      for (const [gltfName, threeName] of Object.entries({ POSITION: 'position', NORMAL: 'normal', JOINTS_0: 'skinIndex', WEIGHTS_0: 'skinWeight' })) {
        if (primitive.attributes[gltfName] !== undefined) geometry.setAttribute(threeName, attribute(primitive.attributes[gltfName]));
      }
      geometry.morphTargetsRelative = true;
      for (const [gltfName, threeName] of Object.entries({ POSITION: 'position', NORMAL: 'normal' })) {
        if (primitive.targets?.[0][gltfName] === undefined) continue;
        geometry.morphAttributes[threeName] = primitive.targets.map((target, i) => {
          const result = attribute(target[gltfName]); result.name = source.extras.targetNames[i]; return result;
        });
      }
      const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
      mesh.name = `${node.name}:${json.materials[primitive.material].name}`;
      mesh.skeleton = new THREE.Skeleton(json.skins[node.skin].joints.map((joint) => bones[joint]));
      scene.add(mesh);
      return mesh;
    });
    nodeMeshes.set(index, meshes);
    return meshes;
  }
  for (const [name, definition] of Object.entries(json.extensions.VRMC_vrm.expressions.preset)) {
    const expression = new VRMExpression(name);
    for (const bind of definition.morphTargetBinds ?? []) expression.addBind(new VRMExpressionMorphTargetBind({ primitives: meshesForNode(bind.node), index: bind.index, weight: bind.weight }));
    manager.registerExpression(expression);
  }
  const vrm = { scene, expressionManager: manager, humanoid: { getRawBoneNode: (name) => bones[humanBones[name]?.node] } };
  const mesh = nodeMeshes.get(151)[0];
  const eyeIndices = ['leftEye', 'rightEye'].map((name) => mesh.skeleton.bones.indexOf(vrm.humanoid.getRawBoneNode(name)));
  const positions = mesh.geometry.attributes.position;
  const eyeVertices = eyeIndices.map((eyeIndex) => Array.from({ length: positions.count }, (_, i) => i).filter((i) => {
    for (let c = 0; c < 4; c++) if (mesh.geometry.attributes.skinIndex.getComponent(i, c) === eyeIndex && mesh.geometry.attributes.skinWeight.getComponent(i, c) > 0.5) return true;
    return false;
  }));
  return { vrm, mesh, eyeVertices };
}

function deformed(mesh, index, component) {
  let value = mesh.geometry.attributes.position.getComponent(index, component);
  mesh.morphTargetInfluences.forEach((weight, morph) => { value += weight * mesh.geometry.morphAttributes.position[morph].getComponent(index, component); });
  return value;
}

test('real VRM splits eyes from mouth and keeps source morph data intact', { skip: modelAvailable ? false : 'Local-only whale VRM is not distributed; skipping calibrated eye geometry.' }, () => {
  const { vrm, mesh, eyeVertices } = fixture();
  const original = mesh.geometry;
  const originalHappy = original.morphAttributes.position[12].array.slice();
  const rig = configureFacialRig(vrm);
  assert.equal(rig.supported, true);
  assert.deepEqual(rig.diagnostics.eyeVertexCounts, [196, 196]);
  assert.deepEqual(original.morphAttributes.position[12].array, originalHappy);
  assert.notEqual(mesh.geometry, original);
  for (const emotion of ['happy', 'relaxed', 'sad']) {
    vrm.expressionManager.resetValues();
    vrm.expressionManager.setValue(rig.channels[emotion].mouth, 1);
    vrm.expressionManager.update();
    for (const indices of eyeVertices) for (const i of indices) for (let c = 0; c < 3; c++) assert.equal(deformed(mesh, i, c), original.attributes.position.getComponent(i, c));
    const sourceIndex = { happy: 12, relaxed: 15, sad: 14 }[emotion];
    // Actual lip vertices preserve the original smile/frown, not just zero motion.
    const lipVertices = Array.from({ length: original.attributes.position.count }, (_, i) => i).filter((i) => original.attributes.position.getY(i) < 0.49 && Math.abs(original.attributes.position.getX(i)) < 0.04);
    assert.ok(lipVertices.some((i) => Math.abs(original.morphAttributes.position[sourceIndex].getY(i)) > 0.001));
    for (const i of lipVertices) assert.ok(Math.abs(deformed(mesh, i, 1) - original.attributes.position.getY(i) - original.morphAttributes.position[sourceIndex].getY(i)) < 1e-7);
  }
  assert.equal(configureFacialRig(vrm), rig, 'configuration must be idempotent');
});

test('real eye geometry retains pupils at baseline and never inverts with a budgeted blink', { skip: modelAvailable ? false : 'Local-only whale VRM is not distributed; skipping calibrated eye geometry.' }, () => {
  const { vrm, mesh, eyeVertices } = fixture();
  const rig = configureFacialRig(vrm), manager = vrm.expressionManager;
  for (const emotion of ['happy', 'relaxed', 'sad']) {
    const baseline = rig.safeWeights[emotion].eyes;
    for (const eyeWeight of [baseline, rig.safeWeights[emotion].reactionEyes]) for (const blink of [0, 0.2, 0.5, 0.8, 1]) {
      manager.resetValues();
      manager.setValue(rig.channels[emotion].eyes, eyeWeight);
      manager.setValue('blink', rig.budgetBlink(blink, eyeWeight));
      manager.update();
      for (const indices of eyeVertices) {
        const source = mesh.geometry.attributes.position;
        const low = indices.reduce((a, b) => source.getY(a) < source.getY(b) ? a : b);
        const high = indices.reduce((a, b) => source.getY(a) > source.getY(b) ? a : b);
        const height = deformed(mesh, high, 1) - deformed(mesh, low, 1);
        assert.ok(height > 0, `${emotion} eye must not invert at blink=${blink}`);
        if (blink === 0 && eyeWeight === baseline) assert.ok(height / (source.getY(high) - source.getY(low)) > 0.78);
        // The source blink moves one tiny highlight patch back by 0.00142;
        // relaxed used to retract the entire eye by 0.031 at weight 0.8.
        for (const i of indices) assert.ok(Math.abs(deformed(mesh, i, 2) - source.getZ(i)) < 0.0015, 'eye must not inherit the relaxed retraction');
      }
    }
  }
});

test('unknown eye layout falls back without changing geometry or registrations', () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  const vrm = { scene: new THREE.Group(), expressionManager: new VRMExpressionManager(), humanoid: {} };
  vrm.scene.add(mesh);
  const geometry = mesh.geometry, count = vrm.expressionManager.expressions.length;
  vrm.humanoid.getRawBoneNode = () => undefined;
  const rig = configureFacialRig(vrm);
  assert.equal(rig.supported, false);
  assert.equal(mesh.geometry, geometry);
  assert.equal(vrm.expressionManager.expressions.length, count);
  assert.equal(rig.fallbackWeights.relaxed, 0.12);
});

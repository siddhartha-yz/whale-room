import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { VRMHumanoid, VRMExpressionManager, VRMExpression, VRMExpressionMorphTargetBind } from '@pixiv/three-vrm';

const modelUrl = new URL('../public/assets/deepseek-chibi.vrm', import.meta.url);
export const localModelAvailable = existsSync(modelUrl);
export const localModelSkip = localModelAvailable ? false : 'Local-only whale VRM is not distributed; skipping calibrated whale geometry checks.';

// Real source geometry, skinning and normalized bones, without loading textures
// or opening a browser. This is sufficient for numerical interaction tests.
export function loadLocalVrmFixture(sourceUrl = modelUrl) {
  const file = readFileSync(sourceUrl), jsonSize = file.readUInt32LE(12);
  const json = JSON.parse(file.subarray(20, 20 + jsonSize)), binary = file.subarray(28 + jsonSize);
  const types = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
  const sizes = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  function attribute(index) {
    const a = json.accessors[index], Type = types[a.componentType], itemSize = sizes[a.type];
    function read(viewIndex, byteOffset, ArrayType, count) {
      const view = json.bufferViews[viewIndex], start = (view.byteOffset ?? 0) + (byteOffset ?? 0);
      const bytes = binary.subarray(start, start + count * ArrayType.BYTES_PER_ELEMENT);
      return new ArrayType(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    }
    const view = json.bufferViews[a.bufferView];
    if (view?.byteStride && view.byteStride !== itemSize * Type.BYTES_PER_ELEMENT) throw new Error('Unsupported fixture stride');
    const values = view ? read(a.bufferView, a.byteOffset, Type, a.count * itemSize) : new Type(a.count * itemSize);
    // The public pixiv sample uses sparse morph targets with an implicit zero base.
    if (a.sparse) {
      const sparse = a.sparse;
      const indices = read(sparse.indices.bufferView, sparse.indices.byteOffset, types[sparse.indices.componentType], sparse.count);
      const replacements = read(sparse.values.bufferView, sparse.values.byteOffset, Type, sparse.count * itemSize);
      for (let i = 0; i < sparse.count; i++) for (let c = 0; c < itemSize; c++) values[indices[i] * itemSize + c] = replacements[i * itemSize + c];
    }
    return new THREE.BufferAttribute(values, itemSize, a.normalized ?? false);
  }
  const joints = new Set(json.skins.flatMap((skin) => skin.joints));
  const nodes = json.nodes.map((definition, index) => {
    const node = joints.has(index) ? new THREE.Bone() : new THREE.Group();
    node.name = definition.name ?? '';
    if (definition.translation) node.position.fromArray(definition.translation);
    if (definition.rotation) node.quaternion.fromArray(definition.rotation);
    if (definition.scale) node.scale.fromArray(definition.scale);
    return node;
  });
  json.nodes.forEach((definition, index) => { for (const child of definition.children ?? []) nodes[index].add(nodes[child]); });
  const scene = new THREE.Group();
  for (const index of json.scenes[json.scene ?? 0].nodes) scene.add(nodes[index]);
  scene.updateMatrixWorld(true);
  const skeletons = json.skins.map((skin) => {
    const inverses = attribute(skin.inverseBindMatrices).array;
    return new THREE.Skeleton(skin.joints.map((index) => nodes[index]), skin.joints.map((_, index) => new THREE.Matrix4().fromArray(inverses, index * 16)));
  });
  const meshNodes = new Map();
  json.nodes.forEach((definition, index) => {
    if (definition.mesh === undefined) return;
    const source = json.meshes[definition.mesh];
    const primitives = source.primitives.map((primitive) => {
      const geometry = new THREE.BufferGeometry();
      for (const [gltfName, threeName] of Object.entries({ POSITION: 'position', NORMAL: 'normal', TEXCOORD_0: 'uv', JOINTS_0: 'skinIndex', WEIGHTS_0: 'skinWeight' })) {
        if (primitive.attributes[gltfName] !== undefined) geometry.setAttribute(threeName, attribute(primitive.attributes[gltfName]));
      }
      if (primitive.indices !== undefined) geometry.setIndex(attribute(primitive.indices));
      geometry.morphTargetsRelative = true;
      for (const [gltfName, threeName] of Object.entries({ POSITION: 'position', NORMAL: 'normal' })) {
        if (primitive.targets?.[0][gltfName] === undefined) continue;
        geometry.morphAttributes[threeName] = primitive.targets.map((target, i) => {
          const result = target[gltfName] === undefined
            ? new THREE.BufferAttribute(new Float32Array(geometry.getAttribute(threeName).count * 3), 3)
            : attribute(target[gltfName]);
          result.name = source.extras.targetNames[i]; return result;
        });
      }
      const mat = new THREE.MeshBasicMaterial(); mat.name = json.materials[primitive.material].name;
      const object = definition.skin === undefined ? new THREE.Mesh(geometry, mat) : new THREE.SkinnedMesh(geometry, mat);
      object.name = `${definition.name}:${mat.name}`; nodes[index].add(object);
      if (definition.skin !== undefined) object.bind(skeletons[definition.skin], nodes[index].matrixWorld);
      return object;
    });
    meshNodes.set(index, primitives);
  });
  const humanoid = new VRMHumanoid(Object.fromEntries(Object.entries(json.extensions.VRMC_vrm.humanoid.humanBones).map(([name, bone]) => [name, { node: nodes[bone.node] }])));
  scene.add(humanoid.normalizedHumanBonesRoot);
  const expressionManager = new VRMExpressionManager();
  for (const [name, definition] of Object.entries(json.extensions.VRMC_vrm.expressions.preset)) {
    const expression = new VRMExpression(name);
    for (const bind of definition.morphTargetBinds ?? []) expression.addBind(new VRMExpressionMorphTargetBind({ primitives: meshNodes.get(bind.node), index: bind.index, weight: bind.weight }));
    expressionManager.registerExpression(expression);
  }
  const vrm = { scene, humanoid, expressionManager, meta: { metaVersion: '1' },
    update() { humanoid.update(); expressionManager.update(); },
  };
  return { scene, userData: { vrm } };
}

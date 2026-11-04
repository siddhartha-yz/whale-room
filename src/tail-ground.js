import * as THREE from 'three';
import { VRMSpringBoneCollider, VRMSpringBoneColliderShapePlane } from '@pixiv/three-vrm';

const FLOOR_Y = .0025, HIT_RADIUS = .04;
const active = new WeakMap();
// Calibration belongs to this local chibi. Do not apply it to a replacement
// character just because that character also happens to have a tail.
const CHAINS = [
  { names: ['WeiBa', 'WeiBa.001', 'WeiBa.002', 'WeiBa.003', 'WeiBa.004'], center: 'hips', lengths: [.09935736, .10457350, .10636455, .10599530] },
  { names: ['WeiBa.L', 'WeiBa.L.001', 'WeiBa.L.002', 'WeiBa.L.003'], center: 'WeiBa.003', lengths: [.07376318, .07994507, .08257388] },
  { names: ['WeiBa.R', 'WeiBa.R.001', 'WeiBa.R.002', 'WeiBa.R.003'], center: 'WeiBa.003', lengths: [.07376318, .07994507, .08257373] },
];

function calibratedJoints(vrm) {
  const manager = vrm?.springBoneManager;
  if (vrm?.meta?.metaVersion !== '1' || vrm.meta.name !== '蓝色小肥鱼Deepseek'
    || vrm.meta.authors?.length !== 1 || vrm.meta.authors[0] !== '木子恶魔'
    || !manager?.joints || typeof manager.addJoint !== 'function') return null;
  const scale = vrm.scene.getWorldScale(new THREE.Vector3());
  if (['x', 'y', 'z'].some(axis => Math.abs(scale[axis] - 1.39055359) > .001)) return null;
  const joints = [...manager.joints].filter(j => j.bone.name.startsWith('WeiBa'));
  if (joints.length !== 10) return null;
  // GLTFLoader removes punctuation from node names. Accept only the raw name
  // or that exact official mapping; duplicate/competing matches remain unsafe.
  const nodesByName = new Map();
  vrm.scene.traverse(node => nodesByName.set(node.name, nodesByName.has(node.name) ? null : node));
  const findNode = name => {
    const matches = [...new Set([name, THREE.PropertyBinding.sanitizeNodeName(name)])]
      .filter(candidate => nodesByName.has(candidate)).map(candidate => nodesByName.get(candidate));
    return matches.length === 1 ? matches[0] : null;
  };
  for (const chain of CHAINS) {
    const center = findNode(chain.center);
    for (let i = 0; i < chain.names.length - 1; i++) {
      const bone = findNode(chain.names[i]), child = findNode(chain.names[i + 1]);
      const joint = joints.find(j => j.bone === bone);
      if (!bone || !child || !center || !joint || joint.child !== child || child.parent !== bone
        || joint.center !== center || (i === 0 && bone.parent !== center)
        || Math.abs(child.position.length() - chain.lengths[i]) > .00001
        || joint.settings.hitRadius !== 0 || joint.colliderGroups.length !== 0) return null;
    }
  }
  // The broad tail fins, not just bone lengths, determine the measured radius.
  // Check their skinning footprint as well as the model's metadata and chains.
  let vertices = 0, unexpectedMesh = false;
  vrm.scene.traverse(mesh => {
    if (!mesh.isSkinnedMesh) return;
    const indices = mesh.geometry.attributes.skinIndex, weights = mesh.geometry.attributes.skinWeight;
    if (!indices || !weights) return;
    const tailBones = new Set(mesh.skeleton.bones.flatMap((bone, index) => bone.name.startsWith('WeiBa') ? [index] : []));
    for (let i = 0; i < indices.count; i++) {
      let influence = 0;
      for (let k = 0; k < 4; k++) if (tailBones.has(indices.getComponent(i, k))) influence += weights.getComponent(i, k);
      if (influence > .05) { vertices++; if (indices.count !== 2880) unexpectedMesh = true; }
    }
  });
  return vertices === 1039 && !unexpectedMesh ? joints : null;
}

/** Opt-in, ground only. The existing VRM manager remains the sole owner of the
 * tail animation. This adds no furniture, wall or rug collision. */
export function createTailGround(vrm, scene, { enabled = false } = {}) {
  const inactive = reason => ({ getState: () => ({ supported: false, enabled: false, joints: 0, reason }), dispose() {} });
  if (!enabled) return inactive('disabled');
  if (active.has(vrm)) return active.get(vrm);
  const joints = calibratedJoints(vrm);
  if (!joints || !scene?.isScene) return inactive('uncalibrated-model');
  const manager = vrm.springBoneManager;
  const collider = new VRMSpringBoneCollider(new VRMSpringBoneColliderShapePlane({
    offset: new THREE.Vector3(0, FLOOR_Y, 0), normal: new THREE.Vector3(0, 1, 0),
  }));
  collider.name = 'CompanionTailGround';
  scene.add(collider);
  const group = { name: 'CompanionTailGround', colliders: [collider] };
  const original = joints.map(joint => ({ joint, groups: joint.colliderGroups, radius: joint.settings.hitRadius }));
  for (const { joint, groups } of original) {
    joint.colliderGroups = [...groups, group];
    joint.settings.hitRadius = HIT_RADIUS;
    // addJoint uses a Set in the pinned 3.5.5 manager. Re-adding the same joint
    // preserves its identity/order and refreshes the collider dependency sort.
    manager.addJoint(joint);
  }
  let disposed = false;
  const result = {
    getState: () => ({ supported: true, enabled: !disposed, joints: disposed ? 0 : joints.length, reason: disposed ? 'disposed' : null }),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const { joint, groups, radius } of original) {
        const remaining = joint.colliderGroups.filter(g => g !== group);
        joint.colliderGroups = remaining.length === groups.length && remaining.every((g, i) => g === groups[i]) ? groups : remaining;
        if (joint.settings.hitRadius === HIT_RADIUS) joint.settings.hitRadius = radius;
        if (manager.joints.has(joint)) manager.addJoint(joint);
      }
      collider.removeFromParent();
      active.delete(vrm);
    },
  };
  active.set(vrm, result);
  return result;
}

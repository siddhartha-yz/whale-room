import { BufferAttribute } from 'three';
import { VRMExpression, VRMExpressionMorphTargetBind } from '@pixiv/three-vrm';

const EMOTIONS = ['happy', 'relaxed', 'sad'];
const configured = new WeakMap();
const unit = (value) => Math.max(0, Math.min(1, Number(value) || 0));
const smoothstep = (low, high, value) => {
  const t = unit((value - low) / (high - low));
  return t * t * (3 - 2 * t);
};

// These are baseline suggestions, not limits enforced on the expression manager.
// The controller owns reaction envelopes and must budget all eye channels together.
const SAFE_WEIGHTS = Object.freeze({
  happy: Object.freeze({ eyes: 0.18, mouth: 0.65, reactionEyes: 0.55 }),
  relaxed: Object.freeze({ eyes: 0.12, mouth: 0.28, reactionEyes: 0.22 }),
  sad: Object.freeze({ eyes: 0.10, mouth: 0.48, reactionEyes: 0.22 }),
  maxCombinedEyeClosure: 0.98,
});
const FALLBACK_WEIGHTS = Object.freeze({ happy: 0.30, relaxed: 0.12, sad: 0.45, surprised: 0 });

function morphBinds(expression) {
  return expression?.binds.filter((bind) => Array.isArray(bind.primitives) && Number.isInteger(bind.index)) ?? [];
}

function eyeRegion(mesh, vrm, blinkIndex) {
  const geometry = mesh.geometry;
  const position = geometry?.getAttribute('position');
  const joints = geometry?.getAttribute('skinIndex');
  const weights = geometry?.getAttribute('skinWeight');
  const blink = geometry?.morphAttributes.position?.[blinkIndex];
  if (!geometry?.morphTargetsRelative || !position || !joints || !weights || !blink || !mesh.skeleton) return null;
  const boneIndices = ['leftEye', 'rightEye'].map((name) => mesh.skeleton.bones.indexOf(vrm.humanoid?.getRawBoneNode(name)));
  if (boneIndices.some((index) => index < 0)) return null;

  const eyeVertices = [[], []];
  const bounds = boneIndices.map(() => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
  for (let i = 0; i < position.count; i++) {
    for (let eye = 0; eye < 2; eye++) {
      let influence = 0;
      for (let c = 0; c < 4; c++) if (joints.getComponent(i, c) === boneIndices[eye]) influence += weights.getComponent(i, c);
      if (influence < 0.5) continue;
      eyeVertices[eye].push(i);
      for (let c = 0; c < 3; c++) {
        bounds[eye].min[c] = Math.min(bounds[eye].min[c], position.getComponent(i, c));
        bounds[eye].max[c] = Math.max(bounds[eye].max[c], position.getComponent(i, c));
      }
    }
  }
  // Only calibrate the source layout actually supported here: two distinct,
  // front-facing, skinned eyes with a vertical closing morph. Unknown avatars
  // keep their original expressions; no coordinate guesses are applied to them.
  if (eyeVertices.some((vertices) => vertices.length < 16)) return null;
  const centers = bounds.map((box) => box.min.map((value, c) => (value + box.max[c]) / 2));
  const dimensions = bounds.map((box) => box.min.map((value, c) => box.max[c] - value));
  const meanHeight = (dimensions[0][1] + dimensions[1][1]) / 2;
  if (dimensions.some(([width, height, depth]) => width <= 0 || height <= 0 || depth <= 0)
      || Math.abs(centers[0][0] - centers[1][0]) < meanHeight
      || Math.abs(centers[0][1] - centers[1][1]) > meanHeight * 0.25) return null;
  let verticalEnergy = 0;
  let otherEnergy = 0;
  for (const indices of eyeVertices) for (const i of indices) {
    verticalEnergy += blink.getY(i) ** 2;
    otherEnergy += blink.getX(i) ** 2 + blink.getZ(i) ** 2;
  }
  if (verticalEnergy < 1e-8 || otherEnergy > verticalEnergy * 0.05) return null;

  const mask = new Float32Array(position.count);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    for (let eye = 0; eye < 2; eye++) {
      const box = bounds[eye];
      const [width, height, depth] = dimensions[eye];
      // Soft margins include eyelids/lashes, but end below the separate brows.
      // The front-depth check excludes the whale ear fins, which the source's
      // blink unexpectedly also moves. Mouth and nose-centre remain outside.
      const horizontal = smoothstep(box.min[0] - width * 0.75, box.min[0] - width * 0.60, x)
        * (1 - smoothstep(box.max[0] + width * 0.60, box.max[0] + width * 0.75, x));
      const vertical = smoothstep(box.min[1] - height * 0.35, box.min[1] - height * 0.10, y)
        * (1 - smoothstep(box.max[1] + height * 0.20, box.max[1] + height * 0.52, y));
      const front = smoothstep(box.min[2] - depth * 2, box.min[2] - depth * 0.5, z);
      mask[i] = Math.max(mask[i], horizontal * vertical * front);
    }
  }
  for (const indices of eyeVertices) for (const i of indices) mask[i] = 1;
  return { mask, eyeVertices, bounds, meanHeight };
}

function appendMorph(mesh, sourceIndex, name, mask, inverse = false) {
  const geometry = mesh.geometry;
  const index = geometry.morphAttributes.position.length;
  for (const [kind, targets] of Object.entries(geometry.morphAttributes)) {
    const source = targets[sourceIndex];
    if (!source || source.count !== mask.length) throw new Error(`Incompatible facial ${kind} morph`);
    const values = new Float32Array(source.count * source.itemSize);
    for (let i = 0; i < source.count; i++) {
      const factor = inverse ? 1 - mask[i] : mask[i];
      for (let c = 0; c < source.itemSize; c++) values[i * source.itemSize + c] = source.getComponent(i, c) * factor;
    }
    const attribute = new BufferAttribute(values, source.itemSize);
    attribute.name = name;
    targets.push(attribute);
  }
  return index;
}

/**
 * Separate this avatar's ocular deformation from its other expression features.
 * Call before the first render. The VRM file and original morph attributes stay
 * intact; additional in-memory morphs are driven by normal VRM expressions.
 *
 * `*Eyes` channels all use the same calibrated blink displacement. In particular,
 * relaxed does not retract the eyeball into the face. `*Mouth` retains the original
 * mouth, cheek, eyebrow and ear-fin motion outside the ocular mask. Decorative
 * eye-symbol planes are intentionally absent from the subtle channels.
 *
 * With supported=true, keep original happy/relaxed/sad at zero. Sum the three
 * eye weights, keep that sum <= maxCombinedEyeClosure, and call budgetBlink for
 * each blink sample. This avoids adding a full closure on top of narrowed eyes.
 */
export function configureFacialRig(vrm) {
  if (configured.has(vrm)) return configured.get(vrm);
  const manager = vrm?.expressionManager;
  const fallback = (reason) => {
    const result = {
      supported: false, reason, channels: {}, safeWeights: SAFE_WEIGHTS,
      fallbackWeights: FALLBACK_WEIGHTS, blinkChannel: 'blink',
      availablePresets: EMOTIONS.filter((name) => morphBinds(manager?.getExpression(name)).length > 0),
      budgetBlink: (blink, eyeWeights = 0) => unit(blink) * Math.max(0, SAFE_WEIGHTS.maxCombinedEyeClosure - Math.max(0, Number(eyeWeights) || 0)),
      diagnostics: {},
    };
    if (vrm && typeof vrm === 'object') configured.set(vrm, result);
    return result;
  };
  if (!manager) return fallback('missing-expression-manager');
  const blinkExpression = manager.getExpression('blink');
  const blinkBinds = morphBinds(blinkExpression);
  const candidates = [];
  for (const bind of blinkBinds) for (const mesh of bind.primitives) {
    const region = eyeRegion(mesh, vrm, bind.index);
    if (region) candidates.push({ mesh, blinkIndex: bind.index, blinkWeight: bind.weight, region });
  }
  // Multiple face meshes or non-unit blink weighting require their own profile.
  if (candidates.length !== 1 || Math.abs(candidates[0].blinkWeight - 1) > 1e-6) return fallback('unrecognised-eye-layout');
  const candidate = candidates[0];
  const { mesh, region, blinkIndex } = candidate;
  const originals = {};
  for (const emotion of EMOTIONS) {
    const binds = morphBinds(manager.getExpression(emotion));
    const bind = binds.find((item) => item.primitives.includes(mesh));
    if (!bind || !mesh.geometry.morphAttributes.position[bind.index]) return fallback(`missing-${emotion}-morph`);
    originals[emotion] = bind;
    if (manager.getExpression(`${emotion}Eyes`) || manager.getExpression(`${emotion}Mouth`)) return fallback('custom-channel-name-conflict');
  }
  for (const targets of Object.values(mesh.geometry.morphAttributes)) {
    for (const index of [blinkIndex, ...Object.values(originals).map((bind) => bind.index)]) {
      if (!targets[index] || targets[index].count !== region.mask.length) return fallback('inconsistent-morph-attributes');
    }
  }

  // The original is kept because other nodes may share it. Outline groups are
  // part of this same geometry, so they automatically follow the new morphs.
  mesh.geometry = mesh.geometry.clone();
  const oldInfluences = [...mesh.morphTargetInfluences];
  const channels = {};
  const registered = [];
  const addExpression = (name, index, weight) => {
    const expression = new VRMExpression(name);
    expression.addBind(new VRMExpressionMorphTargetBind({ primitives: [mesh], index, weight }));
    manager.registerExpression(expression);
    vrm.scene?.add(expression);
    registered.push(name);
  };
  for (const emotion of EMOTIONS) {
    const eyes = `${emotion}Eyes`, mouth = `${emotion}Mouth`;
    const eyeIndex = appendMorph(mesh, blinkIndex, eyes, region.mask);
    const mouthIndex = appendMorph(mesh, originals[emotion].index, mouth, region.mask, true);
    addExpression(eyes, eyeIndex, 1);
    addExpression(mouth, mouthIndex, originals[emotion].weight);
    channels[emotion] = { eyes, mouth };
  }
  const cleanBlinkIndex = appendMorph(mesh, blinkIndex, 'facialBlink', region.mask);
  // Preserve the public 'blink' name while replacing the asset's ear/eyebrow
  // blink motion. The other original presets are retained for explicit fallback.
  for (const bind of [...blinkExpression.binds]) blinkExpression.deleteBind(bind);
  blinkExpression.addBind(new VRMExpressionMorphTargetBind({ primitives: [mesh], index: cleanBlinkIndex, weight: 1 }));
  mesh.updateMorphTargets();
  oldInfluences.forEach((weight, index) => { mesh.morphTargetInfluences[index] = index === blinkIndex ? 0 : weight; });
  mesh.geometry.boundingBox = null;
  mesh.geometry.boundingSphere = null;

  const result = {
    supported: true, reason: null, channels, safeWeights: SAFE_WEIGHTS,
    fallbackWeights: FALLBACK_WEIGHTS, blinkChannel: 'blink',
    availablePresets: [...EMOTIONS],
    budgetBlink(blink, combinedEyeWeight = 0) {
      return unit(blink) * Math.max(0, SAFE_WEIGHTS.maxCombinedEyeClosure - Math.max(0, Number(combinedEyeWeight) || 0));
    },
    diagnostics: {
      mesh: mesh.name, vertexCount: region.mask.length,
      eyeVertexCounts: region.eyeVertices.map((vertices) => vertices.length),
      eyeBounds: region.bounds, registered,
      maskedVertexCount: region.mask.reduce((count, weight) => count + (weight > 0.001 ? 1 : 0), 0),
      neutralEyeHeight: region.meanHeight,
      decoratedExpressionPlanesIncluded: false,
    },
  };
  configured.set(vrm, result);
  return result;
}

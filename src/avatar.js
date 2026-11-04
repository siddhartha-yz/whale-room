import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { createFaceController } from './face.js';
import { configureFacialRig } from './facial-rig.js';
import { createGaitState, stepGait, GAIT } from './gait.js';
import { createFootPlacement, FOOT_PLACEMENT } from './foot-placement.js';
import { createTailGround } from './tail-ground.js';
import { createActivityState, stepActivity, sampleActivity, cancelActivityState, stepReadingGaze } from './activity-rig.js';
import { loadAvatarModel } from './avatar-loader.js';

const EXPRESSIONS = ['neutral', 'happy', 'sad', 'surprised', 'relaxed'];
const damp = (from, to, rate, dt) => THREE.MathUtils.lerp(from, to, 1 - Math.exp(-rate * dt));
const clamp = THREE.MathUtils.clamp;

/**
 * A local, replaceable VRM avatar. The outer root belongs to the room controller:
 * +Z is forward, y=0 is the floor, units are metres. Animation is deliberately
 * procedural in this prototype, with no learned controller or physics claims.
 */
export async function createAvatar(scene, { tailGround = false } = {}) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const { vrm, modelSource, usingFallback } = await loadAvatarModel(loader);

  VRMUtils.rotateVRM0(vrm);
  const root = new THREE.Group();
  root.name = 'CompanionAvatar';
  root.add(vrm.scene);
  scene.add(root);
  vrm.scene.traverse((object) => {
    if (object.isMesh) {
      object.frustumCulled = false;
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });

  root.updateMatrixWorld(true);
  const initialBox = new THREE.Box3().setFromObject(vrm.scene);
  const height = usingFallback ? 1.65 : 1.35;
  const scale = height / (initialBox.max.y - initialBox.min.y);
  vrm.scene.scale.multiplyScalar(scale);
  root.updateMatrixWorld(true);
  const scaledBox = new THREE.Box3().setFromObject(vrm.scene);
  const floorOffset = -scaledBox.min.y;
  vrm.scene.position.y += floorOffset;
  root.updateMatrixWorld(true);

  const boneNames = [
    'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
    'leftShoulder', 'rightShoulder',
    'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm',
    'leftHand', 'rightHand',
    'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg',
    'leftFoot', 'rightFoot',
  ];
  const fingerNames = [];
  for (const side of ['left', 'right']) {
    for (const finger of ['Index', 'Middle', 'Ring', 'Little']) {
      for (const joint of ['Proximal', 'Intermediate', 'Distal']) fingerNames.push(`${side}${finger}${joint}`);
    }
    for (const joint of ['Metacarpal', 'Proximal', 'Distal']) fingerNames.push(`${side}Thumb${joint}`);
  }
  boneNames.push(...fingerNames);
  const bones = Object.fromEntries(boneNames.map((name) => [name, vrm.humanoid.getNormalizedBoneNode(name)]));
  const rest = Object.fromEntries(boneNames.map((name) => [name, bones[name]?.quaternion.clone()]));
  const armLayerNames = ['leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand'];
  const armBase = Object.fromEntries(armLayerNames.map(name => [name, bones[name]?.quaternion.clone()]));
  const hipRest = bones.hips.position.clone();
  const upperLegPoint = bones.leftUpperLeg.getWorldPosition(new THREE.Vector3());
  const kneePoint = bones.leftLowerLeg.getWorldPosition(new THREE.Vector3());
  // The chibi's legs are much shorter than an ordinary chair. Align the pelvis
  // with the cushion and allow the feet to dangle; lowering by thigh length
  // alone would leave her sitting inside the sofa. No translation of root.y
  // is necessary, so room navigation stays in floor coordinates.
  const thighLength = upperLegPoint.distanceTo(kneePoint);
  const hipHeight = bones.hips.getWorldPosition(new THREE.Vector3()).y;
  const headHeight = bones.head.getWorldPosition(new THREE.Vector3()).y;
  const eyeBone = vrm.humanoid.getNormalizedBoneNode('leftEye');
  const eyeHeight = eyeBone ? eyeBone.getWorldPosition(new THREE.Vector3()).y : headHeight + height * 0.10;
  const seatSurfaceHeight = 0.50;
  // The bundled pixiv sample needs its own seated height and fold for the sofa.
  // Keep this calibration restricted to the verified sample rig.
  const publicMeshes = new Map();
  vrm.scene.traverse(mesh => {
    if (!mesh.isSkinnedMesh) return;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    publicMeshes.set(material?.name, mesh.geometry.attributes.position.count);
  });
  const publicSeatCalibrated = usingFallback && vrm.meta?.metaVersion === '1'
    && vrm.meta.name === 'VRM1_Constraint_Twist_Sample' && vrm.meta.version === 'v1.0.1'
    && vrm.meta.authors?.length === 1 && vrm.meta.authors[0] === 'pixiv Inc.'
    && vrm.nodeConstraintManager?.constraints.size === 14
    && Math.abs(thighLength - .3605405422592398) < .0001
    && Math.abs(kneePoint.distanceTo(bones.leftFoot.getWorldPosition(new THREE.Vector3())) - .4243882792915829) < .0001
    && Math.abs(hipHeight - .9275161234035684) < .0001
    && ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'].every(name =>
      vrm.humanoid.getRawBoneNode(name)?.name === `J_Bip_${name.startsWith('left') ? 'L' : 'R'}_${name.replace(/^(left|right)/, '')}`)
    && [['Body_00_SKIN',5307],['Bottoms_01_CLOTH',470],['Shoes_01_CLOTH',600],['Tops_01_CLOTH',717]].every(([name,count]) => publicMeshes.get(name) === count);
  const seatLegAngle = publicSeatCalibrated ? 1.344 : 1.55;
  const pelvisUnderside = publicSeatCalibrated ? .165 : clamp(thighLength * 0.3, 0.035, 0.065);
  const seatedHipHeight = seatSurfaceHeight + pelvisUnderside;
  // Signed: this is negative when getting onto the sofa raises the avatar.
  const sitDrop = hipHeight - seatedHipHeight;
  const footPlacement = createFootPlacement(vrm, root);
  const tailGroundRig = createTailGround(vrm, scene, { enabled: tailGround });
  const tabletopSupported = footPlacement.supported && vrm.meta?.metaVersion === '1'
    && vrm.meta.name === '蓝色小肥鱼Deepseek' && vrm.meta.authors?.length === 1 && vrm.meta.authors[0] === '木子恶魔';
  const cupTransferSupported = tabletopSupported;
  // A local filename alone does not prove the proportions used by these targets.
  const supportedActivities = Object.freeze(tabletopSupported
    ? ['read', 'drink', 'stretch', 'move_cup'] : ['stretch']);

  const scratchEuler = new THREE.Euler();
  const scratchQuaternion = new THREE.Quaternion();
  const localTarget = new THREE.Vector3();
  const expressionManager = vrm.expressionManager;
  const facialRig = configureFacialRig(vrm);
  const face = createFaceController();
  let locomotion = createGaitState();
  let sitBlend = 0;
  let time = 0;
  let yaw = 0;
  let pitch = 0;
  let gesture = null;
  let gestureStart = 0;
  let eyeYaw = 0;
  let eyePitch = 0;
  let isDisposed = false;
  let activity = null;
  let activitySequence = 0;
  let activityResult = null;
  let lastRenderVisible = true;
  let lastCueEnabled = true;
  let lastSpeed = 0;
  const previousRootPosition = root.position.clone();
  let previousRootYaw = root.rotation.y;
  const activityLookTarget = new THREE.Vector3();
  const readingEyeTarget = new THREE.Vector3(), readingGazeLocal = new THREE.Vector3();
  let readingGaze = stepReadingGaze(null, 0);
  const ik = {
    baseUpper: new THREE.Quaternion(), baseLower: new THREE.Quaternion(), baseHand: new THREE.Quaternion(),
    solved: new THREE.Quaternion(),
    shoulder: new THREE.Vector3(), elbow: new THREE.Vector3(), wrist: new THREE.Vector3(),
    target: new THREE.Vector3(), direction: new THREE.Vector3(), pole: new THREE.Vector3(),
    desiredElbow: new THREE.Vector3(), currentDirection: new THREE.Vector3(), wantedDirection: new THREE.Vector3(),
    parentQuaternion: new THREE.Quaternion(), worldQuaternion: new THREE.Quaternion(), deltaQuaternion: new THREE.Quaternion(),
    desiredQuaternion: new THREE.Quaternion(), rootQuaternion: new THREE.Quaternion(), orientation: new THREE.Quaternion(),
  };

  // Avoid driving the eye and head toward an uninitialised origin. The room
  // supplies a world-space lookTarget when the companion should attend to it.
  if (vrm.lookAt) vrm.lookAt.autoUpdate = false;

  function pose(name, x = 0, y = 0, z = 0, smoothing = 12, dt = 1 / 60) {
    const bone = bones[name];
    if (!bone) return;
    scratchEuler.set(x, y, z, 'XYZ');
    scratchQuaternion.setFromEuler(scratchEuler).premultiply(rest[name]);
    bone.quaternion.slerp(scratchQuaternion, 1 - Math.exp(-smoothing * dt));
  }

  function setGesture(name) {
    if (!['wave', 'nod', 'none'].includes(name)) return false;
    gesture = name === 'none' ? null : name;
    if (gesture) face.cancelResponseCue();
    gestureStart = time;
    return true;
  }

  function canUseResponseCue() {
    return !isDisposed && lastRenderVisible && lastCueEnabled && !activity && !gesture && lastSpeed <= .005
      && locomotion.blend < .03 && !(sitBlend > .001 && sitBlend < .999)
      && !['walking', 'settling'].includes(footPlacement.phase);
  }

  function setAttention(value) {
    return face.setAttention(value, { allowResponseCue: canUseResponseCue() });
  }

  function setActivity(name, { props, durationSeconds = null, cupDestination } = {}) {
    if (isDisposed || activity || !supportedActivities.includes(name)) return null;
    if (name !== 'stretch' && !props?.getAnchors) return null;
    if (props?.getCupState?.().blocked) return null;
    if (name === 'move_cup' && (!cupTransferSupported || !props?.getCupState?.().supported)) return null;
    const station = props?.stations?.[name];
    if (station && Math.hypot(root.position.x - station.x, root.position.z - station.z) > (name === 'move_cup' ? .008 : .18)) return null;
    if (station && (sitBlend > 0.05 || Math.abs(Math.atan2(Math.sin(root.rotation.y - station.yaw), Math.cos(root.rotation.y - station.yaw))) > (name === 'move_cup' ? .03 : .25))) return null;
    const cupTransaction = name === 'move_cup' ? props.beginCupTransfer(cupDestination) : null;
    if (name === 'move_cup' && !cupTransaction) return null;
    const cupSnapshot = cupTransaction ?? (name === 'drink' ? props.snapshotCupDrink?.() : null);
    root.updateMatrixWorld(true);
    const localHand = (side) => root.worldToLocal(vrm.humanoid.getRawBoneNode(`${side}Hand`).getWorldPosition(new THREE.Vector3())).toArray();
    const bodyGroundOffset = footPlacement.supported ? footPlacement.surfaceHeight - .002 : 0;
    const anchors = { ...props?.getAnchors(root, cupSnapshot), restLeft: localHand('left'), restRight: localHand('right'),
      cupSip: [0, .550 + bodyGroundOffset, .116], cupSupport: [.08, .505 + bodyGroundOffset, .17] };
    const state = createActivityState(name, { durationSeconds, anchors });
    let finish, begin;
    const finished = new Promise((resolve) => { finish = resolve; });
    const started = new Promise((resolve) => { begin = resolve; });
    activity = { id: ++activitySequence, name, state, props, finish, begin, finished, started, begun: false, frame: sampleActivity(state), handErrors: {},
      cupTransaction, cupHome: cupSnapshot?.home, blocked: false, returnFailure: false };
    face.cancelResponseCue();
    setGesture('none');
    return { id: activity.id, started, finished };
  }

  function cancelActivity() {
    if (!activity) return Promise.resolve(activityResult ?? { status: 'idle' });
    if (activity.blocked) return activity.finished;
    if (!activity.state.cancelling) {
      if (activity.cupTransaction) activity.props.requestCupReturn(activity.cupTransaction);
      activity.state = cancelActivityState(activity.state, { holdingProp: ['drink', 'move_cup'].includes(activity.name) && activity.props?.isCupHeld() });
      if (!activity.begun) activity.begin(false);
    }
    return activity.finished;
  }

  // A small two-link arm solver, used only at fixed interaction stations. Legs
  // and navigation keep their existing controller; targets are avatar-local.
  function reachHand(side, localPosition, weight, tilt = 0) {
    if (weight <= 0.0001) return 0;
    const upper = bones[`${side}UpperArm`], lower = bones[`${side}LowerArm`], hand = bones[`${side}Hand`];
    root.updateMatrixWorld(true);
    upper.getWorldPosition(ik.shoulder); lower.getWorldPosition(ik.elbow); hand.getWorldPosition(ik.wrist);
    ik.baseUpper.copy(upper.quaternion); ik.baseLower.copy(lower.quaternion); ik.baseHand.copy(hand.quaternion);
    const upperLength = ik.shoulder.distanceTo(ik.elbow), lowerLength = ik.elbow.distanceTo(ik.wrist);
    ik.target.fromArray(localPosition); root.localToWorld(ik.target);
    ik.direction.copy(ik.target).sub(ik.shoulder);
    const requestedDistance = ik.direction.length();
    if (requestedDistance < 0.00001) return requestedDistance;
    ik.direction.normalize();
    const distance = clamp(requestedDistance, Math.abs(upperLength - lowerLength) + 0.001, upperLength + lowerLength - 0.001);
    const along = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance);
    const outward = side === 'left' ? 1 : -1;
    ik.pole.set(outward * 0.40, 0.34 - sitDrop * sitBlend, 0.045); root.localToWorld(ik.pole);
    ik.pole.sub(ik.shoulder);
    ik.pole.addScaledVector(ik.direction, -ik.pole.dot(ik.direction));
    if (ik.pole.lengthSq() < 0.000001) ik.pole.set(outward, 0, 0);
    ik.pole.normalize();
    ik.desiredElbow.copy(ik.shoulder).addScaledVector(ik.direction, along)
      .addScaledVector(ik.pole, Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2)));
    const rotateToward = (bone, from, to) => {
      if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return;
      ik.deltaQuaternion.setFromUnitVectors(from.normalize(), to.normalize());
      bone.getWorldQuaternion(ik.worldQuaternion);
      bone.parent.getWorldQuaternion(ik.parentQuaternion).invert();
      ik.desiredQuaternion.copy(ik.deltaQuaternion).multiply(ik.worldQuaternion).premultiply(ik.parentQuaternion);
      bone.quaternion.copy(ik.desiredQuaternion);
      root.updateMatrixWorld(true);
    };
    ik.currentDirection.copy(ik.elbow).sub(ik.shoulder);
    ik.wantedDirection.copy(ik.desiredElbow).sub(ik.shoulder);
    rotateToward(upper, ik.currentDirection, ik.wantedDirection);
    lower.getWorldPosition(ik.elbow); hand.getWorldPosition(ik.wrist);
    ik.currentDirection.copy(ik.wrist).sub(ik.elbow);
    ik.wantedDirection.copy(ik.shoulder).addScaledVector(ik.direction, distance).sub(ik.elbow);
    rotateToward(lower, ik.currentDirection, ik.wantedDirection);
    root.getWorldQuaternion(ik.rootQuaternion);
    ik.orientation.setFromEuler(scratchEuler.set(tilt, side === 'left' ? -Math.PI / 2 : Math.PI / 2, 0, 'XYZ'));
    hand.parent.getWorldQuaternion(ik.parentQuaternion).invert();
    ik.desiredQuaternion.copy(ik.rootQuaternion).multiply(ik.orientation).premultiply(ik.parentQuaternion);
    hand.quaternion.copy(ik.desiredQuaternion);
    // Solve the complete chain before applying its layer weight. Solving the
    // forearm against an already-partially-blended upper arm bends the exit.
    ik.solved.copy(upper.quaternion); upper.quaternion.copy(ik.baseUpper).slerp(ik.solved, weight);
    ik.solved.copy(lower.quaternion); lower.quaternion.copy(ik.baseLower).slerp(ik.solved, weight);
    ik.solved.copy(hand.quaternion); hand.quaternion.copy(ik.baseHand).slerp(ik.solved, weight);
    root.updateMatrixWorld(true);
    hand.getWorldPosition(ik.wrist);
    return ik.wrist.distanceTo(ik.target);
  }

  function update(rawDt, context = {}) {
    if (isDisposed) return;
    const dt = clamp(rawDt, 0, 0.05);
    time += dt;
    const speed = Math.max(0, Number(context.speed) || 0);
    lastSpeed = speed;
    lastRenderVisible = context.renderVisible !== false;
    lastCueEnabled = context.attentionCueEnabled !== false;
    const rootMoved = root.position.distanceToSquared(previousRootPosition) > 1e-10;
    const rootTurned = Math.abs(Math.atan2(Math.sin(root.rotation.y - previousRootYaw), Math.cos(root.rotation.y - previousRootYaw))) > .0001;
    previousRootPosition.copy(root.position); previousRootYaw = root.rotation.y;
    const previousSitBlend = sitBlend;
    const desiredSit = Number.isFinite(context.sitBlend)
      ? clamp(context.sitBlend, 0, 1)
      : (context.seated ? 1 : 0);
    sitBlend = Number.isFinite(context.sitBlend)
      ? desiredSit
      : damp(sitBlend, desiredSit, 4.3, dt);
    locomotion = stepGait(locomotion, dt, { speed, sitBlend, direction: context.walkDirection });
    if (activity && !activity.blocked) {
      activity.state = stepActivity(activity.state, dt, { pageTurnAllowed: context.pageTurnAllowed });
      activity.frame = sampleActivity(activity.state);
    }
    const activityFrame = activity?.frame;
    const responseCueAllowed = canUseResponseCue() && !rootMoved && !rootTurned && Math.abs(sitBlend - previousSitBlend) < .00001;
    const facial = face.update(dt, { moving: speed > 0.03, responseCueAllowed });
    const breath = Math.sin(time * 1.65);
    const seated = sitBlend;
    const standing = 1 - seated;

    // Keep foot placement and stride modest, suitable for a small living room.
    pose('leftUpperLeg', locomotion.leftHip - seatLegAngle * seated, 0, -0.035 * seated, 16, dt);
    pose('rightUpperLeg', locomotion.rightHip - seatLegAngle * seated, 0, 0.035 * seated, 16, dt);
    pose('leftLowerLeg', locomotion.leftKnee + seatLegAngle * seated, 0, 0, 16, dt);
    pose('rightLowerLeg', locomotion.rightKnee + seatLegAngle * seated, 0, 0, 16, dt);
    pose('leftFoot', locomotion.leftAnkle, 0, 0, 16, dt);
    pose('rightFoot', locomotion.rightAnkle, 0, 0, 16, dt);

    bones.hips.position.copy(hipRest);
    bones.hips.position.y += (locomotion.bob + breath * 0.002 * standing) / scale;
    // This translation is in the avatar's local space; the room owns root.y.
    let seatHeightBlend = seated;
    if (publicSeatCalibrated && seated > 0) {
      // Following the current damped fold avoids lowering the pelvis before
      // the long legs have actually bent. This is not a horizontal foot lock.
      scratchQuaternion.copy(rest.leftUpperLeg).invert().multiply(bones.leftUpperLeg.quaternion);
      scratchEuler.setFromQuaternion(scratchQuaternion);
      seatHeightBlend = (1 - Math.cos(Math.abs(scratchEuler.x))) / (1 - Math.cos(seatLegAngle));
    }
    vrm.scene.position.y = floorOffset - sitDrop * seatHeightBlend;
    pose('hips', 0.015 * seated, locomotion.hipYaw, locomotion.hipRoll, 10, dt);
    const footPose = footPlacement.update(dt, { sitBlend: seated, time, groundHeightAt: context.groundHeightAt });
    pose('spine', -0.025 + 0.035 * seated + breath * 0.008 + (activityFrame?.spineLean ?? 0), 0, Math.sin(time * 0.7) * 0.006 * standing, 10, dt);
    pose('chest', breath * 0.009 + (activityFrame?.chestLean ?? 0), THREE.MathUtils.lerp(locomotion.chestYaw, footPose.chestYaw, footPose.weight), 0, 10, dt);
    pose('upperChest', 0, 0, 0, 10, dt);
    pose('leftShoulder', 0, 0, -0.025, 10, dt);
    pose('rightShoulder', 0, 0, 0.025, 10, dt);

    // The normalised skeleton has a T-pose. These Z rotations lower the arms;
    // mild elbow flexion and separated hands avoid intersecting the clothing.
    let leftArmX = THREE.MathUtils.lerp(locomotion.leftArm, footPose.armSwing, footPose.weight) - 0.16 * seated;
    let rightArmX = THREE.MathUtils.lerp(locomotion.rightArm, -footPose.armSwing, footPose.weight) - 0.16 * seated;
    let leftArmZ = -1.22 + 0.06 * seated;
    let rightArmZ = 1.22 - 0.06 * seated;
    let rightElbowY = 0.16;
    let rightElbowZ = 0;
    let rightHandZ = 0;
    let nod = 0;
    if (activityFrame?.stretch) {
      const stretch = activityFrame.stretch;
      leftArmZ = THREE.MathUtils.lerp(leftArmZ, -0.35, stretch);
      rightArmZ = THREE.MathUtils.lerp(rightArmZ, 0.35, stretch);
      leftArmX = THREE.MathUtils.lerp(leftArmX, -0.08, stretch);
      rightArmX = THREE.MathUtils.lerp(rightArmX, -0.08, stretch);
    }
    const gestureAge = time - gestureStart;
    if (gesture === 'wave') {
      const envelope = Math.min(1, gestureAge / 0.35) * Math.min(1, Math.max(0, (2.8 - gestureAge) / 0.45));
      // Keep the hand beside the cheek rather than through the oversized head.
      rightArmZ = THREE.MathUtils.lerp(rightArmZ, 0.12, envelope);
      rightArmX = THREE.MathUtils.lerp(rightArmX, -0.12, envelope);
      rightElbowY = THREE.MathUtils.lerp(rightElbowY, 0.08, envelope);
      rightElbowZ = -0.95 * envelope;
      rightHandZ = Math.sin(gestureAge * 13) * 0.30 * envelope;
      if (gestureAge > 2.8) gesture = null;
    } else if (gesture === 'nod') {
      const envelope = Math.sin(Math.min(1, gestureAge / 1.5) * Math.PI);
      nod = Math.sin(gestureAge * 8.5) * 0.16 * envelope;
      if (gestureAge > 1.5) gesture = null;
    }
    // Animate an independent base pose, not the previous frame's IK result.
    // Otherwise uneven frame lengths feed the reach back into the resting pose.
    for (const name of armLayerNames) if (bones[name]) bones[name].quaternion.copy(armBase[name]);
    pose('leftUpperArm', leftArmX, 0, leftArmZ, 11, dt);
    pose('rightUpperArm', rightArmX, 0, rightArmZ, 11, dt);
    pose('leftLowerArm', 0, -0.16 - seated * 0.55, 0, 11, dt);
    pose('rightLowerArm', 0, rightElbowY + seated * 0.55, rightElbowZ, 11, dt);
    pose('leftHand', 0.05, 0, -0.04, 11, dt);
    pose('rightHand', 0.05, 0, 0.04 + rightHandZ, 11, dt);
    for (const name of armLayerNames) if (bones[name]) armBase[name].copy(bones[name].quaternion);
    for (const name of fingerNames) {
      const side = name.startsWith('left') ? 'left' : 'right';
      const curl = activityFrame?.[`${side}Curl`] ?? 0;
      const factor = name.includes('Distal') ? 0.65 : name.includes('Intermediate') ? 0.85 : 1;
      pose(name, 0, 0, (side === 'left' ? -1 : 1) * curl * factor, 14, dt);
    }
    if (activityFrame) {
      activity.handErrors.left = reachHand('left', activityFrame.leftWrist, activityFrame.leftWeight, activityFrame.leftTilt);
      activity.handErrors.right = reachHand('right', activityFrame.rightWrist, activityFrame.rightWeight, activityFrame.rightTilt);
    }

    let targetYaw = 0;
    let targetPitch = 0;
    let lookTarget = context.lookTarget;
    // Reading can briefly attend to the user while the hands keep their page
    // targets. Drinking retains its own gaze so a sip cannot turn into the cup.
    if (activityFrame?.lookAt && (activity?.name !== 'read' || !context.lookTarget?.isVector3)) {
      activityLookTarget.fromArray(activityFrame.lookAt); root.localToWorld(activityLookTarget); lookTarget = activityLookTarget;
    }
    const bookTarget = activity?.props?.lookTargets?.book;
    const readingLayout = activity?.name === 'read' ? activity.props?.getReadingGazeLayout?.() : null;
    readingGaze = stepReadingGaze(readingGaze, dt, {
      enabled: context.readAlongPage === true && context.renderVisible !== false && activity?.name === 'read'
        && (!context.lookTarget?.isVector3 || (bookTarget?.isVector3 && context.lookTarget.distanceTo(bookTarget) <= .05)),
      phase: activityFrame?.phase, cancelling: activityFrame?.cancelling,
      lineCount: readingLayout?.lineCount, pageKey: readingLayout?.pageKey, episodeKey: activity?.id,
    });
    let eyeLookTarget = lookTarget;
    if (readingGaze.active) {
      const target = activity.props.getReadingGazeTarget(readingGaze, readingEyeTarget);
      if (target) {
        readingGazeLocal.copy(target); root.worldToLocal(readingGazeLocal);
        eyeLookTarget = target;
      } else readingGaze = stepReadingGaze(readingGaze, 0, { episodeKey: activity?.id, pageKey: readingLayout?.pageKey });
    }
    if (lookTarget?.isVector3) {
      root.updateMatrixWorld(true);
      localTarget.copy(lookTarget);
      root.worldToLocal(localTarget);
      const headY = eyeHeight - sitDrop * seated + (footPlacement.supported ? footPlacement.weight * (footPlacement.surfaceHeight - .002) : 0);
      const yawLimit = activity?.name === 'read' ? 0.42 : 0.55;
      targetYaw = clamp(Math.atan2(localTarget.x, localTarget.z), -yawLimit, yawLimit);
      const pitchLimit = activityFrame?.pitchLimit ?? 0.2;
      targetPitch = clamp(-Math.atan2(localTarget.y - headY, Math.hypot(localTarget.x, localTarget.z)), -pitchLimit, pitchLimit);
    }
    yaw = damp(yaw, targetYaw + facial.gazeYaw * 0.35, 4, dt);
    pitch = damp(pitch, targetPitch + facial.gazePitch * 0.3, 4, dt);
    pose('neck', pitch * 0.3, yaw * 0.35, 0, 8, dt);
    pose('head', pitch * 0.7 + nod + facial.responseCuePitch, yaw * 0.65, Math.sin(time * 0.55) * 0.006 + facial.headTilt, 8, dt);

    // Update the actual head transform before calculating residual eye gaze.
    // Otherwise lookAt uses last frame's pose and fights the moving head.
    vrm.humanoid.update();
    vrm.scene.updateMatrixWorld(true);
    if (vrm.lookAt) {
      // Paper scanning belongs to the eyes only. Keep the original head target
      // and supported hands unchanged, including explicit glances at the user.
      if (eyeLookTarget?.isVector3) vrm.lookAt.lookAt(eyeLookTarget);
      else vrm.lookAt.reset();
      const desiredEyeYaw = clamp(vrm.lookAt.yaw + (readingGaze.active ? 0 : THREE.MathUtils.RAD2DEG * facial.gazeYaw * 3), -65, 65);
      const desiredEyePitch = clamp(vrm.lookAt.pitch + (readingGaze.active ? 0 : THREE.MathUtils.RAD2DEG * facial.gazePitch * 3), -35, 35);
      eyeYaw = damp(eyeYaw, desiredEyeYaw, 14, dt);
      eyePitch = damp(eyePitch, desiredEyePitch, 14, dt);
      vrm.lookAt.yaw = eyeYaw;
      vrm.lookAt.pitch = eyePitch;
    }
    for (const name of EXPRESSIONS) expressionManager.setValue(name, 0);
    for (const name of ['happy', 'relaxed', 'sad']) {
      const channels = facialRig.channels?.[name];
      if (channels) {
        expressionManager.setValue(channels.eyes, facial.channels[`${name}Eyes`]);
        expressionManager.setValue(channels.mouth, facial.channels[`${name}Mouth`]);
      } else {
        // The fallback is only for a replacement model without a splittable
        // face. Keep its combined preset below the eye-safe strength.
        expressionManager.setValue(name, facial.channels[`${name}Eyes`]);
      }
    }
    expressionManager.setValue('blink', facial.blink);
    // This model's surprised preset has no binds; its round vowel provides a visible gasp.
    for (const [name, weight] of Object.entries(facial.vowels)) expressionManager.setValue(name, weight);
    vrm.update(dt);
    if (activity) {
      vrm.scene.updateMatrixWorld(true);
      const current = activity, frame = current.frame, props = current.props;
      if (current.name === 'read') props.updateBook(frame.bookOpen, frame.pageFlip);
      if (current.name === 'drink' || current.name === 'move_cup') {
        const handMatrix = vrm.humanoid.getRawBoneNode('rightHand').matrixWorld;
        if (frame.shouldHoldCup && !props.isCupHeld() && !current.cupTransaction?.deposited) props.attachCup(handMatrix);
        if (props.isCupHeld()) props.updateHeldCup(handMatrix);
        if (!frame.shouldHoldCup && props.isCupHeld()) {
          if (current.name === 'drink') props.releaseCup();
          else if (!props.tryCupDeposit(current.cupTransaction)) {
            if (!current.cupTransaction.returning) {
              props.requestCupReturn(current.cupTransaction);current.returnFailure = true;
              current.state = cancelActivityState(current.state, { holdingProp: true });
              current.frame = sampleActivity(current.state);
            } else {
              // Never drop an unsupported cup merely to settle the promise.
              // The room can observe held+blocked and prevent leaving the table.
              current.blocked = true;props.blockCupTransfer(current.cupTransaction);
              current.frame = { ...frame, phase: 'holding-cup', done: false, shouldHoldCup: true, rightWeight: 1, rightCurl: .32 };
              activityResult = { id: current.id, name: current.name, status: 'failed', code: 'CUP_RETURN_BLOCKED',
                placement: props.getCupPlacement(current.cupTransaction), effect: null };
              if (!current.begun) current.begin(false);
              current.finish(activityResult);
            }
            return;
          }
        }
      }
      if (frame.started && !frame.cancelling && !current.begun) { current.begun = true; current.begin(true); }
      if (frame.done) {
        if (!current.begun) current.begin(false);
        const placement = current.cupTransaction ? props.getCupPlacement(current.cupTransaction)
          : current.name === 'drink' ? props.getCupReturnError(current.cupHome) : null;
        const failed = current.returnFailure || (current.cupTransaction ? !placement.supported : placement && (placement.position > .025 || placement.angle > .2));
        const status = current.cupTransaction ? (failed ? 'failed' : frame.cancelling ? 'cancelled' : 'completed')
          : frame.cancelling ? 'cancelled' : failed ? 'failed' : 'completed';
        activityResult = { id: current.id, name: current.name, status, placement,
          ...(current.cupTransaction ? { effect: current.cupTransaction.effect } : {}) };
        if (current.cupTransaction) props.finishCupTransfer(current.cupTransaction);
        activity = null;
        current.finish(activityResult);
      }
    }
  }

  // Establish the resting pose before the first visible frame, avoiding an
  // unexpected T-pose during loading. Spring bones settle in the regular loop.
  for (let i = 0; i < 45; i++) update(1 / 60, {});

  return {
    root,
    vrm,
    ready: true,
    modelSource,
    publicSeatCalibrated,
    usingFallback,
    supportedActivities,
    tabletopSupported,
    height,
    headHeight,
    eyeHeight,
    hipHeight,
    thighLength,
    seatHeight: seatSurfaceHeight,
    seatedHipHeight,
    preferredWalkSpeed: footPlacement.supported ? FOOT_PLACEMENT.speed : GAIT.nominalSpeed,
    preferredTurnSpeed: footPlacement.supported ? FOOT_PLACEMENT.turnSpeed : 3.8,
    get groundOffset() { return footPlacement.supported ? footPlacement.weight * (footPlacement.surfaceHeight - .002) : 0; },
    sitDrop,
    cupTransferSupported,
    expressions: [...EXPRESSIONS],
    update,
    setExpression: face.setExpression,
    setAttention,
    setSpeaking: face.setSpeaking,
    setGesture,
    setActivity,
    cancelActivity,
    getState() { return { ...face.getState(), gesture, seated: sitBlend > 0.95, sitBlend, walkBlend: locomotion.blend, gaitPhase: locomotion.phase, gaze: { yaw: eyeYaw, pitch: eyePitch }, facialRig: facialRig.supported,
      activity: activity ? { id: activity.id, name: activity.name, phase: activity.frame.phase, elapsed: activity.state.elapsed, cancelling: activity.state.cancelling,
        blocked: activity.blocked, holdingProp: ['drink', 'move_cup'].includes(activity.name) && activity.props?.isCupHeld(), handErrors: { ...activity.handErrors } } : null,
      activityResult, get footPlacement() { return footPlacement.getState(); }, tailGround: tailGroundRig.getState(),
      get readingGaze() { return { active: readingGaze.active, scanning: readingGaze.scanning, line: readingGaze.line,
        fixation: readingGaze.fixation, targetLocal: readingGaze.active ? readingGazeLocal.toArray() : null }; },
    }; },
    dispose() {
      isDisposed = true;
      tailGroundRig.dispose();
      root.removeFromParent();
      VRMUtils.deepDispose(vrm.scene);
    },
  };
}

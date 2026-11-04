import * as THREE from 'three';

export const FOOT_PLACEMENT = Object.freeze({ speed: .28, turnSpeed: 2, stepTime: .30, lift: .020, woodHeight: .0025 });
const clamp = THREE.MathUtils.clamp;
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
const smooth = (t) => t * t * (3 - 2 * t);
const angleDelta = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const Y = new THREE.Vector3(0, 1, 0);
const defaultGround = () => FOOT_PLACEMENT.woodHeight;

/** Short-leg foot placement for the locally calibrated chibi, not a general
 * retargeter. Feet have explicit swing/support phases; a support target stays
 * in world space. An analytic two-link solve keeps the knee facing forward.
 * Call after the base hips/leg pose, before hand IK and vrm.update(). */
export function createFootPlacement(vrm, root) {
  const bone = (name) => vrm.humanoid?.getNormalizedBoneNode(name);
  const hips = bone('hips'), scale = vrm.scene.scale.y;
  const fallback = { supported: false, weight: 0, armSwing: 0, chestYaw: 0, surfaceHeight: 0,
    update() { return this; }, getState() { return { supported: false, phase: 'fallback', weight: 0, feet: [] }; } };
  if (!hips || !Number.isFinite(scale) || scale <= 0) return fallback;
  root.updateMatrixWorld(true);
  const scratch = Object.fromEntries(['point', 'upper', 'knee', 'ankle', 'direction', 'pole', 'wantedKnee', 'from', 'to', 'target', 'velocity', 'localLeft', 'localRight'].map(n => [n, new THREE.Vector3()]));
  const quats = Object.fromEntries(['root', 'world', 'parent', 'delta', 'desired', 'pose'].map(n => [n, new THREE.Quaternion()]));
  const euler = new THREE.Euler();
  const restHipY = vrm.humanoid.normalizedRestPose?.hips?.position?.[1];
  const feet = [];
  for (const side of ['left', 'right']) {
    const upper = bone(`${side}UpperLeg`), lower = bone(`${side}LowerLeg`), foot = bone(`${side}Foot`);
    const rawFoot = vrm.humanoid.getRawBoneNode(`${side}Foot`), rawToes = vrm.humanoid.getRawBoneNode(`${side}Toes`);
    if (!upper || !lower || !foot || !rawFoot || !rawToes) return fallback;
    upper.getWorldPosition(scratch.upper); lower.getWorldPosition(scratch.knee); foot.getWorldPosition(scratch.ankle);
    const upperLength = scratch.upper.distanceTo(scratch.knee), lowerLength = scratch.knee.distanceTo(scratch.ankle);
    // Avoid applying the short-leg calibration to an arbitrary replacement VRM.
    if (upperLength < .08 || upperLength > .14 || lowerLength < .055 || lowerLength > .10) return fallback;
    let soleMin = Infinity, vertices = 0;
    const shoePoints = [];
    vrm.scene.traverse(mesh => {
      if (!mesh.isSkinnedMesh) return;
      const indices = [rawFoot, rawToes].map(b => mesh.skeleton.bones.indexOf(b));
      const joints = mesh.geometry.attributes.skinIndex, weights = mesh.geometry.attributes.skinWeight;
      if (!joints || !weights) return;
      for (let i = 0; i < joints.count; i++) {
        let influence = 0;
        for (let channel = 0; channel < 4; channel++) if (indices.includes(joints.getComponent(i, channel))) influence += weights.getComponent(i, channel);
        if (influence <= .5) continue;
        mesh.getVertexPosition(i, scratch.point).applyMatrix4(mesh.matrixWorld);
        soleMin = Math.min(soleMin, scratch.point.y); vertices++;
        shoePoints.push(scratch.point.clone());
      }
    });
    if (!vertices || !Number.isFinite(soleMin)) return fallback;
    foot.getWorldPosition(scratch.ankle);
    const rest = root.worldToLocal(scratch.ankle.clone());
    const offset = scratch.ankle.y - soleMin;
    if (offset < .03 || offset > .11) return fallback;
    const restRotation = foot.getWorldQuaternion(new THREE.Quaternion()).premultiply(root.getWorldQuaternion(quats.root).invert());
    const footprint = new THREE.Box3();
    foot.getWorldQuaternion(quats.desired).invert();
    for (const point of shoePoints) if (point.y <= soleMin + .012) footprint.expandByPoint(point.sub(scratch.ankle).applyQuaternion(quats.desired));
    feet.push({ side, upper, lower, foot, upperLength, lowerLength, rest, offset, restRotation,
      footprint,
      position: new THREE.Vector3(), rotation: new THREE.Quaternion(), start: new THREE.Vector3(), end: new THREE.Vector3(),
      previousPosition: new THREE.Vector3(), previousRotation: new THREE.Quaternion(),
      startRotation: new THREE.Quaternion(), endRotation: new THREE.Quaternion(), phase: 'support', stepId: 0,
      elapsed: 0, duration: FOOT_PLACEMENT.stepTime, error: 0, reachExcess: 0, kneeForward: 0 });
  }
  if (!Number.isFinite(restHipY)) return fallback;
  const previous = root.position.clone();
  let previousYaw = root.rotation.y, active = -1, next = 0, movingBlend = 0, armSwing = 0;
  let initialized = false, paused = false, weight = 0, surfaceHeight = FOOT_PLACEMENT.woodHeight, extraDrop = 0;
  let ground = defaultGround;
  const state = { supported: true, weight: 0, armSwing: 0, chestYaw: 0, surfaceHeight, phase: 'settling' };
  function heightAt(x, z) {
    const value = ground(x, z);
    return Number.isFinite(value) ? clamp(value, -.05, .10) : FOOT_PLACEMENT.woodHeight;
  }
  function ideal(foot, velocity, omega, ahead, position, rotation) {
    quats.root.setFromAxisAngle(Y, root.rotation.y + omega * ahead);
    position.copy(foot.rest).applyQuaternion(quats.root).add(root.position).addScaledVector(velocity, ahead);
    rotation.copy(quats.root).multiply(foot.restRotation);
    position.y = footSurface(foot, position, rotation) + foot.offset;
  }
  function footSurface(foot, position, rotation) {
    let height = heightAt(position.x, position.z);
    for (let corner = 0; corner < 4; corner++) {
      const x = corner & 1 ? foot.footprint.max.x : foot.footprint.min.x;
      const z = corner & 2 ? foot.footprint.max.z : foot.footprint.min.z;
      scratch.point.set(x, 0, z).applyQuaternion(rotation).add(position);
      height = Math.max(height, heightAt(scratch.point.x, scratch.point.z));
    }
    return height;
  }
  function reset() {
    scratch.velocity.set(0, 0, 0);
    for (const foot of feet) {
      ideal(foot, scratch.velocity, 0, 0, foot.position, foot.rotation);
      foot.phase = 'support'; foot.error = 0; foot.reachExcess = 0;
    }
    active = -1; next = 0; weight = 0; extraDrop = 0;
    surfaceHeight = heightAt(root.position.x, root.position.z);
    initialized = true;
  }
  function rotateToward(bone, from, to, amount) {
    if (from.lengthSq() < 1e-12 || to.lengthSq() < 1e-12) return;
    quats.delta.setFromUnitVectors(from.normalize(), to.normalize());
    bone.getWorldQuaternion(quats.world); bone.parent.getWorldQuaternion(quats.parent).invert();
    quats.desired.copy(quats.parent).multiply(quats.delta).multiply(quats.world);
    bone.quaternion.slerp(quats.desired, amount);
  }
  function solve(foot) {
    foot.upper.getWorldPosition(scratch.upper); foot.lower.getWorldPosition(scratch.knee); foot.foot.getWorldPosition(scratch.ankle);
    scratch.direction.copy(foot.position).sub(scratch.upper);
    const requested = scratch.direction.length();
    if (requested < 1e-7) return;
    scratch.direction.divideScalar(requested);
    const maximum = foot.upperLength + foot.lowerLength - .0001;
    const distance = clamp(requested, Math.abs(foot.upperLength - foot.lowerLength) + .0001, maximum);
    const along = (foot.upperLength ** 2 - foot.lowerLength ** 2 + distance ** 2) / (2 * distance);
    root.getWorldQuaternion(quats.root);
    scratch.pole.set(0, 0, 1).applyQuaternion(quats.root);
    scratch.pole.addScaledVector(scratch.direction, -scratch.pole.dot(scratch.direction)).normalize();
    scratch.wantedKnee.copy(scratch.upper).addScaledVector(scratch.direction, along)
      .addScaledVector(scratch.pole, Math.sqrt(Math.max(0, foot.upperLength ** 2 - along ** 2)));
    scratch.from.copy(scratch.knee).sub(scratch.upper); scratch.to.copy(scratch.wantedKnee).sub(scratch.upper);
    rotateToward(foot.upper, scratch.from, scratch.to, weight);
    foot.lower.getWorldPosition(scratch.knee); foot.foot.getWorldPosition(scratch.ankle);
    scratch.from.copy(scratch.ankle).sub(scratch.knee);
    scratch.to.copy(scratch.upper).addScaledVector(scratch.direction, distance).sub(scratch.knee);
    rotateToward(foot.lower, scratch.from, scratch.to, weight);
    foot.foot.parent.getWorldQuaternion(quats.parent).invert();
    quats.desired.copy(quats.parent).multiply(foot.rotation);
    foot.foot.quaternion.slerp(quats.desired, weight);
    foot.foot.getWorldPosition(scratch.ankle); foot.lower.getWorldPosition(scratch.knee);
    foot.error = scratch.ankle.distanceTo(foot.position); foot.reachExcess = Math.max(0, requested - maximum);
    scratch.point.copy(scratch.upper).lerp(scratch.ankle, .5);
    foot.kneeForward = scratch.knee.sub(scratch.point).dot(scratch.pole);
  }
  return Object.assign(state, {
    update(rawDt, { sitBlend = 0, time = 0, groundHeightAt } = {}) {
      const dt = Number.isFinite(rawDt) ? clamp(rawDt, 0, .05) : 0;
      if (dt === 0) return state;
      ground = typeof groundHeightAt === 'function' ? groundHeightAt : defaultGround;
      scratch.velocity.copy(root.position).sub(previous); const displacement = scratch.velocity.length();
      scratch.velocity.divideScalar(dt); scratch.velocity.y = 0;
      let omega = angleDelta(previousYaw, root.rotation.y) / dt;
      previous.copy(root.position); previousYaw = root.rotation.y;
      if (sitBlend > .001) {
        paused = true; weight = 0; active = -1;
        state.weight = 0; state.phase = 'seated'; state.armSwing = 0; state.chestYaw = 0;
        return state;
      }
      if (!initialized || paused || displacement > .25) { reset(); scratch.velocity.set(0, 0, 0); omega = 0; paused = false; }
      weight = Math.min(1, weight + dt / .22);
      const moving = scratch.velocity.length() > .005 || Math.abs(omega) > .1;
      movingBlend = damp(movingBlend, moving ? 1 : 0, 9, dt);
      surfaceHeight = damp(surfaceHeight, heightAt(root.position.x, root.position.z), 12, dt);
      const duration = Math.min(clamp(.09 / Math.max(.01, scratch.velocity.length()), .16, FOOT_PLACEMENT.stepTime),
        clamp(.55 / Math.max(.1, Math.abs(omega)), .11, FOOT_PLACEMENT.stepTime));
      if (active < 0) {
        let index = moving ? next : -1;
        if (!moving) for (const candidate of [next, 1 - next]) {
          ideal(feet[candidate], scratch.velocity, 0, 0, scratch.target, quats.desired);
          if (feet[candidate].position.distanceTo(scratch.target) > .012) { index = candidate; break; }
        }
        if (index >= 0) {
          const foot = feet[index]; foot.phase = 'swing'; foot.stepId++; foot.elapsed = 0;
          foot.duration = movingBlend < .25 && scratch.velocity.length() > .3 ? Math.min(.13, duration) : duration;
          foot.start.copy(foot.position); foot.startRotation.copy(foot.rotation);
          ideal(foot, scratch.velocity, omega, foot.duration * 1.5, foot.end, foot.endRotation);
          active = index; next = 1 - index;
        }
      }
      if (active >= 0) {
        const foot = feet[active];
        foot.previousPosition.copy(foot.position); foot.previousRotation.copy(foot.rotation);
        foot.elapsed = Math.min(foot.duration, foot.elapsed + dt * (1 + Math.min(.8, Math.abs(omega) / 4)));
        const progress = foot.elapsed / foot.duration;
        ideal(foot, scratch.velocity, omega, Math.max(0, foot.duration - foot.elapsed) + (moving ? foot.duration * .5 : 0), scratch.target, quats.desired);
        foot.end.lerp(scratch.target, 1 - Math.exp(-18 * dt)); foot.endRotation.slerp(quats.desired, 1 - Math.exp(-18 * dt));
        foot.position.copy(foot.start).lerp(foot.end, smooth(progress));
        const clearance = FOOT_PLACEMENT.lift + Math.abs(foot.end.y - foot.start.y);
        foot.position.y += clearance * Math.sin(Math.PI * progress) ** 1.5;
        foot.rotation.copy(foot.startRotation).slerp(foot.endRotation, smooth(progress));
        const floorY = footSurface(foot, foot.position, foot.rotation) + foot.offset;
        const wantedY = Math.max(foot.position.y, floorY);
        const limitedY = clamp(wantedY, foot.previousPosition.y - .6 * dt, foot.previousPosition.y + .6 * dt);
        const blocked = limitedY < floorY - .0001;
        // If a landing is retargeted across a raised edge late in the swing,
        // first lift clear of it. Never move horizontally through the rug or
        // teleport the entire 26 mm step height in one frame.
        if (blocked) {
          foot.position.x = foot.previousPosition.x; foot.position.z = foot.previousPosition.z;
          foot.rotation.copy(foot.previousRotation);
        }
        foot.position.y = limitedY;
        if (progress >= 1 - 1e-9 && !blocked && Math.abs(limitedY - wantedY) < .0001) { foot.phase = 'support'; active = -1; }
      }
      // Preserve the current standing height/breathing. The 14 mm maximum
      // compression creates room for a short, forward-bending knee during gait.
      const hipY = restHipY + (surfaceHeight - .002 - .012 * movingBlend + Math.sin(time * 1.65) * .002) / scale;
      hips.position.y = THREE.MathUtils.lerp(hips.position.y, hipY, weight);
      root.worldToLocal(scratch.localLeft.copy(feet[0].position)); root.worldToLocal(scratch.localRight.copy(feet[1].position));
      armSwing = damp(armSwing, clamp((scratch.localLeft.z - scratch.localRight.z) / .10, -1, 1) * .16 * movingBlend, 12, dt);
      quats.pose.setFromEuler(euler.set(0, armSwing * .07, -armSwing * .05));
      hips.quaternion.slerp(quats.pose, weight);
      // A rug edge can put the supporting feet on different planes. Lower the
      // pelvis just enough to respect reach, then release this correction softly.
      let requiredDrop = 0;
      for (const foot of feet) {
        foot.upper.getWorldPosition(scratch.upper);
        const horizontal = Math.hypot(scratch.upper.x - foot.position.x, scratch.upper.z - foot.position.z);
        const reach = foot.upperLength + foot.lowerLength - .0002;
        const vertical = Math.sqrt(Math.max(0, reach * reach - horizontal * horizontal));
        requiredDrop = Math.max(requiredDrop, scratch.upper.y - foot.position.y - vertical);
      }
      extraDrop = Math.min(.026, Math.max(requiredDrop, damp(extraDrop, requiredDrop, 12, dt)));
      hips.position.y -= extraDrop * weight / scale;
      for (const foot of feet) solve(foot);
      state.weight = weight; state.armSwing = armSwing; state.chestYaw = -armSwing * .045;
      state.surfaceHeight = surfaceHeight; state.phase = moving ? 'walking' : active >= 0 || weight < 1 ? 'settling' : 'standing';
      return state;
    },
    getState() {
      return { supported: true, phase: state.phase, weight, surfaceHeight, extraDrop,
        supportError: Math.max(0, ...feet.filter(f => f.phase === 'support').map(f => f.error)),
        feet: feet.map(f => ({ side: f.side, phase: f.phase, stepId: f.stepId, position: f.position.toArray(),
          error: f.error, reachExcess: f.reachExcess, kneeForward: f.kneeForward })) };
    },
  });
}

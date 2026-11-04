// Calibrated for the local 1.35 m chibi: thigh .10964 m, shin .07600 m,
// ankle-to-toe .07473 m. This is a procedural gait, not a foot-contact solver.
export const GAIT = Object.freeze({
  nominalSpeed: 0.45,
  angularSpeed: 6.3,
  hipAmplitude: 0.40,
  kneeAmplitude: 0.55,
  ankleAmplitude: 0.17,
  blendRate: 7,
  poseRate: 16,
});

const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const damp = (from, to, rate, dt) => from + (to - from) * (1 - Math.exp(-rate * dt));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

export function createGaitState() {
  return {
    phase: 0, blend: 0, omega: 0,
    leftHip: 0, rightHip: 0, leftKnee: 0, rightKnee: 0,
    leftAnkle: 0, rightAnkle: 0, bob: 0,
    hipYaw: 0, hipRoll: 0, chestYaw: 0, leftArm: 0, rightArm: 0,
  };
}

/**
 * Pure gait update. Input speed is actual planar travel speed in m/s; direction
 * is -1 for short backwards steps while the avatar keeps its facing direction.
 * Returned angles are radians; bob is metres, and all are walking offsets.
 * The caller adds the seated pose and applies its existing joint smoothing.
 *
 * Cadence stays approximately constant while moving: speed is already expressed
 * through stride amplitude, so multiplying cadence by speed again would create
 * a squared-speed mismatch. At rest both cadence and amplitude settle smoothly.
 */
export function stepGait(previous, rawDt, { speed = 0, sitBlend = 0, direction = 1 } = {}) {
  const state = previous ?? createGaitState();
  const dt = clamp(finite(rawDt), 0, 0.05);
  const velocity = Math.max(0, finite(speed));
  const standing = 1 - clamp(finite(sitBlend), 0, 1);
  const targetBlend = clamp(velocity / GAIT.nominalSpeed, 0, 1) * standing;
  let blend = damp(clamp(finite(state.blend), 0, 1), targetBlend, GAIT.blendRate, dt);
  const moving = velocity > 0.005 && standing > 0.01;
  const travelDirection = finite(direction, 1) < 0 ? -1 : 1;
  let omega = damp(clamp(finite(state.omega), -GAIT.angularSpeed, GAIT.angularSpeed), moving ? travelDirection * GAIT.angularSpeed : 0, moving ? 12 : 14, dt);
  let phase = ((finite(state.phase) + omega * dt) % TAU + TAU) % TAU;
  if (dt > 0 && !moving && blend < 0.001 && Math.abs(omega) < 0.001) {
    return createGaitState();
  }
  const gait = Math.sin(phase), otherGait = -gait;
  // Reverse the cycle, not the joint angles: knees still flex the same way.
  // A future planted-foot controller can replace this without changing callers.
  const leftLift = Math.max(0, -gait) * blend;
  const rightLift = Math.max(0, -otherGait) * blend;
  return {
    phase, blend, omega,
    leftHip: -gait * GAIT.hipAmplitude * blend,
    rightHip: -otherGait * GAIT.hipAmplitude * blend,
    leftKnee: leftLift * GAIT.kneeAmplitude,
    rightKnee: rightLift * GAIT.kneeAmplitude,
    leftAnkle: -leftLift * GAIT.ankleAmplitude,
    rightAnkle: -rightLift * GAIT.ankleAmplitude,
    bob: Math.cos(phase * 2) * 0.008 * blend,
    hipYaw: 0.025 * gait * blend,
    hipRoll: -0.018 * gait * blend,
    chestYaw: -0.018 * gait * blend,
    leftArm: gait * 0.22 * blend,
    rightArm: otherGait * 0.22 * blend,
  };
}

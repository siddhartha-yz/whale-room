const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const damp = (from, to, rate, dt) => from + (to - from) * (1 - Math.exp(-rate * dt));
const smooth = value => { const x = clamp(value, 0, 1); return x * x * (3 - 2 * x); };

export const FACE_PROFILES = Object.freeze({
  neutral: { eyes: 0, mouth: 0, hold: 0 },
  happy: { eyes: 0.18, mouth: 0.62, hold: 4.5 },
  relaxed: { eyes: 0.12, mouth: 0.28, hold: 6 },
  sad: { eyes: 0.10, mouth: 0.48, hold: 5 },
  surprised: { eyes: 0, mouth: 0.42, hold: 1.6 },
});
const EMOTIONS = Object.keys(FACE_PROFILES).filter(name => name !== 'neutral');

/**
 * Local facial timing. A semantic emotion is a reaction, not a latched pose.
 * Blinks interpolate from the current eyelid pose to closed eyes; they never
 * add a full closure on top of another expression. Mouth shapes stay separate.
 */
export function createFaceController({ random = Math.random } = {}) {
  let time = 0;
  let expression = 'neutral';
  let expressionStart = 0;
  let hold = 0;
  let attention = 'idle';
  let attentionUntil = Infinity;
  let speaking = false;
  let speechBlend = 0;
  let nextBlink = 1.8 + random() * 1.6;
  let blinkStart = -Infinity;
  let doubleBlink = false;
  let blink = 0;
  let gazeYaw = 0;
  let gazePitch = 0;
  let gazeGoalYaw = 0;
  let gazeGoalPitch = 0;
  let nextGlance = 2 + random() * 4;
  const amounts = Object.fromEntries(EMOTIONS.map(name => [name, 0]));
  let lastFrame = null;

  function setExpression(name = 'neutral', { source = 'model', holdSeconds } = {}) {
    if (!Object.hasOwn(FACE_PROFILES, name)) return false;
    expression = name;
    expressionStart = time;
    const defaultHold = source === 'manual' ? (name === 'surprised' ? 3 : 9) : FACE_PROFILES[name].hold;
    hold = Number.isFinite(holdSeconds) ? clamp(holdSeconds, 0.5, 12) : defaultHold;
    return true;
  }

  function setAttention(value = 'idle') {
    if (!['idle', 'listening', 'thinking', 'responding'].includes(value)) return false;
    attention = value;
    attentionUntil = value === 'listening' ? time + 3 : value === 'responding' ? time + 4 : Infinity;
    if (value === 'listening' || value === 'thinking') setExpression('neutral');
    return true;
  }

  function update(rawDt, { moving = false } = {}) {
    const dt = clamp(Number(rawDt) || 0, 0, 0.1);
    time += dt;
    if (time >= attentionUntil) { attention = 'idle'; attentionUntil = Infinity; }
    const age = time - expressionStart;
    const release = expression === 'surprised' ? 1 : 2.2;
    const envelope = expression === 'neutral' ? 0 : 1 - smooth((age - hold) / release);
    if (age > hold + release) expression = 'neutral';
    for (const name of EMOTIONS) {
      const target = name === expression ? envelope : 0;
      const value = damp(amounts[name], target, 8, dt);
      amounts[name] = target === 0 && value < 0.00001 ? 0 : value;
    }

    if (time >= nextBlink) {
      blinkStart = time;
      if (doubleBlink) {
        doubleBlink = false;
        nextBlink = time + 2.8 + random() * 3;
      } else {
        doubleBlink = random() < 0.12;
        nextBlink = time + (doubleBlink ? 0.34 : 2.8 + random() * 3);
      }
    }
    const blinkAge = time - blinkStart;
    // Fast close, a brief closed phase, and a softer opening. A single blink
    // lasts 190 ms; its timing is independent of model requests and emotion.
    blink = blinkAge < 0 ? 0 : blinkAge < 0.065 ? smooth(blinkAge / 0.065)
      : blinkAge < 0.085 ? 1 : blinkAge < 0.19 ? 1 - smooth((blinkAge - 0.085) / 0.105) : 0;

    if (time >= nextGlance) {
      // Brief, small glances only. Most idle time is spent looking toward the
      // supplied target; there is no perpetual sinusoidal eye wandering.
      const glance = random() < 0.45;
      gazeGoalYaw = glance ? (random() - 0.5) * 0.075 : 0;
      gazeGoalPitch = glance ? (random() - 0.5) * 0.035 : 0;
      nextGlance = time + (glance ? 0.8 + random() * 0.8 : 3 + random() * 4);
    }
    let targetYaw = gazeGoalYaw;
    let targetPitch = gazeGoalPitch;
    if (moving || attention === 'listening' || attention === 'responding') {
      targetYaw = 0; targetPitch = 0;
    } else if (attention === 'thinking') {
      targetYaw = 0.055 + Math.sin(time * 0.65) * 0.012;
      targetPitch = -0.025;
    }
    gazeYaw = damp(gazeYaw, targetYaw, 5, dt);
    gazePitch = damp(gazePitch, targetPitch, 5, dt);
    speechBlend = damp(speechBlend, speaking ? 1 : 0, 12, dt);
    const channels = {};
    for (const name of EMOTIONS) {
      channels[`${name}Eyes`] = amounts[name] * FACE_PROFILES[name].eyes * (1 - blink);
      channels[`${name}Mouth`] = amounts[name] * FACE_PROFILES[name].mouth * (1 - speechBlend * 0.75);
    }
    lastFrame = {
      channels, blink: blink * 0.98, gazeYaw, gazePitch,
      headTilt: attention === 'listening' ? -0.018 : attention === 'thinking' ? 0.025 : 0,
      vowels: {
        aa: speechBlend * (0.06 + 0.22 * Math.max(0, Math.sin(time * 18))),
        ih: speechBlend * 0.10 * Math.max(0, Math.sin(time * 14 + 0.9)),
        ou: speechBlend * 0.08 * Math.max(0, Math.sin(time * 11 + 2)),
        oh: channels.surprisedMouth * (1 - speechBlend),
      },
    };
    return lastFrame;
  }

  return {
    setExpression, setAttention, update,
    setSpeaking(value) { speaking = Boolean(value); },
    reset() { setExpression('neutral'); setAttention('idle'); speaking = false; },
    getState() { return { expression, attention, speaking, blink: blink * 0.98, reactionAge: time - expressionStart, channels: { ...lastFrame?.channels } }; },
  };
}

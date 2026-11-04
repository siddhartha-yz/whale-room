// Activity curves use avatar-local metres/radians. Rendering, navigation and
// model decisions remain outside this deterministic, visible-time controller.
const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
const ease = (n) => { const t = clamp(n); return t * t * t * (10 + t * (-15 + 6 * t)); };
const mix = (a, b, t) => a + (b - a) * t;
const vector = (a, b, t) => a.map((value, i) => mix(value, b[i], t));
const interval = (time, start, end) => ease((time - start) / (end - start));

export const ACTIVITY_NAMES = Object.freeze(['read', 'drink', 'stretch', 'move_cup']);
export const ACTIVITY_TIMING = Object.freeze({ readEntry: 3, readExit: 1.1, drink: 8, stretch: 6, move_cup: 8 });

// A brief visual suggestion, not a measurement of reading comprehension.
// Once interrupted or completed, this page holds still until a new page/entry.
export function stepReadingGaze(state, rawDt, { enabled = false, phase, cancelling = false, lineCount = 0, pageKey = '', episodeKey = '' } = {}) {
  const key = `${episodeKey}:${pageKey}`;
  const previous = state?.key === key ? state : { key, elapsed: 0, started: false, complete: false, line: 0, fixation: .5 };
  const active = enabled && phase === 'reading' && !cancelling && lineCount > 0;
  if (!active) return { ...previous, active: false, scanning: false, complete: previous.complete || previous.started };
  const duration = Math.min(4.55, lineCount * 1.95);
  const dt = Number.isFinite(rawDt) ? clamp(rawDt, 0, .05) : 0;
  const elapsed = previous.started ? Math.min(duration, previous.elapsed + dt) : 0;
  const complete = previous.complete || elapsed >= duration;
  const index = Math.floor((complete ? duration - .001 : elapsed) / .65);
  return { key, active: true, scanning: !complete, started: true, complete, elapsed,
    line: Math.min(lineCount - 1, Math.floor(index / 3)), fixation: complete ? .5 : [0, .5, 1][index % 3] };
}

export function createActivityState(name, { durationSeconds = null, anchors = {} } = {}) {
  if (!ACTIVITY_NAMES.includes(name)) return null;
  const duration = name === 'read' && Number.isFinite(durationSeconds) ? clamp(durationSeconds, 8, 120) : Infinity;
  return {
    name, elapsed: 0, duration, cancelling: false, cancelElapsed: 0, cancelFrom: null,
    anchors: {
      restLeft: anchors.restLeft ?? [0.197, 0.318, -0.008],
      restRight: anchors.restRight ?? [-0.197, 0.318, -0.008],
      readLeft: anchors.readLeft ?? [0.135, 0.55, 0.17],
      readRight: anchors.readRight ?? [-0.135, 0.55, 0.17],
      book: anchors.book ?? [0, 0.55, 0.35],
      cupPickup: anchors.cupPickup ?? [-0.13, 0.54, 0.17],
      cupDestination: anchors.cupDestination ?? anchors.cupPickup ?? [-0.13, 0.54, 0.17],
      cupTransferNoop: anchors.cupTransferNoop ?? false,
      // Leave a small lip clearance for the head's breathing/gaze motion.
      cupSip: anchors.cupSip ?? [0, 0.550, 0.116],
      cupSupport: anchors.cupSupport ?? [0.08, 0.505, 0.17],
      cup: anchors.cup ?? [-0.13, 0.5525, 0.35],
    },
  };
}

function emptyFrame(state) {
  return {
    name: state.name, elapsed: state.elapsed, phase: 'preparing', done: false, started: false,
    cancelling: state.cancelling, leftWeight: 0, rightWeight: 0,
    leftWrist: [...state.anchors.restLeft], rightWrist: [...state.anchors.restRight],
    leftTilt: 0, rightTilt: 0, leftCurl: 0, rightCurl: 0,
    lookAt: null, pitchLimit: 0.2, spineLean: 0, chestLean: 0, stretch: 0,
    bookOpen: 0, pageFlip: 0, shouldHoldCup: false,
  };
}

function readFrame(state) {
  const frame = emptyFrame(state), { anchors: a, elapsed: t } = state;
  const reach = interval(t, 0.15, 1.55);
  const exitAt = ACTIVITY_TIMING.readEntry + state.duration;
  const leaving = t >= exitAt;
  const exit = leaving ? interval(t, exitAt, exitAt + ACTIVITY_TIMING.readExit) : 0;
  frame.phase = leaving ? 'closing-book' : t < 1.6 ? 'reaching-book' : t < 3 ? 'opening-book' : 'reading';
  frame.started = t >= ACTIVITY_TIMING.readEntry;
  frame.done = leaving && exit >= 1;
  frame.leftWeight = reach * (1 - exit);
  frame.rightWeight = reach * (1 - exit);
  frame.leftWrist = vector(a.restLeft, a.readLeft, reach);
  frame.rightWrist = vector(a.restRight, a.readRight, reach);
  frame.bookOpen = interval(t, 1.3, 2.7) * (1 - exit);
  frame.lookAt = a.book;
  frame.pitchLimit = 0.52;
  frame.spineLean = 0.025 * reach * (1 - exit);
  // One visible page turn after settling, then a quiet interval to actually read.
  if (t > 7 && !leaving && (state.pageTurnCycle === undefined || state.pageTurnCycle === Math.floor((t - 7) / 9))) {
    const age = (t - 7) % 9;
    if (age < 1.25) {
      frame.pageFlip = interval(age, 0, 1.25);
      const touch = Math.sin(Math.PI * interval(age, 0, 0.62));
      frame.rightWrist = [a.readRight[0] + 0.055 * touch, a.readRight[1] + 0.035 * touch, a.readRight[2] + 0.012 * touch];
      frame.phase = 'turning-page';
    }
  }
  return frame;
}

function drinkFrame(state) {
  const frame = emptyFrame(state), { anchors: a, elapsed: t } = state;
  const reach = interval(t, 0, 1.6), lift = interval(t, 2, 3.2), lower = interval(t, 5, 6.5);
  const sip = lift * (1 - lower), recover = interval(t, 7, 8);
  frame.phase = t < 1.6 ? 'reaching-cup' : t < 2 ? 'gripping-cup' : t < 3.2 ? 'lifting-cup'
    : t < 5 ? 'sipping' : t < 6.5 ? 'putting-cup-back' : t < 7 ? 'releasing-cup' : 'withdrawing-hands';
  frame.started = t >= 0.35;
  frame.done = t >= ACTIVITY_TIMING.drink;
  frame.rightWeight = reach * (1 - recover);
  frame.leftWeight = sip;
  frame.rightWrist = vector(vector(a.restRight, a.cupPickup, reach), a.cupSip, sip);
  frame.leftWrist = vector(a.restLeft, a.cupSupport, sip);
  frame.rightTilt = -0.2 * sip;
  frame.leftTilt = -0.6 * sip;
  frame.rightCurl = interval(t, 1.45, 1.9) * (1 - interval(t, 6.5, 6.95)) * 0.48;
  frame.leftCurl = 0.12 * sip;
  frame.shouldHoldCup = t >= 1.8 && t < 6.8;
  frame.lookAt = sip > 0.5 ? [0, 0.66, 1.2] : a.cup;
  frame.pitchLimit = 0.10;
  return frame;
}

function stretchFrame(state) {
  const frame = emptyFrame(state), t = state.elapsed;
  frame.phase = t < 1.4 ? 'opening-shoulders' : t < 3.7 ? 'stretching' : 'relaxing-shoulders';
  frame.stretch = interval(t, 0, 1.4) * (1 - interval(t, 3.7, 5.4));
  frame.chestLean = -0.06 * frame.stretch;
  frame.spineLean = -0.035 * frame.stretch;
  frame.started = t >= 0.4;
  frame.done = t >= ACTIVITY_TIMING.stretch;
  return frame;
}

function moveCupFrame(state) {
  const frame = emptyFrame(state), { anchors: a, elapsed: t } = state;
  if (a.cupTransferNoop) return { ...frame, phase: 'already-placed', started: true, done: true };
  const reach = interval(t, 0, 1.6), lift = interval(t, 2, 3), slide = interval(t, 3, 4.5);
  const lower = interval(t, 4.5, 5.5), withdraw = interval(t, 7, 8);
  frame.phase = t < 1.6 ? 'reaching-cup' : t < 2 ? 'gripping-cup' : t < 3 ? 'lifting-cup'
    : t < 4.5 ? 'moving-cup' : t < 5.5 ? 'lowering-cup' : t < 6.4 ? 'settling-cup' : 'withdrawing-hands';
  frame.started = t >= .35;frame.done = t >= ACTIVITY_TIMING.move_cup;
  frame.rightWeight = reach * (1 - withdraw);
  frame.rightWrist = vector(vector(a.restRight, a.cupPickup, reach), a.cupDestination, slide);
  frame.rightWrist[1] += .03 * lift * (1 - lower);
  // The wider transfer reach uses a looser grip than the existing sip pose.
  frame.rightCurl = interval(t, 1.45, 1.9) * (1 - interval(t, 6.1, 6.6)) * .32;
  frame.shouldHoldCup = t >= 1.8 && t < 6.4;
  frame.lookAt = a.cup;frame.pitchLimit = .10;
  return frame;
}

function cancelMoveCupFrame(state, frame) {
  const from = state.cancelFrom, a = state.anchors, t = state.cancelElapsed;
  const safeHeight = Math.max(from.rightWrist[1], a.cupPickup[1] + .03, a.cupDestination[1] + .03);
  const raised = [...from.rightWrist];raised[1] = safeHeight;
  const aboveSource = [...a.cupPickup];aboveSource[1] = safeHeight;
  frame.rightWrist = vector(from.rightWrist, raised, interval(t, 0, .45));
  frame.rightWrist = vector(frame.rightWrist, aboveSource, interval(t, .45, 1.3));
  frame.rightWrist = vector(frame.rightWrist, a.cupPickup, interval(t, 1.3, 1.8));
  frame.phase = t < .45 ? 'lifting-cup' : t < 1.3 ? 'returning-cup' : t < 2.05 ? 'settling-cup' : 'withdrawing-hands';
  frame.rightWeight = 1 - interval(t, 2.2, 2.8);
  frame.rightTilt = from.rightTilt * (1 - interval(t, 0, .45));
  frame.rightCurl = from.rightCurl * (1 - interval(t, 1.9, 2.25));
  frame.shouldHoldCup = t < 2.05;
  frame.lookAt = a.cup;frame.done = t >= 2.8;
  return frame;
}

export function sampleActivity(state) {
  if (!state) return null;
  if (!state.cancelling) return state.name === 'read' ? readFrame(state) : state.name === 'drink' ? drinkFrame(state) : state.name === 'move_cup' ? moveCupFrame(state) : stretchFrame(state);
  const from = state.cancelFrom, frame = { ...from, cancelling: true, elapsed: state.elapsed, started: from.started };
  const time = state.cancelElapsed;
  if (state.name === 'move_cup' && from.shouldHoldCup) return cancelMoveCupFrame(state, frame);
  if (from.shouldHoldCup) {
    const putBack = interval(time, 0, 1.0), withdraw = interval(time, 1.2, 1.8);
    frame.phase = time < 1.15 ? 'returning-cup' : 'withdrawing-hands';
    frame.rightWrist = vector(from.rightWrist, state.anchors.cupPickup, putBack);
    frame.rightTilt = mix(from.rightTilt, 0, putBack);
    frame.rightWeight = 1 - withdraw;
    frame.leftWrist = vector(from.leftWrist, state.anchors.restLeft, putBack);
    frame.leftWeight = from.leftWeight * (1 - putBack);
    frame.leftTilt = from.leftTilt * (1 - putBack);
    frame.rightCurl = from.rightCurl * (1 - interval(time, 1.0, 1.3));
    frame.leftCurl = from.leftCurl * (1 - putBack);
    frame.shouldHoldCup = time < 1.15;
    frame.lookAt = state.anchors.cup;
    frame.done = time >= 1.8;
  } else {
    const exit = interval(time, 0, state.name === 'read' ? 1.1 : 0.65);
    frame.phase = state.name === 'read' ? 'closing-book' : 'withdrawing-hands';
    frame.leftWeight = from.leftWeight * (1 - exit);
    frame.rightWeight = from.rightWeight * (1 - exit);
    frame.bookOpen = from.bookOpen * (1 - exit);
    frame.pageFlip = mix(from.pageFlip, from.pageFlip < 0.5 ? 0 : 1, interval(time, 0, 0.3));
    frame.stretch = from.stretch * (1 - exit);
    frame.spineLean = from.spineLean * (1 - exit);
    frame.chestLean = from.chestLean * (1 - exit);
    frame.leftCurl = from.leftCurl * (1 - exit);
    frame.rightCurl = from.rightCurl * (1 - exit);
    frame.shouldHoldCup = false;
    frame.done = exit >= 1;
  }
  return frame;
}

export function cancelActivityState(state, { holdingProp } = {}) {
  if (!state || state.cancelling) return state;
  const from = sampleActivity(state);
  if (typeof holdingProp === 'boolean') from.shouldHoldCup = holdingProp;
  return { ...state, cancelling: true, cancelElapsed: 0, cancelFrom: from };
}

export function stepActivity(state, rawDt, { pageTurnAllowed } = {}) {
  if (!state) return null;
  const dt = Number.isFinite(rawDt) ? clamp(rawDt, 0, 0.05) : 0;
  const elapsed = state.elapsed + dt;
  const next = { ...state, elapsed, cancelElapsed: state.cancelElapsed + (state.cancelling ? dt : 0) };
  if (state.name === 'read' && typeof pageTurnAllowed === 'boolean') {
    next.pageTurnCycle ??= -1;
    const cycle = Math.floor((elapsed - 7) / 9), start = 7 + cycle * 9;
    // Gaining eligibility part-way through a slot must not make the leaf jump.
    if (cycle >= 0 && state.elapsed < start) next.pageTurnCycle = pageTurnAllowed ? cycle : -1;
  }
  return next;
}

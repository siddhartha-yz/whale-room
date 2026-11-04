import { activityFeedback, activityWorld, sanitizeActivityJournal } from './activity-journal.js';

const INITIAL_WAIT_MS = 12_000;
const USER_QUIET_MS = 45_000;
const MIN_REQUEST_MS = 10_000;
const SPEECH_GAP_MS = 180_000;
const HOUR_MS = 3_600_000;
const HISTORY_MS = 7 * 24 * HOUR_MS;
const HOURLY_LIMIT = 24;
const clone = (value) => JSON.parse(JSON.stringify(value));

async function requestPlan(payload, { signal }) {
  const response = await fetch('/api/autonomy', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal,
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || '暂时没想好接下来做什么。');
    error.code = body.code; error.status = response.status; error.retryAt = body.retryAt;
    throw error;
  }
  return body;
}

function feedbackSince(before, after) {
  const a = Array.isArray(before) ? before : [];
  const b = Array.isArray(after) ? after : [];
  let shared = Math.min(a.length, b.length);
  while (shared && JSON.stringify(a.slice(-shared)) !== JSON.stringify(b.slice(0, shared))) shared--;
  return activityFeedback(b.slice(shared));
}

function isReadingActivity(activity, id = activity?.id) {
  return activity?.id === id && activity?.kind === 'read'
    && ['reading', 'turning-page'].includes(activity.phase) && !activity.cancelling;
}

function worldMatches(expected, actual = {}) {
  actual ||= {};
  if (expected.position && (!Number.isFinite(actual.position?.x) || !Number.isFinite(actual.position?.z) || Math.hypot(
    expected.position.x - actual.position.x, expected.position.z - actual.position.z,
  ) > 0.25)) return false;
  if (expected.posture && expected.posture !== actual.posture) return false;
  if (expected.gaze && expected.gaze !== actual.gaze) return false;
  // A continuous reading activity must actually still be reading. One-shot
  // stretches/drinks may finish before the following quiet dwell starts.
  if (isReadingActivity(expected.activity)) {
    if (!isReadingActivity(actual.activity, expected.activity.id)) return false;
  }
  return true;
}

function omitSatisfiedActions(actions, world, continuing) {
  return (Array.isArray(actions) ? actions : []).filter((action) => {
    if (action.type === 'sit' && world.posture === 'seated') return false;
    if (action.type === 'stand' && ['idle', 'standing'].includes(world.posture)) return false;
    if (action.type === 'look_at' && action.target === world.gaze) return false;
    if (action.type === 'read' && continuing && isReadingActivity(world.activity, continuing)) return false;
    if (action.type === 'move_to' && ['idle', 'standing'].includes(world.posture)) {
      const destination = world.availableTargets?.find((place) => place.id === action.target);
      if (destination && world.position && Math.hypot(destination.x - world.position.x, destination.z - world.position.z) <= 0.15) return false;
    }
    return true;
  });
}

/**
 * The model chooses activities; local observations determine their progress.
 * The room must cancel its autonomous action queue when notifying this
 * controller of user input, disabling it, or hiding the page.
 */
export function createAutonomyController({
  getSnapshot, onPlan, onStatus = () => {}, onError = () => {},
  fetchPlan = requestPlan, now = Date.now, initialEnabled = true, journal = null,
}) {
  let restored = null;
  try { restored = sanitizeActivityJournal(journal?.load(), now()); } catch { /* Optional persistence. */ }
  let enabled = initialEnabled, started = false, disposed = false, paused = false;
  let timer, generation = 0, active = null, idSequence = 0;
  let nextAt = now() + INITIAL_WAIT_MS;
  let lastUserAt = restored?.lastUserAt ?? now();
  let lastSpeechAt = restored?.speech.lastSpeechAt ?? -Infinity;
  let spokenSinceConversation = restored?.speech.unansweredProactive ?? false;
  const requests = restored?.requestTimes ?? [];
  let lastRequestAt = requests.at(-1) ?? -Infinity;
  let lastDecisionSpeechAllowed = null, lastDecisionAt = null;
  let serverBlockedUntil = restored?.serverBlockedUntil ?? 0;
  const recentActivities = restored?.recentActivities ?? [];
  let currentActivity = restored?.currentActivity ?? null;
  let activityFeedbackCursor = [];
  let activity = '', reason = '', status = enabled ? 'waiting' : 'off', lastPublished = '';
  let errorReported = false, lastObservedAt = now(), lastDwellEligible = false, lastSavedAt = -Infinity;

  function pruneRequests() {
    while (requests.length && requests[0] <= now() - HOUR_MS) requests.shift();
  }

  function persist(force = true) {
    for (let index = recentActivities.length - 1; index >= 0; index--) {
      if (recentActivities[index].endedAt < now() - HISTORY_MS) recentActivities.splice(index, 1);
    }
    if (!journal || (!force && now() - lastSavedAt < 10_000)) return;
    pruneRequests();
    try {
      journal.save({
        version: 1, currentActivity, recentActivities, requestTimes: requests, lastUserAt, serverBlockedUntil,
        speech: { lastSpeechAt: Number.isFinite(lastSpeechAt) ? lastSpeechAt : null, unansweredProactive: spokenSinceConversation },
      });
      lastSavedAt = now();
    } catch { /* An optional journal must never stop actions or chat. */ }
  }

  function getState() {
    pruneRequests();
    return {
      enabled, status, activity, reason,
      nextAt: enabled && !paused && !active ? nextAt : null,
      requestCount: requests.length,
      lastDecisionSpeechAllowed, lastDecisionAt,
      currentActivity: currentActivity ? clone(currentActivity) : null,
    };
  }

  function publish(nextStatus = status, nextReason = reason) {
    status = nextStatus; reason = nextReason;
    const state = getState();
    // Progress remains readable through getState(), without repainting the UI
    // each second while a long activity is quietly continuing.
    const serialized = JSON.stringify({ ...state, currentActivity: currentActivity ? { id: currentActivity.id, phase: currentActivity.phase } : null });
    if (serialized !== lastPublished) { lastPublished = serialized; onStatus(state); }
  }

  function finishActivity(endReason, forcedOutcome) {
    if (!currentActivity) return;
    if (currentActivity.phase !== 'executing' && endReason !== 'reload') {
      // Main records safe exits before notifyUser(). Retain that actual result
      // even though the model request/action queue has already finished.
      const observed = feedbackSince(activityFeedbackCursor, getSnapshot().feedback)
        .filter((entry) => !entry.source || entry.source === 'autonomy');
      currentActivity.feedback = [...currentActivity.feedback, ...observed].slice(-8);
    }
    recentActivities.push({
      id: currentActivity.id, activity: currentActivity.activity,
      outcome: forcedOutcome || (currentActivity.dwellComplete ? 'completed' : 'interrupted'),
      endReason, startedAt: currentActivity.startedAt, endedAt: now(), at: new Date(now()).toISOString(),
      elapsedVisibleSeconds: currentActivity.elapsedVisibleSeconds,
      feedback: activityFeedback(currentActivity.feedback),
    });
    if (recentActivities.length > 24) recentActivities.splice(0, recentActivities.length - 24);
    currentActivity = null; activityFeedbackCursor = []; lastDwellEligible = false;
    persist();
  }

  // Restore an intention as history, never as a restored body or offline work.
  if (currentActivity) finishActivity('reload', 'interrupted');
  nextAt = Math.max(nextAt, lastUserAt + (restored ? USER_QUIET_MS : 0), lastRequestAt + MIN_REQUEST_MS, serverBlockedUntil);

  function observe(snapshot = getSnapshot(), { closingInterval = false, checkWorld = true } = {}) {
    const time = now();
    if (!currentActivity || currentActivity.phase === 'executing') {
      lastObservedAt = time; lastDwellEligible = false; return;
    }
    const matches = worldMatches(currentActivity.world, snapshot.world);
    const eligible = enabled && !paused && snapshot.visible && snapshot.renderActive !== false && snapshot.ready && snapshot.idle
      && !snapshot.typing && !snapshot.chatBusy && matches;
    if (lastDwellEligible && snapshot.renderActive !== false && (eligible || closingInterval)) {
      const elapsed = Math.max(0, time - lastObservedAt) / 1000;
      currentActivity.elapsedVisibleSeconds += elapsed;
      currentActivity.segmentVisibleSeconds += elapsed;
    }
    lastObservedAt = time; lastDwellEligible = eligible;
    if (!currentActivity.dwellComplete && currentActivity.segmentVisibleSeconds >= currentActivity.dwellSeconds) {
      currentActivity.dwellComplete = true;
      currentActivity.phase = 'ready';
      persist();
    } else persist(false);
    if (checkWorld && snapshot.visible && snapshot.renderActive !== false && snapshot.ready && snapshot.idle && !snapshot.typing && !snapshot.chatBusy && !matches) {
      finishActivity('world_changed', 'interrupted');
      nextAt = Math.max(nextAt, time + USER_QUIET_MS);
      publish('waiting');
    }
  }

  function captureFeedback(run, result) {
    if (run.feedbackCaptured || !currentActivity || currentActivity.id !== run.activityId) return;
    run.feedbackCaptured = true;
    const added = Array.isArray(result?.feedback) ? activityFeedback(result.feedback)
      : feedbackSince(run.beforeFeedback, getSnapshot().feedback);
    currentActivity.feedback = [...currentActivity.feedback, ...added].slice(-8);
    activityFeedbackCursor = clone(getSnapshot().feedback || []);
  }

  function cancelRequest() {
    generation++;
    if (active) {
      active.controller.abort();
      if (active.phase === 'acting') captureFeedback(active);
      active = null;
    }
  }

  function canSpeak(snapshot = getSnapshot()) {
    return snapshot.canSpeak !== false && !spokenSinceConversation && now() - lastSpeechAt >= SPEECH_GAP_MS;
  }

  function context(snapshot, requestedChange = false) {
    return {
      history: snapshot.history || [], world: snapshot.world || {}, feedback: snapshot.feedback || [],
      ...(snapshot.memory ? { memory: snapshot.memory } : {}),
      autonomy: {
        requestedChange,
        currentActivity: currentActivity ? clone(currentActivity) : null,
        recentActivities: clone(recentActivities.slice(-8)),
        secondsSinceUser: Math.max(0, Math.floor((now() - lastUserAt) / 1000)),
        secondsSinceSpeech: Number.isFinite(lastSpeechAt) ? Math.max(0, Math.floor((now() - lastSpeechAt) / 1000)) : null,
        canSpeak: canSpeak(snapshot),
        localTime: new Date(now()).toLocaleString('zh-CN', { hour12: false }),
      },
    };
  }

  function blockedReason(snapshot) {
    if (disposed || !started) return '自主陪伴还没有启动。';
    if (!enabled) return '先开启自主陪伴。';
    if (paused || !snapshot.visible || snapshot.renderActive === false) return '回到房间后再继续。';
    if (!snapshot.ready) return '房间还在准备中。';
    if (snapshot.typing || snapshot.chatBusy) return '先听你把话说完。';
    if (active) return '正在完成刚才的安排。';
    if (!snapshot.idle) return '先完成当前动作。';
    if (now() < serverBlockedUntil) return '这一小时先慢慢待着，稍后再安排活动。';
    pruneRequests();
    if (requests.length >= HOURLY_LIMIT) return '这一小时先慢慢待着，稍后再安排活动。';
    if (now() - lastRequestAt < MIN_REQUEST_MS) return '稍等几秒，再想下一件事。';
    return '';
  }

  async function decide(snapshot, { requestedChange = false } = {}) {
    const token = generation, controller = new AbortController();
    const run = { controller, phase: 'thinking', beforeFeedback: snapshot.feedback || [], activityId: null, feedbackCaptured: false };
    active = run; lastRequestAt = now(); requests.push(lastRequestAt); persist();
    try {
      const payload = context(snapshot, requestedChange);
      lastDecisionSpeechAllowed = payload.autonomy.canSpeak;
      lastDecisionAt = now();
      publish('thinking', '正在想接下来做什么');
      const returned = await fetchPlan(payload, { signal: controller.signal });
      if (disposed || token !== generation || controller.signal.aborted) return;
      const latest = getSnapshot();
      if (!latest.visible || latest.renderActive === false) { pauseForHidden(); return; }
      if (latest.typing || latest.chatBusy) { notifyUser(); return; }
      if (!latest.ready || !latest.idle) {
        cancelRequest(); nextAt = now() + USER_QUIET_MS; publish('waiting'); return;
      }
      observe(latest);
      const continuing = returned.continuationOf ?? null;
      if (requestedChange && continuing !== null) throw new Error('这次没有换成新的活动，请稍后重试。');
      if (continuing !== null && continuing !== currentActivity?.id) throw new Error('活动已改变，稍后重新安排。');
      const continuedReading = continuing && isReadingActivity(currentActivity.world.activity);
      if (!continuing) {
        finishActivity('changed');
        activityFeedbackCursor = clone(latest.feedback || []);
        currentActivity = {
          id: globalThis.crypto?.randomUUID?.() || `${now()}-${++idSequence}-${Math.random().toString(36).slice(2, 9)}`,
          activity: returned.activity, phase: 'executing', startedAt: now(),
          elapsedVisibleSeconds: 0, segmentVisibleSeconds: 0, dwellSeconds: 120, dwellComplete: false,
          world: {}, feedback: [],
        };
      }
      currentActivity.phase = 'executing';
      currentActivity.segmentVisibleSeconds = 0;
      currentActivity.dwellSeconds = Math.max(60, Math.min(240, Number(returned.dwellSeconds) || 120));
      currentActivity.dwellComplete = false;
      const plan = {
        ...returned, continuationOf: continuing, activityId: currentActivity.id,
        reply: payload.autonomy.canSpeak && canSpeak(latest) ? returned.reply : '',
        actions: omitSatisfiedActions(returned.actions, latest.world || {}, continuing),
      };
      run.phase = 'acting'; run.activityId = currentActivity.id;
      activity = currentActivity.activity;
      if (plan.reply?.trim()) { lastSpeechAt = now(); spokenSinceConversation = true; }
      lastObservedAt = now(); lastDwellEligible = false;
      persist(); publish('acting', plan.reason || '');
      const result = await onPlan(plan);
      if (disposed || token !== generation || controller.signal.aborted) return;
      captureFeedback(run, result);
      active = null;
      nextAt = now() + currentActivity.dwellSeconds * 1000;
      if (result?.status === 'cancelled') finishActivity('execution_cancelled', 'interrupted');
      else if (result?.status === 'failed' || result === false || result?.ok === false) finishActivity('execution_failed', 'failed');
      else {
        currentActivity.world = activityWorld(getSnapshot().world);
        if (result?.activity) currentActivity.world.activity = activityWorld({ activity: result.activity }).activity;
        if (continuedReading && !isReadingActivity(currentActivity.world.activity, continuing)) {
          finishActivity('continuation_changed_body', 'interrupted');
        } else {
          currentActivity.phase = 'dwelling';
          lastObservedAt = now(); lastDwellEligible = false;
          observe();
        }
      }
      errorReported = false;
      persist(); publish('resting', plan.reason || '');
    } catch (error) {
      if (disposed || token !== generation || controller.signal.aborted || error.name === 'AbortError') return;
      if (run.phase === 'acting') { captureFeedback(run); finishActivity('execution_error', 'failed'); }
      active = null;
      if (error.code === 'AUTONOMY_LIMIT') {
        serverBlockedUntil = Math.max(now() + MIN_REQUEST_MS, Number.isFinite(error.retryAt) ? error.retryAt : now() + HOUR_MS);
        nextAt = serverBlockedUntil; publish('resting', '这一小时先慢慢待着，稍后再安排活动。');
      } else if (error.code === 'PREEMPTED' || error.status === 409) {
        nextAt = now() + USER_QUIET_MS; publish('waiting', '先听你说');
      } else if (error.code === 'BUSY' || error.status === 429) {
        nextAt = now() + 30_000; publish('waiting', '等当前对话结束后再安排');
      } else {
        nextAt = now() + 120_000; publish('error', error.message || '稍后再想下一件事');
        if (!errorReported) { errorReported = true; onError(error); }
      }
      persist();
    } finally {
      if (token === generation && active === run) active = null;
    }
  }

  function notifyUser({ conversation = false } = {}) {
    if (disposed) return;
    observe(getSnapshot(), { closingInterval: !paused, checkWorld: false });
    cancelRequest(); finishActivity('user', 'interrupted');
    lastUserAt = now();
    if (conversation) spokenSinceConversation = false;
    nextAt = now() + USER_QUIET_MS;
    persist(); publish(!enabled ? 'off' : paused ? 'paused' : 'waiting', '先听你说');
  }

  function noteSpeech() { if (disposed) return; lastSpeechAt = now(); persist(); }

  function pauseForHidden() {
    if (disposed || paused) return;
    observe(getSnapshot(), { closingInterval: true, checkWorld: false });
    paused = true;
    const wasExecuting = currentActivity?.phase === 'executing';
    cancelRequest();
    if (wasExecuting) finishActivity('hidden', 'interrupted');
    lastDwellEligible = false;
    persist(); publish(enabled ? 'paused' : 'off', '回到房间后继续');
  }

  function resumeVisible() {
    if (disposed || !paused) return;
    paused = false; lastObservedAt = now(); lastDwellEligible = false;
    observe();
    const remaining = currentActivity ? Math.max(0, currentActivity.dwellSeconds - currentActivity.segmentVisibleSeconds) * 1000 : 0;
    nextAt = Math.max(nextAt, now() + INITIAL_WAIT_MS, now() + remaining);
    persist(); publish(enabled ? currentActivity ? 'resting' : 'waiting' : 'off', reason);
  }

  async function tick() {
    if (disposed || !started || !enabled) return;
    const snapshot = getSnapshot();
    if (!snapshot.visible || snapshot.renderActive === false) { pauseForHidden(); return; }
    if (paused) resumeVisible();
    if (snapshot.typing || snapshot.chatBusy) {
      if (active || currentActivity) notifyUser();
      return;
    }
    observe(snapshot);
    const blocked = blockedReason(snapshot);
    if (blocked) {
      if (!active && now() < serverBlockedUntil) {
        nextAt = Math.max(nextAt, serverBlockedUntil); publish('resting', blocked);
      } else if (!active && requests.length >= HOURLY_LIMIT) {
        nextAt = Math.max(nextAt, requests[0] + HOUR_MS);
        publish('resting', blocked);
      }
      return;
    }
    if (currentActivity?.phase === 'dwelling' && !currentActivity.dwellComplete) {
      nextAt = Math.max(nextAt, now() + (currentActivity.dwellSeconds - currentActivity.segmentVisibleSeconds) * 1000);
      return;
    }
    if (now() < nextAt) return;
    await decide(snapshot);
  }

  function requestNow() {
    if (disposed) return { ok: false, reason: '自主陪伴还没有启动。' };
    const snapshot = getSnapshot();
    observe(snapshot);
    const blocked = blockedReason(snapshot);
    if (blocked) return { ok: false, reason: blocked };
    void decide(snapshot, { requestedChange: true });
    return { ok: true, reason: '' };
  }

  function adoptActivity({ id, activity: label, dwellSeconds = 120, feedback = [] } = {}) {
    if (disposed) return { ok: false, reason: '自主陪伴已结束。' };
    if (!enabled) return { ok: false, reason: '自主活动已关闭。' };
    const snapshot = getSnapshot();
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !isReadingActivity(snapshot.world?.activity, id)) {
      return { ok: false, reason: '当前没有这项持续阅读活动。' };
    }
    if (currentActivity?.id === id) {
      observe(snapshot, { checkWorld: false });
      return { ok: true, reason: '', activityId: id };
    }

    // A chat can start a real persistent activity before the idle scheduler
    // owns it. Adopt that observed body state without replaying its setup or
    // claiming any unobserved time before this handoff.
    observe(snapshot, { checkWorld: false });
    cancelRequest();
    finishActivity('adopted', 'interrupted');
    currentActivity = {
      id, activity: typeof label === 'string' && label.trim() ? label.slice(0, 60) : '看书',
      phase: 'dwelling', startedAt: now(), elapsedVisibleSeconds: 0, segmentVisibleSeconds: 0,
      dwellSeconds: Math.max(60, Math.min(240, Math.round(Number(dwellSeconds) || 120))), dwellComplete: false,
      world: activityWorld(snapshot.world), feedback: activityFeedback(feedback),
    };
    activity = currentActivity.activity;
    activityFeedbackCursor = clone(snapshot.feedback || []);
    lastObservedAt = now(); lastDwellEligible = false;
    if (!snapshot.visible || snapshot.renderActive === false) paused = true;
    observe(snapshot);
    pruneRequests();
    nextAt = Math.max(now() + currentActivity.dwellSeconds * 1000, lastUserAt + USER_QUIET_MS,
      lastRequestAt + MIN_REQUEST_MS, serverBlockedUntil, requests.length >= HOURLY_LIMIT ? requests[0] + HOUR_MS : 0);
    persist(); publish(paused ? 'paused' : 'resting', '');
    return { ok: true, reason: '', activityId: id };
  }

  function setEnabled(value) {
    if (disposed || enabled === Boolean(value)) return;
    observe(getSnapshot(), { closingInterval: !paused, checkWorld: false });
    enabled = Boolean(value); cancelRequest(); finishActivity('disabled', 'interrupted');
    if (enabled) nextAt = Math.max(now() + INITIAL_WAIT_MS, lastUserAt + USER_QUIET_MS);
    persist(); publish(enabled ? paused ? 'paused' : 'waiting' : 'off', enabled ? '' : '由你来安排活动');
  }

  function start() {
    if (started || disposed) return;
    started = true; nextAt = Math.max(nextAt, now() + INITIAL_WAIT_MS);
    timer = setInterval(() => { void tick(); }, 1000);
    timer.unref?.(); publish();
  }

  function clearMemory() {
    if (disposed) return;
    notifyUser({ conversation: true });
    recentActivities.length = 0; activity = '';
    persist(); publish();
  }

  function dispose() {
    if (disposed) return;
    observe(getSnapshot(), { closingInterval: !paused, checkWorld: false });
    cancelRequest(); persist();
    disposed = true; enabled = false;
    clearInterval(timer); publish('off', '');
  }

  return { start, dispose, tick, setEnabled, notifyUser, noteSpeech, requestNow, adoptActivity, pauseForHidden, resumeVisible, clearMemory, getState };
}

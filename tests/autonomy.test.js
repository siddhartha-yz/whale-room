import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutonomyController } from '../src/autonomy.js';
import { createActivityState, sampleActivity } from '../src/activity-rig.js';

const plan = {
  activity: '在窗边待一会儿',
  reason: '刚刚聊到午后的光线，想安静看看房间',
  reply: '',
  expression: 'relaxed',
  actions: [{ type: 'move_to', target: 'window' }],
  dwellSeconds: 90,
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, overrides = {}) {
  let clock = overrides.initialTime ?? Date.parse('2026-11-03T14:00:00Z');
  const snapshot = {
    ready: true, idle: true, visible: true, typing: false, chatBusy: false,
    history: [{ role: 'user', content: '我想安静待一会儿。' }],
    world: { location: '沙发上', posture: 'seated' }, feedback: [],
  };
  const calls = [], applied = [], statuses = [], errors = [];
  const controller = createAutonomyController({
    getSnapshot: () => snapshot,
    now: () => clock,
    fetchPlan: async (payload, options) => { calls.push({ payload, ...options }); return { ...plan }; },
    onPlan: async (value) => { applied.push(value); return { status: 'completed', feedback: [] }; },
    onStatus: (value) => statuses.push(value),
    onError: (error) => errors.push(error),
    ...overrides,
  });
  controller.start();
  t.after(() => controller.dispose());
  return {
    controller, snapshot, calls, applied, statuses, errors,
    advance(ms) { clock += ms; }, setTime(value) { clock = value; }, now: () => clock,
  };
}

test('first idle turn asks the model with real history/world and accepts a silent plan', async (t) => {
  const f = fixture(t);
  f.advance(11_999);
  await f.controller.tick();
  assert.equal(f.calls.length, 0);
  f.advance(1);
  await f.controller.tick();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].payload.history, f.snapshot.history);
  assert.deepEqual(f.calls[0].payload.world, f.snapshot.world);
  assert.equal('message' in f.calls[0].payload, false, 'no fabricated user message');
  assert.equal(f.calls[0].payload.autonomy.canSpeak, true);
  assert.equal(f.applied[0].reply, '');
  assert.equal(f.controller.getState().status, 'resting');
  assert.equal(f.controller.getState().nextAt, f.now() + 90_000);
  const published = f.statuses.length;
  await f.controller.tick();
  await f.controller.tick();
  assert.equal(f.statuses.length, published, 'unchanged waiting ticks must not repaint the UI');
});

test('loading, manual activity, typing, chat and hidden pages do not request decisions', async (t) => {
  const f = fixture(t);
  f.advance(12_000);
  for (const key of ['ready', 'idle', 'visible']) {
    f.snapshot[key] = false;
    await f.controller.tick();
    assert.equal(f.calls.length, 0, key);
    f.snapshot[key] = true;
  }
  await f.controller.tick(); // returning to the visible room waits another 12 seconds
  f.advance(12_000);
  for (const key of ['typing', 'chatBusy']) {
    f.snapshot[key] = true;
    await f.controller.tick();
    assert.equal(f.calls.length, 0, key);
    f.snapshot[key] = false;
  }
  await f.controller.tick();
  assert.equal(f.calls.length, 1);
});

test('model work and action execution cannot overlap; dwell starts after execution finishes', async (t) => {
  const response = deferred(), execution = deferred();
  let requests = 0, executions = 0;
  const f = fixture(t, {
    fetchPlan: async () => { requests++; return response.promise; },
    onPlan: async () => { executions++; return execution.promise; },
  });
  f.advance(12_000);
  const pending = f.controller.tick();
  f.advance(120_000);
  await f.controller.tick();
  assert.equal(requests, 1);
  response.resolve(plan);
  await flush();
  assert.equal(executions, 1);
  assert.equal(f.controller.getState().status, 'acting');
  f.advance(120_000);
  await f.controller.tick();
  assert.equal(requests, 1);
  execution.resolve({ status: 'completed', feedback: [{ action: 'move_to', status: 'completed', detail: '到了窗边' }] });
  await pending;
  assert.equal(f.controller.getState().nextAt, f.now() + 90_000);
  assert.equal(f.controller.getState().status, 'resting');
});

test('user interruption aborts a request, rejects a late response and waits 45 seconds', async (t) => {
  const late = deferred();
  let requests = 0, signal;
  const f = fixture(t, {
    fetchPlan: async (_payload, options) => {
      requests++;
      signal = options.signal;
      return requests === 1 ? late.promise : plan;
    },
  });
  f.advance(12_000);
  const pending = f.controller.tick();
  f.controller.notifyUser({ conversation: true });
  assert.equal(signal.aborted, true);
  late.resolve({ ...plan, reply: '这是一条过时的主动发言。' });
  await pending;
  assert.equal(f.applied.length, 0);
  f.advance(44_999);
  await f.controller.tick();
  assert.equal(requests, 1);
  f.advance(1);
  await f.controller.tick();
  assert.equal(requests, 2);
  assert.equal(f.applied.length, 1);
});

test('disabling or hiding the page rejects late decisions even when a provider ignores abort', async (t) => {
  for (const action of ['disable', 'hide']) {
    const response = deferred();
    const f = fixture(t, { fetchPlan: async () => response.promise });
    f.advance(12_000);
    const pending = f.controller.tick();
    if (action === 'disable') f.controller.setEnabled(false);
    else { f.snapshot.visible = false; f.controller.pauseForHidden(); }
    response.resolve(plan);
    await pending;
    assert.equal(f.applied.length, 0, action);
    assert.equal(f.controller.getState().status, action === 'disable' ? 'off' : 'paused');
  }
});

test('interrupted activity is recorded as interrupted with actual feedback, not completed', async (t) => {
  const execution = deferred();
  const payloads = [];
  let applied = 0;
  const f = fixture(t, {
    fetchPlan: async (payload) => { payloads.push(payload); return plan; },
    onPlan: async () => { applied++; if (applied === 1) return execution.promise; return { status: 'completed' }; },
  });
  f.advance(12_000);
  const pending = f.controller.tick();
  await flush();
  f.snapshot.feedback = [{ action: 'move_to', status: 'cancelled', detail: '用户打断了移动' }];
  f.controller.notifyUser();
  execution.resolve({ status: 'completed' }); // stale executor result must not change the memory
  await pending;
  f.advance(45_000);
  await f.controller.tick();
  const memories = payloads[1].autonomy.recentActivities;
  assert.equal(memories.length, 1);
  assert.equal(memories[0].outcome, 'interrupted');
  assert.equal(memories[0].feedback[0].status, 'cancelled');
});

test('one proactive remark per conversation and a three-minute speech gap prevent repeated nudges', async (t) => {
  const payloads = [];
  const f = fixture(t, { fetchPlan: async (payload) => { payloads.push(payload); return { ...plan, reply: '今天的光线很柔和。' }; } });
  f.advance(12_000);
  await f.controller.tick();
  assert.equal(payloads[0].autonomy.canSpeak, true);
  assert.notEqual(f.applied[0].reply, '');
  f.advance(200_000);
  await f.controller.tick();
  assert.equal(payloads[1].autonomy.canSpeak, false, 'silence is not a reply inviting another remark');
  assert.equal(f.applied[1].reply, '', 'client also enforces quiet even if provider ignores canSpeak');
  f.controller.notifyUser(); // clicking an action is not a new conversation
  f.advance(200_000);
  await f.controller.tick();
  assert.equal(payloads[2].autonomy.canSpeak, false);
  f.controller.notifyUser({ conversation: true });
  f.controller.noteSpeech(); // normal chat response is also speech
  f.advance(45_000);
  await f.controller.tick();
  assert.equal(payloads[3].autonomy.canSpeak, false);
  f.advance(135_000);
  await f.controller.tick();
  assert.equal(payloads[4].autonomy.canSpeak, true);
});

test('manual rethink bypasses dwell but respects ten-second spacing and the hourly request limit', async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.controller.requestNow(), { ok: true, reason: '' });
  await flush();
  assert.equal(f.controller.requestNow().ok, false);
  f.advance(10_000);
  assert.equal(f.controller.requestNow().ok, true);
  await flush();
  for (let index = 2; index < 24; index++) {
    f.advance(10_000);
    assert.equal(f.controller.requestNow().ok, true);
    await flush();
  }
  f.advance(10_000);
  assert.equal(f.calls.length, 24);
  assert.equal(f.controller.requestNow().ok, false);
  await f.controller.tick();
  const fullState = f.controller.getState();
  assert.equal(fullState.requestCount, 24);
  assert.equal(fullState.status, 'resting');
  f.controller.clearMemory();
  assert.equal(f.controller.getState().requestCount, 24, 'clearing chat must not reset model budget');
  f.setTime(fullState.nextAt);
  await f.controller.tick();
  assert.equal(f.calls.length, 25);
});

test('busy/preempted responses retry quietly and general failures do not spam repeated notifications', async (t) => {
  const errors = [
    Object.assign(new Error('busy'), { status: 429, code: 'BUSY' }),
    Object.assign(new Error('preempted'), { status: 409, code: 'PREEMPTED' }),
    new Error('network unavailable'), new Error('network unavailable'),
  ];
  const f = fixture(t, { fetchPlan: async () => { throw errors.shift(); } });
  f.advance(12_000);
  await f.controller.tick();
  assert.equal(f.controller.getState().nextAt, f.now() + 30_000);
  assert.equal(f.errors.length, 0);
  f.advance(30_000);
  await f.controller.tick();
  assert.equal(f.controller.getState().nextAt, f.now() + 45_000);
  assert.equal(f.errors.length, 0);
  f.advance(45_000);
  await f.controller.tick();
  f.advance(120_000);
  await f.controller.tick();
  assert.equal(f.errors.length, 1);
  assert.equal(f.controller.getState().status, 'error');
});

function memoryJournal() {
  let data = null;
  return {
    load: () => structuredClone(data),
    save: (value) => { data = structuredClone(value); },
    inspect: () => structuredClone(data),
  };
}

test('a quiet dwell is ongoing until observed time elapses, and user interruption records its actual duration', async (t) => {
  const journal = memoryJournal();
  const f = fixture(t, { journal, fetchPlan: async () => ({ ...plan, actions: [], dwellSeconds: 120 }) });
  f.advance(12_000); await f.controller.tick();
  assert.equal(journal.inspect().recentActivities.length, 0, 'empty action list is not a completed two-minute activity');
  assert.equal(f.controller.getState().currentActivity.phase, 'dwelling');
  f.advance(1_000); f.controller.notifyUser();
  const [entry] = journal.inspect().recentActivities;
  assert.equal(entry.outcome, 'interrupted');
  assert.equal(entry.endReason, 'user');
  assert.equal(entry.elapsedVisibleSeconds, 1);
  assert.deepEqual(entry.feedback, []);
  assert.equal(journal.inspect().currentActivity, null);
});

test('continuing reading keeps one activity and omits already satisfied setup actions', async (t) => {
  const journal = memoryJournal();
  let snapshot, count = 0;
  const applied = [];
  const f = fixture(t, {
    journal,
    fetchPlan: async (payload) => {
      count++;
      if (count === 3) return { ...plan, activity: '在原地休息', actions: [] };
      return {
        ...plan, activity: '坐着读书', continuationOf: payload.autonomy.currentActivity?.id ?? null,
        actions: [{ type: 'sit', target: 'sofa' }, { type: 'read', target: 'none' }, { type: 'look_at', target: 'user' }],
      };
    },
    onPlan: async (value) => {
      applied.push(value);
      snapshot.world.activity = { id: value.activityId, kind: 'read', phase: 'reading', heldObject: null };
      return { status: 'completed', feedback: value.actions.length ? [{ action: 'read', status: 'started', detail: '正在翻看书页' }] : [] };
    },
  });
  snapshot = f.snapshot; snapshot.world.gaze = 'user';
  f.advance(12_000); await f.controller.tick();
  const id = f.controller.getState().currentActivity.id;
  assert.deepEqual(applied[0].actions, [{ type: 'read', target: 'none' }]);
  f.advance(90_000); await f.controller.tick();
  assert.equal(applied[1].activityId, id);
  assert.equal(applied[1].continuationOf, id);
  assert.deepEqual(applied[1].actions, []);
  assert.equal(f.controller.getState().currentActivity.elapsedVisibleSeconds, 90);
  assert.equal(f.controller.getState().currentActivity.segmentVisibleSeconds, 0);
  assert.equal(journal.inspect().recentActivities.length, 0, 'a continuation is not another finished activity');
  f.advance(90_000); await f.controller.tick();
  const entries = journal.inspect().recentActivities;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, id);
  assert.equal(entries[0].outcome, 'completed');
  assert.equal(entries[0].elapsedVisibleSeconds, 180);
  assert.equal(entries[0].feedback.length, 1, 'setup did not happen a second time');
});

test('hidden time does not satisfy a dwell and returning resumes the remaining visible duration', async (t) => {
  const f = fixture(t);
  f.advance(12_000); await f.controller.tick();
  f.advance(30_000); await f.controller.tick();
  f.snapshot.visible = false; f.controller.pauseForHidden();
  f.advance(600_000); await f.controller.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.controller.getState().currentActivity.elapsedVisibleSeconds, 30);
  f.snapshot.visible = true; f.controller.resumeVisible();
  assert.equal(f.controller.getState().nextAt, f.now() + 60_000);
  f.advance(59_000); await f.controller.tick();
  assert.equal(f.calls.length, 1);
  f.advance(1_000); await f.controller.tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].payload.autonomy.currentActivity.elapsedVisibleSeconds, 90);
  assert.equal(f.calls[1].payload.autonomy.currentActivity.dwellComplete, true);
});

test('a reading pose lost while hidden is interrupted instead of claiming continued reading', async (t) => {
  let snapshot;
  const f = fixture(t, {
    onPlan: async (value) => {
      snapshot.world.activity = { id: value.activityId, kind: 'read', phase: 'reading', heldObject: null };
      return { status: 'completed', feedback: [], activity: snapshot.world.activity };
    },
  });
  snapshot = f.snapshot;
  f.advance(12_000); await f.controller.tick();
  f.advance(30_000); f.snapshot.visible = false; f.controller.pauseForHidden();
  f.advance(600_000); snapshot.world.activity = null;
  f.snapshot.visible = true; f.controller.resumeVisible();
  assert.equal(f.controller.getState().currentActivity, null);
  f.advance(45_000); await f.controller.tick();
  const [entry] = f.calls[1].payload.autonomy.recentActivities;
  assert.equal(entry.outcome, 'interrupted');
  assert.equal(entry.endReason, 'world_changed');
  assert.equal(entry.elapsedVisibleSeconds, 30);
});

test('refresh preserves intention as an interrupted log and preserves the unanswered speech gate', async (t) => {
  const journal = memoryJournal();
  const f = fixture(t, { journal, fetchPlan: async () => ({ ...plan, reply: '我先看看这本书。' }) });
  f.advance(12_000); await f.controller.tick();
  f.advance(30_000); await f.controller.tick();
  const id = f.controller.getState().currentActivity.id;
  f.controller.dispose();
  const reloaded = fixture(t, { journal, initialTime: f.now() + 600_000 });
  assert.equal(reloaded.controller.getState().currentActivity, null, 'no 3D pose is restored by the journal');
  reloaded.advance(12_000); await reloaded.controller.tick();
  const payload = reloaded.calls[0].payload;
  assert.equal(payload.autonomy.currentActivity, null);
  assert.equal(payload.autonomy.canSpeak, false, 'refresh is not a user response');
  const entry = payload.autonomy.recentActivities.find((item) => item.id === id);
  assert.equal(entry.outcome, 'interrupted');
  assert.equal(entry.endReason, 'reload');
  assert.equal(entry.elapsedVisibleSeconds, 30, 'offline minutes are not activity progress');
});

test('the hourly request budget survives refresh and clearing activity memory', async (t) => {
  const journal = memoryJournal();
  const f = fixture(t, { journal });
  const firstRequestAt = f.now();
  for (let index = 0; index < 24; index++) {
    assert.equal(f.controller.requestNow().ok, true);
    await flush(); f.advance(10_000);
  }
  f.controller.dispose();
  const reloaded = fixture(t, { journal, initialTime: f.now() });
  assert.equal(reloaded.controller.getState().requestCount, 24);
  assert.equal(reloaded.controller.requestNow().ok, false);
  reloaded.controller.clearMemory();
  assert.equal(reloaded.controller.requestNow().ok, false);
  reloaded.setTime(firstRequestAt + 3_600_000);
  assert.equal(reloaded.controller.requestNow().ok, true);
  await flush();
  assert.equal(reloaded.calls.length, 1);
});

test('explicit quiet preferences are a hard gate and user memory is passed without being rewritten', async (t) => {
  const response = deferred();
  const f = fixture(t, {
    fetchPlan: async (payload) => { f.calls.push({ payload }); return response.promise; },
  });
  f.snapshot.memory = { revision: 3, entries: [{ key: 'proactive', value: 'quiet', evidence: '别主动说话' }] };
  f.advance(12_000); const pending = f.controller.tick();
  f.snapshot.canSpeak = false; // A preference changed while the real request was in flight.
  response.resolve({ ...plan, reply: '不应该显示的发言。' }); await pending;
  assert.deepEqual(f.calls[0].payload.memory, f.snapshot.memory);
  assert.equal(f.applied[0].reply, '');
  f.advance(90_000); await f.controller.tick();
  assert.equal(f.calls[1].payload.autonomy.canSpeak, false);
});

test('unrelated continuation ids never execute and failed execution is not a completed activity', async (t) => {
  const journal = memoryJournal();
  let requests = 0;
  const f = fixture(t, {
    journal,
    fetchPlan: async () => ({ ...plan, continuationOf: ++requests === 1 ? 'stale-activity-id' : null }),
    onPlan: async () => ({ status: 'failed', feedback: [{ action: 'read', status: 'failed', detail: '没有成功进入阅读姿态' }] }),
  });
  f.advance(12_000); await f.controller.tick();
  assert.equal(f.controller.getState().currentActivity, null);
  assert.equal(journal.inspect().recentActivities.length, 0);
  assert.equal(f.errors.length, 1);
  f.advance(120_000); await f.controller.tick();
  const [entry] = journal.inspect().recentActivities;
  assert.equal(entry.outcome, 'failed');
  assert.equal(entry.elapsedVisibleSeconds, 0);
  assert.equal(entry.feedback[0].status, 'failed');
});

test('a continuation that actually ends reading cannot accumulate fictitious reading time', async (t) => {
  const journal = memoryJournal();
  let snapshot, executions = 0;
  const f = fixture(t, {
    journal,
    fetchPlan: async (payload) => ({ ...plan, activity: '读一会儿书', continuationOf: payload.autonomy.currentActivity?.id ?? null }),
    onPlan: async (value) => {
      snapshot.world.activity = ++executions === 1
        ? { id: value.activityId, kind: 'read', phase: 'reading', heldObject: null } : null;
      return { status: 'completed', feedback: [] };
    },
  });
  snapshot = f.snapshot;
  f.advance(12_000); await f.controller.tick();
  f.advance(90_000); await f.controller.tick();
  assert.equal(f.controller.getState().currentActivity, null);
  const [entry] = journal.inspect().recentActivities;
  assert.equal(entry.endReason, 'continuation_changed_body');
  assert.equal(entry.outcome, 'interrupted');
  assert.equal(entry.elapsedVisibleSeconds, 90);
});

test('refresh does not bypass the ten-second request spacing', async (t) => {
  const journal = memoryJournal();
  const f = fixture(t, { journal });
  assert.equal(f.controller.requestNow().ok, true); await flush();
  f.controller.dispose();
  const reloaded = fixture(t, { journal, initialTime: f.now() + 1_000 });
  assert.equal(reloaded.controller.requestNow().ok, false);
  reloaded.advance(9_000);
  assert.equal(reloaded.controller.requestNow().ok, true); await flush();
  assert.equal(reloaded.calls.length, 1);
});

test('real reading page-turn phases preserve dwell and do not repeat the read setup', async (t) => {
  const journal = memoryJournal();
  const rig = createActivityState('read');
  let snapshot, modelCalls = 0;
  const applied = [];
  const f = fixture(t, {
    journal,
    fetchPlan: async (payload) => {
      modelCalls++;
      return { ...plan, dwellSeconds: 67, activity: '读书', continuationOf: payload.autonomy.currentActivity?.id ?? null, actions: [{ type: 'read', target: 'none' }] };
    },
    onPlan: async (value) => {
      applied.push(value);
      snapshot.world.activity = {
        id: value.activityId, kind: 'read', phase: sampleActivity({ ...rig, elapsed: modelCalls === 1 ? 3 : 70 }).phase,
      };
      return { status: 'completed', feedback: [], activity: snapshot.world.activity };
    },
  });
  snapshot = f.snapshot;
  f.advance(12_000); await f.controller.tick();
  const id = f.controller.getState().currentActivity.id;
  const phases = new Set();
  for (let seconds = 1; seconds <= 67; seconds++) {
    snapshot.world.activity.phase = sampleActivity({ ...rig, elapsed: 3 + seconds }).phase;
    phases.add(snapshot.world.activity.phase);
    f.advance(1000); await f.controller.tick();
    assert.equal(f.controller.getState().currentActivity?.id, id);
  }
  assert.equal(phases.has('turning-page'), true);
  assert.equal(f.controller.getState().currentActivity.elapsedVisibleSeconds, 67);
  assert.equal(modelCalls, 2);
  assert.deepEqual(applied[1].actions, [], 'turning a page is still the same reading activity');
  assert.equal(f.controller.getState().currentActivity.id, id);
  assert.equal(journal.inspect().recentActivities.length, 0);
  snapshot.world.activity.phase = 'closing-book';
  f.advance(1000); await f.controller.tick();
  assert.equal(f.controller.getState().currentActivity, null);
  assert.equal(journal.inspect().recentActivities[0].endReason, 'world_changed');
});

test('interrupting a sustained activity includes its real cancellation feedback', async (t) => {
  const journal = memoryJournal();
  let snapshot;
  const f = fixture(t, {
    journal,
    onPlan: async () => {
      snapshot.feedback.push({ id: 1, action: 'read', status: 'completed', detail: '开始看书', source: 'autonomy' });
      return { status: 'completed', feedback: snapshot.feedback };
    },
  });
  snapshot = f.snapshot;
  f.advance(12_000); await f.controller.tick();
  f.advance(1000);
  snapshot.feedback.push({ id: 2, action: 'read', status: 'cancelled', detail: '用户打断，正在合书', source: 'autonomy' });
  f.controller.notifyUser();
  const [entry] = journal.inspect().recentActivities;
  assert.equal(entry.outcome, 'interrupted');
  assert.equal(entry.elapsedVisibleSeconds, 1);
  assert.deepEqual(entry.feedback.map(({ id, status }) => ({ id, status })), [
    { id: 1, status: 'completed' }, { id: 2, status: 'cancelled' },
  ]);
});

test('the change-activity button requests a new intention and rejects a disguised continuation without ending the real activity', async (t) => {
  const journal = memoryJournal();
  const payloads = [];
  let requests = 0;
  const f = fixture(t, {
    journal,
    fetchPlan: async (payload) => {
      payloads.push(payload); requests++;
      return {
        ...plan,
        activity: requests === 3 ? '换到窗边待一会儿' : plan.activity,
        continuationOf: requests === 2 ? payload.autonomy.currentActivity.id : null,
      };
    },
  });
  f.advance(12_000); await f.controller.tick();
  const id = f.controller.getState().currentActivity.id;
  assert.equal(payloads[0].autonomy.requestedChange, false);
  f.advance(10_000); assert.equal(f.controller.requestNow().ok, true); await flush();
  assert.equal(payloads[1].autonomy.requestedChange, true);
  assert.equal(f.applied.length, 1, 'a continued activity must not masquerade as the requested change');
  assert.equal(f.errors.length, 1);
  assert.equal(f.controller.getState().status, 'error');
  assert.equal(f.controller.getState().currentActivity.id, id, 'the body keeps its real activity while awaiting a valid replacement');
  assert.equal(journal.inspect().recentActivities.length, 0);
  assert.equal(f.controller.requestNow().ok, false, 'the minimum request spacing still applies');
  f.advance(10_000); assert.equal(f.controller.requestNow().ok, true); await flush();
  assert.equal(payloads[2].autonomy.requestedChange, true);
  assert.equal(f.applied.length, 2);
  assert.notEqual(f.controller.getState().currentActivity.id, id);
  assert.equal(f.controller.getState().requestCount, 3);
  assert.equal(journal.inspect().recentActivities[0].endReason, 'changed');
});

test('a rejected change keeps counting the real dwell and the later automatic retry can continue it', async (t) => {
  const payloads = [];
  let calls = 0, snapshot;
  const f = fixture(t, {
    fetchPlan: async (payload) => {
      payloads.push(payload);
      if (++calls === 2) throw Object.assign(new Error('change was rejected'), { code: 'INVALID_MODEL_OUTPUT' });
      return { ...plan, continuationOf: payload.autonomy.currentActivity?.id ?? null, actions: [{ type: 'read', target: 'none' }] };
    },
    onPlan: async (value) => {
      snapshot.world.activity = { id: value.activityId, kind: 'read', phase: 'reading', heldObject: null };
      return { status: 'completed', feedback: [], activity: snapshot.world.activity };
    },
  });
  snapshot = f.snapshot;
  f.advance(12_000); await f.controller.tick();
  const id = f.controller.getState().currentActivity.id;
  f.advance(10_000); f.controller.requestNow(); await flush();
  f.advance(30_000); await f.controller.tick();
  assert.equal(calls, 2);
  assert.equal(f.controller.getState().currentActivity.id, id);
  assert.equal(f.controller.getState().currentActivity.elapsedVisibleSeconds, 40);
  f.advance(90_000); await f.controller.tick();
  assert.equal(calls, 3);
  assert.equal(payloads[2].autonomy.requestedChange, false);
  assert.equal(payloads[2].autonomy.currentActivity.elapsedVisibleSeconds, 130);
  assert.equal(payloads[2].autonomy.currentActivity.dwellComplete, true);
  assert.equal(f.controller.getState().currentActivity.id, id);
  assert.equal(f.controller.getState().currentActivity.elapsedVisibleSeconds, 130);
  assert.equal(f.controller.getState().currentActivity.segmentVisibleSeconds, 0);
});

test('every disposed public mutation is inert after another page can own the journal', async (t) => {
  const underlying = memoryJournal();
  let writes = 0;
  const journal = { load: underlying.load, save: (value) => { writes++; underlying.save(value); } };
  const f = fixture(t, { journal });
  f.advance(12_000); await f.controller.tick();
  f.advance(1000); f.controller.dispose();
  const saved = underlying.inspect(), writesAtHandoff = writes;
  f.advance(180_000);
  f.snapshot.world.posture = 'walking';
  f.snapshot.feedback.push({ action: 'read', status: 'cancelled', detail: 'another page changed the room' });
  f.controller.noteSpeech();
  assert.equal(f.controller.adoptActivity({ id: 'old-chat', activity: '看书' }).ok, false);
  f.controller.notifyUser({ conversation: true });
  assert.equal(f.controller.requestNow().ok, false);
  f.controller.clearMemory();
  f.controller.pauseForHidden();
  f.controller.resumeVisible();
  f.controller.setEnabled(true);
  f.controller.start();
  await f.controller.tick();
  f.controller.dispose();
  assert.equal(writes, writesAtHandoff, 'a late chat callback or UI event must not overwrite the new owner');
  assert.deepEqual(underlying.inspect(), saved);
  assert.equal(f.calls.length, 1);
});

test('the shared server budget blocks manual and automatic retries until retryAt, including after refresh', async (t) => {
  const journal = memoryJournal();
  let attempts = 0, retryAt;
  const f = fixture(t, {
    journal,
    fetchPlan: async () => {
      attempts++; retryAt = f.now() + 180_000;
      throw Object.assign(new Error('shared hourly budget'), { status: 429, code: 'AUTONOMY_LIMIT', retryAt });
    },
  });
  f.advance(12_000); await f.controller.tick();
  assert.equal(f.controller.getState().nextAt, retryAt);
  assert.equal(f.errors.length, 0);
  f.advance(30_000); await f.controller.tick();
  assert.equal(f.controller.requestNow().ok, false);
  assert.equal(attempts, 1, 'shared budget errors must not fall into the 30-second busy retry');
  f.controller.clearMemory();
  assert.equal(f.controller.requestNow().ok, false);
  f.controller.dispose();
  const reloaded = fixture(t, { journal, initialTime: f.now() });
  assert.equal(reloaded.controller.requestNow().ok, false);
  reloaded.setTime(retryAt - 1); await reloaded.controller.tick();
  assert.equal(reloaded.calls.length, 0);
  reloaded.advance(1); await reloaded.controller.tick();
  assert.equal(reloaded.calls.length, 1);
});

test('a real chat-started reading can be adopted without a model call, replay, premature completion or reset on repeated adoption', async (t) => {
  const journal = memoryJournal();
  const f = fixture(t, {
    journal,
    fetchPlan: async (payload) => {
      f.calls.push({ payload });
      return { ...plan, activity: '继续阅读', continuationOf: payload.autonomy.currentActivity.id, actions: [] };
    },
  });
  f.controller.notifyUser({ conversation: true });
  f.controller.noteSpeech();
  f.snapshot.world.activity = { id: 'chat-read-1', kind: 'read', phase: 'reading', cancelling: false };
  const actualFeedback = [{ id: 1, action: 'read', status: 'completed', detail: '打开书，开始阅读', source: 'chat' }];
  f.snapshot.feedback = actualFeedback;
  const adopted = f.controller.adoptActivity({ id: 'chat-read-1', activity: '看书', dwellSeconds: 60, feedback: actualFeedback });
  assert.deepEqual(adopted, { ok: true, reason: '', activityId: 'chat-read-1' });
  assert.equal(f.controller.getState().requestCount, 0);
  assert.equal(f.calls.length, 0); assert.equal(f.applied.length, 0);
  assert.equal(journal.inspect().recentActivities.length, 0);
  assert.equal(f.controller.getState().currentActivity.dwellComplete, false);
  assert.equal(f.controller.getState().currentActivity.feedback[0].source, 'chat');
  const deadline = f.controller.getState().nextAt;
  f.advance(30_000); await f.controller.tick();
  f.snapshot.world.activity.phase = 'turning-page';
  assert.equal(f.controller.adoptActivity({ id: 'chat-read-1', activity: '不应替换旧标签', dwellSeconds: 240 }).ok, true);
  assert.equal(f.controller.getState().currentActivity.elapsedVisibleSeconds, 30);
  assert.equal(f.controller.getState().currentActivity.dwellSeconds, 60);
  assert.equal(f.controller.getState().currentActivity.activity, '看书');
  assert.equal(f.controller.getState().nextAt, deadline);
  f.advance(30_000); await f.controller.tick();
  assert.equal(f.calls.length, 1, 'the first model call happens only after the observed dwell');
  assert.equal(f.calls[0].payload.autonomy.currentActivity.id, 'chat-read-1');
  assert.equal(f.calls[0].payload.autonomy.currentActivity.elapsedVisibleSeconds, 60);
  assert.equal(f.calls[0].payload.autonomy.currentActivity.dwellComplete, true);
  assert.equal(f.calls[0].payload.autonomy.canSpeak, false, 'adopting reading must not clear the recent chat speech gate');
  assert.equal(f.controller.getState().currentActivity.id, 'chat-read-1');
});

test('adoption requires enabled control and an exact live reading identity, with no journal mutation on rejection', (t) => {
  const journal = memoryJournal();
  const f = fixture(t, { journal, initialEnabled: false });
  f.snapshot.world.activity = { id: 'chat-read', kind: 'read', phase: 'reading' };
  assert.equal(f.controller.adoptActivity({ id: 'chat-read', activity: '看书' }).ok, false);
  assert.equal(f.controller.getState().currentActivity, null);
  f.controller.setEnabled(true);
  const before = journal.inspect();
  for (const actual of [null,
    { id: 'other', kind: 'read', phase: 'reading' },
    { id: 'chat-read', kind: 'drink', phase: 'reading' },
    { id: 'chat-read', kind: 'read', phase: 'opening-book' },
    { id: 'chat-read', kind: 'read', phase: 'reading', cancelling: true },
  ]) {
    f.snapshot.world.activity = actual;
    assert.equal(f.controller.adoptActivity({ id: 'chat-read' }).ok, false);
    assert.deepEqual(journal.inspect(), before);
  }
  f.snapshot.world.activity = { id: 'chat-read', kind: 'read', phase: 'turning-page', cancelling: false };
  assert.equal(f.controller.adoptActivity({ id: 'chat-read' }).ok, true);
  assert.equal(f.controller.getState().currentActivity.phase, 'dwelling');
  f.controller.dispose();
  const disposed = journal.inspect();
  assert.equal(f.controller.adoptActivity({ id: 'chat-read' }).ok, false);
  assert.deepEqual(journal.inspect(), disposed);
});

test('adopting actual chat activity cancels a stale model request and discards its eventual result', async (t) => {
  const response = deferred();
  let signal;
  const f = fixture(t, { fetchPlan: async (_payload, options) => { signal = options.signal; return response.promise; } });
  f.advance(12_000); const pending = f.controller.tick();
  f.snapshot.world.activity = { id: 'chat-read', kind: 'read', phase: 'reading' };
  assert.equal(f.controller.adoptActivity({ id: 'chat-read', activity: '看书', dwellSeconds: 60 }).ok, true);
  assert.equal(signal.aborted, true);
  response.resolve({ ...plan, reply: '旧的自主安排' }); await pending;
  assert.equal(f.applied.length, 0);
  assert.equal(f.controller.getState().currentActivity.id, 'chat-read');
  assert.equal(f.controller.getState().requestCount, 1, 'adoption does not spend an additional model request');
});

test('adoption while hidden does not count offline time, and a shared server budget still gates the next decision', async (t) => {
  const journal = memoryJournal();
  let requests = 0, retryAt;
  const f = fixture(t, {
    journal,
    fetchPlan: async () => {
      requests++; retryAt = f.now() + 3_600_000;
      throw Object.assign(new Error('hourly budget'), { code: 'AUTONOMY_LIMIT', status: 429, retryAt });
    },
  });
  f.advance(12_000); await f.controller.tick();
  f.snapshot.visible = false;
  f.snapshot.world.activity = { id: 'chat-read', kind: 'read', phase: 'reading' };
  assert.equal(f.controller.adoptActivity({ id: 'chat-read', dwellSeconds: 60 }).ok, true);
  assert.equal(f.controller.getState().status, 'paused');
  f.advance(600_000); await f.controller.tick();
  f.snapshot.visible = true; f.controller.resumeVisible();
  assert.equal(f.controller.getState().currentActivity.elapsedVisibleSeconds, 0);
  f.advance(60_000); await f.controller.tick();
  assert.equal(f.controller.getState().currentActivity.elapsedVisibleSeconds, 60);
  assert.equal(f.controller.getState().currentActivity.dwellComplete, true);
  assert.equal(f.controller.getState().nextAt, retryAt);
  assert.equal(f.controller.requestNow().ok, false);
  assert.equal(requests, 1);
});

test('adopted ids and dwell seconds always satisfy the backend activity schema', (t) => {
  const f = fixture(t);
  for (const id of ['chat/read', 'x'.repeat(101)]) {
    f.snapshot.world.activity = { id, kind: 'read', phase: 'reading' };
    assert.equal(f.controller.adoptActivity({ id }).ok, false);
  }
  for (const [id, supplied, expected] of [['chat_read-1', 120.5, 121], ['chat_read-2', 3.7, 60], ['chat_read-3', 999.2, 240]]) {
    f.snapshot.world.activity = { id, kind: 'read', phase: 'reading' };
    assert.equal(f.controller.adoptActivity({ id, dwellSeconds: supplied }).ok, true);
    assert.equal(f.controller.getState().currentActivity.dwellSeconds, expected);
  }
});

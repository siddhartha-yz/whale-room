import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutonomyController } from '../src/autonomy.js';
import { createActivityJournal } from '../src/activity-journal.js';
import { createBookObservation, ROOM_BOOK } from '../src/book-observation.js';
import { createActivityState, stepActivity, sampleActivity } from '../src/activity-rig.js';

const future = { activity: '伸展肩背，再休息一会儿', reason: '换一下姿势',
  actions: [{ type: 'stretch', target: 'none' }], dwellSeconds: 60, after: 'dwell' };
const parent = { activity: '在窗边安静待一会儿', reason: '先在这里待一会儿', reply: '', expression: 'neutral',
  actions: [{ type: 'move_to', target: 'window' }], dwellSeconds: 60, continuationOf: null, nextIntent: future };
const copy = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture(t, { response = parent, fetchPlan, execute, allowNextIntent = true, requestTimes = [] } = {}) {
  let time = 1_800_000_000_000;
  const calls = [], applied = [], errors = [], values = new Map();
  const snapshot = { ready: true, idle: true, visible: true, renderActive: true, typing: false, chatBusy: false,
    canSpeak: false, memory: { revision: 'initial', entries: [] }, history: [], feedback: [],
    world: { position: { x: 0, z: 0 }, posture: 'standing', gaze: 'user', activity: null,
      availableTargets: [{ id: 'window', x: -2, z: 0 }], availableActivities: ['read', 'drink', 'stretch'] },
  };
  const journal = createActivityJournal({ now: () => time,
    storage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) } });
  if (requestTimes.length) journal.save({ version: 1, lastUserAt: time - 60_000, requestTimes: requestTimes.map(offset => time + offset) });
  const f = { snapshot, calls, applied, errors, journal, values, now: () => time,
    advance(ms) { time += ms; },
    async tick(ms = 0) { time += ms;await controller.tick(); },
    async start() { await this.tick(12_000); },
    finish(plan) {
      for (const action of plan.actions) {
        if (action.type === 'move_to') snapshot.world.position = { x: -2, z: 0 };
        if (action.type === 'sit') snapshot.world.posture = 'seated';
        if (action.type === 'look_at') snapshot.world.gaze = action.target;
        if (action.type === 'stretch') snapshot.world.activity = null;
      }
      const feedback = plan.actions.map(action => ({ id: snapshot.feedback.length + 1, action: action.type,
        status: 'completed', detail: '实际动作完成', source: 'autonomy' }));
      snapshot.feedback.push(...feedback);
      return { status: 'completed', feedback, activity: snapshot.world.activity };
    },
  };
  const controller = createAutonomyController({ now: () => time, getSnapshot: () => snapshot, journal, allowNextIntent,
    fetchPlan: async payload => {
      calls.push(copy(payload));
      return fetchPlan ? fetchPlan(payload, f) : copy(calls.length === 1 ? response : { ...parent, nextIntent: null });
    },
    onPlan: async plan => { applied.push(copy(plan));return execute ? execute(plan, f) : f.finish(plan); },
    onError: error => errors.push(error),
  });
  f.controller = controller;controller.start();t.after(() => controller.dispose());
  return f;
}

test('one model request schedules one real follow-up only after the observed dwell; future text never enters history or storage', async t => {
  const f = fixture(t);await f.start();
  const before = f.controller.getState(), id = before.currentActivity.id;
  assert.equal(f.calls[0].autonomy.allowNextIntent, true);
  assert.equal(before.nextIntent.parentActivityId, id);
  assert.equal(before.activity, parent.activity);
  assert.equal(JSON.stringify(before).includes(future.activity), false);
  assert.equal([...f.values.values()].join('').includes(future.activity), false);
  assert.equal(Object.hasOwn(f.applied[0], 'nextIntent'), false);
  await f.tick(59_000);
  assert.equal(f.applied.length, 1);
  f.advance(1000);await Promise.all([f.controller.tick(), f.controller.tick(), f.controller.tick()]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.applied.length, 2);
  const next = f.applied[1], after = f.controller.getState();
  assert.equal(next.executionSource, 'planned-next');
  assert.equal(next.parentActivityId, id);
  assert.notEqual(next.activityId, id);
  assert.equal(next.reply, '');
  assert.equal(next.expression, 'neutral');
  assert.equal(after.nextIntent, null);
  assert.equal(after.lastIntentEvent.event, 'started');
  assert.equal(after.lastDecisionAt, before.lastDecisionAt);
  assert.equal(after.requestCount, 1);
  assert.equal(f.journal.load().recentActivities[0].outcome, 'completed');
  assert.deepEqual(f.journal.load().recentActivities[0].feedback.map(item => item.action), ['move_to']);
  await f.tick(60_000);
  assert.equal(f.calls.length, 2, 'the follow-up cannot manufacture a third local step');
});

test('the parent must actually finish; failed, cancelled, or late work cannot arm a future', async t => {
  const completion = deferred();
  const f = fixture(t, { execute: async (plan, state) => {
    if (state.applied.length === 1) { await completion.promise; }
    return state.finish(plan);
  } });
  f.advance(12_000);const pending = f.controller.tick();await flush();
  await f.tick(60_000);
  assert.equal(f.controller.getState().nextIntent, null);
  assert.equal(f.applied.length, 1);
  completion.resolve();await pending;
  assert.ok(f.controller.getState().nextIntent);
  await f.tick(59_000);assert.equal(f.applied.length, 1);
  await f.tick(1000);assert.equal(f.applied.length, 2);

  for (const status of ['failed', 'cancelled']) {
    const failed = fixture(t, { execute: async () => ({ status, feedback: [] }) });
    await failed.start();assert.equal(failed.controller.getState().nextIntent, null);
    assert.equal(failed.controller.getState().currentActivity, null);
  }
});

test('user input, hidden or throttled rendering, memory revision and new observations discard pending work', async t => {
  const changes = [
    ['user', f => f.controller.notifyUser()],
    ['clear', f => f.controller.clearMemory()],
    ['off', f => f.controller.setEnabled(false)],
    ['hidden', f => { f.snapshot.visible = false; }],
    ['render-inactive', f => { f.snapshot.renderActive = false; }],
    ['dispose', f => f.controller.dispose()],
    ['memory', f => { f.snapshot.memory.revision = 'changed'; }],
    ['feedback', f => { f.snapshot.feedback.push({ id: 90, action: 'wave', status: 'completed' }); }],
    ['body', f => { f.snapshot.world.position.x += 1; }],
    ['conversation', f => { f.snapshot.history.push({ role: 'user', content: '新消息' }); }],
    ['typing', f => { f.snapshot.typing = true; }],
    ['chat', f => { f.snapshot.chatBusy = true; }],
  ];
  for (const [label, change] of changes) {
    const f = fixture(t);await f.start();assert.ok(f.controller.getState().nextIntent, label);
    change(f);await f.tick(1000);
    assert.equal(f.controller.getState().nextIntent, null, label);
    await f.tick(600_000);
    assert.equal(f.applied.some(plan => plan.executionSource === 'planned-next'), false, label);
  }
});

test('a change request rejected by cooldown still discards the old intention, and owner reload never restores it', async t => {
  const f = fixture(t);await f.start();
  assert.equal(f.controller.requestNow().ok, false);
  assert.equal(f.controller.getState().nextIntent, null);
  assert.equal(f.controller.getState().lastIntentEvent.reason, 'requested_change');
  await f.tick(60_000);
  assert.equal(f.applied.some(plan => plan.executionSource === 'planned-next'), false);

  const owned = fixture(t);await owned.start();owned.controller.dispose();
  const next = createAutonomyController({ now: owned.now, journal: owned.journal,
    getSnapshot: () => owned.snapshot, onPlan: async () => { throw Error('No restored future may execute'); } });
  assert.equal(next.getState().nextIntent, null);
  assert.equal(owned.journal.load().recentActivities.at(-1).endReason, 'reload');
  next.dispose();
});

test('memory is bound at request start, including changes during inference and during parent execution', async t => {
  const response = deferred();
  const f = fixture(t, { fetchPlan: async () => response.promise });
  f.advance(12_000);const thinking = f.controller.tick();
  f.snapshot.memory.revision = 'new-preference';response.resolve(parent);await thinking;
  assert.equal(f.applied.length, 0, 'an old response cannot adopt the new revision after returning');
  assert.equal(f.controller.getState().nextIntent, null);
  const completion = deferred();
  const acting = fixture(t, { execute: async (plan, state) => { await completion.promise;return state.finish(plan); } });
  acting.advance(12_000);const running = acting.controller.tick();await flush();
  acting.snapshot.memory.revision = 'edited-during-action';completion.resolve();await running;
  assert.equal(acting.controller.getState().nextIntent, null);
});

test('speech eligibility gets a fresh model decision, while an unanswered remark still forbids more speech', async t => {
  const f = fixture(t);await f.start();f.snapshot.canSpeak = true;
  await f.tick(60_000);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].autonomy.canSpeak, true);
  assert.equal(f.applied.some(plan => plan.executionSource === 'planned-next'), false);
  assert.equal(f.controller.getState().lastIntentEvent.reason, 'speech_opportunity');

  const spoken = fixture(t, { response: { ...parent, reply: '我先在这儿待会儿。' } });
  spoken.snapshot.canSpeak = true;await spoken.start();
  await spoken.tick(60_000);
  assert.equal(spoken.applied[1].executionSource, 'planned-next');
  assert.equal(spoken.applied[1].reply, '');
  await spoken.tick(120_000);
  assert.equal(spoken.calls.at(-1).autonomy.canSpeak, false);
  assert.equal(spoken.applied.filter(plan => plan.reply).length, 1);
});

test('the follow-up obeys the hourly gate and wall-time expiry without inventing requests', async t => {
  const f = fixture(t, { requestTimes: Array.from({ length: 23 }, (_, i) => -500_000 + i * 10_000) });
  await f.start();assert.equal(f.controller.getState().requestCount, 24);
  await f.tick(60_000);assert.equal(f.applied.length, 1);
  await f.tick(31_000);assert.equal(f.controller.getState().nextIntent, null);
  assert.equal(f.calls.length, 1);
  const expired = fixture(t);await expired.start();await expired.tick(91_000);
  assert.equal(expired.applied.some(plan => plan.executionSource === 'planned-next'), false);
  assert.equal(expired.controller.getState().lastIntentEvent.reason, 'expired');
});

test('a running follow-up can be interrupted; its late successful promise does not revive plans or completed history', async t => {
  const completion = deferred();
  const f = fixture(t, { execute: async (plan, state) => {
    if (plan.executionSource === 'planned-next') return completion.promise;
    return state.finish(plan);
  } });
  await f.start();f.advance(60_000);const running = f.controller.tick();await flush();
  await f.controller.tick();assert.equal(f.applied.length, 2);
  f.snapshot.feedback.push({ id: 2, action: 'stretch', status: 'cancelled', source: 'autonomy', detail: '用户打断' });
  f.controller.notifyUser({ conversation: true });
  completion.resolve({ status: 'completed', feedback: [] });await running;
  assert.equal(f.controller.getState().currentActivity, null);
  assert.equal(f.controller.getState().nextIntent, null);
  assert.equal(f.journal.load().recentActivities.at(-1).outcome, 'interrupted');
  assert.equal(f.journal.load().recentActivities.at(-1).feedback.at(-1).status, 'cancelled');
});

function readingFixture(t, { after = 'book_complete', alreadyRead = false } = {}) {
  const observation = createBookObservation();
  let physical = null, parentId;
  const update = (f, { realFrame = true, lookingAtBook = true } = {}) => {
    const view = observation.getState();
    physical = stepActivity(physical, 1 / 60, { pageTurnAllowed:
      view.pageIndex < ROOM_BOOK.pages.length - 1 && view.readPageIds.includes(view.pageId) });
    const frame = sampleActivity(physical);
    observation.observe({ ...frame, activityId: 17, deltaSeconds: 1 / 60, realFrame, renderActive: realFrame, lookingAtBook });
    f.snapshot.world.reading = observation.getContext();
    f.snapshot.world.activity = { id: parentId, kind: 'read', phase: frame.phase, cancelling: false, heldObject: null };
  };
  const f = fixture(t, { response: { ...parent, actions: [{ type: 'read', target: 'none' }], nextIntent: { ...future, after } },
    execute: async (plan, state) => {
      if (plan.actions.some(action => action.type === 'read')) {
        physical = createActivityState('read');parentId = plan.activityId;
        state.snapshot.world.gaze = 'book';
        for (let frame = 0; frame < 3.2 * 60; frame++) update(state);
        state.advance(3200);
      }
      return state.finish(plan);
    } });
  f.snapshot.world.reading = observation.getContext();
  if (alreadyRead) f.snapshot.world.reading.allPagesRead = true;
  f.reading = observation;
  f.readSeconds = async (seconds, options) => {
    for (let second = 0; second < seconds; second++) {
      for (let frame = 0; frame < 60; frame++) update(f, options);
      await f.tick(1000);
    }
  };
  return f;
}

test('book_complete uses real gaze/page evidence and a new completion edge, then still waits for the parent dwell', async t => {
  const f = readingFixture(t);await f.start();
  assert.ok(f.controller.getState().nextIntent);
  assert.notEqual(f.snapshot.world.reading.activityId, f.controller.getState().currentActivity.id, 'physical and logical ids use separate namespaces');
  await f.readSeconds(30);
  assert.equal(f.snapshot.world.reading.allPagesRead, true);
  assert.equal(f.applied.length, 1);
  await f.readSeconds(29);assert.equal(f.applied.length, 1);
  await f.readSeconds(1);
  assert.equal(f.applied[1].executionSource, 'planned-next');
  assert.equal(f.calls.length, 1);
  const old = readingFixture(t, { alreadyRead: true });await old.start();
  assert.equal(old.controller.getState().nextIntent, null, 'an old completed bookmark cannot stand in for this activity');
});

test('new reading facts cancel an ordinary dwell intention; incomplete or reset reading cannot satisfy book_complete', async t => {
  const ordinary = readingFixture(t, { after: 'dwell' });await ordinary.start();
  await ordinary.readSeconds(4);
  assert.equal(ordinary.controller.getState().nextIntent, null);
  assert.equal(ordinary.controller.getState().lastIntentEvent.reason, 'reading_changed');
  for (const options of [{ lookingAtBook: false }, { realFrame: false }]) {
    const f = readingFixture(t);await f.start();await f.readSeconds(60, options);
    assert.equal(f.applied.some(plan => plan.executionSource === 'planned-next'), false);
    assert.equal(f.reading.getState().allPagesRead, false);
  }
  const reset = readingFixture(t);await reset.start();await reset.readSeconds(10);
  reset.reading.reset();await reset.readSeconds(1);
  assert.equal(reset.controller.getState().nextIntent, null);
});

test('baseline opt-out and malformed optional intents preserve the current valid activity without future execution', async t => {
  const baseline = fixture(t, { allowNextIntent: false });await baseline.start();
  assert.equal(baseline.calls[0].autonomy.allowNextIntent, false);
  assert.equal(baseline.controller.getState().nextIntent, null);
  await baseline.tick(60_000);assert.equal(baseline.calls.length, 2);
  for (const invalid of [{ ...future, reply: '未来台词' }, { ...future, nextIntent: future },
    { ...future, actions: [{ type: 'read', target: 'none' }, { type: 'stretch', target: 'none' }] },
    { ...future, actions: [{ type: 'sit', target: 'window' }] }, { ...future, dwellSeconds: 60.5 }]) {
    const f = fixture(t, { response: { ...parent, nextIntent: invalid } });await f.start();
    assert.equal(f.applied.length, 1);assert.equal(f.errors.length, 0);
    assert.equal(f.controller.getState().nextIntent, null);
  }
});

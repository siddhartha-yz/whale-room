import test from 'node:test';
import assert from 'node:assert/strict';
import { captureChatReadingResult, tryAdoptChatReading } from '../src/chat-activity.js';
import { createAutonomyController } from '../src/autonomy.js';

function fixture(t) {
  let time = 1_000_000, journalValue = null, modelCalls = 0;
  const run = { id: 7, activityId: 'chat-read-7', source: 'chat', name: 'read' };
  const actual = { id: 7, name: 'read', phase: 'reading', cancelling: false };
  const state = { idle: true, visible: true, typing: true, chatBusy: false };
  const unrelated = { id: 1, action: 'stretch', status: 'completed', source: 'user', detail: '上一次手动伸展' };
  const reading = { id: 2, action: 'read', status: 'completed', source: 'chat', detail: '本次聊天打开书' };
  const snapshot = () => ({
    ready: true, ...state, idle: state.idle && run.source === 'autonomy',
    world: { posture: 'idle', gaze: 'book', activity: { id: run.activityId, kind: actual.name, phase: actual.phase, cancelling: actual.cancelling } },
    feedback: [unrelated, reading],
  });
  const controller = createAutonomyController({
    now: () => time, getSnapshot: snapshot,
    journal: { load: () => null, save: (value) => { journalValue = structuredClone(value); } },
    fetchPlan: async () => { modelCalls++; throw new Error('unexpected model call'); }, onPlan: async () => {},
  });
  controller.start(); controller.notifyUser({ conversation: true });
  t.after(() => controller.dispose());
  return {
    run, actual, state, reading, controller,
    capture(result = { status: 'completed', activity: { id: run.activityId, kind: 'read' }, feedback: [reading] }) {
      return captureChatReadingResult(run, result);
    },
    attempt(owner = controller) { return tryAdoptChatReading({ run, actual, autonomy: owner, ...state }); },
    advance(ms) { time += ms; }, journal: () => journalValue, calls: () => modelCalls,
  };
}

test('a draft keeps finished chat reading in chat control; clearing it safely adopts the same entity with only its own feedback', async (t) => {
  const f = fixture(t);
  assert.equal(f.capture(), true);
  assert.equal(f.attempt(), false);
  assert.equal(f.run.source, 'chat');
  f.advance(30_000); await f.controller.tick();
  assert.equal(f.controller.getState().currentActivity, null);
  assert.deepEqual(f.journal().recentActivities, [], 'typing must not create a zero-second interrupted reading');
  assert.equal(f.actual.phase, 'reading');
  f.state.typing = false; // main clears this only after the draft is empty and its five-second input pause ends
  assert.equal(f.attempt(), true);
  assert.equal(f.run.source, 'autonomy');
  f.advance(10_000); await f.controller.tick();
  const current = f.controller.getState().currentActivity;
  assert.equal(current.id, 'chat-read-7');
  assert.equal(current.elapsedVisibleSeconds, 10);
  assert.deepEqual(current.feedback, [f.reading], 'the earlier manual stretch is not part of this chat reading');
  assert.equal(f.calls(), 0);
  assert.equal(f.attempt(), false, 'a successful handoff is not repeated each visible frame');
  assert.equal(f.controller.getState().currentActivity.elapsedVisibleSeconds, 10);
});

test('a busy reply, unsettled action, hidden page, or absent owner defers handoff without changing its source', (t) => {
  const f = fixture(t); f.capture(); f.state.typing = false;
  for (const [key, blocked] of [['chatBusy', true], ['idle', false], ['visible', false]]) {
    const previous = f.state[key]; f.state[key] = blocked;
    assert.equal(f.attempt(), false, key);
    assert.equal(f.run.source, 'chat');
    f.state[key] = previous;
  }
  assert.equal(f.attempt(null), false);
  assert.equal(f.run.source, 'chat');
  assert.equal(f.attempt(), true, 'the same completed reading can be adopted after owner acquisition');
});

test('late results, a different body, cancelled reading, and manual reading cannot be adopted', (t) => {
  const f = fixture(t); f.state.typing = false;
  assert.equal(f.attempt(), false, 'the action result must finish before its feedback is eligible');
  assert.equal(f.capture({ status: 'completed', activity: { id: 'older-chat-read', kind: 'read' }, feedback: [f.reading] }), false);
  assert.equal(f.run.chatFeedback, undefined);
  assert.equal(f.capture({ status: 'cancelled', activity: { id: f.run.activityId, kind: 'read' }, feedback: [] }), false);
  f.capture();
  f.actual.id = 8; assert.equal(f.attempt(), false);
  f.actual.id = 7; f.actual.cancelling = true; assert.equal(f.attempt(), false);
  f.actual.cancelling = false; f.run.source = 'user'; assert.equal(f.attempt(), false);
  assert.equal(f.run.source, 'user');
  assert.equal(f.controller.getState().currentActivity, null);
});

test('a refused handoff restores chat ownership and captured feedback is a detached copy', (t) => {
  const f = fixture(t); f.state.typing = false;
  f.capture();
  f.reading.detail = 'later mutation';
  assert.equal(f.run.chatFeedback[0].detail, '本次聊天打开书');
  f.controller.setEnabled(false);
  assert.equal(f.attempt(), false);
  assert.equal(f.run.source, 'chat');
  f.controller.setEnabled(true);
  f.actual.phase = 'turning-page';
  assert.equal(f.attempt(), true);
  assert.equal(f.controller.getState().currentActivity.feedback[0].detail, '本次聊天打开书');
});

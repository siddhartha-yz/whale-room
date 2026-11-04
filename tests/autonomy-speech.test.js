import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutonomyController } from '../src/autonomy.js';
import { createActivityJournal } from '../src/activity-journal.js';
import { proactivePreference } from '../shared/memory.js';
import { buildAutonomyPrompt, validateAutonomyRequest, validateAutonomyReply } from '../server/companion.js';

function memoryWith(value, createdAt = Date.now()) {
  return { revision: 'speech-test', entries: [{
    id: `speech-${value}`, kind: 'proactive', value, scope: 'session',
    evidence: value === 'allowed' ? '可以偶尔主动说点自己的想法，不用总等我问' : '现在先别主动说话',
    createdAt, expiresAt: null, sessionId: 'test-session',
  }] };
}
const invitation = '用户已明确邀请你偶尔主动分享';
const silentPlan = { activity: '继续看书', reason: '仍在同一段阅读中', reply: '', expression: 'neutral', actions: [], dwellSeconds: 120, continuationOf: null };

test('an explicit invitation affects the prompt only when the effective preference and speech gate allow it', () => {
  const earlierQuiet = memoryWith('quiet', Date.now() - 10_000).entries[0];
  const allowed = memoryWith('allowed');
  const newerQuiet = { ...earlierQuiet, id: 'latest-quiet', createdAt: Date.now() + 1 };
  const cases = [
    { memory: allowed, canSpeak: true, requestedChange: false, invited: true },
    { memory: { ...allowed, entries: [earlierQuiet, ...allowed.entries] }, canSpeak: true, invited: true },
    { memory: allowed, canSpeak: false, invited: false },
    { memory: allowed, canSpeak: true, requestedChange: true, invited: false, effectiveGate: false },
    { memory: { ...allowed, entries: [...allowed.entries, newerQuiet] }, canSpeak: true, invited: false, effectiveGate: false },
    { memory: { revision: '0', entries: [] }, canSpeak: true, invited: false },
  ];
  for (const { memory, canSpeak, requestedChange = false, invited, effectiveGate = canSpeak } of cases) {
    const input = validateAutonomyRequest({ memory, autonomy: { canSpeak, requestedChange } });
    const prompt = buildAutonomyPrompt(input);
    assert.equal(prompt.includes(invitation), invited);
    assert.equal(input.autonomy.canSpeak, effectiveGate);
    assert.deepEqual(JSON.parse(prompt.trim().split('\n').at(-1)), input, 'the invitation does not invent a new user message or alter context');
    assert.equal(validateAutonomyReply(silentPlan, input.autonomy).reply, '', 'silence remains a valid decision even when explicitly invited');
    assert.equal(validateAutonomyReply({ ...silentPlan, reply: '一个具体的小念头。' }, input.autonomy).reply,
      effectiveGate ? '一个具体的小念头。' : '', 'quiet and cooldown restrictions remain enforced in output validation');
  }
  assert.equal(validateAutonomyReply({ ...silentPlan, reply: '临时主动发言。' }, { canSpeak: true, requestedChange: true }).reply, '',
    'an injected caller cannot turn a manual activity change into a speaking opportunity');
});

test('chat-started continuous reading reopens speech after three minutes; silence does not consume the single remark', async t => {
  let now = Date.now(), emitted = false;
  const initialTime = now, calls = [], applied = [], statuses = [], values = new Map();
  const memory = memoryWith('allowed', now);
  const snapshot = {
    ready: true, idle: true, visible: true, typing: false, chatBusy: false,
    history: [{ role: 'user', content: memory.entries[0].evidence }, { role: 'assistant', content: '好，我先看会儿书。' }],
    memory, canSpeak: proactivePreference(memory) !== 'quiet', feedback: [],
    world: { posture: 'standing', activity: { id: 'chat-reading', kind: 'read', phase: 'reading', heldObject: null } },
  };
  const journal = createActivityJournal({ now: () => now, storage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) } });
  const controller = createAutonomyController({
    now: () => now, getSnapshot: () => snapshot, journal,
    onStatus: state => statuses.push(state),
    fetchPlan: async payload => {
      const input = validateAutonomyRequest(payload);
      calls.push({ at: now, payload, input });
      const reply = input.autonomy.canSpeak && !emitted && now - initialTime >= 360_000 ? '看一会儿书再放空一下，这个节奏我挺喜欢。' : '';
      if (reply) emitted = true;
      return validateAutonomyReply({ ...silentPlan, reply, continuationOf: input.autonomy.currentActivity?.id ?? null }, { ...input.autonomy, world: input.world });
    },
    onPlan: async plan => { applied.push(plan); return { status: 'completed', feedback: [], activity: snapshot.world.activity }; },
  });
  t.after(() => controller.dispose());
  assert.equal(controller.getState().lastDecisionSpeechAllowed, null);
  assert.equal(controller.getState().lastDecisionAt, null);
  controller.start();controller.notifyUser({ conversation: true });controller.noteSpeech();
  assert.equal(controller.adoptActivity({ id: 'chat-reading', activity: '在桌边看书', dwellSeconds: 120 }).ok, true);
  for (let second = 1; second <= 900; second++) { now += 1000; await controller.tick(); }
  assert.equal(calls.length, 7);
  assert.deepEqual(calls.map(call => call.payload.autonomy.canSpeak), [false, true, true, false, false, false, false]);
  assert.deepEqual(calls.map(call => call.input.autonomy.canSpeak), [false, true, true, false, false, false, false]);
  assert.equal(applied.filter(plan => plan.reply).length, 1);
  assert.equal(calls[1].payload.autonomy.secondsSinceSpeech, 240, 'continuation and a silent decision do not reset the normal chat speech timestamp');
  assert.ok(calls.every(call => call.payload.autonomy.currentActivity.id === 'chat-reading'));
  assert.ok(statuses.filter(state => state.status === 'thinking').every((state, index) =>
    state.lastDecisionSpeechAllowed === calls[index].payload.autonomy.canSpeak && state.lastDecisionAt === calls[index].at));
  assert.equal(controller.getState().lastDecisionAt, calls.at(-1).at);
  assert.equal(controller.getState().lastDecisionSpeechAllowed, false);
  assert.equal(Object.hasOwn(journal.load(), 'lastDecisionSpeechAllowed'), false, 'per-run diagnostics do not become persisted conversation data');
  controller.dispose();
  const restored = createAutonomyController({ now: () => now, getSnapshot: () => snapshot, journal, onPlan: async () => {} });
  assert.equal(restored.getState().lastDecisionSpeechAllowed, null, 'a fresh owner has no claimed decision observation until it really constructs a request');
  assert.equal(restored.getState().lastDecisionAt, null);
  restored.dispose();
});

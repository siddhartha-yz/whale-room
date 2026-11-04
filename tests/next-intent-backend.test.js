import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createApp } from '../server/index.js';
import { runCompanion, validateAutonomyRequest, validateAutonomyReply } from '../server/companion.js';

const current = { id: 'reading-1', activity: '看一会儿小册子', phase: 'dwelling', startedAt: 1,
  elapsedVisibleSeconds: 30, segmentVisibleSeconds: 30, dwellSeconds: 120, dwellComplete: false,
  world: { activity: { id: 'reading-1', kind: 'read', phase: 'reading' } }, feedback: [] };
const input = { history: [], world: { ...current.world, reading: { activityId: 'reading-1', allPagesRead: false } }, feedback: [],
  autonomy: { currentActivity: current, canSpeak: false } };
const intent = { activity: '伸展一下肩背', reason: '看过这一段后换个姿势', actions: [{ type: 'stretch', target: 'none' }], dwellSeconds: 90, after: 'book_complete' };
const plan = { activity: '继续看小册子', reason: '还在看这一段', reply: '', expression: 'neutral', actions: [], dwellSeconds: 120, continuationOf: 'reading-1', nextIntent: intent };
const options = { ...input.autonomy, world: input.world };
const metadata = { elapsedMs: 123, usage: { input_tokens: 100, output_tokens: 40 } };

test('one follow-up is optional, request-gated, and validated without invalidating the immediate plan', () => {
  assert.equal(validateAutonomyRequest(input).autonomy.allowNextIntent, true);
  assert.equal(validateAutonomyRequest({ ...input, autonomy: { ...input.autonomy, allowNextIntent: false } }).autonomy.allowNextIntent, false);
  assert.throws(() => validateAutonomyRequest({ ...input, autonomy: { ...input.autonomy, allowNextIntent: 'false' } }), { code: 'INVALID_AUTONOMY' });
  assert.deepEqual(validateAutonomyReply(plan, options).nextIntent, intent);
  assert.equal(validateAutonomyReply(plan, { ...options, allowNextIntent: false }).nextIntent, null);
  for (const nextIntent of [undefined, null]) assert.equal(validateAutonomyReply({ ...plan, nextIntent }, options).nextIntent, null);

  const malformed = [
    '伸展', [], { ...intent, activity: ' ' }, { ...intent, reason: '字'.repeat(201) },
    { ...intent, actions: [] }, { ...intent, actions: Array(5).fill(intent.actions[0]) },
    { ...intent, actions: [{ type: 'look_at', target: 'none' }] },
    { ...intent, actions: [{ type: 'read', target: 'none' }, { type: 'stand', target: 'none' }] },
    { ...intent, dwellSeconds: 59 }, { ...intent, dwellSeconds: 241 }, { ...intent, dwellSeconds: 60.5 },
    { ...intent, after: 'tomorrow' }, { ...intent, reply: '未来的对白' },
    { ...intent, expression: 'happy' }, { ...intent, continuationOf: current.id },
    { ...intent, nextIntent: intent },
  ];
  for (const nextIntent of malformed) {
    const result = validateAutonomyReply({ ...plan, nextIntent }, options);
    assert.equal(result.nextIntent, null);
    assert.equal(result.activity, plan.activity);
    assert.deepEqual(result.actions, plan.actions);
  }
  assert.throws(() => validateAutonomyReply({ ...plan, actions: [{ type: 'read_file', target: 'none' }] }, options), { code: 'INVALID_MODEL_OUTPUT' }, 'invalid immediate actions still fail closed');
});

test('book completion needs a real parent reading plan and current unread-page evidence', () => {
  const newRead = { ...plan, continuationOf: null, actions: [{ type: 'read', target: 'none' }] };
  assert.deepEqual(validateAutonomyReply(newRead, { world: { reading: { allPagesRead: false } } }).nextIntent, intent);
  assert.deepEqual(validateAutonomyReply(plan, options).nextIntent, intent);
  const closedOrCancelled = [null, { ...current.world.activity, cancelling: true }, { ...current.world.activity, phase: 'closing-book' }, { ...current.world.activity, id: 'different-read' }];
  for (const activity of closedOrCancelled) {
    assert.equal(validateAutonomyReply(plan, { ...options, world: { ...input.world, activity } }).nextIntent, null, 'current activity overrides the saved reading snapshot');
  }
  for (const reading of [undefined, null, {}, { allPagesRead: true }]) {
    assert.equal(validateAutonomyReply(plan, { ...options, world: { ...input.world, reading } }).nextIntent, null, 'missing or completed current book evidence cannot arm a new completion trigger');
  }
  const savedComplete = { ...current, world: { ...current.world, reading: { allPagesRead: false } } };
  assert.equal(validateAutonomyReply(plan, { ...options, currentActivity: savedComplete, world: { ...input.world, reading: { allPagesRead: true } } }).nextIntent, null);
  const sit = { ...plan, continuationOf: null, actions: [{ type: 'sit', target: 'sofa' }] };
  assert.equal(validateAutonomyReply(sit, options).nextIntent, null);
  assert.deepEqual(validateAutonomyReply({ ...sit, nextIntent: { ...intent, after: 'dwell' } }, options).nextIntent, { ...intent, after: 'dwell' });
});

test('a follow-up must change the physical sequence rather than simply replay it', () => {
  const readAgain = { ...intent, actions: [{ type: 'read', target: 'none' }], after: 'dwell' };
  assert.equal(validateAutonomyReply({ ...plan, nextIntent: readAgain }, options).nextIntent, null);
  const sitActions = [{ type: 'sit', target: 'sofa' }];
  assert.equal(validateAutonomyReply({ ...plan, continuationOf: null, actions: sitActions, nextIntent: { ...intent, after: 'dwell', actions: sitActions } }, options).nextIntent, null);
  assert.deepEqual(validateAutonomyReply(plan, options).actions, [], 'a future stretch must not be mistaken for an illegal current read continuation');
});

function fakeProcess(output, capture) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();child.stderr = new PassThrough();child.stdin = new PassThrough();
  child.exitCode = null;child.kill = () => true;
  let prompt = '';
  child.stdin.on('data', chunk => { prompt += chunk.toString(); });
  child.stdin.on('finish', () => {
    capture(JSON.parse(prompt.trim().split('\n').at(-1)));
    child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) } }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'turn.completed', usage: metadata.usage }) + '\n');
    child.exitCode = 0;child.emit('close', 0);
  });
  return child;
}

test('CLI response validation preserves a valid intent and independently enforces the A/B gate', async () => {
  for (const allowNextIntent of [true, false]) {
    const submitted = validateAutonomyRequest({ ...input, autonomy: { ...input.autonomy, allowNextIntent } });
    let context, starts = 0;
    const result = await runCompanion(submitted, { mode: 'autonomy', spawnProcess: () => {
      starts++;return fakeProcess(plan, value => { context = value; });
    } });
    assert.equal(context.autonomy.allowNextIntent, allowNextIntent);
    assert.deepEqual(result.nextIntent, allowNextIntent ? intent : null);
    assert.equal(result.model, 'gpt-6-astra');
    assert.deepEqual(result.usage, metadata.usage);
    assert.equal(starts, 1, 'two stages are one model decision');
  }
  const result = await runCompanion(validateAutonomyRequest(input), { mode: 'autonomy',
    spawnProcess: () => fakeProcess({ ...plan, nextIntent: { ...intent, reply: '不允许的未来对白' } }, () => {}) });
  assert.equal(result.nextIntent, null);
  assert.deepEqual(result.actions, plan.actions);
});

test('HTTP validation passes the optional intent and metadata while stripping a disabled or malformed intent', async t => {
  let starts = 0, output = { ...plan, ...metadata };
  const server = createApp({ runner: async () => { starts++;return output; } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/autonomy`;
  const post = async body => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);return response.json();
  };
  const enabled = await post(input);
  assert.deepEqual(enabled.nextIntent, intent);
  assert.equal(enabled.elapsedMs, metadata.elapsedMs);
  assert.deepEqual(enabled.usage, metadata.usage);
  assert.equal(enabled.model, 'gpt-6-astra');
  assert.equal((await post({ ...input, autonomy: { ...input.autonomy, allowNextIntent: false } })).nextIntent, null);
  output = { ...output, nextIntent: { ...intent, expression: 'happy' } };
  const malformed = await post(input);
  assert.equal(malformed.nextIntent, null);
  assert.equal(malformed.activity, plan.activity);
  assert.equal(starts, 3, 'validation neither schedules nor retries a future model request');
});

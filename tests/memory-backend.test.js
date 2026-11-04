import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createApp } from '../server/index.js';
import { validateRequest, validateReply, validateAutonomyRequest, validateAutonomyReply, runCompanion } from '../server/companion.js';

const message = '以后叫我阿澈，别主动说话。';
const memoryPatch = { set: [
  { kind: 'name', value: '阿澈', scope: 'persistent', evidence: '以后叫我阿澈', replacesId: null },
  { kind: 'proactive', value: 'quiet', scope: 'persistent', evidence: '别主动说话', replacesId: null },
], forget: [] };
const reply = { reply: '好，阿澈。', expression: 'neutral', actions: [], memoryPatch };
const currentActivity = { id: 'activity-one', activity: '在桌边读书', phase: 'ready', startedAt: Date.now() - 70_000,
  elapsedVisibleSeconds: 65, segmentVisibleSeconds: 65, dwellSeconds: 60, dwellComplete: true, world: { posture: 'reading' }, feedback: [] };
const quiet = { revision: 'revision-one', entries: [{ id: 'quiet-one', kind: 'proactive', value: 'quiet', scope: 'persistent',
  evidence: '以后别主动说话', createdAt: Date.now(), expiresAt: null, sessionId: null }] };
const idle = { activity: '继续读书', reason: '刚开始这段阅读', reply: '不该主动说的话', expression: 'neutral', actions: [], dwellSeconds: 120, continuationOf: currentActivity.id };

test('chat memory validation rejects historical or invented evidence and HTTP retains the validated patch', async () => {
  assert.deepEqual(validateReply(reply, { message }).memoryPatch, memoryPatch);
  assert.throws(() => validateReply(reply, { message: '你好', memory: quiet }), /来源/);
  assert.throws(() => validateRequest({ message, memory: { revision: 'r', entries: [{ kind: 'event', value: '已经到窗边' }] } }), /记忆/);
  const app = createApp({ runner: async input => {
    assert.equal(input.memory.revision, quiet.revision);
    return { ...reply, model: 'gpt-6-astra', elapsedMs: 1 };
  } });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, memory: quiet }) });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).memoryPatch, memoryPatch);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('CLI output validation has access to the current message for sourced memory extraction', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.exitCode = null; child.kill = () => true;
  child.stdin.resume();
  child.stdin.on('finish', () => {
    child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(reply) } }) + '\n');
    child.exitCode = 0; child.emit('close', 0);
  });
  const result = await runCompanion(validateRequest({ message }), { spawnProcess: () => child });
  assert.deepEqual(result.memoryPatch, memoryPatch);
  assert.equal(result.model, 'gpt-6-astra');
});

test('autonomy preserves real activity context and cannot speak through a remembered quiet constraint', () => {
  const input = validateAutonomyRequest({ history: [], memory: quiet, autonomy: { canSpeak: true, currentActivity, recentActivities: [{ id: 'previous', outcome: 'interrupted', elapsedVisibleSeconds: 8 }] } });
  assert.equal(input.autonomy.canSpeak, false);
  assert.deepEqual(input.autonomy.currentActivity, currentActivity);
  assert.equal(input.autonomy.recentActivities[0].outcome, 'interrupted');
  assert.equal(validateAutonomyReply(idle, input.autonomy).reply, '');
  assert.equal(validateAutonomyReply(idle, input.autonomy).continuationOf, currentActivity.id);
  assert.throws(() => validateAutonomyReply({ ...idle, continuationOf: 'invented' }, input.autonomy), /活动/);
  assert.throws(() => validateAutonomyReply({ ...idle, activityId: 'invented' }, input.autonomy), /无效/);
  assert.throws(() => validateAutonomyRequest({ autonomy: { canSpeak: true, currentActivity: { ...currentActivity, elapsedVisibleSeconds: -1 } } }), /活动/);
  const receipts = Array.from({ length: 8 }, (_, id) => ({ id, action: 'look_at', status: 'completed', detail: '字'.repeat(200) }));
  const recentActivities = Array.from({ length: 8 }, (_, id) => ({ id: `activity-${id}`, activity: '在桌边读书', outcome: 'completed',
    startedAt: Date.now() - 120_000, endedAt: Date.now(), elapsedVisibleSeconds: 120, feedback: receipts }));
  assert.equal(validateAutonomyRequest({ autonomy: { canSpeak: true, currentActivity: { ...currentActivity, feedback: receipts }, recentActivities } }).autonomy.recentActivities.length, 8);
});

test('new embodied actions require none target and continuous reading must be the last action', () => {
  const base = { reply: '我去桌边看看书。', expression: 'neutral', actions: [{ type: 'drink', target: 'none' }, { type: 'stretch', target: 'none' }, { type: 'read', target: 'none' }] };
  assert.deepEqual(validateReply(base).actions, base.actions);
  assert.throws(() => validateReply({ ...base, actions: [{ type: 'read', target: 'sofa' }] }), /不支持/);
  assert.throws(() => validateReply({ ...base, actions: [{ type: 'read', target: 'none' }, { type: 'wave', target: 'none' }] }), /不支持/);
  assert.throws(() => validateReply({ ...base, actions: [{ type: 'drink', target: 'window' }] }), /不支持/);
});

test('explicit activity changes reject continuation through HTTP without bypassing quiet preferences', async () => {
  const body = { memory: quiet, autonomy: { canSpeak: true, currentActivity, requestedChange: true } };
  assert.equal(validateAutonomyRequest({ autonomy: { canSpeak: true } }).autonomy.requestedChange, false);
  for (const invalid of [null, 1, 'true']) {
    assert.throws(() => validateAutonomyRequest({ autonomy: { canSpeak: true, requestedChange: invalid } }), { code: 'INVALID_AUTONOMY', status: 400 });
  }
  const input = validateAutonomyRequest(body);
  assert.equal(input.autonomy.canSpeak, false);
  assert.throws(() => validateAutonomyReply(idle, input.autonomy), { code: 'INVALID_MODEL_OUTPUT' });
  assert.equal(validateAutonomyReply(idle, { ...input.autonomy, requestedChange: false }).continuationOf, currentActivity.id);
  let output = idle;
  const app = createApp({ runner: async (observed) => {
    assert.equal(observed.autonomy.requestedChange, true);
    assert.equal(observed.autonomy.canSpeak, false);
    return output;
  } });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const post = () => fetch(`http://127.0.0.1:${server.address().port}/api/autonomy`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const rejected = await post();
    assert.equal(rejected.status, 502);
    assert.equal((await rejected.json()).code, 'INVALID_MODEL_OUTPUT');
    output = { ...idle, activity: '去窗边站一会儿', reason: '换个地方休息眼睛', actions: [{ type: 'move_to', target: 'window' }], continuationOf: null };
    const accepted = await post();
    assert.equal(accepted.status, 200);
    const payload = await accepted.json();
    assert.equal(payload.continuationOf, null);
    assert.equal(payload.reply, '');
    assert.deepEqual(payload.actions, output.actions);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('CLI validation also rejects continuing when the user requested a change', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.exitCode = null; child.kill = () => true;
  child.stdin.resume();
  child.stdin.on('finish', () => {
    child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(idle) } }) + '\n');
    child.exitCode = 0; child.emit('close', 0);
  });
  await assert.rejects(runCompanion(validateAutonomyRequest({ autonomy: { canSpeak: true, currentActivity, requestedChange: true } }),
    { mode: 'autonomy', spawnProcess: () => child }), { code: 'INVALID_MODEL_OUTPUT' });
});

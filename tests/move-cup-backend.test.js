import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createApp } from '../server/index.js';
import { buildPrompt, buildAutonomyPrompt, validateRequest, validateReply,
  validateAutonomyRequest, validateAutonomyReply, runCompanion } from '../server/companion.js';

const available = { cup: { supported: true, spot: 'cup_inner', held: false } };
const move = { type: 'move_cup', target: 'cup_edge' };
const chat = { reply: '好，我把杯子挪到右侧杯垫。', expression: 'neutral', actions: [move] };
const plan = { activity: '把杯子挪到内侧', reason: '杯子目前在桌沿', reply: '', expression: 'neutral',
  actions: [move], dwellSeconds: 90, continuationOf: null, nextIntent: null };
const intent = { activity: '把杯子放到内侧', reason: '这段活动后给桌边留出空间', actions: [move],
  dwellSeconds: 90, after: 'dwell' };
const withoutCup = [undefined, {}, { cup: null }, { cup: [] },
  { cup: { ...available.cup, supported: false } }, { cup: { ...available.cup, supported: 'true' } },
  { cup: { supported: true, spot: 'cup_inner' } }, { cup: { ...available.cup, held: 'false' } },
  { cup: { ...available.cup, spot: 'table' } }, { cup: { supported: true, held: false } }];

test('cup moves require an explicit current capability and allow a held cup to exit safely first', () => {
  for (const spot of ['cup_inner', 'cup_edge']) for (const held of [false, true]) {
    const world = { cup: { supported: true, spot, held } };
    for (const target of ['cup_inner', 'cup_edge']) {
      const actions = [{ type: 'move_cup', target }];
      assert.deepEqual(validateReply({ ...chat, actions }, { world }).actions, actions);
      assert.deepEqual(validateAutonomyReply({ ...plan, actions }, { world }).actions, actions);
    }
  }
  for (const world of withoutCup) {
    assert.throws(() => validateReply(chat, { world }), { code: 'INVALID_MODEL_OUTPUT' });
    assert.throws(() => validateAutonomyReply(plan, { world }), { code: 'INVALID_MODEL_OUTPUT' });
    assert.deepEqual(validateReply({ ...chat, actions: [] }, { world }).actions, [], 'ordinary chat remains available');
  }
  for (const target of ['none', 'cup', 'center', 'window']) {
    assert.throws(() => validateReply({ ...chat, actions: [{ type: 'move_cup', target }] },
      { world: available }), { code: 'INVALID_MODEL_OUTPUT' });
  }
});

test('saved activity state cannot enable cup moves, while an unavailable follow-up fails soft', () => {
  const currentActivity = { id: 'saved-plan', world: available };
  for (const world of withoutCup) {
    assert.throws(() => validateAutonomyReply(plan, { currentActivity, world }), { code: 'INVALID_MODEL_OUTPUT' });
    const result = validateAutonomyReply({ ...plan, actions: [], nextIntent: intent }, { currentActivity, world });
    assert.equal(result.nextIntent, null);
    assert.deepEqual(result.actions, []);
    assert.equal(result.activity, plan.activity);
  }
  assert.deepEqual(validateAutonomyReply({ ...plan, actions: [], nextIntent: intent },
    { world: available }).nextIntent, intent);
  assert.equal(validateAutonomyReply({ ...plan, actions: [], nextIntent: intent },
    { world: available, allowNextIntent: false }).nextIntent, null);
});

test('moving the cup cannot masquerade as continuing a live read', () => {
  const currentActivity = { id: 'read-one' };
  const world = { ...available, activity: { id: currentActivity.id, kind: 'read', phase: 'reading', cancelling: false } };
  assert.throws(() => validateAutonomyReply({ ...plan, continuationOf: currentActivity.id },
    { currentActivity, world }), { code: 'INVALID_MODEL_OUTPUT' });
  assert.deepEqual(validateAutonomyReply(plan, { currentActivity, world }).actions, [move]);
});

test('prompts advertise cup movement only for the observed capability and keep its claims bounded', () => {
  for (const world of withoutCup) {
    const input = validateRequest({ message: '请挪一下杯子', world });
    assert.ok(!buildPrompt(input).includes('move_cup'));
    assert.ok(!buildAutonomyPrompt(validateAutonomyRequest({ world, autonomy: { canSpeak: false } })).includes('move_cup'));
  }
  const ordinary = buildPrompt(validateRequest({ message: '请挪一下杯子', world: available }));
  assert.match(ordinary, /move_cup/);
  assert.match(ordinary, /用户明确要求挪动这只杯子/);
  assert.match(ordinary, /下发动作不等于已经放好/);
  const autonomous = buildAutonomyPrompt(validateAutonomyRequest({ world: available, autonomy: { canSpeak: false } }));
  assert.match(autonomous, /不要为了自主而反复整理、来回搬杯/);
  assert.match(autonomous, /drink 会放回当次拿起时所在杯垫/);
});

function fakeProcess(output) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.exitCode = null; child.kill = () => true; child.stdin.resume();
  child.stdin.on('finish', () => {
    child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) } }) + '\n');
    child.exitCode = 0; child.emit('close', 0);
  });
  return child;
}

test('CLI chat and autonomy validators receive the current world without making a real model call', async () => {
  for (const mode of ['chat', 'autonomy']) {
    const output = mode === 'chat' ? chat : plan;
    const submit = world => mode === 'chat' ? validateRequest({ message: '把杯子挪一下', world })
      : validateAutonomyRequest({ world, autonomy: { canSpeak: false } });
    const invoke = world => runCompanion(submit(world), { mode, spawnProcess: () => fakeProcess(output) });
    assert.deepEqual((await invoke(available)).actions, [move]);
    assert.deepEqual((await invoke({ cup: { ...available.cup, held: true } })).actions, [move]);
    await assert.rejects(invoke({}), { code: 'INVALID_MODEL_OUTPUT' });
  }
  const input = validateAutonomyRequest({ world: {}, autonomy: { canSpeak: false } });
  const result = await runCompanion(input, { mode: 'autonomy',
    spawnProcess: () => fakeProcess({ ...plan, actions: [], nextIntent: intent }) });
  assert.equal(result.nextIntent, null);
  assert.deepEqual(result.actions, []);
});

test('HTTP revalidation gates cup moves against request observations and strips only an invalid next intent', async () => {
  let output = chat;
  const server = createApp({ runner: async () => output }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const request = (mode, world) => fetch(`http://127.0.0.1:${server.address().port}/api/${mode}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(mode === 'chat' ? { message: '把杯子挪一下', world } : { world, autonomy: { canSpeak: false } }),
  });
  try {
    for (const mode of ['chat', 'autonomy']) {
      output = mode === 'chat' ? chat : plan;
      const enabled = await request(mode, available);
      assert.equal(enabled.status, 200); assert.deepEqual((await enabled.json()).actions, [move]);
      const held = await request(mode, { cup: { ...available.cup, held: true } });
      assert.equal(held.status, 200); await held.json();
      const disabled = await request(mode, { cup: { ...available.cup, supported: false } });
      assert.equal(disabled.status, 502); assert.equal((await disabled.json()).code, 'INVALID_MODEL_OUTPUT');
    }
    output = { ...plan, actions: [], nextIntent: intent };
    const result = await request('autonomy', {});
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.equal(body.nextIntent, null); assert.deepEqual(body.actions, []);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { createApp } from '../server/index.js';
import { validateReply, validateAutonomyReply, validateAutonomyRequest, runCompanion } from '../server/companion.js';
import { ROOM_ACTION_TYPES, ROOM_TARGET_TYPES, MAX_ROOM_ACTIONS } from '../shared/room-actions.js';

const reading = { id: 'reading-one', kind: 'read', phase: 'reading', cancelling: false };
const currentActivity = { id: reading.id, activity: '在桌边看书', phase: 'ready', startedAt: Date.now() - 120_000,
  elapsedVisibleSeconds: 120, segmentVisibleSeconds: 120, dwellSeconds: 120, dwellComplete: true, world: {}, feedback: [] };
const plan = { activity: '继续读一会儿', reason: '这一段刚开始', reply: '', expression: 'neutral', actions: [], dwellSeconds: 120, continuationOf: reading.id };
const breakingActions = [
  { type: 'move_to', target: 'window' }, { type: 'sit', target: 'sofa' },
  ...['stand', 'drink', 'stretch', 'wave', 'nod'].map(type => ({ type, target: 'none' })),
];

test('the CLI schemas advertise the same action vocabulary and limits as the client and server validator', () => {
  for (const file of ['response-schema.json', 'autonomy-schema.json']) {
    const { properties } = JSON.parse(readFileSync(new URL(`../server/${file}`, import.meta.url), 'utf8'));
    assert.equal(properties.actions.maxItems, MAX_ROOM_ACTIONS);
    assert.deepEqual(new Set(properties.actions.items.properties.type.enum), new Set(ROOM_ACTION_TYPES));
    assert.deepEqual(new Set(properties.actions.items.properties.target.enum), new Set(ROOM_TARGET_TYPES));
  }
});

test('look_at requires a real room target in both chat and autonomous results', () => {
  for (const target of ['sofa', 'window', 'plant', 'center', 'user']) {
    const actions = [{ type: 'look_at', target }];
    assert.deepEqual(validateReply({ reply: '嗯。', expression: 'neutral', actions }).actions, actions);
    assert.deepEqual(validateAutonomyReply({ ...plan, continuationOf: null, actions }).actions, actions);
  }
  for (const target of ['none', 'book', 'cup']) {
    const actions = [{ type: 'look_at', target }];
    assert.throws(() => validateReply({ reply: '嗯。', expression: 'neutral', actions }), { code: 'INVALID_MODEL_OUTPUT' });
    assert.throws(() => validateAutonomyReply({ ...plan, continuationOf: null, actions }), { code: 'INVALID_MODEL_OUTPUT' });
  }
});

test('an observed reading continuation cannot execute actions that end reading', () => {
  for (const phase of ['reading', 'turning-page']) {
    const options = { currentActivity, world: { activity: { ...reading, phase } } };
    for (const action of breakingActions) {
      assert.throws(() => validateAutonomyReply({ ...plan, actions: [action] }, options), { code: 'INVALID_MODEL_OUTPUT' });
      assert.deepEqual(validateAutonomyReply({ ...plan, continuationOf: null, actions: [action] }, options).actions, [action]);
    }
    for (const actions of [[], [{ type: 'look_at', target: 'user' }], [{ type: 'read', target: 'none' }], [{ type: 'look_at', target: 'window' }, { type: 'read', target: 'none' }]]) {
      assert.deepEqual(validateAutonomyReply({ ...plan, actions }, options).actions, actions);
    }
  }
});

test('current ended or cancelling observations override a saved read and unknown state is not restricted', () => {
  const saved = { ...currentActivity, world: { activity: reading } };
  const change = { ...plan, actions: [{ type: 'stretch', target: 'none' }] };
  for (const activity of [null, {}, { ...reading, cancelling: true }, { ...reading, phase: 'closing-book' },
    { ...reading, phase: 'opening-book' }, { ...reading, phase: 'unknown' }, { ...reading, id: 'another-activity' }, { ...reading, kind: 'drink' }]) {
    assert.doesNotThrow(() => validateAutonomyReply(change, { currentActivity: saved, world: { activity } }));
  }
  assert.doesNotThrow(() => validateAutonomyReply(change, { currentActivity, world: {} }));
  // A supplied saved reading observation remains usable when no newer activity field exists.
  assert.throws(() => validateAutonomyReply(change, { currentActivity: saved, world: {} }), { code: 'INVALID_MODEL_OUTPUT' });
});

test('HTTP and CLI validation receive current body observations before accepting a continuation', async () => {
  const output = { ...plan, actions: [{ type: 'stretch', target: 'none' }] };
  const input = validateAutonomyRequest({ world: { activity: reading }, autonomy: { canSpeak: false, currentActivity } });
  const server = createApp({ runner: async () => output }).listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const post = body => fetch(`http://127.0.0.1:${server.address().port}/api/autonomy`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const rejected = await post(input);
    assert.equal(rejected.status, 502); assert.equal((await rejected.json()).code, 'INVALID_MODEL_OUTPUT');
    const ended = await post({ ...input, world: { activity: null }, autonomy: { ...input.autonomy, currentActivity: { ...currentActivity, world: { activity: reading } } } });
    assert.equal(ended.status, 200); await ended.json();
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.exitCode = null; child.kill = () => true; child.stdin.resume();
  child.stdin.on('finish', () => {
    child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) } }) + '\n');
    child.exitCode = 0; child.emit('close', 0);
  });
  await assert.rejects(runCompanion(input, { mode: 'autonomy', spawnProcess: () => child }), { code: 'INVALID_MODEL_OUTPUT' });
});

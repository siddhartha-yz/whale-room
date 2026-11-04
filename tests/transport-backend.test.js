import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/index.js';
import { createConversation } from '../src/conversation.js';

const reply = { reply: '我听着。', expression: 'neutral', actions: [] };
const idle = { ...reply, reply: '', activity: '安静坐一会儿', reason: '稍微歇歇', dwellSeconds: 120, continuationOf: null };
function historyFixture(length) {
  const conversation = createConversation({ storage: null });
  for (let index = 0; index < 20; index++) conversation.append(index % 2 ? 'assistant' : 'user', '中'.repeat(length));
  return conversation;
}
async function serve(runner, check) {
  const server = createApp({ runner }).listen(0, '127.0.0.1'); await once(server, 'listening');
  const post = (route, body) => fetch(`http://127.0.0.1:${server.address().port}/api/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try { await check(post); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('twenty valid Chinese history entries pass HTTP without altering the saved conversation', async () => {
  const conversation = historyFixture(2000), original = conversation.snapshot(); let calls = 0;
  const body = { message: '继续聊这个话题', history: conversation.modelHistory(), world: { location: '房间中央', posture: 'idle' }, feedback: [] };
  assert.ok(Buffer.byteLength(JSON.stringify(body)) > 80 * 1024);
  await serve(async input => {
    calls++; assert.deepEqual(input.history, body.history); return reply;
  }, async post => {
    const response = await post('chat', body);
    assert.equal(response.status, 200); assert.equal((await response.json()).reply, reply.reply);
  });
  assert.equal(calls, 1);
  assert.deepEqual(conversation.snapshot(), original);
});

test('full-length saved history plus bounded observations and memory fits the autonomous transport', async () => {
  const conversation = historyFixture(4000), original = conversation.snapshot(), now = Date.now();
  const receipts = Array.from({ length: 8 }, (_, id) => ({ id, action: 'read', status: 'completed', detail: '字'.repeat(200) }));
  const memory = { revision: 'capacity-probe', entries: Array.from({ length: 12 }, (_, id) => ({
    id: `preference-${id}`, kind: 'preference', value: '偏'.repeat(120), scope: 'persistent', evidence: '原'.repeat(400),
    createdAt: now, expiresAt: null, sessionId: null,
  })) };
  const body = { history: conversation.modelHistory(), memory, world: { room: '房'.repeat(11000) }, feedback: [],
    autonomy: { canSpeak: false, recentActivities: Array.from({ length: 8 }, (_, id) => ({
      id: `activity-${id}`, activity: '读'.repeat(60), outcome: 'interrupted', endReason: 'user',
      startedAt: now - 120_000, endedAt: now, elapsedVisibleSeconds: 120, feedback: receipts,
    })) } };
  const bytes = Buffer.byteLength(JSON.stringify(body));
  assert.ok(bytes > 300_000 && bytes < 512 * 1024, `fixture uses ${bytes} UTF-8 bytes`);
  let calls = 0;
  await serve(async (input, options) => {
    calls++; assert.equal(options.mode, 'autonomy'); assert.equal(input.history.length, 20);
    assert.ok(input.history.every(entry => entry.content === '中'.repeat(2000)), 'existing model-context normalization is unchanged');
    assert.equal(input.memory.entries.length, 12); assert.equal(input.autonomy.recentActivities.length, 8);
    return idle;
  }, async post => {
    const response = await post('autonomy', body);
    assert.equal(response.status, 200); assert.equal((await response.json()).activity, idle.activity);
  });
  assert.equal(calls, 1); assert.deepEqual(conversation.snapshot(), original);
});

test('the transport still rejects more than 512 KiB and semantic limits remain unchanged', async () => {
  let calls = 0;
  await serve(async () => { calls++; return reply; }, async post => {
    const tooLarge = { message: '中'.repeat(180_000) };
    assert.ok(Buffer.byteLength(JSON.stringify(tooLarge)) > 512 * 1024);
    const oversized = await post('chat', tooLarge);
    assert.equal(oversized.status, 413); await oversized.json();
    const longMessage = await post('chat', { message: '中'.repeat(4001) });
    assert.equal(longMessage.status, 400); assert.equal((await longMessage.json()).code, 'INVALID_MESSAGE');
    const longWorld = await post('chat', { message: '你好', world: { room: '房'.repeat(12000) } });
    assert.equal(longWorld.status, 400); assert.equal((await longWorld.json()).code, 'INVALID_WORLD');
  });
  assert.equal(calls, 0);
});

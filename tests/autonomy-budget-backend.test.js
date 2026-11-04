import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/index.js';

const plan = { activity: '安静坐一会儿', reason: '稍微歇歇', reply: '', expression: 'neutral', actions: [], dwellSeconds: 120, continuationOf: null };
const input = { autonomy: { canSpeak: false } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function serve(options, run) {
  const server = createApp(options).listen(0, '127.0.0.1'); await once(server, 'listening');
  const post = (route, body, signal) => fetch(`http://127.0.0.1:${server.address().port}/api/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  try { await run(post); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('the server shares 24 autonomous starts across clients, permits chat, and resumes at the rolling expiry', async () => {
  let clock = Date.now(), starts = 0, chats = 0;
  const firstStart = clock;
  await serve({ now: () => clock, runner: async (_input, { mode }) => {
    if (mode === 'chat') { chats++; return { reply: '我听着。', expression: 'neutral', actions: [] }; }
    starts++; return plan;
  } }, async post => {
    for (let index = 0; index < 24; index++) {
      const response = await post('autonomy', { ...input, world: { client: index % 2 ? 'page-a' : 'page-b' } });
      assert.equal(response.status, 200); await response.json(); clock += 10_000;
    }
    let denied = await post('autonomy', input);
    assert.equal(denied.status, 429);
    assert.equal(denied.headers.get('retry-after'), '3360');
    assert.deepEqual(await denied.json(), { error: '这一小时先慢慢待着，稍后再安排活动。', code: 'AUTONOMY_LIMIT', retryAt: firstStart + 3_600_000 });
    const chat = await post('chat', { message: '你好' });
    assert.equal(chat.status, 200); await chat.json(); assert.equal(chats, 1);
    clock = firstStart + 3_600_000 - 1;
    denied = await post('autonomy', input); assert.equal(denied.status, 429); await denied.json();
    clock++;
    const next = await post('autonomy', input); assert.equal(next.status, 200); await next.json();
    assert.equal(starts, 25);
    denied = await post('autonomy', input); assert.equal(denied.status, 429); await denied.json();
  });
});

test('a cancelled start spends one turn, while invalid and busy requests do not spend turns', async () => {
  let starts = 0; const began = deferred(), stopped = deferred();
  await serve({ runner: async (_input, { signal }) => {
    starts++;
    if (starts > 1) return plan;
    began.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    stopped.resolve(); throw new Error('cancelled');
  } }, async post => {
    const controller = new AbortController();
    const active = post('autonomy', input, controller.signal).catch(() => null);
    await began.promise;
    const busy = await post('autonomy', input); assert.equal(busy.status, 429); assert.equal((await busy.json()).code, 'BUSY');
    const invalid = await post('autonomy', { autonomy: { canSpeak: 'no' } }); assert.equal(invalid.status, 400); await invalid.json();
    controller.abort(); await stopped.promise; await active;
    for (let index = 0; index < 23; index++) {
      const response = await post('autonomy', input); assert.equal(response.status, 200); await response.json();
    }
    const denied = await post('autonomy', input); assert.equal(denied.status, 429); assert.equal((await denied.json()).code, 'AUTONOMY_LIMIT');
    assert.equal(starts, 24);
  });
});

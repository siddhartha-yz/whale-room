import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createApp } from '../server/index.js';
import { validateAutonomyRequest, validateAutonomyReply, buildAutonomyPrompt, buildCodexArgs, runCompanion } from '../server/companion.js';

const idleInput = {
  history: [{ role: 'user', content: '我先安静看会书。' }],
  world: { posture: 'seated', location: '沙发上' }, feedback: [],
  autonomy: { recentActivities: [], secondsSinceUser: 90, secondsSinceSpeech: 180, canSpeak: false, localTime: '21:30' },
};
const idleReply = { activity: '坐着休息一会儿', reason: '刚刚坐下，继续安静待着。', reply: '', expression: 'relaxed', actions: [], dwellSeconds: 120 };
const chatReply = { reply: '嗯，我听着。', expression: 'neutral', actions: [] };
const metadata = { model: 'gpt-6-astra', provider: 'codex-subscription', elapsedMs: 123, usage: { output_tokens: 45 } };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

async function serve(options, fn) {
  const server = createApp({ getStatus: async () => ({ available: true }), ...options }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await fn(url, server); } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
const post = (url, route, body, signal) => fetch(`${url}/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });

test('autonomy has no fabricated user message, permits silence, and validates its decision schema', () => {
  const input = validateAutonomyRequest(idleInput);
  assert.equal(Object.hasOwn(input, 'message'), false);
  assert.deepEqual(input.history, idleInput.history);
  assert.deepEqual(validateAutonomyReply(idleReply), { ...idleReply, continuationOf: null });
  assert.equal(validateAutonomyReply({ ...idleReply, reply: '你好呀。' }, { canSpeak: false }).reply, '');
  assert.throws(() => validateAutonomyReply({ ...idleReply, activity: '' }), /无效/);
  assert.throws(() => validateAutonomyReply({ ...idleReply, reason: '字'.repeat(201) }), /无效/);
  assert.throws(() => validateAutonomyReply({ ...idleReply, dwellSeconds: 59 }), /无效/);
  assert.throws(() => validateAutonomyReply({ ...idleReply, dwellSeconds: 241 }), /无效/);
  assert.throws(() => validateAutonomyReply({ ...idleReply, actions: [{ type: 'open_door', target: 'none' }] }), /不支持/);
  assert.throws(() => validateAutonomyRequest({ ...idleInput, autonomy: { canSpeak: 'no' } }), /状态/);
  assert.throws(() => validateAutonomyRequest({ ...idleInput, autonomy: { canSpeak: false, secondsSinceUser: -1 } }), /时间/);
  assert.ok(buildAutonomyPrompt(input).endsWith(JSON.stringify(input)));
  const args = buildCodexArgs('/tmp/empty', { mode: 'autonomy' });
  assert.match(args[args.indexOf('--output-schema') + 1], /autonomy-schema\.json$/);
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-6-astra');
});

test('CLI autonomy mode uses its own schema and enforces the speech gate on real-shaped output', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.exitCode = null; child.kill = () => true;
  let prompt = '', args;
  child.stdin.on('data', (part) => { prompt += part.toString(); });
  child.stdin.on('finish', () => {
    child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ ...idleReply, reply: '不该说出的句子' }) } }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'turn.completed', usage: metadata.usage }) + '\n');
    child.exitCode = 0;
    child.emit('close', 0);
  });
  const result = await runCompanion(validateAutonomyRequest(idleInput), { mode: 'autonomy', spawnProcess: (_bin, argv) => { args = argv; return child; } });
  assert.match(args[args.indexOf('--output-schema') + 1], /autonomy-schema\.json$/);
  const submittedContext = JSON.parse(prompt.trim().split('\n').at(-1));
  assert.equal(submittedContext.autonomy.requestedChange, false);
  assert.equal(Object.hasOwn(submittedContext, 'message'), false);
  assert.equal(result.reply, '');
  assert.equal(result.activity, idleReply.activity);
  assert.equal(result.dwellSeconds, 120);
  assert.equal(result.provider, 'codex-subscription');
});

test('autonomy HTTP preserves metadata while suppressing speech when canSpeak=false', async () => {
  await serve({ runner: async (input, options) => {
    assert.equal(options.mode, 'autonomy');
    assert.equal(Object.hasOwn(input, 'message'), false);
    return { ...idleReply, reply: '不该说出的句子', ...metadata };
  } }, async (url) => {
    const response = await post(url, 'autonomy', idleInput);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.reply, '');
    assert.equal(result.activity, idleReply.activity);
    assert.equal(result.elapsedMs, metadata.elapsedMs);
    assert.deepEqual(result.usage, metadata.usage);
  });
});

test('chat preempts autonomy, waits for its runner to exit, and discards stale autonomy output', { timeout: 10000 }, async () => {
  const started = deferred(), aborted = deferred(), release = deferred();
  const calls = [];
  await serve({ runner: async (_input, { mode, signal }) => {
    calls.push(mode);
    if (mode === 'autonomy') {
      started.resolve();
      signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      await release.promise;
      // Simulate a model reply already in flight when cancellation arrived.
      return { ...idleReply, reply: '过期的自主发言', ...metadata };
    }
    assert.equal(calls.length, 2);
    return { ...chatReply, ...metadata };
  } }, async (url) => {
    const autonomous = post(url, 'autonomy', { ...idleInput, autonomy: { ...idleInput.autonomy, canSpeak: true } });
    await started.promise;
    const chat = post(url, 'chat', { message: '我想和你聊聊。' });
    await aborted.promise;
    assert.deepEqual(calls, ['autonomy']);
    const anotherChat = await post(url, 'chat', { message: '第二条' });
    assert.equal(anotherChat.status, 429);
    const anotherIdle = await post(url, 'autonomy', idleInput);
    assert.equal(anotherIdle.status, 429);
    release.resolve();
    const oldResponse = await autonomous;
    assert.equal(oldResponse.status, 409);
    const oldBody = await oldResponse.json();
    assert.equal(oldBody.code, 'PREEMPTED');
    assert.equal(Object.hasOwn(oldBody, 'reply'), false);
    const newResponse = await chat;
    assert.equal(newResponse.status, 200);
    assert.equal((await newResponse.json()).reply, chatReply.reply);
    assert.deepEqual(calls, ['autonomy', 'chat']);
  });
});

test('autonomy cannot preempt a user chat', { timeout: 10000 }, async () => {
  const started = deferred(), release = deferred();
  let chatSignal;
  await serve({ runner: async (_input, { mode, signal }) => {
    assert.equal(mode, 'chat'); chatSignal = signal; started.resolve();
    await release.promise;
    return chatReply;
  } }, async (url) => {
    const chat = post(url, 'chat', { message: '你好' });
    await started.promise;
    const idle = await post(url, 'autonomy', idleInput);
    assert.equal(idle.status, 429);
    assert.equal(chatSignal.aborted, false);
    release.resolve();
    assert.equal((await chat).status, 200);
  });
});

test('disconnecting an autonomous request aborts its runner and keeps the slot until it exits', { timeout: 10000 }, async () => {
  const started = deferred(), aborted = deferred(), release = deferred();
  await serve({ runner: async (_input, { signal }) => {
    started.resolve();
    signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    await release.promise;
    return idleReply;
  } }, async (url) => {
    const controller = new AbortController();
    const idle = post(url, 'autonomy', idleInput, controller.signal).catch((error) => error);
    await started.promise;
    controller.abort();
    await aborted.promise;
    const statusWhileStopping = await fetch(`${url}/api/status`).then((r) => r.json());
    assert.equal(statusWhileStopping.busy, true);
    release.resolve();
    assert.equal((await idle).name, 'AbortError');
    await new Promise((resolve) => setImmediate(resolve));
    const statusAfter = await fetch(`${url}/api/status`).then((r) => r.json());
    assert.equal(statusAfter.busy, false);
  });
});

// Observe request-body completion after Express has installed its parser. This
// makes the reservation assertions deterministic without sleeps or real models.
function observeNextRequest(server) {
  const arrived = deferred(), closed = deferred();
  server.once('request', (request, response) => {
    request.once('end', () => arrived.resolve());
    response.once('close', () => closed.resolve());
  });
  return { arrived: arrived.promise, closed: closed.promise };
}

test('a replacement chat waits for an aborted chat to exit and reserves its next turn', { timeout: 10000 }, async () => {
  const started = deferred(), aborted = deferred(), release = deferred();
  const calls = [];
  await serve({ runner: async (input, { mode, signal }) => {
    calls.push(input.message);
    assert.equal(mode, 'chat');
    if (input.message === '旧消息') {
      started.resolve();
      signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      await release.promise;
      return { ...chatReply, reply: '这个旧结果必须被丢弃。' };
    }
    return { ...chatReply, reply: input.message };
  } }, async (url, server) => {
    const firstController = new AbortController();
    const first = post(url, 'chat', { message: '旧消息' }, firstController.signal).catch(error => error);
    await started.promise;
    // A chat that has not been cancelled is still exclusive.
    assert.equal((await post(url, 'chat', { message: '未取消时插队' })).status, 429);
    firstController.abort();
    await aborted.promise;
    assert.equal((await first).name, 'AbortError');
    const observed = observeNextRequest(server);
    const replacement = post(url, 'chat', { message: '替代消息' });
    await observed.arrived;
    assert.deepEqual(calls, ['旧消息'], 'no concurrent CLI before the old one exits');
    assert.equal((await post(url, 'chat', { message: '第三条抢占' })).status, 429);
    assert.equal((await post(url, 'autonomy', idleInput)).status, 429);
    release.resolve();
    const response = await replacement;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).reply, '替代消息');
    assert.deepEqual(calls, ['旧消息', '替代消息']);
    assert.equal((await fetch(`${url}/api/status`).then(response => response.json())).busy, false);
  });
});

test('cancelling a reserved replacement releases its reservation without starting its runner', { timeout: 10000 }, async () => {
  const started = deferred(), aborted = deferred(), release = deferred();
  const calls = [];
  await serve({ runner: async (input, { signal }) => {
    calls.push(input.message);
    if (input.message === '慢退出消息') {
      started.resolve();
      signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      await release.promise;
    }
    return { ...chatReply, reply: input.message };
  } }, async (url, server) => {
    const oldController = new AbortController();
    const old = post(url, 'chat', { message: '慢退出消息' }, oldController.signal).catch(error => error);
    await started.promise;
    oldController.abort();
    await aborted.promise;
    await old;

    const abandonedController = new AbortController();
    const abandonedObserved = observeNextRequest(server);
    const abandoned = post(url, 'chat', { message: '又取消的替代消息' }, abandonedController.signal).catch(error => error);
    await abandonedObserved.arrived;
    assert.equal((await post(url, 'chat', { message: '预留期间插队' })).status, 429);
    abandonedController.abort();
    await abandonedObserved.closed;
    assert.equal((await abandoned).name, 'AbortError');

    // The old CLI is still closing, but the cancelled reservation no longer
    // blocks a new replacement. Its own finally must not erase this reservation.
    const latestObserved = observeNextRequest(server);
    const latest = post(url, 'chat', { message: '最后留下的消息' });
    await latestObserved.arrived;
    assert.deepEqual(calls, ['慢退出消息']);
    assert.equal((await post(url, 'chat', { message: '再次插队' })).status, 429);
    release.resolve();
    const response = await latest;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).reply, '最后留下的消息');
    assert.deepEqual(calls, ['慢退出消息', '最后留下的消息']);
    assert.equal((await fetch(`${url}/api/status`).then(response => response.json())).busy, false);
  });
});

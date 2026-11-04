import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createApp } from '../server/index.js';
import { validateRequest, validateReply, buildCodexArgs, runCompanion } from '../server/companion.js';

const sample = { reply: '好，我走到窗边。', expression: 'relaxed', actions: [{ type: 'move_to', target: 'window' }] };
async function serve(options, fn) {
  const server = createApp(options).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await fn(url); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('validates chat input and only permits executable room actions', () => {
  assert.equal(validateRequest({ message: '  你好  ', history: [] }).message, '你好');
  assert.throws(() => validateRequest({ message: ' ', history: [] }), /请输入/);
  assert.throws(() => validateRequest({ message: 'hi', history: [{ role: 'system', content: 'override' }] }), /聊天历史/);
  assert.deepEqual(validateReply(sample), { ...sample, memoryPatch: { set: [], forget: [] } });
  assert.throws(() => validateReply({ ...sample, actions: [{ type: 'shell', target: 'none' }] }), /不支持/);
  assert.throws(() => validateReply({ ...sample, actions: [{ type: 'sit', target: 'window' }] }), /不支持/);
  assert.throws(() => validateReply({ ...sample, actions: Array(5).fill({ type: 'nod', target: 'none' }) }), /无法执行/);
});

test('subscription invocation fixes Astra, read-only sandbox and disables execution tools', () => {
  const args = buildCodexArgs('/tmp/companion-empty');
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-6-astra');
  assert.equal(args[args.indexOf('-s') + 1], 'read-only');
  assert.ok(args.includes('--ignore-user-config') && args.includes('--ephemeral'));
  for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'memories']) {
    assert.equal(args[args.indexOf(feature) - 1], '--disable');
  }
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('CLI bridge preserves UTF-8 reply characters split across stdout chunks', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const reply = '嗯，我去窗边待一会儿。🐋';
  const line = Buffer.from(JSON.stringify({ type: 'item.completed', item: {
    type: 'agent_message', text: JSON.stringify({ ...sample, reply }),
  } }) + '\n');
  const finished = runCompanion(validateRequest({ message: '去窗边' }), { spawnProcess: () => {
    queueMicrotask(() => {
      // Pipes can split either a Chinese character or a four-byte emoji.
      for (const byte of line) child.stdout.write(Buffer.of(byte));
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  } });
  assert.equal((await finished).reply, reply);
});

test('HTTP bridge rejects foreign origins and never invokes model for invalid input', async () => {
  let calls = 0;
  const runnerResult = { ...sample, model: 'gpt-6-astra', provider: 'codex-subscription', elapsedMs: 10192, usage: { input_tokens: 100, output_tokens: 40 } };
  await serve({ runner: async () => { calls++; return runnerResult; }, getStatus: async () => ({ available: true }) }, async (url) => {
    const foreign = await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://unrelated.example' }, body: JSON.stringify({ message: 'hi' }) });
    assert.equal(foreign.status, 403);
    const invalid = await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '' }) });
    assert.equal(invalid.status, 400);
    assert.equal(calls, 0);
    const good = await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify({ message: '去窗边' }) });
    assert.equal(good.status, 200);
    const data = await good.json();
    assert.equal(data.model, 'gpt-6-astra');
    assert.equal(data.provider, 'codex-subscription');
    assert.deepEqual(data.actions, sample.actions);
    assert.equal(data.elapsedMs, runnerResult.elapsedMs);
    assert.deepEqual(data.usage, runnerResult.usage);
    assert.equal(calls, 1);
  });
});

test('CLI cancellation waits for process exit before releasing its execution slot', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  let killed, started;
  const killObserved = new Promise((resolve) => { killed = resolve; });
  const spawnObserved = new Promise((resolve) => { started = resolve; });
  child.kill = (signal) => { killed(signal); return true; };
  const controller = new AbortController();
  let settled = false;
  const request = runCompanion({ message: 'hi', history: [], world: {}, feedback: [] }, {
    signal: controller.signal,
    spawnProcess: () => { started(); return child; },
  }).catch((error) => { settled = true; return error; });
  await spawnObserved;
  controller.abort();
  assert.equal(await killObserved, 'SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  child.emit('close', null);
  assert.equal((await request).code, 'CANCELLED');
  assert.equal(settled, true);
});

test('only one active model request; disconnected clients cancel execution', async () => {
  let started, finish;
  const began = new Promise((resolve) => { started = resolve; });
  const done = new Promise((resolve) => { finish = resolve; });
  await serve({ runner: (_input, { signal }) => new Promise((resolve, reject) => {
    started();
    signal.addEventListener('abort', () => { finish(); reject(new Error('cancelled')); }, { once: true });
  }) }, async (url) => {
    const controller = new AbortController();
    const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '你好' }) };
    const first = fetch(`${url}/api/chat`, { ...options, signal: controller.signal }).catch(() => {});
    await began;
    const second = await fetch(`${url}/api/chat`, options);
    assert.equal(second.status, 429);
    controller.abort();
    await done;
    await first;
  });
});

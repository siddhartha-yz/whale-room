import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnectionStatus } from '../src/connection-status.js';
import { createAutonomyController } from '../src/autonomy.js';
import { createApp } from '../server/index.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes;reject = no; });
  return { promise, resolve, reject };
}
const flushed = () => new Promise(resolve => setImmediate(resolve));

test('explicit status recheck after login unlocks the real autonomous controller without a chat request', async t => {
  let loggedIn = false, clock = Date.now(), checks = 0, modelStarts = 0;
  const server = createApp({ now: () => clock,
    getStatus: async () => { checks++;return { available: loggedIn }; },
    runner: async (_input, { mode }) => {
      assert.equal(mode, 'autonomy', 'recovery does not require sending a chat or probe to the model');
      modelStarts++;
      return { activity: '安静坐一会儿', reason: '继续休息', reply: '', expression: 'neutral', actions: [], dwellSeconds: 120, continuationOf: null };
    },
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const connection = createConnectionStatus({ fetchStatus: async ({ signal }) => (await fetch(`${url}/api/status`, { signal })).json() });
  t.after(() => connection.dispose());
  const controller = createAutonomyController({ now: () => clock,
    getSnapshot: () => ({ ready: connection.getState().available, idle: true, visible: true, renderActive: true, typing: false, chatBusy: false, world: {}, feedback: [] }),
    fetchPlan: async (payload, { signal }) => {
      const response = await fetch(`${url}/api/autonomy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal });
      assert.equal(response.status, 200);return response.json();
    }, onPlan: async () => ({ status: 'completed' }),
  });
  t.after(() => controller.dispose());
  assert.equal((await connection.check()).status, 'needs-login');
  controller.start();loggedIn = true;
  for (let minute = 0; minute < 30; minute++) { clock += 60_000;await controller.tick(); }
  assert.equal(checks, 1, 'there is no background polling');
  assert.equal(modelStarts, 0);
  assert.equal(controller.requestNow().ok, false);

  assert.equal((await connection.check()).status, 'ready');
  assert.equal(modelStarts, 0, 'a status check itself never invokes the model');
  await controller.tick();
  assert.equal(modelStarts, 1);
  assert.equal(controller.getState().status, 'resting');
  assert.equal(checks, 2);
});

test('concurrent checks share one request and timeout even when the transport ignores abort', async t => {
  const response = deferred();let calls = 0, signal;
  const connection = createConnectionStatus({ timeoutMs: 20, fetchStatus: options => { calls++;signal = options.signal;return response.promise; } });
  t.after(() => connection.dispose());
  const first = connection.check();
  assert.equal(connection.check(), first);
  assert.equal(connection.getState().checking, true);
  const result = await first;
  assert.equal(result.status, 'offline');
  assert.equal(result.checking, false);
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
  response.resolve({ available: true });await flushed();
  assert.equal(connection.getState().status, 'offline', 'a late response cannot undo the timeout');
  assert.equal(calls, 1, 'a timeout does not schedule a retry');
});

test('successful chat supersedes a pending status check and fences its late error', async t => {
  const response = deferred();let signal;
  const connection = createConnectionStatus({ fetchStatus: options => { signal = options.signal;return response.promise; } });
  t.after(() => connection.dispose());
  const checking = connection.check();await flushed();
  assert.equal(connection.markSuccess(), true);
  assert.equal((await checking).status, 'ready');
  assert.equal(signal.aborted, true);
  response.reject(new Error('late connection failure'));await flushed();
  assert.deepEqual(connection.getState(), { status: 'ready', available: true, reason: '', checking: false });
});

test('only explicit authentication, missing CLI or transport errors revoke availability', async t => {
  const response = deferred();
  const connection = createConnectionStatus({ fetchStatus: () => response.promise });
  t.after(() => connection.dispose());
  connection.markSuccess();
  for (const error of [
    { code: 'BUSY', status: 429 }, { code: 'AUTONOMY_LIMIT', status: 429 },
    { code: 'INVALID_MODEL_OUTPUT', status: 502 }, { code: 'MODEL_TIMEOUT', status: 504 },
    { code: 'USAGE_LIMIT', status: 503 }, new TypeError('not necessarily a network error'),
  ]) {
    assert.equal(connection.markFailure(error), false);
    assert.equal(connection.getState().status, 'ready');
  }
  const checking = connection.check();
  assert.equal(connection.getState().available, true, 'an optional check does not disable an already working room');
  connection.markFailure({ code: 'LOGIN_REQUIRED', message: '请重新登录' });
  assert.equal((await checking).status, 'needs-login');
  response.resolve({ available: true });await flushed();
  assert.equal(connection.getState().status, 'needs-login', 'old status cannot override a newer authentication error');
  connection.markSuccess();connection.markFailure({ code: 'CODEX_UNAVAILABLE' });
  assert.equal(connection.getState().status, 'offline');
  connection.markSuccess();connection.markFailure({ transport: true });
  assert.equal(connection.getState().status, 'offline');
});

test('invalid status data is offline rather than a fabricated login requirement', async t => {
  const connection = createConnectionStatus({ fetchStatus: async () => ({ error: 'server unavailable' }) });
  t.after(() => connection.dispose());
  assert.equal((await connection.check()).status, 'offline');
});

test('dispose releases a pending check and prevents late callbacks or future requests', async () => {
  const response = deferred();let calls = 0, changes = 0, signal;
  const connection = createConnectionStatus({ fetchStatus: options => { calls++;signal = options.signal;return response.promise; }, onChange: () => changes++ });
  const checking = connection.check();await flushed();
  connection.dispose();const before = changes;
  assert.equal((await checking).checking, false);
  assert.equal(signal.aborted, true);
  response.resolve({ available: true });await flushed();
  connection.markSuccess();connection.markFailure({ code: 'LOGIN_REQUIRED' });await connection.check();
  assert.equal(changes, before);
  assert.equal(calls, 1);

  const neverStarted = createConnectionStatus({ fetchStatus: async () => { calls++;return { available: true }; } });
  const cancelledImmediately = neverStarted.check();neverStarted.dispose();
  await cancelledImmediately;await flushed();
  assert.equal(calls, 1, 'leaving before the fetch microtask must not start a new request');
});

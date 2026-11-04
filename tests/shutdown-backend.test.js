import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/index.js';

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

test('shutdown aborts active and reserved requests, waits for the runner and rejects new work', { timeout: 5000 }, async t => {
  const started = deferred(), aborted = deferred(), release = deferred();
  const modes = [];
  const app = createApp({ runner: async (_, { mode, signal }) => {
    modes.push(mode);
    signal.addEventListener('abort', aborted.resolve, { once: true });
    started.resolve();
    await release.promise;
    assert.equal(signal.aborted, true);
    throw new DOMException('runner closed', 'AbortError');
  } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { release.resolve();server.closeAllConnections();return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (mode, body) => {
    const result = await fetch(`${origin}/api/${mode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return [result.status, (await result.json()).code];
  };
  const auto = post('autonomy', { autonomy: { canSpeak: false } });
  await started.promise;
  const chat = post('chat', { message: '等一等' });
  await aborted.promise; // Chat reserved the slot while the first runner closes.
  let done = false;
  const stopping = app.locals.stopCompanion();
  assert.equal(app.locals.stopCompanion(), stopping);
  void stopping.then(() => { done = true; });
  assert.deepEqual(await post('chat', { message: '新的请求' }), [503, 'SHUTTING_DOWN']);
  assert.equal(done, false);
  release.resolve();
  assert.deepEqual(await Promise.all([auto, chat]), [[503, 'SHUTTING_DOWN'], [503, 'SHUTTING_DOWN']]);
  await stopping;
  assert.equal(done, true);
  assert.deepEqual(modes, ['autonomy']);
});

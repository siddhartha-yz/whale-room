import test from 'node:test';
import assert from 'node:assert/strict';
import { hasActionList, postLocalJson } from '../src/local-request.js';

test('HTML and JSON primitives from an unexpected local service report a reconnectable error', async () => {
  for (const body of ['<!doctype html><title>different service</title>', 'null', '[]']) {
    await assert.rejects(postLocalJson('/api/chat', { message: '你好' }, {
      fetchRequest: async () => new Response(body, { status: 200 }),
    }), error => error.transport === true && error.message.includes('重连') && !error.message.includes(body));
  }
});

test('normal structured responses retain rate limits, UTF-8 text and action shape', async () => {
  const payload = { message: '你好' };
  const retryAt = 1_800_000_000_000;
  await assert.rejects(postLocalJson('/api/autonomy', payload, {
    fetchRequest: async (path, options) => {
      assert.equal(path, '/api/autonomy');
      assert.deepEqual(JSON.parse(options.body), payload);
      return Response.json({ error: '稍后再安排', code: 'AUTONOMY_LIMIT', retryAt }, { status: 429 });
    },
  }), error => error.status === 429 && error.code === 'AUTONOMY_LIMIT' && error.retryAt === retryAt && !error.transport);
  const reply = await postLocalJson('/api/chat', payload, { fetchRequest: async () => Response.json({ reply: '你好', actions: [] }) });
  assert.equal(hasActionList(reply.actions), true);
  assert.equal(hasActionList([null]), false);
});

test('cancelling during fetch or body decoding never changes connection status', async () => {
  const controller = new AbortController();
  const abort = new DOMException('取消', 'AbortError');
  controller.abort();
  for (const fetchRequest of [async () => { throw abort; }, async () => ({ json: async () => { throw abort; } })]) {
    await assert.rejects(postLocalJson('/api/chat', {}, { signal: controller.signal, fetchRequest }), error => error === abort);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationScope } from '../src/conversation-scope.js';
import { createConversation } from '../src/conversation.js';

const key = 'test-room-history';
function storageFixture(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values, getItem: name => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, String(value)), removeItem: name => values.delete(name),
    duplicate: () => storageFixture(Object.fromEntries(values)),
  };
}
function fakeLocks() {
  const held = new Set();
  return { request(name, options, callback) {
    assert.equal(options.ifAvailable, true);
    assert.equal(options.mode, 'exclusive');
    if (held.has(name)) return Promise.resolve().then(() => callback(null));
    held.add(name);
    return Promise.resolve().then(() => callback({ name })).finally(() => held.delete(name));
  } };
}
function fixture(initial) {
  const storage = storageFixture(initial), locks = fakeLocks(); let sequence = 0;
  const open = sessionStorage => createConversationScope({ key, storage, locks, sessionStorage, newId: () => `page-${++sequence}` });
  return { storage, locks, open };
}
const conversationFor = scope => createConversation({ storage: scope.storage, key: scope.key });

test('a second page cannot interrupt the first request or overwrite its eventual real reply', async () => {
  const legacy = JSON.stringify([{ role: 'user', content: '  原有文字\n保留  ' }, { role: 'assistant', content: '原回复' }]);
  const { storage, open } = fixture({ [key]: legacy, unrelatedPreference: 'unchanged' });
  const scopeA = await open(storageFixture()), a = conversationFor(scopeA);
  const pending = a.append('user', '等待实际回复', { status: 'pending' });
  const scopeB = await open(storageFixture()), b = conversationFor(scopeB);
  assert.notEqual(scopeB.key, scopeA.key, 'the last session is active, so the new page copies into its own scope');
  assert.equal(b.snapshot().at(-1).status, 'interrupted');
  assert.equal(JSON.parse(storage.getItem(scopeA.key)).at(-1).status, 'pending');
  a.mark(pending.id, 'answered');
  a.append('assistant', '这是 A 真实收到的回复');
  b.append('user', 'B 的新问题');
  assert.equal(JSON.parse(storage.getItem(scopeA.key)).at(-1).content, '这是 A 真实收到的回复');
  assert.equal(JSON.parse(storage.getItem(scopeB.key)).at(-1).content, 'B 的新问题');
  assert.equal(storage.getItem(key), legacy, 'migration never normalizes or overwrites the legacy key');
  assert.equal(storage.getItem('unrelatedPreference'), 'unchanged');
  await Promise.all([scopeA.dispose(), scopeB.dispose()]);
});

test('refresh reclaims the same scope, marks an unfinished request interrupted, and fences old callbacks', async () => {
  const { storage, open } = fixture(), session = storageFixture();
  const first = await open(session), before = conversationFor(first);
  const pending = before.append('user', '刷新前发出的请求', { status: 'pending' });
  await first.dispose();
  const second = await open(session), after = conversationFor(second);
  assert.equal(second.id, first.id);
  assert.deepEqual(after.snapshot(), [{ ...pending, status: 'interrupted' }]);
  assert.deepEqual(after.modelHistory(), []);
  after.append('assistant', '新页面的有效消息');
  const saved = storage.getItem(second.key);
  before.mark(pending.id, 'answered');
  before.append('assistant', '已离开页面的迟到结果');
  assert.equal(storage.getItem(second.key), saved);
  await second.dispose();
  const reopened = await open(storageFixture());
  assert.equal(reopened.id, second.id, 'a closed last session can be reopened without a sessionStorage id');
  assert.equal(conversationFor(reopened).snapshot().at(-1).content, '新页面的有效消息');
  await reopened.dispose();
});

test('duplicate tabs with a copied session id fork, then each refreshes its own independent conversation', async () => {
  const { open } = fixture(), tabA = storageFixture();
  const scopeA = await open(tabA), a = conversationFor(scopeA);
  a.append('user', '复制前的共同历史');
  const tabB = tabA.duplicate(), scopeB = await open(tabB), b = conversationFor(scopeB);
  assert.notEqual(scopeA.id, scopeB.id);
  assert.deepEqual(b.modelHistory(), a.modelHistory());
  a.append('assistant', 'A 后来的回复');b.append('assistant', 'B 后来的回复');
  await scopeB.dispose();
  const restoredB = await open(tabB);
  assert.equal(restoredB.id, scopeB.id);
  assert.equal(conversationFor(restoredB).snapshot().at(-1).content, 'B 后来的回复');
  assert.equal(a.snapshot().at(-1).content, 'A 后来的回复');
  await Promise.all([scopeA.dispose(), restoredB.dispose()]);
});

test('pagehide interruption persists before releasing ownership and cannot become a cancelled or successful reply', async () => {
  const { open } = fixture(), tab = storageFixture();
  const scope = await open(tab), conversation = conversationFor(scope);
  const pending = conversation.append('user', '离开页面时仍在等待', { status: 'pending' });
  conversation.mark(pending.id, 'interrupted');
  const released = scope.dispose();
  assert.equal(conversation.mark(pending.id, 'cancelled'), null);
  assert.equal(conversation.mark(pending.id, 'answered'), null);
  await released;
  const resumed = await open(tab);
  assert.deepEqual(conversationFor(resumed).snapshot(), [{ ...pending, status: 'interrupted' }]);
  await resumed.dispose();
});

test('without Web Locks, session-only copies remain separate and preserve a refresh', async () => {
  const legacy = JSON.stringify([{ role: 'user', content: '旧内容不丢' }]);
  const storage = storageFixture({ [key]: legacy }), tabA = storageFixture();
  const open = sessionStorage => createConversationScope({ key, storage, sessionStorage, locks: null });
  const scopeA = await open(tabA), a = conversationFor(scopeA);
  assert.equal(scopeA.mode, 'session');
  a.append('assistant', '复制前');
  const tabB = tabA.duplicate(), scopeB = await open(tabB), b = conversationFor(scopeB);
  a.append('assistant', 'A 私有回复');b.append('assistant', 'B 私有回复');
  await scopeA.dispose();
  const refreshedA = await open(tabA);
  assert.equal(conversationFor(refreshedA).snapshot().at(-1).content, 'A 私有回复');
  assert.equal(b.snapshot().at(-1).content, 'B 私有回复');
  assert.equal(storage.getItem(key), legacy);
  assert.equal(storage.values.size, 1, 'unsafe shared persistence is never used without a lock');
  await Promise.all([refreshedA.dispose(), scopeB.dispose()]);
});

test('blocked stores or failed lock acquisition retain a private copy without poisoning the legacy data', async () => {
  const legacy = JSON.stringify([{ role: 'assistant', content: '现有原文\n'.repeat(1000) }]);
  const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  const storage = storageFixture({ [key]: legacy });
  const scope = await createConversationScope({ key, storage, sessionStorage: blocked, locks: fakeLocks() });
  assert.equal(scope.mode, 'memory');
  const conversation = conversationFor(scope);
  assert.equal(conversation.snapshot()[0].content, JSON.parse(legacy)[0].content);
  conversation.append('user', '仍可以聊天');
  assert.equal(storage.getItem(key), legacy);
  await scope.dispose();
  const failedLock = await createConversationScope({ key, storage, sessionStorage: storageFixture(), locks: { request() { throw Error('unavailable'); } } });
  assert.equal(failedLock.mode, 'session');
  assert.equal(conversationFor(failedLock).snapshot()[0].content, JSON.parse(legacy)[0].content);
  await failedLock.dispose();
});

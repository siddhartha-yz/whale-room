import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../src/conversation.js';

function localStorageFixture(initial) {
  const values = new Map(Object.entries(initial ?? {}));
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('legacy history retains the latest 30 original texts without a new content limit', () => {
  const originals = Array.from({ length: 31 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user', content: index === 30 ? `  原文\n${'鲸'.repeat(12_000)}\n ` : `旧消息 ${index}`,
  }));
  const storage = localStorageFixture({ room: JSON.stringify(originals), preferences: 'unchanged' });
  const conversation = createConversation({ storage, key: 'room' });
  const entries = conversation.snapshot();
  assert.equal(entries.length, 30);
  assert.deepEqual(entries.map(({ role, content }) => ({ role, content })), originals.slice(-30));
  assert.ok(entries.every((entry) => entry.status === 'answered' && entry.id));
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 30);
  assert.equal(storage.getItem('preferences'), 'unchanged');
  assert.deepEqual(createConversation({ storage, key: 'room' }).snapshot(), entries, 'stable ids survive migration and reload');
});

test('model history includes only answered text and applies its limit after filtering delivery states', () => {
  const conversation = createConversation({ storage: null });
  const pending = conversation.append('user', '这个请求还在等回复', { status: 'pending' });
  conversation.append('assistant', '之前已经说过的话');
  for (const status of ['cancelled', 'interrupted', 'failed']) conversation.append('user', `不能作为偏好：${status}`, { status });
  assert.deepEqual(conversation.modelHistory(), [{ role: 'assistant', content: '之前已经说过的话' }]);
  conversation.mark(pending.id, 'answered');
  assert.deepEqual(conversation.modelHistory(), [
    { role: 'user', content: '这个请求还在等回复' }, { role: 'assistant', content: '之前已经说过的话' },
  ]);
  assert.deepEqual(conversation.modelHistory(1), [{ role: 'assistant', content: '之前已经说过的话' }]);
  assert.deepEqual(conversation.modelHistory(0), []);
  assert.equal(conversation.snapshot().length, 5, 'delivery statuses stay visible in local history');
});

test('reload changes pending to interrupted without inventing an assistant response or dropping user text', () => {
  const storage = localStorageFixture();
  const first = createConversation({ storage, key: 'room' });
  const entry = first.append('user', '先别离开这里。', { status: 'pending' });
  const reloaded = createConversation({ storage, key: 'room' });
  assert.deepEqual(reloaded.snapshot(), [{ ...entry, status: 'interrupted' }]);
  assert.deepEqual(reloaded.modelHistory(), []);
  assert.deepEqual(JSON.parse(storage.getItem('room')), [{ ...entry, status: 'interrupted' }]);
  assert.equal(reloaded.mark(entry.id, 'answered'), null, 'a late completion cannot revive an interrupted entry');
});

test('cancellation is final, and late marks after clearing or retention eviction cannot rebuild text', () => {
  const changes = [];
  const conversation = createConversation({ storage: null, onChange: (entries) => changes.push(entries) });
  const entry = conversation.append('user', '被取消的请求', { status: 'pending' });
  assert.equal(conversation.mark(entry.id, 'cancelled').status, 'cancelled');
  const changedCount = changes.length;
  assert.equal(conversation.mark(entry.id, 'answered'), null);
  assert.equal(conversation.mark(entry.id, 'cancelled').status, 'cancelled');
  assert.equal(changes.length, changedCount, 'a repeated completion callback is inert');
  assert.deepEqual(conversation.modelHistory(), []);
  conversation.clear();
  const clearedCount = changes.length;
  assert.equal(conversation.mark(entry.id, 'failed'), null);
  assert.equal(changes.length, clearedCount);
  assert.deepEqual(conversation.snapshot(), []);
  const evicted = conversation.append('user', '最旧请求', { status: 'pending' });
  for (let index = 0; index < 30; index++) conversation.append('user', `新请求 ${index}`, { status: index % 2 ? 'failed' : 'pending' });
  assert.equal(conversation.snapshot().length, 30, 'all states count toward the existing 30-entry window');
  assert.equal(conversation.mark(evicted.id, 'answered'), null);
  assert.deepEqual(conversation.modelHistory(), []);
});

test('returned entries and onChange snapshots cannot mutate stored conversation state', () => {
  const storage = localStorageFixture();
  const conversation = createConversation({ storage, key: 'room', onChange: (entries) => { entries[0].content = 'external mutation'; } });
  const entry = conversation.append('user', '保留这句话', { status: 'pending' });
  entry.content = 'changed returned entry';
  conversation.snapshot()[0].status = 'answered';
  assert.equal(conversation.snapshot()[0].content, '保留这句话');
  assert.deepEqual(conversation.modelHistory(), []);
  const marked = conversation.mark(entry.id, 'answered');
  marked.status = 'failed';
  assert.equal(conversation.snapshot()[0].status, 'answered');
  assert.equal(JSON.parse(storage.getItem('room'))[0].content, '保留这句话');
});

test('corrupt or unavailable storage and a throwing default storage getter leave an usable in-memory conversation', () => {
  for (const raw of ['not json', '{"unexpected":true}']) {
    assert.deepEqual(createConversation({ storage: { getItem: () => raw } }).snapshot(), []);
  }
  const storage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('full'); } };
  const conversation = createConversation({ storage });
  const entry = conversation.append('user', '仍然可以对话', { status: 'pending' });
  conversation.mark(entry.id, 'answered');
  assert.equal(conversation.modelHistory()[0].content, '仍然可以对话');
  assert.doesNotThrow(() => conversation.clear());
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('disabled getter'); } });
    const memoryOnly = createConversation();
    assert.equal(memoryOnly.append('assistant', '本地存储被禁用时也可运行').status, 'answered');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});

test('invalid roles are filtered, duplicate ids are repaired, and unknown delivery state stays out of model history', () => {
  const storage = localStorageFixture({ room: JSON.stringify([
    { id: 'same', role: 'user', content: '有效旧文本' },
    { id: 'same', role: 'assistant', content: '另一条有效文本', status: 'answered' },
    { role: 'user', content: '状态损坏但文字保留', status: 'unknown' },
    { role: 'system', content: '不是已有UI角色' }, { role: 'user', content: 1 },
  ]) });
  const conversation = createConversation({ storage, key: 'room' });
  assert.equal(conversation.snapshot().length, 3);
  assert.equal(new Set(conversation.snapshot().map(({ id }) => id)).size, 3);
  assert.equal(conversation.snapshot()[2].status, 'interrupted');
  assert.equal(conversation.modelHistory().length, 2);
});

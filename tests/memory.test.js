import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, proactivePreference } from '../src/memory.js';
import { validateMemoryPatch } from '../shared/memory.js';

const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
const patch = (value, evidence, { kind = 'preference', scope = 'persistent', replacesId = null } = {}) => ({
  set: [{ kind, value, evidence, scope, replacesId }], forget: [],
});
const apply = (store, value, message, options) => store.applyPatch(patch(value, message, options), { message, expectedRevision: store.snapshot().revision });

test('memory patches require current-user evidence and known correction/deletion targets', () => {
  assert.throws(() => validateMemoryPatch(patch('阿禾', '叫我阿禾', { kind: 'name' }), { message: '你好' }), /来源/);
  assert.throws(() => validateMemoryPatch(patch('quiet', '别主动说话', { kind: 'proactive', replacesId: 'invented' }), { message: '别主动说话' }), /来源/);
  assert.throws(() => validateMemoryPatch({ set: [], forget: [{ id: 'invented', evidence: '忘了吧' }] }, { message: '忘了吧' }), /来源/);
  assert.throws(() => validateMemoryPatch(patch('aggressive', '别主动说话', { kind: 'proactive' }), { message: '别主动说话' }), /来源/);
  assert.throws(() => validateMemoryPatch({ ...patch('短一点', '以后短一点'), events: ['已经去了窗边'] }, { message: '以后短一点' }), /来源/);
  assert.throws(() => validateMemoryPatch({ set: Array(4).fill(patch('短一点', '以后短一点').set[0]), forget: [] }, { message: '以后短一点' }), /来源/);
});

test('explicit preferences and source quotes survive refresh while inspection storage is separate', () => {
  const local = storage(), session = storage();
  const options = { storage: local, sessionStorage: session, key: 'normal' };
  const first = createMemoryStore(options);
  assert.equal(apply(first, '阿澈', '以后叫我阿澈', { kind: 'name' }).applied, true);
  const restored = createMemoryStore(options);
  assert.deepEqual(restored.snapshot().entries, first.snapshot().entries);
  assert.equal(restored.snapshot().entries[0].evidence, '以后叫我阿澈');
  const inspection = createMemoryStore({ ...options, key: 'inspection' });
  assert.deepEqual(inspection.snapshot().entries, []);
  inspection.clear();
  assert.equal(restored.snapshot().entries.length, 1);
});

test('today expires at local midnight, session survives refresh but not a new tab session', () => {
  const local = storage(), session = storage();
  let now = new Date(2030, 0, 2, 23, 59).getTime();
  const options = { storage: local, sessionStorage: session, now: () => now };
  const store = createMemoryStore(options);
  apply(store, 'quiet', '以后别主动说话', { kind: 'proactive' });
  apply(store, 'allowed', '今天可以主动找我', { kind: 'proactive', scope: 'today', replacesId: store.snapshot().entries[0].id });
  assert.equal(proactivePreference(store.snapshot(), { now }), 'allowed');
  const expires = store.snapshot().entries.at(-1).expiresAt;
  assert.equal(expires, new Date(2030, 0, 3).getTime());
  const revision = store.snapshot().revision;
  now = expires;
  assert.equal(proactivePreference(store.snapshot(), { now }), 'quiet');
  assert.notEqual(store.snapshot().revision, revision);
  assert.equal(store.applyPatch(patch('短一点', '以后短一点'), { message: '以后短一点', expectedRevision: revision }).reason, 'stale');
  apply(store, 'allowed', '现在可以主动找我', { kind: 'proactive', scope: 'session' });
  assert.equal(proactivePreference(createMemoryStore(options).snapshot(), { now }), 'allowed');
  assert.equal(proactivePreference(createMemoryStore({ ...options, sessionStorage: storage() }).snapshot(), { now }), 'quiet');
});

test('deletion and clear invalidate late patches; undo is local and never persists deleted content', () => {
  const local = storage(), session = storage();
  const changes = [];
  const options = { storage: local, sessionStorage: session, key: 'memory', onChange: value => changes.push(value) };
  const store = createMemoryStore(options);
  apply(store, '短一点', '以后回复短一点');
  const before = store.snapshot(), removed = store.remove(before.entries[0].id);
  assert.equal(removed.canUndo, true);
  assert.equal(store.applyPatch(patch('阿澈', '以后叫我阿澈', { kind: 'name' }), { message: '以后叫我阿澈', expectedRevision: before.revision }).reason, 'stale');
  assert.equal(local.getItem('memory').includes('短一点'), false);
  assert.equal(createMemoryStore(options).snapshot().canUndo, false);
  assert.deepEqual(store.undo().entries, before.entries);
  const old = store.snapshot().revision;
  store.clear();
  assert.equal(store.applyPatch(patch('短一点', '以后回复短一点'), { message: '以后回复短一点', expectedRevision: old }).reason, 'stale');
  assert.equal(store.undo().entries.length, 1);
  assert.equal(store.snapshot().canUndo, false);
  assert.ok(changes.length >= 5);
});

test('another store deletion and corrected names cannot resurrect stale memory', () => {
  const options = { storage: storage(), sessionStorage: storage() };
  const first = createMemoryStore(options), second = createMemoryStore(options);
  apply(first, '阿澈', '以后叫我阿澈', { kind: 'name' });
  const old = first.snapshot();
  apply(second, '阿禾', '改叫阿禾吧', { kind: 'name', replacesId: old.entries[0].id });
  assert.deepEqual(first.snapshot().entries.map(entry => entry.value), ['阿禾']);
  second.clear();
  assert.equal(first.applyPatch(patch('阿澈', '以后叫我阿澈', { kind: 'name' }), { message: '以后叫我阿澈', expectedRevision: old.revision }).reason, 'stale');
  assert.deepEqual(first.snapshot().entries, []);
});

test('failed persistence never reports a saved memory or changes the prior snapshot', () => {
  const local = storage();
  const store = createMemoryStore({ storage: local, sessionStorage: storage() });
  apply(store, '阿澈', '以后叫我阿澈', { kind: 'name' });
  const before = store.snapshot();
  local.setItem = () => { throw new Error('quota'); };
  assert.equal(apply(store, '短一点', '以后回复短一点').reason, 'storage');
  assert.deepEqual(store.snapshot(), before);
  assert.throws(() => store.clear(), /没有保存成功/);
  assert.deepEqual(store.snapshot(), before);
});

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

test('an independent session write cannot remove another session quiet override, even with an interleaved shared write', () => {
  for (const interleaved of [false, true]) {
    const local = storage(), sessionA = storage(), sessionB = storage();
    const a = createMemoryStore({ storage: local, sessionStorage: sessionA });
    const b = createMemoryStore({ storage: local, sessionStorage: sessionB });
    apply(a, 'allowed', '以后可以主动聊天', { kind: 'proactive' });
    const quiet = () => assert.equal(apply(a, 'quiet', '这次先别主动说话', { kind: 'proactive', scope: 'session' }).applied, true);
    if (interleaved) {
      const write = local.setItem;
      local.setItem = (key, value) => { local.setItem = write; quiet(); write(key, value); };
    } else quiet();
    assert.equal(apply(b, '阿禾', '以后叫我阿禾', { kind: 'name' }).applied, true);
    assert.equal(proactivePreference(a.snapshot()), 'quiet');
    assert.equal(proactivePreference(createMemoryStore({ storage: local, sessionStorage: sessionA }).snapshot()), 'quiet');
    assert.equal(proactivePreference(b.snapshot()), 'allowed');
    assert.equal(b.snapshot().entries.some(entry => entry.scope === 'session'), false);
    assert.equal(local.getItem('room-companion-memory-v1').includes('这次先别主动说话'), false);
  }
});

test('legacy session quotes migrate on mutation and a private empty tombstone prevents fallback after deletion', () => {
  const local = storage(), session = storage(), key = 'legacy';
  session.setItem(`${key}:session`, 'session-a');
  const legacy = { revision: 'legacy-1', entries: [
    { id: 'quiet-a', kind: 'proactive', value: 'quiet', scope: 'session', evidence: '本次不要主动聊天', createdAt: 10, expiresAt: null, sessionId: 'session-a' },
    { id: 'preference-b', kind: 'preference', value: '本页短一点', scope: 'session', evidence: '本页回答短一点', createdAt: 11, expiresAt: null, sessionId: 'session-b' },
  ] };
  local.setItem(key, JSON.stringify(legacy));
  const a = createMemoryStore({ storage: local, sessionStorage: session, key });
  const b = createMemoryStore({ storage: local, sessionStorage: storage(), key });
  assert.equal(proactivePreference(a.snapshot()), 'quiet');
  apply(b, '阿禾', '以后叫我阿禾', { kind: 'name' });
  assert.deepEqual(Object.keys(JSON.parse(local.getItem(key))).sort(), ['entries', 'revision']);
  assert.equal(proactivePreference(a.snapshot()), 'quiet');
  a.remove('quiet-a');
  assert.equal(local.getItem(key).includes('本次不要主动聊天'), false);
  assert.equal(local.getItem(key).includes('本页回答短一点'), true);
  // An old shared record can be written by another already-open page. The
  // explicit empty private record must not re-import this deleted preference.
  local.setItem(key, JSON.stringify(legacy));
  assert.equal(proactivePreference(createMemoryStore({ storage: local, sessionStorage: session, key }).snapshot()), null);
  a.clear();
  assert.equal(local.getItem(key).includes('本次不要主动聊天'), false);
});

test('a failed mixed durable/session commit keeps quiet across refresh, including failed rollback', () => {
  for (const failure of ['shared', 'private-final-and-rollback']) {
    const local = storage(), session = storage(), options = { storage: local, sessionStorage: session, key: 'mixed' };
    const store = createMemoryStore(options);
    apply(store, 'allowed', '以后可以主动聊天', { kind: 'proactive' });
    apply(store, 'quiet', '本次别主动聊天', { kind: 'proactive', scope: 'session' });
    const before = store.snapshot();
    const writeShared = local.setItem, writePrivate = session.setItem;
    let sharedWrites = 0, privateWrites = 0;
    local.setItem = (key, value) => {
      if (failure === 'shared' || ++sharedWrites > 1) throw new Error('quota');
      writeShared(key, value);
    };
    session.setItem = (key, value) => {
      if (failure !== 'shared' && ++privateWrites > 1) throw new Error('denied');
      writePrivate(key, value);
    };
    const message = '以后叫我阿禾，本次可以主动聊';
    const mixed = { set: [patch('阿禾', message, { kind: 'name' }).set[0], patch('allowed', message, { kind: 'proactive', scope: 'session' }).set[0]], forget: [] };
    assert.equal(store.applyPatch(mixed, { message, expectedRevision: before.revision }).reason, 'storage');
    assert.deepEqual(store.snapshot().entries, before.entries);
    assert.deepEqual(createMemoryStore(options).snapshot().entries, before.entries);
    assert.equal(proactivePreference(store.snapshot()), 'quiet');
    if (failure === 'private-final-and-rollback') {
      // A retry that still cannot write shared storage must not discard the
      // fallback retained by the first partially failed transaction.
      session.setItem = writePrivate;
      local.setItem = () => { throw new Error('still denied'); };
      assert.equal(store.applyPatch(mixed, { message, expectedRevision: store.snapshot().revision }).reason, 'storage');
      assert.deepEqual(createMemoryStore(options).snapshot().entries, before.entries);
    }
    local.setItem = writeShared; session.setItem = writePrivate;
    store.clear();
    assert.equal(local.getItem('mixed').includes('本次别主动聊天'), false);
    assert.equal(session.getItem('mixed:entries').includes('本次别主动聊天'), false);
  }
});

test('private storage denial preserves the prior session constraint and does not block independent durable writes', () => {
  const local = storage(), session = storage(), options = { storage: local, sessionStorage: session };
  const store = createMemoryStore(options);
  apply(store, 'quiet', '本次安静一点', { kind: 'proactive', scope: 'session' });
  const before = store.snapshot();
  session.setItem = () => { throw new Error('quota'); };
  assert.equal(apply(store, 'allowed', '本次可以主动聊', { kind: 'proactive', scope: 'session' }).reason, 'storage');
  assert.deepEqual(store.snapshot(), before);
  assert.equal(apply(store, '阿禾', '以后叫我阿禾', { kind: 'name' }).applied, true);
  assert.equal(proactivePreference(createMemoryStore(options).snapshot()), 'quiet');
});

test('a full shared list cannot evict private constraints or lose hidden durable entries during edit and undo', () => {
  const local = storage(), session = storage();
  let clock = 100;
  const a = createMemoryStore({ storage: local, sessionStorage: session, key: 'bounded', now: () => ++clock });
  const b = createMemoryStore({ storage: local, sessionStorage: storage(), key: 'bounded', now: () => ++clock });
  apply(a, 'quiet', '本次别主动聊', { kind: 'proactive', scope: 'session' });
  for (let i = 0; i < 12; i++) assert.equal(apply(b, `习惯${i}`, `以后记住习惯${i}`).applied, true);
  assert.equal(a.snapshot().entries.length, 12);
  assert.equal(proactivePreference(a.snapshot()), 'quiet');
  const visible = a.snapshot().entries.find(entry => entry.scope === 'persistent');
  a.remove(visible.id);
  assert.equal(JSON.parse(local.getItem('bounded')).entries.length, 11);
  a.undo();
  assert.equal(JSON.parse(local.getItem('bounded')).entries.length, 12);
  a.clear();
  assert.equal(JSON.parse(local.getItem('bounded')).entries.length, 0);
  assert.equal(a.snapshot().entries.length, 0);
  a.undo();
  assert.equal(JSON.parse(local.getItem('bounded')).entries.length, 12);
  assert.equal(proactivePreference(a.snapshot()), 'quiet');
});

test('twelve inaccessible legacy session rows cannot block durable saves or erase a live legacy quiet', () => {
  const local = storage(), key = 'legacy-full', ownerSession = storage();
  ownerSession.setItem(`${key}:session`, 'legacy-owner');
  const legacy = Array.from({ length: 12 }, (_, index) => ({
    id: `old-${index}`, kind: index === 11 ? 'proactive' : 'preference', value: index === 11 ? 'quiet' : `会话偏好${index}`,
    scope: 'session', evidence: index === 11 ? '本次先不要主动聊天' : `本次记住会话偏好${index}`,
    createdAt: 100 + index, expiresAt: null, sessionId: 'legacy-owner',
  }));
  local.setItem(key, JSON.stringify({ revision: 'old-full', entries: legacy }));
  const independent = createMemoryStore({ storage: local, sessionStorage: storage(), key });
  assert.equal(independent.snapshot().entries.length, 0);
  assert.equal(apply(independent, '阿禾', '以后叫我阿禾', { kind: 'name' }).applied, true);
  const owner = createMemoryStore({ storage: local, sessionStorage: ownerSession, key });
  assert.equal(proactivePreference(owner.snapshot()), 'quiet');
  assert.equal(owner.snapshot().entries.length, 12);
  owner.remove('old-0');
  const record = JSON.parse(local.getItem(key));
  assert.deepEqual(record.entries.map(entry => entry.value), ['阿禾']);
  assert.equal(record.legacySessions, undefined);
  assert.equal(proactivePreference(createMemoryStore({ storage: local, sessionStorage: ownerSession, key }).snapshot()), 'quiet');
});

test('a failed durable relaxation cannot return through a later unrelated edit', () => {
  for (const foreignEdit of [false, true]) {
    const local = storage(), session = storage(), options = { storage: local, sessionStorage: session, key: 'retry' };
    let clock = 100;
    options.now = () => ++clock;
    const store = createMemoryStore(options);
    apply(store, 'quiet', '本次别主动聊天', { kind: 'proactive', scope: 'session' });
    const writeShared = local.setItem, removeShared = local.removeItem, writePrivate = session.setItem;
    let writes = 0;
    local.removeItem = () => { throw new Error('rollback denied'); };
    session.setItem = (key, value) => { if (++writes > 1) throw new Error('final write denied'); writePrivate(key, value); };
    assert.equal(apply(store, 'allowed', '以后可以主动聊天', { kind: 'proactive' }).reason, 'storage');
    session.setItem = writePrivate; local.removeItem = removeShared;
    if (foreignEdit) {
      const b = createMemoryStore({ ...options, sessionStorage: storage() });
      apply(b, '阿禾', '以后叫我阿禾', { kind: 'name' });
    }
    const result = apply(store, '回复简短', '本次回复简短', { scope: 'session' });
    assert.equal(result.applied, !foreignEdit);
    assert.equal(proactivePreference(createMemoryStore(options).snapshot()), 'quiet');
    if (foreignEdit) {
      assert.equal(result.reason, 'storage');
      assert.equal(JSON.parse(local.getItem('retry')).entries.some(entry => entry.value === '阿禾'), true);
      store.clear();
      assert.deepEqual(createMemoryStore(options).snapshot().entries, []);
      store.undo();
      assert.equal(proactivePreference(store.snapshot()), 'quiet');
      assert.equal(store.snapshot().entries.some(entry => entry.value === '阿禾'), true);
      assert.equal(store.snapshot().entries.some(entry => entry.value === 'allowed'), false);
    } else assert.equal(local.getItem('retry'), null);
    local.setItem = writeShared;
  }
});

test('a session replacement preserves the shared today policy for other pages and across refresh', () => {
  const local = storage(), sessionA = storage(), sessionB = storage();
  let now = new Date(2030, 0, 2, 12).getTime();
  const options = { storage: local, now: () => now };
  const a = createMemoryStore({ ...options, sessionStorage: sessionA });
  const b = createMemoryStore({ ...options, sessionStorage: sessionB });
  apply(b, 'allowed', '今天可以主动聊天', { kind: 'proactive', scope: 'today' });
  const underlying = a.snapshot().entries[0];
  now += 1000;
  assert.equal(apply(a, 'quiet', '这次先不要主动说话', { kind: 'proactive', scope: 'session', replacesId: underlying.id }).applied, true);
  assert.equal(proactivePreference(a.snapshot(), { now }), 'quiet');
  assert.equal(proactivePreference(b.snapshot(), { now }), 'allowed');
  assert.equal(JSON.parse(local.getItem('room-companion-memory-v1')).entries[0].id, underlying.id);
  assert.equal(proactivePreference(createMemoryStore({ ...options, sessionStorage: sessionA }).snapshot(), { now }), 'quiet');
  now = underlying.expiresAt;
  assert.equal(proactivePreference(b.snapshot(), { now }), null);
  assert.equal(proactivePreference(createMemoryStore({ ...options, sessionStorage: sessionA }).snapshot(), { now }), 'quiet');
  assert.equal(proactivePreference(createMemoryStore({ ...options, sessionStorage: storage() }).snapshot(), { now }), null);
});

test('shared quiet stays effective above the combined view cap without losing hidden session entries', () => {
  const local = storage(), session = storage(), key = 'private-full';
  let clock = 100;
  const options = { storage: local, key, now: () => ++clock };
  const a = createMemoryStore({ ...options, sessionStorage: session });
  const b = createMemoryStore({ ...options, sessionStorage: storage() });
  for (let i = 0; i < 12; i++) assert.equal(apply(a, `本页习惯${i}`, `本次记住习惯${i}`, { scope: 'session' }).applied, true);
  apply(b, 'quiet', '以后别主动说话', { kind: 'proactive' });
  const before = a.snapshot();
  assert.equal(before.entries.length, 12);
  assert.equal(proactivePreference(before), 'quiet');
  const privateRows = () => JSON.parse(session.getItem(`${key}:entries`)).entries;
  const hidden = privateRows().find(entry => !before.entries.some(visible => visible.id === entry.id));
  assert.ok(hidden);
  const visible = before.entries.find(entry => entry.scope === 'session');
  a.remove(visible.id);
  assert.equal(privateRows().length, 11);
  assert.equal(privateRows().some(entry => entry.id === hidden.id), true);
  a.undo();
  assert.equal(privateRows().length, 12);
  const replace = a.snapshot().entries.find(entry => entry.scope === 'session');
  assert.equal(apply(a, '另一个本页习惯', '本次改成另一个习惯', { scope: 'session', replacesId: replace.id }).applied, true);
  assert.equal(privateRows().length, 12);
  assert.equal(privateRows().some(entry => entry.id === hidden.id), true);
  assert.equal(proactivePreference(createMemoryStore({ ...options, sessionStorage: session }).snapshot()), 'quiet');
  a.clear();
  assert.equal(privateRows().length, 0);
  assert.equal(JSON.parse(local.getItem(key)).entries.length, 0);
  a.undo();
  assert.equal(privateRows().length, 12);
  assert.equal(proactivePreference(a.snapshot()), 'quiet');
});

test('a partial failed commit does not mask a later external quiet policy or clear', () => {
  const local = storage(), session = storage(), key = 'external-after-failure';
  let clock = 100;
  const options = { storage: local, key, now: () => ++clock };
  const a = createMemoryStore({ ...options, sessionStorage: session });
  const b = createMemoryStore({ ...options, sessionStorage: storage() });
  apply(a, 'allowed', '以后可以主动聊天', { kind: 'proactive' });
  apply(a, '原来的本页习惯', '本次保留原习惯', { scope: 'session' });
  const writeShared = local.setItem, writePrivate = session.setItem;
  let sharedWrites = 0, privateWrites = 0;
  local.setItem = (key, value) => { if (++sharedWrites > 1) throw new Error('rollback denied'); writeShared(key, value); };
  session.setItem = (key, value) => { if (++privateWrites > 1) throw new Error('final denied'); writePrivate(key, value); };
  const message = '以后叫我失败名字，本次增加一个习惯';
  const mixed = { set: [patch('失败名字', message, { kind: 'name' }).set[0], patch('失败的本页习惯', message, { scope: 'session' }).set[0]], forget: [] };
  assert.equal(a.applyPatch(mixed, { message, expectedRevision: a.snapshot().revision }).reason, 'storage');
  local.setItem = writeShared; session.setItem = writePrivate;
  apply(b, 'quiet', '以后先不要主动说话', { kind: 'proactive' });
  assert.equal(proactivePreference(a.snapshot()), 'quiet');
  assert.equal(proactivePreference(createMemoryStore({ ...options, sessionStorage: session }).snapshot()), 'quiet');
  assert.equal(a.snapshot().entries.some(entry => entry.value === '失败名字'), false);
  b.clear();
  assert.deepEqual(a.snapshot().entries.map(entry => entry.value), ['原来的本页习惯']);
  assert.deepEqual(createMemoryStore({ ...options, sessionStorage: session }).snapshot().entries, a.snapshot().entries);
});

test('external edits keep a failed relaxation hidden but do not resurrect externally removed replacements', () => {
  const local = storage(), session = storage(), key = 'failed-replacement';
  let clock = 100;
  const options = { storage: local, key, now: () => ++clock };
  const a = createMemoryStore({ ...options, sessionStorage: session });
  const b = createMemoryStore({ ...options, sessionStorage: storage() });
  apply(a, 'quiet', '以后别主动说话', { kind: 'proactive' });
  apply(a, '本页原习惯', '本次记住原习惯', { scope: 'session' });
  const writeShared = local.setItem, writePrivate = session.setItem;
  let sharedWrites = 0, privateWrites = 0;
  local.setItem = (key, value) => { if (++sharedWrites > 1) throw new Error('rollback denied'); writeShared(key, value); };
  session.setItem = (key, value) => { if (++privateWrites > 1) throw new Error('final denied'); writePrivate(key, value); };
  const message = '以后可以主动聊天，本次增加习惯';
  const mixed = { set: [patch('allowed', message, { kind: 'proactive' }).set[0], patch('失败习惯', message, { scope: 'session' }).set[0]], forget: [] };
  assert.equal(a.applyPatch(mixed, { message, expectedRevision: a.snapshot().revision }).reason, 'storage');
  local.setItem = writeShared; session.setItem = writePrivate;
  apply(b, '阿禾', '以后叫我阿禾', { kind: 'name' });
  assert.equal(proactivePreference(a.snapshot()), 'quiet');
  assert.equal(a.snapshot().entries.some(entry => entry.value === '阿禾'), true);
  assert.equal(proactivePreference(createMemoryStore({ ...options, sessionStorage: session }).snapshot()), 'quiet');
  const failedReplacement = b.snapshot().entries.find(entry => entry.kind === 'proactive');
  b.remove(failedReplacement.id);
  assert.equal(proactivePreference(a.snapshot()), null);
  assert.equal(a.snapshot().entries.some(entry => entry.value === '本页原习惯'), true);
  b.clear();
  assert.deepEqual(a.snapshot().entries.map(entry => entry.value), ['本页原习惯']);
});

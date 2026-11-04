import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityJournal, sanitizeActivityJournal } from '../src/activity-journal.js';

const now = Date.parse('2026-11-04T14:00:00Z');
const hour = 3_600_000, week = 7 * 24 * hour;
const activity = {
  id: 'reading-1', activity: '在沙发上读书', phase: 'dwelling', startedAt: now - 30_000,
  elapsedVisibleSeconds: 30, segmentVisibleSeconds: 30, dwellSeconds: 120,
  world: { posture: 'seated', activity: { id: 'reading-1', kind: 'read', phase: 'reading', heldObject: null } },
  feedback: [{ id: 1, action: 'read', status: 'started', detail: '开始翻看书页', source: 'autonomy', position: { x: 1, z: 2 } }],
};
const record = (index) => ({
  id: `a-${index}`, activity: '看书', outcome: 'completed', endReason: 'changed',
  startedAt: now - 120_000, endedAt: now - index * 1_000, elapsedVisibleSeconds: 120,
  feedback: [],
});

test('journal round-trips bounded observations, current intent, speech gate and rolling request times', () => {
  const storage = new Map();
  const journal = createActivityJournal({ storage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) }, now: () => now });
  journal.save({
    version: 1, currentActivity: activity, recentActivities: [record(1)],
    requestTimes: [now - hour - 1, now - 40_000, now - 10_000], lastUserAt: now - 60_000,
    speech: { lastSpeechAt: now - 30_000, unansweredProactive: true },
    memory: { privateProfile: 'must not be stored in this journal' },
  });
  const value = journal.load();
  assert.equal(value.currentActivity.elapsedVisibleSeconds, 30);
  assert.equal(value.currentActivity.dwellComplete, false);
  assert.equal(value.currentActivity.world.activity.phase, 'reading');
  assert.deepEqual(value.currentActivity.feedback[0].position, { x: 1, z: 2 });
  assert.deepEqual(value.requestTimes, [now - 40_000, now - 10_000]);
  assert.equal(value.speech.unansweredProactive, true);
  assert.equal('memory' in value, false);
});

test('journal bounds retention and repairs invalid fields instead of creating completed facts', () => {
  const result = sanitizeActivityJournal({
    version: 1,
    currentActivity: { ...activity, world: null, segmentVisibleSeconds: 1, elapsedVisibleSeconds: -10, dwellComplete: true },
    recentActivities: [record(1), { ...record(2), endedAt: now - week - 1 }, ...Array.from({ length: 30 }, (_, i) => record(i + 3))],
    requestTimes: [NaN, now + 100_000], speech: { lastSpeechAt: now + 20_000, unansweredProactive: 'yes' },
  }, now);
  assert.equal(result.currentActivity.dwellComplete, false);
  assert.equal(result.currentActivity.elapsedVisibleSeconds, 1);
  assert.deepEqual(result.currentActivity.world, {});
  assert.equal(result.recentActivities.length, 24);
  assert.deepEqual(result.requestTimes, [now]);
  assert.equal(result.speech.lastSpeechAt, now);
  assert.equal(result.speech.unansweredProactive, false);
  const expired = sanitizeActivityJournal({ version: 1, currentActivity: { ...activity, startedAt: now - week - 1 }, recentActivities: [{ ...record(0), endedAt: now - week - 1 }] }, now);
  assert.equal(expired.currentActivity, null);
  assert.deepEqual(expired.recentActivities, []);
});

test('corrupt, future-version and unavailable storage fail quietly and clear only the selected key', () => {
  for (const raw of ['{broken', '{"version":99}', 'x'.repeat(100_001)]) {
    assert.equal(createActivityJournal({ storage: { getItem: () => raw } }).load(), null);
  }
  const unavailable = createActivityJournal({ storage: { getItem() { throw Error('disabled'); }, setItem() { throw Error('quota'); }, removeItem() { throw Error('disabled'); } } });
  assert.equal(unavailable.load(), null);
  assert.doesNotThrow(() => unavailable.save({ version: 1 }));
  assert.doesNotThrow(() => unavailable.clear());
  let removed;
  createActivityJournal({ storage: { removeItem: (key) => { removed = key; } }, key: 'inspection-journal' }).clear();
  assert.equal(removed, 'inspection-journal');
});

test('loading an old observation preserves savedAt; only a new save without a timestamp stamps the current time', () => {
  let clock = now, raw;
  const journal = createActivityJournal({
    storage: { getItem: () => raw, setItem: (_key, value) => { raw = value; } }, now: () => clock,
  });
  journal.save({ version: 1, currentActivity: activity });
  assert.equal(journal.load().savedAt, now);
  clock += hour;
  const previous = journal.load();
  assert.equal(previous.savedAt, now, 'an old activity is not a new observation just because chat reads it');
  assert.equal(previous.currentActivity.elapsedVisibleSeconds, 30);
  journal.save(previous);
  assert.equal(journal.load().savedAt, now, 'explicitly supplied observation time survives a round-trip');
  journal.save({ version: 1, currentActivity: activity });
  assert.equal(journal.load().savedAt, clock, 'a new controller checkpoint receives its actual save time');
});

test('future savedAt is clamped while missing or corrupt savedAt remains unknown on load', () => {
  assert.equal(sanitizeActivityJournal({ version: 1, savedAt: now + hour }, now).savedAt, now);
  assert.equal(sanitizeActivityJournal({ version: 1, savedAt: now - hour }, now).savedAt, now - hour);
  for (const savedAt of [undefined, null, -1, NaN, Infinity, 'yesterday']) {
    const journal = createActivityJournal({ storage: { getItem: () => JSON.stringify({ version: 1, savedAt }) }, now: () => now });
    assert.equal(journal.load().savedAt, null);
  }
});

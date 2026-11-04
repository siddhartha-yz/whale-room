import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutonomyOwner } from '../src/autonomy-owner.js';
import { createAutonomyController } from '../src/autonomy.js';
import { createActivityJournal } from '../src/activity-journal.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(setImmediate);

// A controllable exclusive lock queue, with the same abort distinction as Web
// Locks: queued requests abort; an acquired callback keeps its lock until return.
function fakeLocks() {
  const resources = new Map();
  const drain = resource => {
    if (resource.held || !resource.queue.length) return;
    const job = resource.queue.shift(); resource.held = true;
    job.signal.removeEventListener('abort', job.abort);
    Promise.resolve().then(() => job.callback({ name: job.name, mode: 'exclusive' }))
      .then(job.resolve, job.reject).finally(() => { resource.held = false; drain(resource); });
  };
  return { request(name, { signal }, callback) {
    if (signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    let resource = resources.get(name);
    if (!resource) { resource = { held: false, queue: [] }; resources.set(name, resource); }
    return new Promise((resolve, reject) => {
      const job = { name, signal, callback, resolve, reject };
      job.abort = () => {
        resource.queue = resource.queue.filter(entry => entry !== job);
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      signal.addEventListener('abort', job.abort, { once: true });
      resource.queue.push(job); drain(resource);
    });
  } };
}

test('only one page creates a controller and cleanup finishes before ownership transfers', async () => {
  const locks = fakeLocks(), cleanup = deferred(), events = [];
  const a = createAutonomyOwner({ locks, onAcquire: () => { events.push('a:start'); return async () => { events.push('a:cleanup'); await cleanup.promise; events.push('a:stopped'); }; } });
  const b = createAutonomyOwner({ locks, onAcquire: () => { events.push('b:start'); return () => events.push('b:stopped'); } });
  a.setEnabled(true); b.setEnabled(true); await flush();
  assert.equal(a.isOwner(), true); assert.equal(b.isOwner(), false);
  assert.deepEqual(events, ['a:start']);
  a.setEnabled(false); await flush();
  assert.deepEqual(events, ['a:start', 'a:cleanup']);
  assert.equal(b.isOwner(), false);
  cleanup.resolve(); await flush();
  assert.deepEqual(events, ['a:start', 'a:cleanup', 'a:stopped', 'b:start']);
  assert.equal(a.isOwner(), false); assert.equal(b.isOwner(), true);
  await Promise.all([a.dispose(), b.dispose()]);
});

test('queued disable/dispose cancels acquisition and rapid re-enable has only one owner callback', async () => {
  const locks = fakeLocks(), statuses = []; let acquisitions = 0;
  const a = createAutonomyOwner({ locks });
  const b = createAutonomyOwner({ locks, onAcquire: () => { acquisitions++; }, onStatus: value => statuses.push(value.status) });
  a.setEnabled(true); b.setEnabled(true); await flush();
  b.setEnabled(false); b.setEnabled(true); await flush();
  assert.equal(acquisitions, 0);
  await a.dispose(); await flush();
  assert.equal(acquisitions, 1); assert.equal(b.isOwner(), true);
  await b.dispose(); b.setEnabled(true); await flush();
  assert.equal(acquisitions, 1); assert.equal(b.isOwner(), false);
  assert.equal(statuses.at(-1), 'idle');
});

test('disabling during asynchronous acquisition still cleans up before releasing the lock', async () => {
  const locks = fakeLocks(), initialization = deferred(), cleanup = deferred(); let bStarted = false, cleaned = false;
  const a = createAutonomyOwner({ locks, onAcquire: () => initialization.promise });
  const b = createAutonomyOwner({ locks, onAcquire: () => { bStarted = true; } });
  a.setEnabled(true); b.setEnabled(true); await flush();
  const stopped = a.dispose();
  initialization.resolve(async () => { await cleanup.promise; cleaned = true; }); await flush();
  assert.equal(bStarted, false); assert.equal(cleaned, false);
  cleanup.resolve(); await stopped; await flush();
  assert.equal(cleaned, true); assert.equal(bStarted, true);
  await b.dispose();
});

test('missing Web Locks never starts parallel work and acquisition failures release the lock', async () => {
  let called = false; const states = [];
  const unavailable = createAutonomyOwner({ locks: null, onAcquire: () => { called = true; }, onStatus: value => states.push(value.status) });
  unavailable.setEnabled(true); await flush();
  assert.equal(called, false); assert.equal(unavailable.isOwner(), false); assert.equal(states.at(-1), 'unsupported');
  await unavailable.dispose();
  const locks = fakeLocks(), errors = [];
  const broken = createAutonomyOwner({ locks, onAcquire: () => { throw new Error('setup failed'); }, onStatus: value => errors.push(value) });
  const next = createAutonomyOwner({ locks });
  broken.setEnabled(true); next.setEnabled(true); await flush();
  assert.equal(broken.isOwner(), false); assert.equal(next.isOwner(), true);
  assert.equal(errors.at(-1).status, 'error'); assert.equal(errors.at(-1).error, 'setup failed');
  await Promise.all([broken.dispose(), next.dispose()]);
});

test('a waiting page loads the latest journal on acquisition and cannot overwrite a spent budget', async () => {
  const locks = fakeLocks(), values = new Map(); let clock = Date.now(), calls = 0;
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const makePage = () => {
    let controller;
    const owner = createAutonomyOwner({ locks, onAcquire: () => {
      controller = createAutonomyController({
        now: () => clock, journal: createActivityJournal({ storage, now: () => clock }),
        getSnapshot: () => ({ ready: true, idle: true, visible: true, typing: false, chatBusy: false, world: { posture: 'standing' }, feedback: [] }),
        fetchPlan: async () => { calls++; return { activity: '安静站着', reason: '本地测试', reply: '', expression: 'neutral', actions: [], dwellSeconds: 60 }; },
        onPlan: async () => ({ status: 'completed', feedback: [] }),
      });
      controller.start();
      return () => { controller.dispose(); };
    } });
    return { owner, controller: () => controller };
  };
  const a = makePage(), b = makePage();
  a.owner.setEnabled(true); b.owner.setEnabled(true); await flush();
  assert.equal(b.controller(), undefined);
  for (let index = 0; index < 24; index++) {
    assert.equal(a.controller().requestNow().ok, true); await flush(); clock += 10_000;
  }
  a.owner.setEnabled(false); await flush();
  assert.equal(b.owner.isOwner(), true);
  assert.equal(b.controller().getState().requestCount, 24);
  assert.equal(b.controller().requestNow().ok, false);
  assert.equal(calls, 24);
  assert.equal(createActivityJournal({ storage, now: () => clock }).load().requestTimes.length, 24);
  await Promise.all([a.owner.dispose(), b.owner.dispose()]);
});

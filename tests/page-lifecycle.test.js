import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageLifecycle } from '../src/page-lifecycle.js';
import { createRenderPresence } from '../src/render-presence.js';

test('resume cannot release a history gate and each persisted return restores its scope once', () => {
  const changes = [];
  const lifecycle = createPageLifecycle({ onChange: change => changes.push(change) });
  lifecycle.handle('visibilitychange', { hidden: true });
  lifecycle.handle('pagehide', { persisted: true, hidden: true });
  lifecycle.handle('freeze', { hidden: true });
  lifecycle.handle('resume', { hidden: false });
  assert.equal(lifecycle.isBlocked(), true);
  assert.equal(lifecycle.getState().inHistory, true);
  const restored = lifecycle.handle('pageshow', { persisted: true, hidden: false });
  assert.equal(restored.historyRestored, true);
  assert.equal(restored.blocked, false);
  assert.equal(lifecycle.handle('pageshow', { persisted: true, hidden: false }).historyRestored, false);
  assert.deepEqual(changes.map(({ type }) => type), ['visibilitychange', 'pagehide', 'freeze', 'resume', 'pageshow']);
  assert.equal(changes[2].previous.blocked, true);
  assert.equal(changes[2].state.blocked, true, 'a new freeze is observable even while already blocked');

  lifecycle.handle('pagehide', { persisted: true });
  assert.equal(lifecycle.handle('pageshow', { persisted: true }).historyRestored, true);
  assert.equal(lifecycle.handle('pageshow', { persisted: true }).historyRestored, false);
});

test('a pageshow or visible transition cannot override a freeze, and repeated events do not repeat effects', () => {
  let changes = 0;
  const lifecycle = createPageLifecycle({ onChange: () => changes++ });
  assert.equal(lifecycle.handle('pageshow', { persisted: true }).historyRestored, false, 'no prior departure to restore');
  lifecycle.handle('freeze');lifecycle.handle('freeze');
  lifecycle.handle('pagehide', { persisted: true });lifecycle.handle('pagehide', { persisted: true });
  assert.equal(changes, 2);
  assert.equal(lifecycle.handle('pageshow', { persisted: true, hidden: false }).historyRestored, true);
  assert.equal(lifecycle.isBlocked(), true, 'a frozen document remains blocked even after history restoration');
  lifecycle.handle('visibilitychange', { hidden: false });
  assert.equal(lifecycle.isBlocked(), true);
  lifecycle.handle('resume');lifecycle.handle('resume');
  assert.equal(lifecycle.isBlocked(), false);
  assert.equal(changes, 4);
});

test('non-persisted departure is terminal and cannot resurrect ownership from late lifecycle events', () => {
  const changes = [];
  const lifecycle = createPageLifecycle({ hidden: true, onChange: change => changes.push(change) });
  lifecycle.handle('pagehide', { persisted: false });
  const departed = lifecycle.getState();
  for (const type of ['pageshow', 'resume', 'visibilitychange', 'freeze', 'pagehide']) {
    const result = lifecycle.handle(type, { persisted: true, hidden: false });
    assert.equal(result.changed, false);
    assert.equal(result.historyRestored, false);
    assert.deepEqual(lifecycle.getState(), departed);
  }
  assert.equal(lifecycle.isBlocked(), true);
  assert.equal(changes.length, 1);
});

test('lifecycle restoration cannot reuse pre-freeze render evidence to reactivate an owner', () => {
  let now = 0, ownerEnabled = false;
  const presence = createRenderPresence({ now: () => now, wallNow: () => now });
  const lifecycle = createPageLifecycle({ onChange: () => presence.invalidate() });
  const refreshOwner = () => { ownerEnabled = !lifecycle.isBlocked() && presence.getState().active; };
  presence.frame();
  for (let count = 0; count < 11; count++) { now += 50;presence.frame(); }
  refreshOwner();assert.equal(ownerEnabled, true);

  lifecycle.handle('freeze');refreshOwner();assert.equal(ownerEnabled, false);
  lifecycle.handle('resume');refreshOwner();assert.equal(ownerEnabled, false);
  now += 50;presence.frame();
  for (let count = 0; count < 9; count++) { now += 50;presence.frame();refreshOwner();assert.equal(ownerEnabled, false); }
  now += 50;presence.frame();refreshOwner();assert.equal(ownerEnabled, true);
  assert.equal(presence.getState().deltaSeconds, 0, 'resumption does not simulate the frozen interval');
});

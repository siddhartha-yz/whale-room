import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutonomyController } from '../src/autonomy.js';
import { createActivityJournal } from '../src/activity-journal.js';

const baseTime = Date.parse('2026-11-04T18:00:00Z');
const quietPlan = { activity: '在沙发上安静看向窗边', reason: '保持刚才舒服的坐姿', reply: '',
  expression: 'neutral', actions: [], dwellSeconds: 240 };
const nextIntent = { activity: '稍后伸展', reason: '坐完这一段再换个姿势',
  actions: [{ type: 'stretch', target: 'none' }], after: 'dwell', dwellSeconds: 90 };
const copy = value => JSON.parse(JSON.stringify(value));

function fixture(t, { plan = quietPlan } = {}) {
  let clock = baseTime, raw = null, rejectWrites = false;
  const storage = { getItem: () => raw, setItem: (_key, value) => {
    if (rejectWrites) throw new Error('storage disabled'); raw = value;
  }, removeItem: () => { raw = null; } };
  const journal = createActivityJournal({ storage, now: () => clock });
  const snapshot = { ready: true, idle: true, visible: true, renderActive: true,
    typing: false, chatBusy: false, canSpeak: false, memory: { revision: 'memory-one', entries: [] },
    world: { position: { x: -.85, z: -1.71 }, posture: 'seated', gaze: 'window', activity: null },
    history: [], feedback: [] };
  const controllers = [], calls = [], executions = [];
  const create = (options = {}) => {
    const controller = createAutonomyController({ journal, now: () => clock, getSnapshot: () => snapshot,
      fetchPlan: async payload => { calls.push(payload); return copy(plan); },
      onPlan: async value => { executions.push(value); return { status: 'completed', feedback: [] }; }, ...options });
    controllers.push(controller); controller.start(); return controller;
  };
  t.after(() => controllers.forEach(controller => controller.dispose()));
  const hide = controller => {
    snapshot.visible = false; snapshot.renderActive = false; controller.pauseForHidden();
  };
  return { journal, snapshot, calls, executions, create, hide,
    show() { snapshot.visible = true; snapshot.renderActive = true; },
    advance(ms) { clock += ms; }, now: () => clock,
    failWrites() { rejectWrites = true; }, raw: () => raw,
    async begin(options) { const controller = create(options); clock += 12_000; await controller.tick(); return controller; },
    seal(controller) { hide(controller); return controller.dispose({ preserveQuietDwell: true }); },
  };
}

test('the observed short-gap case resumes its exact quiet segment with no hidden credit or extra request', async t => {
  const f = fixture(t), old = await f.begin();
  f.advance(21_575); await old.tick();
  const before = old.getState().currentActivity, proof = f.seal(old);
  assert.ok(proof);
  const sealed = f.journal.load();
  f.advance(511); f.show();
  const resumed = f.create({ quietDwellRecovery: proof }), state = resumed.getState();
  assert.equal(state.recoveredQuietDwell, true);
  assert.equal(state.status, 'resting'); assert.equal(state.activity, quietPlan.activity);
  assert.deepEqual(state.currentActivity, before);
  assert.equal(state.nextAt, f.now() + (240 - 21.575) * 1000);
  assert.equal(f.journal.load().recentActivities.length, 0, 'same-page reacquisition is not a reload interruption');
  assert.notEqual(f.journal.load().writerId, sealed.writerId);
  assert.notEqual(f.journal.load().revision, sealed.revision);
  assert.equal(f.calls.length, 1); assert.equal(f.executions.length, 1);
  f.advance(38_000); await resumed.tick(); assert.equal(f.calls.length, 1);
  f.advance(180_424); await resumed.tick(); assert.equal(f.calls.length, 1);
  f.advance(1); await resumed.tick(); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].autonomy.currentActivity.id, before.id);
  assert.ok(Math.abs(f.calls[1].autonomy.currentActivity.segmentVisibleSeconds - 240) < 1e-9);
  assert.equal(f.calls[1].autonomy.currentActivity.dwellComplete, true);
});

test('repeated short gaps preserve only newly observed time and never restore a pending intention', async t => {
  const f = fixture(t, { plan: { ...quietPlan, nextIntent } }), old = await f.begin();
  assert.ok(old.getState().nextIntent);
  f.advance(20_000); await old.tick();
  const proof = f.seal(old); f.advance(30_000); f.show();
  const resumed = f.create({ quietDwellRecovery: proof });
  assert.equal(resumed.getState().currentActivity.segmentVisibleSeconds, 20);
  assert.equal(resumed.getState().nextIntent, null);
  f.advance(10_000); await resumed.tick();
  const second = f.seal(resumed); f.advance(80_000); f.show();
  const again = f.create({ quietDwellRecovery: second });
  assert.equal(again.getState().recoveredQuietDwell, true);
  assert.equal(again.getState().currentActivity.segmentVisibleSeconds, 30);
  assert.equal(again.getState().nextAt, f.now() + 210_000);
  assert.equal(again.getState().nextIntent, null);
  assert.equal(f.calls.length, 1); assert.equal(f.executions.length, 1);
});

test('any intervening journal write invalidates the receipt, even at the same millisecond', async t => {
  const f = fixture(t), old = await f.begin(), proof = f.seal(old), sealed = f.journal.load();
  const receipt = f.journal.save(sealed);
  assert.equal(receipt.savedAt, sealed.savedAt);
  assert.notEqual(receipt.revision, sealed.revision);
  f.show(); const resumed = f.create({ quietDwellRecovery: proof });
  assert.equal(resumed.getState().recoveredQuietDwell, false);
  assert.equal(resumed.getState().currentActivity, null);
});

test('an intervening owner claims a new writer before any model work and the old page cannot revive its plan', async t => {
  const f = fixture(t), old = await f.begin(), proof = f.seal(old), sealed = f.journal.load();
  f.show(); const other = f.create();
  assert.notEqual(f.journal.load().writerId, sealed.writerId);
  assert.equal(f.calls.length, 1, 'taking ownership does not itself call the model');
  other.dispose();
  const resumed = f.create({ quietDwellRecovery: proof });
  assert.equal(resumed.getState().recoveredQuietDwell, false);
  assert.equal(resumed.getState().currentActivity, null);
  assert.equal(resumed.getState().requestCount, 1);
  assert.equal(f.journal.load().recentActivities.length, 1);
  assert.equal(f.journal.load().recentActivities[0].endReason, 'reload');
});

test('a cloned, expired, consumed or backwards-clock proof is never accepted', async t => {
  for (const variant of ['clone', 'expired', 'consumed', 'clock-backwards', 'no-proof']) {
    const f = fixture(t), old = await f.begin(), proof = f.seal(old);
    let supplied = proof;
    if (variant === 'clone') supplied = copy(proof);
    if (variant === 'expired') f.advance(120_001);
    if (variant === 'clock-backwards') f.advance(-1);
    if (variant === 'no-proof') supplied = null;
    f.show();
    if (variant === 'consumed') {
      const first = f.create({ quietDwellRecovery: proof });
      assert.equal(first.getState().recoveredQuietDwell, true); first.dispose();
    }
    const resumed = f.create({ quietDwellRecovery: supplied });
    assert.equal(resumed.getState().recoveredQuietDwell, false, variant);
    assert.equal(resumed.getState().currentActivity, null, variant);
  }
});

test('body, cup, memory and interaction changes reject recovery before journal mutation', async t => {
  const changes = [
    s => { s.world.position.x += .01; }, s => { s.world.position.z += .01; },
    s => { s.world.posture = 'idle'; }, s => { s.world.gaze = 'user'; },
    s => { s.world.activity = { id: 'read-one', kind: 'read', phase: 'reading' }; },
    s => { s.world.cup.held = true; }, s => { s.world.cup.spot = 'cup_edge'; },
    s => { s.memory.revision = 'memory-two'; },
    s => { s.feedback.push({ id: 1, action: 'look_at', status: 'completed' }); },
    s => { s.history.push({ role: 'user', content: '换个活动吧' }); },
    s => { s.ready = false; }, s => { s.idle = false; },
    s => { s.typing = true; }, s => { s.chatBusy = true; },
    s => { s.visible = false; }, s => { s.renderActive = false; },
  ];
  for (const change of changes) {
    const f = fixture(t);
    f.snapshot.world.cup = { supported: true, spot: 'cup_inner', held: false };
    const old = await f.begin(), proof = f.seal(old);
    assert.ok(proof); f.show(); change(f.snapshot);
    const resumed = f.create({ quietDwellRecovery: proof });
    assert.equal(resumed.getState().recoveredQuietDwell, false, String(change));
    assert.equal(resumed.getState().currentActivity, null);
  }
});

test('sealing requires a paused unfinished quiet body and a confirmed final write', async t => {
  const cases = [
    { name: 'not paused', change: () => {}, pause: false },
    { name: 'held cup', change: s => { s.world.cup = { supported: true, spot: 'cup_inner', held: true }; } },
    { name: 'reading', change: s => { s.world.activity = { id: 'read-one', kind: 'read', phase: 'reading' }; } },
    { name: 'moving', change: s => { s.idle = false; } },
    { name: 'standing up', change: s => { s.world.posture = 'standing_up'; } },
    { name: 'memory unknown', change: s => { delete s.memory; } },
    { name: 'storage failed', change: () => {}, fail: true },
  ];
  for (const entry of cases) {
    const f = fixture(t), old = await f.begin(); entry.change(f.snapshot);
    if (entry.fail) f.failWrites();
    if (entry.pause !== false) f.hide(old);
    assert.equal(old.dispose({ preserveQuietDwell: true }), null, entry.name);
  }
});

test('ready activities and an in-flight request are not recoverable and late output stays inert', async t => {
  let resolveLater;
  const later = new Promise(resolve => { resolveLater = resolve; });
  const f = fixture(t);
  let requests = 0;
  const old = await f.begin({ fetchPlan: async () => ++requests === 1 ? copy(quietPlan) : later });
  f.advance(240_000); const pending = old.tick();
  assert.equal(old.getState().currentActivity.phase, 'ready');
  assert.equal(old.getState().status, 'thinking');
  const proof = f.seal(old);
  assert.equal(proof, null);
  const journal = f.raw();
  resolveLater({ ...quietPlan, actions: [{ type: 'stand', target: 'none' }] }); await pending;
  assert.equal(f.raw(), journal);
  assert.equal(f.executions.length, 1);
});

test('journal receipts are returned only for matching successful reads and writes', () => {
  for (const storage of [undefined, {}, { getItem: () => null, setItem() {} },
    { getItem: () => { throw new Error('disabled'); }, setItem() {} },
    { getItem: () => null, setItem: () => { throw new Error('quota'); } }]) {
    const journal = createActivityJournal({ storage, now: () => baseTime });
    assert.equal(journal.save({ version: 1, writerId: 'writer-one' }), null);
  }
  let raw;
  const journal = createActivityJournal({ storage: { getItem: () => raw, setItem: (_key, value) => { raw = value; } }, now: () => baseTime });
  const first = journal.save({ version: 1, writerId: 'writer-one' });
  const second = journal.save({ version: 1, writerId: 'writer-one' });
  assert.equal(first.writerId, 'writer-one');
  assert.notEqual(first.revision, second.revision);
  assert.deepEqual(journal.load(), second);
});

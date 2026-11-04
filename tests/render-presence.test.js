import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderPresence } from '../src/render-presence.js';
import { createAutonomyController } from '../src/autonomy.js';

function fixture() {
  let time = 0;
  const changes = [];
  const presence = createRenderPresence({ now: () => time, wallNow: () => time, onChange: state => changes.push(state) });
  return { presence, changes,
    frame(ms = 50) { time += ms;return presence.frame(time); },
    advance(ms) { time += ms; },
  };
}

test('ordinary 15 and 30 FPS rendering becomes active and stays active without repeated status events', () => {
  for (const fps of [15, 30]) {
    const f = fixture();
    assert.equal(f.presence.getState().active, false);
    let activeFrames = 0;
    for (let frame = 0; frame < fps * 3; frame++) {
      const sample = f.frame(1000 / fps);
      if (sample.active) activeFrames++;
    }
    assert.ok(activeFrames > fps * 2, `${fps} FPS is foreground-quality evidence`);
    assert.deepEqual(f.changes.map(change => change.active), [true]);
    assert.equal(f.presence.getState().active, true);
  }
});

test('one long frame suspends animation without catch-up and requires a stable recovery window', () => {
  const f = fixture();
  f.presence.frame();
  for (let count = 0; count < 11; count++) f.frame();
  assert.equal(f.presence.getState().active, true);
  const stalled = f.frame(600);
  assert.equal(stalled.active, false);
  assert.equal(stalled.rawDeltaMs, 600);
  assert.equal(stalled.deltaSeconds, 0);
  for (let count = 0; count < 3; count++) {
    const sample = f.frame(125);
    assert.equal(sample.active, false);
    assert.equal(sample.deltaSeconds, 0);
  }
  const resumed = f.frame(125);
  assert.equal(resumed.active, true);
  assert.equal(resumed.stableFrames, 4);
  assert.equal(resumed.stableMs, 500);
  assert.equal(resumed.deltaSeconds, 0, 'the recovery transition itself cannot replay any lost time');
  assert.equal(f.frame(50).deltaSeconds, .05);
  assert.deepEqual(f.changes.map(change => change.active), [true, false, true]);
});

test('1 Hz RAF never counts as active rendering even if document visibility never changes', () => {
  const f = fixture();
  f.presence.frame();
  for (let count = 0; count < 11; count++) f.frame();
  for (let second = 0; second < 600; second++) {
    const sample = f.frame(1000);
    assert.equal(sample.active, false);
    assert.equal(sample.deltaSeconds, 0);
  }
  assert.deepEqual(f.changes.map(change => change.active), [true, false]);
});

test('watchdog and state reads detect a missing frame at the boundary without needing another RAF', () => {
  const f = fixture();
  f.presence.frame();
  for (let count = 0; count < 11; count++) f.frame();
  f.advance(499);
  assert.equal(f.presence.check().active, true);
  f.advance(1);
  const expired = f.presence.getState();
  assert.equal(expired.active, false);
  assert.equal(expired.frameAgeMs, 500);
  assert.equal(expired.changed, true);
  f.advance(600_000);
  assert.equal(f.presence.check().changed, false);
  assert.equal(f.frame(0).deltaSeconds, 0);
  assert.equal(f.presence.getState().active, false);
  assert.deepEqual(f.changes.map(change => change.active), [true, false]);
});

test('isolated short bursts and duplicate timestamps cannot prematurely restore render activity', () => {
  const f = fixture();
  f.presence.frame();
  for (let count = 0; count < 3; count++) f.frame(125);
  assert.equal(f.frame(200).stableMs, 0);
  for (let count = 0; count < 3; count++) f.frame(125);
  for (let count = 0; count < 20; count++) {
    const sample = f.frame(0);
    assert.equal(sample.active, false);
    assert.equal(sample.stableFrames, 3);
  }
  assert.equal(f.frame(125).active, true);
});

test('a real controller cannot credit a 600-second unrendered gap or request work before stable frames return', async t => {
  let clock = Date.now(), calls = 0;
  const presence = createRenderPresence({ now: () => clock, wallNow: () => clock });
  presence.frame();
  for (let count = 0; count < 11; count++) { clock += 50;presence.frame(); }
  const snapshot = { ready: true, idle: true, visible: true, typing: false, chatBusy: false,
    world: { posture: 'standing', activity: { id: 'actual-read', kind: 'read', phase: 'reading', heldObject: null } }, feedback: [],
  };
  const controller = createAutonomyController({ now: () => clock,
    getSnapshot: () => ({ ...snapshot, renderActive: presence.getState().active }),
    fetchPlan: async () => { calls++;throw Error('No request should be made during this test'); }, onPlan: async () => {},
  });
  t.after(() => controller.dispose());
  controller.start();
  assert.equal(controller.adoptActivity({ id: 'actual-read', activity: '在桌边看书' }).ok, true);
  for (let count = 0; count < 40; count++) { clock += 50;presence.frame();await controller.tick(); }
  const observed = controller.getState().currentActivity.elapsedVisibleSeconds;
  assert.ok(Math.abs(observed - 2) < 1e-6);

  clock += 600_000;
  await controller.tick(); // Scheduler runs before either the watchdog or a delayed frame.
  assert.equal(controller.getState().status, 'paused');
  assert.equal(controller.getState().currentActivity.elapsedVisibleSeconds, observed);
  assert.equal(controller.getState().currentActivity.dwellComplete, false);
  assert.equal(controller.requestNow().ok, false);
  assert.equal(calls, 0);
  presence.frame();
  for (let count = 0; count < 10; count++) { clock += 50;presence.frame();await controller.tick(); }
  assert.equal(controller.getState().currentActivity.elapsedVisibleSeconds, observed, 'recovery does not replay the hidden interval');
  for (let count = 0; count < 20; count++) { clock += 50;presence.frame();await controller.tick(); }
  assert.ok(Math.abs(controller.getState().currentActivity.elapsedVisibleSeconds - observed - 1) < 1e-6);
  assert.equal(calls, 0);

  clock += 600_000;
  controller.dispose(); // Owner release also uses a closing interval.
  assert.ok(Math.abs(controller.getState().currentActivity.elapsedVisibleSeconds - observed - 1) < 1e-6);
});

test('sleep with a stopped RAF clock cannot credit wall time or launch a new autonomous request', async t => {
  let monotonic = 0, wall = Date.now(), calls = 0;
  const presence = createRenderPresence({ now: () => monotonic, wallNow: () => wall });
  const frame = (ms = 50) => { monotonic += ms;wall += ms;return presence.frame(); };
  presence.frame();
  for (let count = 0; count < 11; count++) frame();
  const snapshot = { ready: true, idle: true, visible: true, typing: false, chatBusy: false,
    world: { posture: 'standing', activity: { id: 'sleep-read', kind: 'read', phase: 'reading', heldObject: null } }, feedback: [],
  };
  const controller = createAutonomyController({ now: () => wall,
    getSnapshot: () => ({ ...snapshot, renderActive: presence.getState().active }),
    fetchPlan: async () => { calls++;throw Error('No request should be made during this test'); }, onPlan: async () => {},
  });
  t.after(() => controller.dispose());
  controller.start();
  assert.equal(controller.adoptActivity({ id: 'sleep-read', activity: '在桌边看书' }).ok, true);
  for (let count = 0; count < 40; count++) { frame();await controller.tick(); }
  const observed = controller.getState().currentActivity.elapsedVisibleSeconds;
  assert.ok(Math.abs(observed - 2) < 1e-6);

  wall += 600_000;monotonic += 50;
  await controller.tick(); // The controller can resume before the next RAF/watchdog.
  assert.equal(presence.getState().reason, 'clock-discontinuity');
  assert.equal(controller.getState().status, 'paused');
  assert.equal(controller.getState().currentActivity.elapsedVisibleSeconds, observed);
  assert.equal(controller.getState().currentActivity.dwellComplete, false);
  assert.equal(controller.requestNow().ok, false);
  assert.equal(calls, 0);

  assert.equal(presence.frame().deltaSeconds, 0);
  for (let count = 0; count < 10; count++) { assert.equal(frame().deltaSeconds, 0);await controller.tick(); }
  assert.equal(controller.getState().currentActivity.elapsedVisibleSeconds, observed);
  for (let count = 0; count < 20; count++) { frame();await controller.tick(); }
  assert.ok(Math.abs(controller.getState().currentActivity.elapsedVisibleSeconds - observed - 1) < 1e-6);
  assert.equal(calls, 0);
});

test('large wall-clock corrections pause either callback order, while small skew never advances animation', () => {
  for (const adjustment of [-60_000, 60_000]) {
    for (const first of ['frame', 'check']) {
      let monotonic = 0, wall = 1_800_000_000_000;
      const presence = createRenderPresence({ now: () => monotonic, wallNow: () => wall });
      presence.frame();
      for (let count = 0; count < 20; count++) { monotonic += 50;wall += 51;presence.frame(); }
      assert.equal(presence.getState().active, true, 'one millisecond of skew per frame is harmless');
      assert.equal(presence.getState().deltaSeconds, .05, 'wall time cannot advance the body');
      wall += adjustment;monotonic += 50;
      const paused = presence[first]();
      assert.equal(paused.active, false);
      assert.equal(paused.reason, 'clock-discontinuity');
      assert.equal(paused.deltaSeconds, 0);
      if (first === 'check') presence.frame();
      for (let count = 0; count < 10; count++) { monotonic += 50;wall += 50;presence.frame(); }
      assert.equal(presence.getState().active, true);
      assert.equal(presence.getState().deltaSeconds, 0, 'recovery cannot replay the clock correction');
    }
  }
});

test('lifecycle invalidation discards prior frame evidence and requires a fresh stable recovery', () => {
  const f = fixture();
  f.presence.frame();
  for (let count = 0; count < 11; count++) f.frame();
  const invalidated = f.presence.invalidate();
  assert.equal(invalidated.active, false);
  assert.equal(invalidated.reason, 'lifecycle');
  assert.equal(invalidated.frameAgeMs, null);
  assert.equal(invalidated.wallFrameAgeMs, null);
  assert.equal(invalidated.rawDeltaMs, null);
  assert.equal(invalidated.deltaSeconds, 0);
  f.presence.invalidate();
  f.advance(600_000);
  assert.equal(f.presence.getState().active, false);
  assert.equal(f.frame().active, false, 'the first returning frame is not evidence of recovery');
  for (let count = 0; count < 4; count++) assert.equal(f.frame(100).active, false);
  assert.equal(f.frame(100).active, true);
  assert.equal(f.presence.getState().deltaSeconds, 0);
  assert.equal(f.frame().deltaSeconds, .05);
  assert.deepEqual(f.changes.map(change => change.active), [true, false, true]);
});

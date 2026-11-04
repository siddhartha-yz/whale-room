import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_BOOK, createBookObservation } from '../src/book-observation.js';
import { createActivityState, sampleActivity, stepActivity, cancelActivityState } from '../src/activity-rig.js';

function readingFixture({ gatePageTurns = true } = {}) {
  const observation = createBookObservation();
  let activity = createActivityState('read'), id = 'read-1';
  return {
    observation,
    actual() { return sampleActivity(activity); },
    frame(overrides = {}, dt = 1 / 60) {
      const view = observation.getState();
      const pageTurnAllowed = view.pageIndex < ROOM_BOOK.pages.length - 1 && view.readPageIds.includes(view.pageId);
      activity = stepActivity(activity, dt, gatePageTurns ? { pageTurnAllowed } : {});
      return observation.observe({ ...sampleActivity(activity), activityId: id, deltaSeconds: dt,
        renderActive: true, realFrame: true, lookingAtBook: true, ...overrides });
    },
    run(seconds, overrides = {}) {
      for (let frame = 0; frame < Math.round(seconds * 60); frame++) this.frame(overrides);
      return observation.getState();
    },
    cancel() { activity = cancelActivityState(activity); },
    reopen() { activity = createActivityState('read');id += '-next'; },
  };
}

test('the real entry animation cannot expose text, and the first page is read before the first turn', () => {
  const f = readingFixture();
  assert.equal(f.observation.getState().status, 'closed');
  assert.deepEqual(f.observation.getContext().readPages, []);
  f.run(3);
  assert.deepEqual(f.observation.getContext().readPages, [], 'opening the book is not reading its text');
  f.run(2.9);
  assert.deepEqual(f.observation.getContext().readPages, []);
  const state = f.run(.5);
  assert.equal(state.pageIndex, 0);
  assert.equal(state.status, 'reading');
  assert.deepEqual(state.readPageIds, [ROOM_BOOK.pages[0].id]);
  assert.equal(f.observation.getContext().readPages[0].text, ROOM_BOOK.pages[0].text);
  const context = JSON.stringify(f.observation.getContext());
  for (const page of ROOM_BOOK.pages.slice(1)) assert.equal(context.includes(page.text), false);
});

test('actual full page turns advance once after settling; the last page finishes without another turn', () => {
  const f = readingFixture();
  f.run(8.3);
  assert.equal(f.observation.getState().pageIndex, 0, 'the leaf has landed but not yet settled');
  f.run(.2);
  assert.equal(f.observation.getState().pageIndex, 1);
  assert.deepEqual(f.observation.getState().readPageIds, [ROOM_BOOK.pages[0].id]);
  f.run(21); // t=29.5: page four has been stable for three seconds; next turn is t=34.
  assert.equal(f.observation.getState().pageIndex, 3);
  assert.equal(f.observation.getState().allPagesRead, true);
  assert.equal(f.observation.getContext().readPages.length, 4);
  f.run(30);
  assert.equal(f.observation.getState().pageIndex, 3);
  assert.equal(f.observation.getContext().readPages.length, 4, 'looping animation cannot invent extra pages');
  assert.equal(f.actual().phase, 'reading', 'the terminal page stops requesting actual page-turn animation');
});

test('looking away pauses reading credit even if an ungated renderer turns the physical page', () => {
  const f = readingFixture({ gatePageTurns: false });
  f.run(6.4, { lookingAtBook: false });
  assert.equal(f.observation.getState().pageReadSeconds, 0);
  assert.deepEqual(f.observation.getContext().readPages, []);
  f.run(2.1, { lookingAtBook: false });
  assert.equal(f.observation.getState().pageIndex, 1);
  f.run(1.5);
  const before = f.observation.getState().pageReadSeconds;
  f.run(1.5, { lookingAtBook: false });
  assert.equal(f.observation.getState().pageReadSeconds, before);
  f.run(1.6);
  assert.deepEqual(f.observation.getState().readPageIds, [ROOM_BOOK.pages[1].id]);
  assert.equal(f.observation.getState().allPagesRead, false);
});

test('ordinary 15 and 30 FPS samples observe real page turns without crediting unopened pages', () => {
  for (const fps of [15, 30]) {
    const f = readingFixture();
    for (let frame = 0; frame < fps * 15 && f.observation.getState().pageIndex === 0; frame++) f.frame({}, 1 / fps);
    const state = f.observation.getState();
    assert.equal(state.pageIndex, 1, `${fps} FPS observes the complete first turn`);
    assert.deepEqual(state.readPageIds, [ROOM_BOOK.pages[0].id], `${fps} FPS has not watched page two long enough`);
    for (let frame = 0; frame < fps * 4; frame++) f.frame({}, 1 / fps);
    assert.ok(f.observation.getState().readPageIds.includes(ROOM_BOOK.pages[1].id));
  }
});

test('late reading eligibility waits for a complete future turn instead of entering mid-animation', () => {
  const f = readingFixture();
  f.run(4.2, { lookingAtBook: false });
  f.run(3.1); // First page becomes read at about t=7.217, after the t=7 slot has closed.
  assert.deepEqual(f.observation.getState().readPageIds, [ROOM_BOOK.pages[0].id]);
  assert.equal(f.actual().phase, 'reading');
  for (let frame = 0; frame < 1.5 * 60; frame++) {
    f.frame();
    assert.equal(f.actual().pageFlip, 0, 'eligibility cannot jump into the middle of the old slot');
    assert.equal(f.observation.getState().pageIndex, 0);
  }
  f.run(7.4); // t=16.2, a newly observed turn starts from its beginning.
  assert.equal(f.actual().phase, 'turning-page');
  assert.ok(f.actual().pageFlip > 0 && f.actual().pageFlip < .05);
  f.run(1.4);
  assert.equal(f.observation.getState().pageIndex, 1);
});

test('cancelling any partial turn keeps the stable bookmark, and reopening resumes it', () => {
  for (const cancelAt of [7.1, 7.7, 8.2, 8.3, 16.2, 16.8, 17.3]) {
    const f = readingFixture();
    f.run(cancelAt);
    const before = f.observation.getState();
    f.cancel();f.run(1.3);
    assert.equal(f.observation.getState().status, 'closed');
    assert.equal(f.observation.getState().pageIndex, before.pageIndex);
    assert.deepEqual(f.observation.getState().readPageIds, before.readPageIds);
    f.observation.observe();
    assert.equal(f.observation.getState().activityId, null);
    f.reopen();f.run(3.5);
    assert.equal(f.observation.getState().pageIndex, before.pageIndex, `resume bookmark after cancelling at ${cancelAt}`);
    assert.deepEqual(f.observation.getState().readPageIds, before.readPageIds);
  }
});

test('inactive rendering, manual stepping, and long intervals never grant time or finish an unseen turn', () => {
  const f = readingFixture();
  f.run(5);
  const before = f.observation.getState().pageReadSeconds;
  const stable = { activityId: 'read-1', phase: 'reading', bookOpen: 1, pageFlip: 0,
    deltaSeconds: 600, renderActive: true, realFrame: true, lookingAtBook: true };
  f.observation.observe(stable);
  f.observation.observe({ ...stable, deltaSeconds: .05, renderActive: false });
  for (let i = 0; i < 200; i++) f.observation.observe({ ...stable, deltaSeconds: .05, realFrame: false });
  assert.equal(f.observation.getState().pageReadSeconds, before);
  assert.deepEqual(f.observation.getContext().readPages, []);
  f.run(.5);
  assert.ok(f.observation.getState().pageReadSeconds < before + .4, 'resumption starts a fresh stable interval');

  const interrupted = readingFixture();
  interrupted.run(7.6);
  interrupted.frame({ renderActive: false }, 600);
  interrupted.run(2);
  assert.equal(interrupted.observation.getState().pageIndex, 0, 'a page turn crossing an unobserved gap is unconfirmed');
});

test('closing a partly read page preserves only its real progress and reopening does not claim it was read offline', () => {
  const f = readingFixture();
  f.run(4.5);
  const before = f.observation.getState().pageReadSeconds;
  assert.ok(before > 1 && before < 2);
  f.cancel();f.run(1.3);
  assert.equal(f.observation.getState().pageReadSeconds, before);
  assert.deepEqual(f.observation.getContext().readPages, []);
  f.observation.observe({ deltaSeconds: 600 });
  f.reopen();f.run(3.2);
  assert.ok(f.observation.getState().pageReadSeconds < before + .1);
  assert.deepEqual(f.observation.getContext().readPages, []);
  f.run(1.8);
  assert.deepEqual(f.observation.getState().readPageIds, [ROOM_BOOK.pages[0].id]);
});

test('a new activity id, a reversed turn, or joining mid-turn cannot finish the old page transition', () => {
  for (const kind of ['new-id', 'reverse', 'jump']) {
    const f = readingFixture();
    f.run(7.6);
    if (kind === 'new-id') f.reopen();
    else f.frame({ pageFlip: kind === 'reverse' ? 0 : 1 });
    f.run(kind === 'new-id' ? 4 : 2);
    assert.equal(f.observation.getState().pageIndex, 0, kind);
  }
  const f = readingFixture({ gatePageTurns: false });
  f.run(7.6, { realFrame: false });
  f.run(2);
  assert.equal(f.observation.getState().pageIndex, 0);
});

test('same-id samples preserve partial reading, while reset clears evidence and returned objects cannot mutate it', () => {
  const f = readingFixture();
  f.run(5);
  const before = f.observation.getState().pageReadSeconds;
  f.run(.5);
  assert.ok(f.observation.getState().pageReadSeconds > before + .49);
  f.run(1);
  const state = f.observation.getState(), context = f.observation.getContext();
  state.readPageIds.length = 0;context.readPages[0].text = 'Changed';context.readPages.length = 0;
  assert.equal(f.observation.getContext().readPages[0].text, ROOM_BOOK.pages[0].text);
  const reset = f.observation.reset();
  assert.equal(reset.status, 'closed');
  assert.equal(reset.pageIndex, 0);
  assert.equal(reset.pageReadSeconds, 0);
  assert.deepEqual(f.observation.getContext().readPages, []);
});

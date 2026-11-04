// Original text for this prototype, not a quotation or an external book.
export const ROOM_BOOK = Object.freeze({
  id: 'small-things-in-the-room',
  title: '屋里的小事',
  author: '本原型原创',
  pages: Object.freeze([
    { id: 'bookmark', title: '一枚书签', text: '书签不一定要夹在最重要的一页。夹在想回来的地方，也很好。' },
    { id: 'blank-space', title: '留一点空白', text: '纸上的空白不是漏写的句子。留着它，下一笔才有落脚的地方。' },
    { id: 'window-seat', title: '窗边的位置', text: '同一张椅子，换个朝向，就像换了一个角落。房间没变，停下来的方式变了。' },
    { id: 'begin-again', title: '重新开头', text: '上次没读完的地方，不必补上一句抱歉。翻开书，故事便又有了下一页。' },
  ].map(page => Object.freeze(page))),
});

const EPSILON = 1e-8;
const OPEN_THRESHOLD = .95;
const TURN_START = .05;
const TURN_END = .95;
const MAX_FRAME_SECONDS = .15;

function copyBook(book) {
  if (!book || typeof book.id !== 'string' || !book.id || typeof book.title !== 'string'
      || !Array.isArray(book.pages) || book.pages.length === 0) throw new TypeError('A book needs an id, title, and pages');
  const ids = new Set();
  const pages = book.pages.map(page => {
    if (!page || typeof page.id !== 'string' || !page.id || ids.has(page.id)
        || typeof page.title !== 'string' || typeof page.text !== 'string') throw new TypeError('Book pages need unique ids and text');
    ids.add(page.id);
    return { id: page.id, title: page.title, text: page.text };
  });
  return { id: book.id, title: book.title, author: typeof book.author === 'string' ? book.author : '', pages };
}

/**
 * Evidence from rendered book/gaze samples, not a simulation clock or a claim
 * of comprehension. Call only from the real frame path with realFrame: true;
 * manual diagnostic animation steps must leave that flag false. A missing or
 * oversized interval breaks continuity instead of granting catch-up credit.
 */
export function createBookObservation({ book = ROOM_BOOK, minReadSeconds = 3, settleSeconds = .15 } = {}) {
  const contents = copyBook(book);
  if (!Number.isFinite(minReadSeconds) || minReadSeconds <= 0
      || !Number.isFinite(settleSeconds) || settleSeconds < 0) throw new RangeError('Reading thresholds must be finite and nonnegative');
  let pageIndex = 0, activityId = null, status = 'closed';
  let pageSeconds = contents.pages.map(() => 0);
  let stableSeconds = 0, previous = null, turn = null;

  const read = index => pageSeconds[index] + EPSILON >= minReadSeconds;
  const getState = () => ({
    bookId: contents.id, title: contents.title, author: contents.author,
    status, activityId, pageIndex, pageId: contents.pages[pageIndex].id,
    pageCount: contents.pages.length, pageReadSeconds: pageSeconds[pageIndex],
    readPageIds: contents.pages.filter((_, index) => read(index)).map(page => page.id),
    allPagesRead: contents.pages.every((_, index) => read(index)),
  });
  const getContext = () => ({
    ...getState(),
    readPages: contents.pages.flatMap((page, index) => read(index)
      ? [{ ...page, pageIndex: index, observedSeconds: pageSeconds[index] }] : []),
  });

  function breakContinuity() { stableSeconds = 0;previous = null;turn = null; }
  function reset() {
    pageIndex = 0;activityId = null;status = 'closed';
    pageSeconds = contents.pages.map(() => 0);breakContinuity();
    return getState();
  }

  function observe({ activityId: nextId = null, phase, cancelling = false,
    bookOpen = 0, pageFlip = 0, deltaSeconds = 0, renderActive = false,
    lookingAtBook = false, realFrame = false } = {}) {
    const hasActivity = (typeof nextId === 'string' && nextId.length > 0)
      || (typeof nextId === 'number' && Number.isFinite(nextId));
    if (!hasActivity) {
      activityId = null;status = 'closed';breakContinuity();return getState();
    }
    if (nextId !== activityId) { activityId = nextId;breakContinuity(); }
    if (cancelling || phase === 'closing-book') {
      status = bookOpen > .01 ? 'closing' : 'closed';breakContinuity();return getState();
    }
    const genuine = realFrame === true && renderActive === true
      && Number.isFinite(deltaSeconds) && deltaSeconds > 0 && deltaSeconds <= MAX_FRAME_SECONDS;
    if (!genuine) { status = 'paused';breakContinuity();return getState(); }
    if (!Number.isFinite(bookOpen) || bookOpen <= OPEN_THRESHOLD
        || (phase !== 'reading' && phase !== 'turning-page')) {
      status = 'opening';breakContinuity();return getState();
    }
    const sample = { phase, lookingAtBook: lookingAtBook === true };
    if (phase === 'turning-page') {
      status = 'turning';
      if (!Number.isFinite(pageFlip) || pageFlip < 0 || pageFlip > 1) {
        breakContinuity();return getState();
      }
      if (!turn && previous?.phase === 'reading' && stableSeconds + EPSILON >= settleSeconds && pageFlip <= TURN_START) {
        turn = { progress: pageFlip, samples: 1, settled: 0, reachedEnd: false };
      } else if (turn && previous?.phase === 'turning-page' && pageFlip + EPSILON >= turn.progress
          && pageFlip - turn.progress <= .35) {
        turn.progress = pageFlip;turn.samples++;
        turn.reachedEnd = pageFlip >= TURN_END && turn.samples >= 3;
      } else {
        // Reversed, skipped, interrupted, or joined mid-turn: no new page fact.
        turn = null;
      }
      stableSeconds = 0;previous = sample;return getState();
    }

    if (turn) {
      if (turn.reachedEnd) {
        // The first reading sample only establishes that the leaf has landed.
        if (previous?.phase === 'reading') turn.settled += deltaSeconds;
        if (turn.settled + EPSILON < settleSeconds) {
          status = 'turning';previous = sample;return getState();
        }
        pageIndex = Math.min(pageIndex + 1, contents.pages.length - 1);
        stableSeconds = settleSeconds;
        turn = null;status = 'reading';previous = sample;return getState();
      }
      turn = null;stableSeconds = 0;
    }

    status = 'reading';
    if (previous?.phase === 'reading') {
      const before = stableSeconds;
      stableSeconds += deltaSeconds;
      if (sample.lookingAtBook && previous.lookingAtBook) {
        // Only the portion after the page itself has settled is readable.
        const readable = Math.max(0, stableSeconds - settleSeconds) - Math.max(0, before - settleSeconds);
        pageSeconds[pageIndex] += readable;
      }
    }
    previous = sample;
    return getState();
  }

  return { observe, getState, getContext, reset };
}

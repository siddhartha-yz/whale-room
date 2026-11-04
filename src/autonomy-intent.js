import { isRoomActionList } from '../shared/room-actions.js';

// Future intentions are disposable instructions, never persisted observations.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const copy = value => JSON.parse(JSON.stringify(value));

// The server validates too. Keep the browser fail-closed for injected/custom
// providers and mixed-version responses; an optional bad intent is discarded.
export function normalizeNextIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['activity', 'reason', 'actions', 'dwellSeconds', 'after'].includes(key))
      || typeof value.activity !== 'string' || !value.activity.trim() || value.activity.length > 60
      || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 200
      || !Number.isInteger(value.dwellSeconds) || value.dwellSeconds < 60 || value.dwellSeconds > 240
      || !['dwell', 'book_complete'].includes(value.after)
      || !isRoomActionList(value.actions) || !value.actions.length) return null;
  return copy({ ...value, activity: value.activity.trim(), reason: value.reason.trim() });
}

export const memoryRevision = snapshot => snapshot.memory?.revision ?? null;

function readingEvidence(world) {
  const value = world?.reading;
  if (!value || typeof value.bookId !== 'string' || !Array.isArray(value.readPageIds)) return null;
  return {
    bookId: value.bookId, activityId: value.activityId ?? null, pageIndex: value.pageIndex,
    status: ['reading', 'turning'].includes(value.status) ? 'open' : value.status,
    readPageIds: [...value.readPageIds], allPagesRead: value.allPagesRead === true,
  };
}

export function captureIntentContext(snapshot) {
  const world = snapshot.world || {};
  if (!Number.isFinite(world.position?.x) || !Number.isFinite(world.position?.z)
      || typeof world.posture !== 'string' || typeof world.gaze !== 'string') return null;
  return copy({
    position: world.position, posture: world.posture, gaze: world.gaze,
    body: world.activity ?? null, reading: readingEvidence(world), cup: world.cup ?? null,
    feedback: snapshot.feedback || [], history: snapshot.history || [],
    capabilities: [world.availableTargets ?? null, world.availableActivities ?? null],
  });
}

// Allow the expected reading progress, not arbitrary new context. The numeric
// book-observer handle is distinct from the controller's logical activity id.
export function changedIntentContext(anchor, snapshot, after) {
  const current = captureIntentContext(snapshot);
  if (!current) return 'missing_observation';
  if (Math.hypot(current.position.x - anchor.position.x, current.position.z - anchor.position.z) > .25
      || current.posture !== anchor.posture || current.gaze !== anchor.gaze) return 'body_changed';
  if (anchor.body?.kind === 'read') {
    if (current.body?.id !== anchor.body.id || current.body?.kind !== 'read'
        || current.body.cancelling || !['reading', 'turning-page'].includes(current.body.phase)) return 'reading_interrupted';
  } else if (!same(current.body, anchor.body)) return 'body_changed';
  if (!same(current.cup, anchor.cup)) return 'cup_changed';
  if (!same(current.feedback, anchor.feedback)) return 'feedback_changed';
  if (!same(current.history, anchor.history)) return 'conversation_changed';
  if (!same(current.capabilities, anchor.capabilities)) return 'capabilities_changed';
  if (after === 'dwell') return same(current.reading, anchor.reading) ? '' : 'reading_changed';
  const previous = anchor.reading, reading = current.reading;
  if (!reading || !previous || reading.bookId !== previous.bookId || reading.activityId !== previous.activityId
      || reading.activityId === null || reading.status !== 'open'
      || !Number.isInteger(reading.pageIndex) || reading.pageIndex < previous.pageIndex
      || previous.readPageIds.some(id => !reading.readPageIds.includes(id))
      || (previous.allPagesRead && !reading.allPagesRead)) return 'reading_changed';
  return '';
}

export function advanceIntentReading(anchor, snapshot) {
  anchor.reading = readingEvidence(snapshot.world);
  return anchor.reading?.allPagesRead === true;
}

const VERSION = 1;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 24;
const text = (value, length = 200) => typeof value === 'string' ? value.slice(0, length) : '';
const seconds = (value) => Number.isFinite(value) && value >= 0 ? Math.min(value, WEEK_MS / 1000) : 0;
const timestamp = (value, now) => Number.isFinite(value) && value >= 0 ? Math.min(value, now) : null;
const marker = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;
const revision = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function activityWorld(world = {}) {
  if (!world || typeof world !== 'object') world = {};
  const result = {};
  if (Number.isFinite(world.position?.x) && Number.isFinite(world.position?.z)) {
    result.position = { x: world.position.x, z: world.position.z };
  }
  for (const key of ['posture', 'gaze', 'location']) {
    if (typeof world[key] === 'string') result[key] = text(world[key], 80);
  }
  if (world.activity && typeof world.activity === 'object') {
    result.activity = {};
    for (const key of ['id', 'kind', 'phase', 'heldObject']) {
      result.activity[key] = typeof world.activity[key] === 'string' ? text(world.activity[key], 100) : null;
    }
  }
  return result;
}

export function activityFeedback(feedback) {
  return (Array.isArray(feedback) ? feedback.slice(-8) : []).filter((entry) => entry && typeof entry.action === 'string')
    .map((entry) => {
      const result = { action: text(entry.action, 40), status: text(entry.status, 40), detail: text(entry.detail) };
      if (Number.isFinite(entry.id)) result.id = entry.id;
      if (typeof entry.source === 'string') result.source = text(entry.source, 40);
      if (Number.isFinite(entry.position?.x) && Number.isFinite(entry.position?.z)) result.position = { ...activityWorld(entry).position };
      return result;
    });
}

function currentActivity(value, now) {
  if (!value || typeof value.id !== 'string' || !value.id || typeof value.activity !== 'string' || !value.activity) return null;
  const startedAt = timestamp(value.startedAt, now);
  if (startedAt === null || startedAt < now - WEEK_MS) return null;
  const dwellSeconds = Math.max(60, Math.min(240, Number(value.dwellSeconds) || 120));
  const segmentVisibleSeconds = seconds(value.segmentVisibleSeconds);
  return {
    id: text(value.id, 100), activity: text(value.activity, 60),
    phase: ['executing', 'dwelling', 'ready'].includes(value.phase) ? value.phase : 'executing',
    startedAt,
    elapsedVisibleSeconds: Math.max(seconds(value.elapsedVisibleSeconds), segmentVisibleSeconds),
    segmentVisibleSeconds, dwellSeconds,
    dwellComplete: value.phase !== 'executing' && segmentVisibleSeconds >= dwellSeconds,
    world: activityWorld(value.world), feedback: activityFeedback(value.feedback),
  };
}

/** A small, versioned, local journal. It contains observations, never user profiles. */
export function sanitizeActivityJournal(value, now = Date.now()) {
  if (!value || value.version !== VERSION) return null;
  const recentActivities = (Array.isArray(value.recentActivities) ? value.recentActivities.slice(-MAX_ENTRIES) : [])
    .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.activity === 'string'
      && ['completed', 'interrupted', 'failed'].includes(entry.outcome)
      && Number.isFinite(entry.endedAt) && entry.endedAt >= now - WEEK_MS)
    .map((entry) => ({
      id: text(entry.id, 100), activity: text(entry.activity, 60), outcome: entry.outcome,
      endReason: text(entry.endReason, 60),
      startedAt: timestamp(entry.startedAt, now), endedAt: timestamp(entry.endedAt, now),
      at: new Date(timestamp(entry.endedAt, now)).toISOString(),
      elapsedVisibleSeconds: seconds(entry.elapsedVisibleSeconds), feedback: activityFeedback(entry.feedback),
    }));
  return {
    version: VERSION, savedAt: timestamp(value.savedAt, now),
    writerId: marker(value.writerId), revision: marker(value.revision),
    currentActivity: currentActivity(value.currentActivity, now), recentActivities,
    requestTimes: (Array.isArray(value.requestTimes) ? value.requestTimes.slice(-24) : [])
      .filter((time) => Number.isFinite(time) && time > now - HOUR_MS)
      .map((time) => Math.min(time, now)).sort((a, b) => a - b),
    lastUserAt: timestamp(value.lastUserAt, now),
    serverBlockedUntil: Number.isFinite(value.serverBlockedUntil) && value.serverBlockedUntil > now
      ? Math.min(value.serverBlockedUntil, now + HOUR_MS) : 0,
    speech: {
      lastSpeechAt: timestamp(value.speech?.lastSpeechAt, now),
      unansweredProactive: value.speech?.unansweredProactive === true,
    },
  };
}

export function createActivityJournal({ storage, key = 'room-companion-activity-journal-v1', now = Date.now } = {}) {
  return {
    load() {
      try {
        const raw = storage?.getItem(key);
        return raw && raw.length <= 100_000 ? sanitizeActivityJournal(JSON.parse(raw), now()) : null;
      } catch { return null; }
    },
    save(value) {
      try {
        const time = now();
        // Reading old observations never makes them fresh. Only an actual
        // write without a supplied observation time receives the current time.
        const data = sanitizeActivityJournal({ ...value,
          savedAt: value?.savedAt === undefined ? time : value.savedAt, revision: revision() }, time);
        if (!data || typeof storage?.setItem !== 'function' || typeof storage?.getItem !== 'function') return null;
        const serialized = JSON.stringify(data);
        storage.setItem(key, serialized);
        // A recovery proof requires a confirmed write, not a best-effort save.
        // Every write has a fresh revision even when two writers share a clock.
        return storage.getItem(key) === serialized ? data : null;
      } catch { return null; /* Local storage can be disabled or full. */ }
    },
    clear() {
      try { storage?.removeItem(key); } catch { /* Best effort, like save. */ }
    },
  };
}

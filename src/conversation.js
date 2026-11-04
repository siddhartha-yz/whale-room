const STATUSES = new Set(['pending', 'answered', 'cancelled', 'interrupted', 'failed']);
const isRole = (role) => role === 'user' || role === 'assistant';
const copy = (entry) => ({ ...entry });

function randomId() {
  try {
    const values = new Uint32Array(2);
    globalThis.crypto.getRandomValues(values);
    return Array.from(values, (value) => value.toString(36)).join('-');
  } catch {
    return `${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Local conversation text and delivery state; no preference or profile writes. */
export function createConversation({ storage, key = 'room-companion-history-v1', maxEntries = 30, onChange } = {}) {
  if (storage === undefined) {
    try { storage = globalThis.localStorage; } catch { storage = null; }
  }
  const capacity = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : 30;
  let entries = [];

  function uniqueId(used) {
    let id;
    do { id = randomId(); } while (used.has(id));
    return id;
  }

  function persist() {
    try { storage?.setItem(key, JSON.stringify(entries)); } catch { /* Keep the in-memory conversation when storage is unavailable. */ }
  }

  function snapshot() { return entries.map(copy); }

  function changed() {
    persist();
    if (typeof onChange === 'function') onChange(snapshot());
  }

  try {
    const raw = storage?.getItem(key);
    const saved = raw ? JSON.parse(raw) : [];
    if (Array.isArray(saved)) {
      const used = new Set();
      entries = saved.filter((entry) => entry && isRole(entry.role) && typeof entry.content === 'string')
        .slice(-capacity).map((entry) => {
          let id = typeof entry.id === 'string' && entry.id ? entry.id : uniqueId(used);
          if (used.has(id)) id = uniqueId(used);
          used.add(id);
          // A legacy entry is completed history. A formerly pending request
          // has no live owner after reload and must not become model context.
          const status = entry.status === undefined ? 'answered'
            : entry.status === 'pending' || !STATUSES.has(entry.status) ? 'interrupted' : entry.status;
          return { id, role: entry.role, content: entry.content, status };
        });
      if (JSON.stringify(entries) !== JSON.stringify(saved)) persist();
    }
  } catch { /* Corrupt or blocked storage must not prevent opening the room. */ }

  function append(role, content, { status = 'answered' } = {}) {
    if (!isRole(role) || typeof content !== 'string' || !STATUSES.has(status)) return null;
    const entry = { id: uniqueId(new Set(entries.map((item) => item.id))), role, content, status };
    entries.push(entry);
    if (entries.length > capacity) entries.splice(0, entries.length - capacity);
    changed();
    return copy(entry);
  }

  function mark(id, status) {
    if (!STATUSES.has(status)) return null;
    const entry = entries.find((item) => item.id === id);
    if (!entry) return null;
    if (entry.status === status) return copy(entry);
    // Delivery outcomes are final. In particular, a late successful response
    // cannot revive a cancelled request or a request interrupted by reload.
    if (entry.status !== 'pending' || status === 'pending') return null;
    entry.status = status;
    changed();
    return copy(entry);
  }

  function modelHistory(limit = 20) {
    const count = Number.isInteger(limit) && limit >= 0 ? limit : 20;
    if (!count) return [];
    return entries.filter((entry) => entry.status === 'answered').slice(-count)
      .map(({ role, content }) => ({ role, content }));
  }

  function clear() {
    entries = [];
    changed();
  }

  return { snapshot, modelHistory, append, mark, clear };
}

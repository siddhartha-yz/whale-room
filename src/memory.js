import { MAX_MEMORY_ENTRIES, isMemoryActive, validateMemoryPatch, validateMemorySnapshot } from '../shared/memory.js';
export { proactivePreference } from '../shared/memory.js';

const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const browserStorage = name => { try { return globalThis[name]; } catch { return null; } };

/** Bounded, source-backed local memory. No model calls or inferred event history. */
export function createMemoryStore({ storage = browserStorage('localStorage'), sessionStorage = browserStorage('sessionStorage'),
  key = 'room-companion-memory-v1', now = Date.now, onChange = () => {} } = {}) {
  const sessionKey = `${key}:session`;
  let sessionId;
  try {
    sessionId = sessionStorage?.getItem(sessionKey);
    if (!sessionId || !/^[a-zA-Z0-9_-]{1,80}$/.test(sessionId)) {
      sessionId = newId(); sessionStorage?.setItem(sessionKey, sessionId);
    }
  } catch { sessionId = newId(); }
  let state = { revision: newId(), entries: [] };
  let lastRaw;
  let undoState = null;
  let undoRevision = null;
  const view = () => ({ revision: state.revision, entries: state.entries.map(entry => ({ ...entry })), canUndo: Boolean(undoState) });
  function sync() {
    let raw;
    try { raw = storage?.getItem(key) ?? null; } catch { return; }
    if (raw === lastRaw) return;
    lastRaw = raw;
    try { state = raw ? validateMemorySnapshot(JSON.parse(raw), { now: now(), sessionId }) : { revision: newId(), entries: [] }; }
    catch { state = { revision: newId(), entries: [] }; }
    undoState = null; undoRevision = null;
  }
  function commit(entries, previous = null) {
    const next = { revision: newId(), entries };
    const raw = JSON.stringify(next);
    if (!storage) throw new Error('浏览器无法保存记忆。');
    try { storage.setItem(key, raw); } catch { throw new Error('记忆没有保存成功，请检查浏览器存储空间。'); }
    state = next; lastRaw = raw; undoState = previous; undoRevision = previous ? next.revision : null;
    const result = view(); onChange(result); return result;
  }
  function snapshot() {
    sync();
    const active = state.entries.filter(entry => isMemoryActive(entry, { now: now(), sessionId }));
    if (active.length !== state.entries.length) {
      // Expiration also invalidates a reply computed from the old memory set.
      try { return commit(active); }
      catch { state = { revision: newId(), entries: active }; undoState = null; undoRevision = null; }
    }
    return view();
  }
  function applyPatch(patch, { message, expectedRevision } = {}) {
    const before = snapshot();
    if (expectedRevision !== before.revision) return { applied: false, reason: 'stale', snapshot: before };
    let valid;
    try { valid = validateMemoryPatch(patch, { message, memory: before }); }
    catch { return { applied: false, reason: 'invalid', snapshot: before }; }
    if (!valid.set.length && !valid.forget.length) return { applied: true, snapshot: before };
    let entries = before.entries.filter(entry => !valid.forget.some(item => item.id === entry.id));
    const timestamp = now();
    for (const item of valid.set) {
      entries = entries.filter(entry => {
        // A temporary override must not erase the durable preference underneath,
        // even if the model supplied its id as the replacement target.
        if (item.kind !== 'preference' && item.scope !== 'persistent'
            && entry.kind === item.kind && entry.scope === 'persistent') return true;
        return entry.id !== item.replacesId
          && !(item.kind !== 'preference' && entry.kind === item.kind)
          && !(item.kind === 'preference' && entry.kind === item.kind && entry.value === item.value && entry.scope === item.scope);
      });
      const end = new Date(timestamp); end.setHours(24, 0, 0, 0);
      entries.push({ id: newId(), kind: item.kind, value: item.value, scope: item.scope, evidence: item.evidence,
        createdAt: timestamp, expiresAt: item.scope === 'today' ? end.getTime() : null,
        sessionId: item.scope === 'session' ? sessionId : null });
    }
    if (entries.length > MAX_MEMORY_ENTRIES) return { applied: false, reason: 'full', snapshot: before };
    try { return { applied: true, snapshot: commit(entries) }; }
    catch { return { applied: false, reason: 'storage', snapshot: view() }; }
  }
  function remove(id) {
    const before = snapshot();
    if (!before.entries.some(entry => entry.id === id)) return before;
    return commit(before.entries.filter(entry => entry.id !== id), before.entries);
  }
  function clear() {
    const before = snapshot();
    // Even an already-empty clear must invalidate in-flight extraction.
    return commit([], before.entries.length ? before.entries : null);
  }
  function undo() {
    const before = snapshot();
    if (!undoState || undoRevision !== before.revision) return before;
    return commit(undoState.filter(entry => isMemoryActive(entry, { now: now(), sessionId })));
  }
  return { snapshot, applyPatch, remove, clear, undo };
}

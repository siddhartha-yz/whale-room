import { MAX_MEMORY_ENTRIES, isMemoryActive, validateMemoryPatch, validateMemorySnapshot } from '../shared/memory.js';
export { proactivePreference } from '../shared/memory.js';

const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const browserStorage = name => { try { return globalThis[name]; } catch { return null; } };

/** Bounded, source-backed local memory. No model calls or inferred event history. */
export function createMemoryStore({ storage = browserStorage('localStorage'), sessionStorage = browserStorage('sessionStorage'),
  key = 'room-companion-memory-v1', now = Date.now, onChange = () => {} } = {}) {
  const sessionKey = `${key}:session`;
  const entriesKey = `${key}:entries`;
  let sessionId;
  try {
    sessionId = sessionStorage?.getItem(sessionKey);
    if (!sessionId || !/^[a-zA-Z0-9_-]{1,80}$/.test(sessionId)) {
      sessionId = newId(); sessionStorage?.setItem(sessionKey, sessionId);
    }
  } catch { sessionId = newId(); }
  let state = { revision: newId(), entries: [] };
  let lastRaw, lastPrivateRaw;
  let shared = { entries: [] }, privateState = null;
  let undoState = null;
  let undoRevision = null;
  const view = () => ({ revision: state.revision, entries: state.entries.map(entry => ({ ...entry })), canUndo: Boolean(undoState) });
  const read = (source, name, fallback = null) => { try { return source?.getItem(name) ?? null; } catch { return fallback; } };
  const decode = raw => {
    try {
      if (!raw) return { entries: [] };
      const { legacySessions, ...value } = JSON.parse(raw);
      const current = validateMemorySnapshot(value, { now: now() });
      if (legacySessions === undefined) return current;
      const legacy = validateMemorySnapshot({ revision: current.revision, entries: legacySessions }, { now: now() });
      if (current.entries.some(entry => entry.scope === 'session') || legacy.entries.some(entry => entry.scope !== 'session')) throw new Error('scope');
      return { ...current, entries: [...current.entries, ...legacy.entries] };
    }
    catch { return { entries: [] }; }
  };
  function decodePrivate(raw) {
    if (raw === null) return null;
    try {
      const { fallback, rollback, ...value } = JSON.parse(raw);
      const parsed = validateMemorySnapshot(value, { now: now(), sessionId });
      if (parsed.entries.some(entry => entry.scope !== 'session')) throw new Error('scope');
      if (rollback && (!fallback || Object.keys(rollback).some(key => !['before', 'after'].includes(key))
        || (rollback.before !== null && typeof rollback.before !== 'string') || typeof rollback.after !== 'string')) throw new Error('rollback');
      return { ...parsed, rollback, fallback: fallback ? validateMemorySnapshot(fallback, { now: now(), sessionId }) : null };
    } catch { return { entries: [] }; }
  }
  function merge(durable, temporary) {
    const all = [...durable, ...temporary];
    const recent = (a, b) => b.createdAt - a.createdAt;
    // The effective speech constraint must reach the local gate and model even
    // if independent pages filled both stores. Keep hidden rows in their source.
    const proactive = all.filter(entry => entry.kind === 'proactive').reverse().sort(recent)[0];
    const selected = new Set();
    for (const entry of [proactive, ...[...temporary].sort(recent), ...[...durable].sort(recent)]) {
      if (entry && selected.size < MAX_MEMORY_ENTRIES) selected.add(entry.id);
    }
    return all.filter(entry => selected.has(entry.id)).sort((a, b) => a.createdAt - b.createdAt);
  }
  function effectiveDurable() {
    const current = shared.entries.filter(entry => entry.scope !== 'session');
    if (!privateState?.fallback) return current;
    const rollback = privateState.rollback;
    if (!rollback) return privateState.fallback.entries.filter(entry => entry.scope !== 'session');
    const before = decode(rollback.before).entries.filter(entry => entry.scope !== 'session');
    if (lastRaw === rollback.before || lastRaw === rollback.after) return before;
    const after = decode(rollback.after).entries.filter(entry => entry.scope !== 'session');
    const same = (a, b) => Object.keys(a).every(key => a[key] === b[key]);
    const introduced = after.filter(entry => !before.some(prior => same(prior, entry)));
    const failed = introduced.filter(entry => current.some(row => same(row, entry)));
    const external = current.filter(entry => !after.some(row => same(row, entry)));
    const result = current.filter(entry => !failed.some(row => same(row, entry)));
    // A new external revision is authoritative. Hide unchanged failed additions,
    // but never restore a prior value after its replacement was deleted/cleared
    // or another page supplied a new value of that kind. Ambiguous preference
    // replacements have no safe one-to-one restoration, so do not guess.
    for (const prior of before) {
      if (after.some(row => row.id === prior.id) || result.some(row => row.id === prior.id)
        || !failed.some(row => row.kind === prior.kind) || external.some(row => row.kind === prior.kind)
        || (prior.kind === 'preference' && introduced.filter(row => row.kind === prior.kind).length !== 1)) continue;
      result.push(prior);
    }
    return result;
  }
  function combined() {
    const temporary = privateState?.entries ?? shared.entries.filter(entry => entry.scope === 'session' && entry.sessionId === sessionId);
    return merge(effectiveDurable(), temporary);
  }
  function sync() {
    const raw = read(storage, key, lastRaw), privateRaw = read(sessionStorage, entriesKey, lastPrivateRaw);
    if (raw === lastRaw && privateRaw === lastPrivateRaw) return;
    lastRaw = raw; lastPrivateRaw = privateRaw;
    shared = decode(raw); privateState = decodePrivate(privateRaw);
    state = { revision: newId(), entries: combined() };
    undoState = null; undoRevision = null;
  }
  function commit(entries, previous = null, durableOverride = null, temporaryOverride = null) {
    if (privateState?.rollback && !(durableOverride?.length === 0 && entries.length === 0)) {
      const { before, after } = privateState.rollback;
      try {
        // Only retract this transaction's own partial shared write. A later
        // foreign write cannot safely be rolled back here; keep its effective view and
        // report failure. Explicit clear remains available in that rare case.
        const current = read(storage, key);
        if (current !== before && current !== after) throw new Error('changed');
        if (current === after) before === null ? storage.removeItem(key) : storage.setItem(key, before);
        lastRaw = before; shared = decode(before);
        const restored = JSON.stringify({ revision: newId(), entries: privateState.entries });
        sessionStorage.setItem(entriesKey, restored);
        lastPrivateRaw = restored; privateState = decodePrivate(restored);
      } catch { throw new Error('上次记忆没有保存成功，请重试；若仍失败，可先清空记忆。'); }
    }
    const visibleIds = new Set(state.entries.map(entry => entry.id));
    const foreignLegacy = shared.entries.filter(entry => entry.scope === 'session' && entry.sessionId !== sessionId);
    const currentTemporary = privateState?.entries ?? shared.entries.filter(entry => entry.scope === 'session' && entry.sessionId === sessionId);
    const durable = durableOverride ?? [...shared.entries.filter(entry => entry.scope !== 'session' && !visibleIds.has(entry.id)), ...entries.filter(entry => entry.scope !== 'session')];
    // Legacy sessions from other pages remain readable but cannot consume the
    // durable quota forever after those pages close. Both sections are bounded.
    const activeDurable = durable.filter(entry => isMemoryActive(entry, { now: now() }));
    const combinedShared = [...activeDurable, ...foreignLegacy];
    const nextShared = { revision: newId(), entries: combinedShared.length <= MAX_MEMORY_ENTRIES ? combinedShared : activeDurable,
      ...(combinedShared.length > MAX_MEMORY_ENTRIES && foreignLegacy.length ? { legacySessions: foreignLegacy } : {}) };
    const nextPrivate = { revision: newId(), entries: temporaryOverride
      ?? [...currentTemporary.filter(entry => !visibleIds.has(entry.id)), ...entries.filter(entry => entry.scope === 'session')] };
    if (nextShared.entries.length > MAX_MEMORY_ENTRIES || nextPrivate.entries.length > MAX_MEMORY_ENTRIES) throw Object.assign(new Error('记忆已满。'), { code: 'full' });
    const sharedChanged = JSON.stringify(combinedShared) !== JSON.stringify(shared.entries);
    const privateChanged = Boolean(privateState?.fallback)
      || JSON.stringify(nextPrivate.entries) !== JSON.stringify(privateState?.entries ?? [])
      || shared.entries.some(entry => entry.scope === 'session' && entry.sessionId === sessionId);
    // Empty clears still need a persisted revision to fence old replies.
    const writeShared = sharedChanged || !privateChanged;
    const raw = writeShared ? JSON.stringify(nextShared) : lastRaw;
    const privateRaw = privateChanged ? JSON.stringify(nextPrivate) : lastPrivateRaw;
    const oldRaw = lastRaw;
    const oldPrivate = lastPrivateRaw ?? JSON.stringify({ revision: newId(), entries: currentTemporary });
    const oldUndo = previous ? { entries: previous, durable: effectiveDurable(), temporary: currentTemporary } : null;
    let staged = false, sharedWritten = false;
    try {
      if ((writeShared && !storage) || (privateChanged && !sessionStorage)) throw new Error('unavailable');
      if (writeShared && privateChanged) {
        // The two Web Storage areas cannot commit atomically. Stage the old
        // effective view first; if even rollback is denied, reload keeps that
        // view until a later successful user mutation, never a half-applied
        // relaxation of quiet. Successful commits retain no deleted snapshot.
        sessionStorage.setItem(entriesKey, JSON.stringify({ revision: newId(),
          entries: currentTemporary,
          fallback: state, rollback: { before: oldRaw, after: raw } }));
        staged = true;
      }
      if (writeShared) { storage.setItem(key, raw); sharedWritten = true; }
      if (privateChanged) sessionStorage.setItem(entriesKey, privateRaw);
    } catch {
      if (sharedWritten && read(storage, key) === raw) {
        try { oldRaw === null ? storage.removeItem(key) : storage.setItem(key, oldRaw); } catch { /* fallback stays authoritative */ }
      }
      if (staged && read(storage, key) === oldRaw) {
        try { sessionStorage.setItem(entriesKey, oldPrivate); } catch { /* fallback preserves the same view */ }
      }
      lastRaw = read(storage, key, lastRaw); lastPrivateRaw = read(sessionStorage, entriesKey, lastPrivateRaw);
      shared = decode(lastRaw); privateState = decodePrivate(lastPrivateRaw);
      throw new Error('记忆没有保存成功，请检查浏览器存储空间。');
    }
    lastRaw = raw; lastPrivateRaw = privateRaw;
    shared = decode(raw); privateState = decodePrivate(privateRaw);
    state = { revision: newId(), entries: combined() };
    undoState = oldUndo; undoRevision = oldUndo ? state.revision : null;
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
        // A session-scoped correction belongs to this page. Even an explicit
        // replacement id cannot delete the shared today/persistent policy.
        if (item.scope === 'session' && entry.scope !== 'session' && entry.kind === item.kind) return true;
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
    catch (error) { return { applied: false, reason: error.code === 'full' ? 'full' : 'storage', snapshot: view() }; }
  }
  function remove(id) {
    const before = snapshot();
    if (!before.entries.some(entry => entry.id === id)) return before;
    return commit(before.entries.filter(entry => entry.id !== id), before.entries);
  }
  function clear() {
    const before = snapshot();
    // Even an already-empty clear must invalidate in-flight extraction.
    return commit([], before.entries.length ? before.entries : null, [], []);
  }
  function undo() {
    const before = snapshot();
    if (!undoState || undoRevision !== before.revision) return before;
    return commit(undoState.entries.filter(entry => isMemoryActive(entry, { now: now(), sessionId })), null,
      undoState.durable.filter(entry => isMemoryActive(entry, { now: now() })), undoState.temporary);
  }
  return { snapshot, applyPatch, remove, clear, undo };
}

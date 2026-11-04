export const MEMORY_KINDS = ['name', 'preference', 'proactive'];
export const MEMORY_SCOPES = ['persistent', 'today', 'session'];
export const MAX_MEMORY_ENTRIES = 12;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const keys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const fail = () => { throw new Error('记忆内容或来源无效。'); };
export const emptyMemoryPatch = () => ({ set: [], forget: [] });

export function isMemoryActive(entry, { now = Date.now(), sessionId } = {}) {
  return (entry.expiresAt === null || entry.expiresAt > now)
    && (entry.scope !== 'session' || sessionId === undefined || entry.sessionId === sessionId);
}

export function validateMemorySnapshot(value, { now = Date.now(), sessionId } = {}) {
  if (value === undefined) return { revision: '0', entries: [] };
  if (!object(value) || !keys(value, ['revision', 'entries', 'canUndo']) || !id(value.revision)
      || !Array.isArray(value.entries) || value.entries.length > MAX_MEMORY_ENTRIES) fail();
  const ids = new Set();
  const entries = value.entries.map(entry => {
    if (!object(entry) || !keys(entry, ['id', 'kind', 'value', 'scope', 'evidence', 'createdAt', 'expiresAt', 'sessionId'])
        || !id(entry.id) || ids.has(entry.id) || !MEMORY_KINDS.includes(entry.kind)
        || !text(entry.value, entry.kind === 'name' ? 40 : 120) || !MEMORY_SCOPES.includes(entry.scope)
        || !text(entry.evidence, 400) || !Number.isFinite(entry.createdAt) || entry.createdAt < 0
        || !(entry.expiresAt === null || (Number.isFinite(entry.expiresAt) && entry.expiresAt > entry.createdAt))
        || (entry.scope === 'today' ? entry.expiresAt === null : entry.expiresAt !== null)
        || (entry.scope === 'session' ? !id(entry.sessionId) : entry.sessionId !== null)
        || (entry.kind === 'proactive' && !['quiet', 'allowed'].includes(entry.value))) fail();
    ids.add(entry.id);
    return { ...entry, value: entry.value.trim(), evidence: entry.evidence.trim() };
  }).filter(entry => isMemoryActive(entry, { now, sessionId }));
  return { revision: value.revision, entries };
}

// A quote establishes provenance, not a proof that the model understood intent.
// The prompt restricts extraction to explicit user preferences; the UI exposes
// every saved quote and lets the user correct or remove it.
export function validateMemoryPatch(value, { message = '', memory = { entries: [] } } = {}) {
  if (value === undefined) return emptyMemoryPatch();
  if (!object(value) || !keys(value, ['set', 'forget']) || !Array.isArray(value.set)
      || !Array.isArray(value.forget) || value.set.length + value.forget.length > 3) fail();
  const entries = memory.entries || [];
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const referenced = new Set();
  const evidence = quote => {
    if (!text(quote, 400) || typeof message !== 'string' || !message.includes(quote)) fail();
    return quote;
  };
  const reference = (target, kind) => {
    if (!id(target) || !byId.has(target) || referenced.has(target) || (kind && byId.get(target).kind !== kind)) fail();
    referenced.add(target);
    return target;
  };
  const fixedKinds = new Set();
  const set = value.set.map(item => {
    if (!object(item) || !keys(item, ['kind', 'value', 'scope', 'evidence', 'replacesId'])
        || !MEMORY_KINDS.includes(item.kind) || !MEMORY_SCOPES.includes(item.scope)
        || !text(item.value, item.kind === 'name' ? 40 : 120)
        || (item.kind === 'proactive' && !['quiet', 'allowed'].includes(item.value))
        || (item.replacesId !== null && typeof item.replacesId !== 'string')) fail();
    if (item.kind !== 'preference') {
      if (fixedKinds.has(item.kind)) fail();
      fixedKinds.add(item.kind);
    }
    return { kind: item.kind, value: item.value.trim(), scope: item.scope, evidence: evidence(item.evidence),
      replacesId: item.replacesId === null ? null : reference(item.replacesId, item.kind) };
  });
  const forget = value.forget.map(item => {
    if (!object(item) || !keys(item, ['id', 'evidence'])) fail();
    return { id: reference(item.id), evidence: evidence(item.evidence) };
  });
  return { set, forget };
}

// Temporary changes overlay a persistent preference until they expire.
export function proactivePreference(memory, options) {
  return memory?.entries?.filter(entry => entry.kind === 'proactive' && isMemoryActive(entry, options))
    .reverse().sort((a, b) => b.createdAt - a.createdAt)[0]?.value ?? null;
}

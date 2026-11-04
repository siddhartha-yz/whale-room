const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

function randomId() {
  try { return globalThis.crypto.randomUUID(); }
  catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`; }
}

function defaultValue(read) { try { return read(); } catch { return null; } }
function read(storage, key) { try { return storage?.getItem(key) ?? null; } catch { return null; } }

// Resolve acquisition immediately, while keeping the Web Lock until dispose.
async function claim(locks, name) {
  let acquired, rejected, release;
  const ready = new Promise((resolve, reject) => { acquired = resolve; rejected = reject; });
  const held = new Promise(resolve => { release = resolve; });
  const finished = Promise.resolve().then(() => locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) { acquired(null); return; }
    acquired(() => { release(); return finished; });
    await held;
  })).catch(error => { rejected(error); });
  return ready;
}

/** Claim one page's chat history before createConversation normalizes pending entries.
 * The old unscoped key is a read-only migration source, never a write target.
 */
export async function createConversationScope({
  key = 'room-companion-history-v1', storage, sessionStorage, locks, newId = randomId,
} = {}) {
  if (storage === undefined) storage = defaultValue(() => globalThis.localStorage);
  if (sessionStorage === undefined) sessionStorage = defaultValue(() => globalThis.sessionStorage);
  if (locks === undefined) locks = defaultValue(() => globalThis.navigator?.locks);
  const sessionKey = `${key}:session`, lastKey = `${key}:last`, fallbackKey = `${key}:tab-history`;
  const dataKey = id => `${key}:scope:${id}`;
  const sessionId = read(sessionStorage, sessionKey), lastId = read(storage, lastKey);
  const preferred = validId(sessionId) ? sessionId : validId(lastId) ? lastId : null;
  const tabCopy = read(sessionStorage, fallbackKey);
  const source = () => tabCopy ?? (preferred ? read(storage, dataKey(preferred)) : null) ?? read(storage, key);

  function makeId() {
    const generated = newId();
    return validId(generated) ? generated : randomId();
  }

  function scoped({ id, targetKey, raw, backing, mode, release = () => Promise.resolve() }) {
    let active = true, value = raw ?? '[]', stopped;
    return {
      id, key: targetKey, mode,
      storage: {
        getItem: requested => requested === targetKey ? value : null,
        setItem(requested, next) {
          if (!active || requested !== targetKey) return;
          value = String(next);
          try { backing?.setItem(targetKey, value); } catch { backing = null; }
        },
      },
      dispose() {
        // Fence late promises synchronously, before another page can acquire.
        active = false;
        return stopped ??= release();
      },
    };
  }

  function fallback(raw) {
    const id = makeId();
    // sessionStorage is copied, not shared, by duplicate tabs. It remains safe
    // without Web Locks and still preserves refresh in supported browsers.
    try {
      if (!sessionStorage) throw new Error('No tab storage');
      sessionStorage.setItem(fallbackKey, raw ?? '[]');
      return scoped({ id, targetKey: fallbackKey, raw, backing: sessionStorage, mode: 'session' });
    } catch {
      return scoped({ id, targetKey: dataKey(id), raw, backing: null, mode: 'memory' });
    }
  }

  if (!storage || !sessionStorage || typeof locks?.request !== 'function') return fallback(source());
  let release;
  try {
    // A prior session-only fallback is a newer private copy; migrate it into a
    // fresh scope instead of replacing an older shared session's contents.
    let id = tabCopy === null && preferred ? preferred : makeId();
    for (let attempt = 0; attempt < 4; attempt++) {
      release = await claim(locks, `${key}:owner:${id}`);
      if (release) break;
      id = makeId();
    }
    if (!release) return fallback(source());
    const targetKey = dataKey(id);
    const raw = (id === preferred && tabCopy === null ? read(storage, targetKey) : null) ?? source() ?? '[]';
    // These writes also verify that persistence actually works. A failure uses
    // an independent fallback and relinquishes any acquired shared scope.
    sessionStorage.setItem(sessionKey, id);
    storage.setItem(targetKey, raw);
    storage.setItem(lastKey, id);
    try { sessionStorage.removeItem(fallbackKey); } catch { /* Optional cleanup. */ }
    return scoped({ id, targetKey, raw, backing: storage, mode: 'local', release });
  } catch {
    await release?.();
    return fallback(source());
  }
}

/** One visible room owns autonomous decisions and journal writes for this origin. */
export function createAutonomyOwner({
  key = 'room-companion-autonomy', locks = globalThis.navigator?.locks,
  onAcquire = () => {}, onStatus = () => {},
} = {}) {
  let enabled = false, disposed = false, owner = false, cycle = null, status = 'idle';
  function publish(next, error) {
    status = next;
    // Rendering failures must not strand a browser lock.
    try { onStatus({ status, owner, enabled, ...(error ? { error } : {}) }); } catch { /* UI is optional. */ }
  }

  function acquire() {
    if (!enabled || disposed || cycle) return;
    if (typeof locks?.request !== 'function') { publish('unsupported'); return; }
    const controller = new AbortController();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const attempt = { controller, release, done: null };
    cycle = attempt;
    publish('waiting');
    attempt.done = Promise.resolve().then(() => locks.request(key, {
      mode: 'exclusive', signal: controller.signal,
    }, async () => {
      if (disposed || !enabled || controller.signal.aborted) return;
      owner = true;
      let cleanup;
      try {
        cleanup = await onAcquire();
        if (enabled && !disposed && !controller.signal.aborted) publish('owner');
        await held;
      } finally {
        try { if (typeof cleanup === 'function') await cleanup(); }
        finally { owner = false; }
      }
    })).catch(error => {
      if (error?.name === 'AbortError' && controller.signal.aborted) return;
      enabled = false;
      publish('error', error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (cycle !== attempt) return;
      cycle = null;
      if (enabled && !disposed) acquire();
      else if (status !== 'error') publish('idle');
    });
  }

  function setEnabled(value) {
    if (disposed) return;
    enabled = Boolean(value);
    if (!enabled) {
      cycle?.controller.abort(); // Cancel a queued request; an owned lock exits via cleanup.
      cycle?.release();
      if (!cycle) publish('idle');
    } else acquire();
  }

  function dispose() {
    if (!disposed) { setEnabled(false); disposed = true; }
    return cycle?.done ?? Promise.resolve();
  }

  return { setEnabled, dispose, isOwner: () => owner };
}

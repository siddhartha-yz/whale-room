const GAP_MS = 500;
const STABLE_FRAME_MS = 150;
const RECOVERY_MS = 500;
const RECOVERY_FRAMES = 4;

/** Rendering evidence only: no DOM, timers, animation catch-up, or model calls.
 * All timestamps use the same monotonic clock as requestAnimationFrame.
 */
export function createRenderPresence({ now = () => globalThis.performance?.now() ?? Date.now(), onChange = () => {} } = {}) {
  let active = false, reason = 'no-frame', lastFrameAt = null, lastObservedAt = -Infinity;
  let rawDeltaMs = null, deltaSeconds = 0, stableMs = 0, stableFrames = 0;

  function timestamp(value) {
    const candidate = Number.isFinite(value) ? value : now();
    lastObservedAt = Math.max(lastObservedAt, candidate);
    return lastObservedAt;
  }

  function state(time, changed = false) {
    return { active, changed, reason, lastFrameAt,
      frameAgeMs: lastFrameAt === null ? null : Math.max(0, time - lastFrameAt),
      rawDeltaMs, deltaSeconds, stableMs, stableFrames };
  }

  function result(time, previous) {
    const snapshot = state(time, active !== previous);
    if (snapshot.changed) onChange({ ...snapshot });
    return snapshot;
  }

  function check(at = now()) {
    const time = timestamp(at), previous = active;
    if (lastFrameAt !== null && time - lastFrameAt >= GAP_MS) {
      active = false;reason = 'frame-gap';deltaSeconds = 0;stableMs = 0;stableFrames = 0;
    }
    return result(time, previous);
  }

  function frame(at = now()) {
    const time = timestamp(at), previous = active;
    rawDeltaMs = lastFrameAt === null ? null : Math.max(0, time - lastFrameAt);
    lastFrameAt = time;
    if (rawDeltaMs === null) {
      reason = 'recovering';
    } else if (rawDeltaMs >= GAP_MS) {
      active = false;reason = 'frame-gap';stableMs = 0;stableFrames = 0;
    } else if (!active) {
      reason = 'recovering';
      if (rawDeltaMs > 0 && rawDeltaMs <= STABLE_FRAME_MS) {
        stableMs += rawDeltaMs;stableFrames++;
        if (stableMs >= RECOVERY_MS && stableFrames >= RECOVERY_FRAMES) { active = true;reason = 'active'; }
      } else if (rawDeltaMs > STABLE_FRAME_MS) {
        stableMs = 0;stableFrames = 0;
      }
    }
    // Do not simulate the gap, the recovery period, or even the transition
    // frame. Only consecutive active frames can advance the body.
    deltaSeconds = previous && active ? Math.min(rawDeltaMs / 1000, .05) : 0;
    return result(time, previous);
  }

  // Reading state checks freshness too: a controller timer may run before the
  // watchdog or before the next delayed RAF callback gets a chance to run.
  return { frame, check, getState: check };
}

const GAP_MS = 500;
const STABLE_FRAME_MS = 150;
const RECOVERY_MS = 500;
const RECOVERY_FRAMES = 4;

/** Rendering evidence only: no DOM, timers, animation catch-up, or model calls.
 * Animation uses the RAF clock. The wall clock only detects suspended clocks
 * or clock corrections; it must never contribute animation time.
 */
export function createRenderPresence({ now = () => globalThis.performance?.now() ?? Date.now(), wallNow = Date.now, onChange = () => {} } = {}) {
  let active = false, reason = 'no-frame', lastFrameAt = null, lastObservedAt = -Infinity;
  let lastWallFrameAt = null;
  let rawDeltaMs = null, deltaSeconds = 0, stableMs = 0, stableFrames = 0;

  function timestamp(value) {
    const candidate = Number.isFinite(value) ? value : now();
    lastObservedAt = Math.max(lastObservedAt, candidate);
    return lastObservedAt;
  }

  function gapReason(time, wallTime) {
    if (lastFrameAt === null) return null;
    const elapsed = time - lastFrameAt, wallElapsed = wallTime - lastWallFrameAt;
    if (Math.abs(wallElapsed - elapsed) >= GAP_MS) return 'clock-discontinuity';
    return elapsed >= GAP_MS || wallElapsed >= GAP_MS ? 'frame-gap' : null;
  }

  function state(time, wallTime, changed = false) {
    return { active, changed, reason, lastFrameAt,
      frameAgeMs: lastFrameAt === null ? null : Math.max(0, time - lastFrameAt),
      wallFrameAgeMs: lastWallFrameAt === null ? null : Math.max(0, wallTime - lastWallFrameAt),
      rawDeltaMs, deltaSeconds, stableMs, stableFrames };
  }

  function result(time, wallTime, previous) {
    const snapshot = state(time, wallTime, active !== previous);
    if (snapshot.changed) onChange({ ...snapshot });
    return snapshot;
  }

  function check(at = now()) {
    const time = timestamp(at), wallTime = wallNow(), previous = active;
    const gap = gapReason(time, wallTime);
    if (gap) {
      active = false;reason = gap;deltaSeconds = 0;stableMs = 0;stableFrames = 0;
    }
    return result(time, wallTime, previous);
  }

  function frame(at = now()) {
    const time = timestamp(at), wallTime = wallNow(), previous = active;
    const gap = gapReason(time, wallTime);
    rawDeltaMs = lastFrameAt === null ? null : Math.max(0, time - lastFrameAt);
    lastFrameAt = time;lastWallFrameAt = wallTime;
    if (rawDeltaMs === null) {
      reason = 'recovering';
    } else if (gap) {
      active = false;reason = gap;stableMs = 0;stableFrames = 0;
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
    return result(time, wallTime, previous);
  }

  function invalidate(cause = 'lifecycle') {
    const previous = active;
    active = false;reason = cause;lastFrameAt = null;lastWallFrameAt = null;lastObservedAt = -Infinity;
    rawDeltaMs = null;deltaSeconds = 0;stableMs = 0;stableFrames = 0;
    return result(timestamp(now()), wallNow(), previous);
  }

  // Reading state checks freshness too: a controller timer may run before the
  // watchdog or before the next delayed RAF callback gets a chance to run.
  return { frame, check, getState: check, invalidate };
}

/** Browser lifecycle gates only. Leaving a gate never proves that RAF recovered.
 * Callers own DOM listeners, persisted-page restoration and async cleanup.
 */
export function createPageLifecycle({ hidden = false, onChange = () => {} } = {}) {
  let pageHidden = Boolean(hidden), frozen = false, inHistory = false, departed = false;

  function isBlocked() { return pageHidden || frozen || inHistory || departed; }
  function getState() { return { blocked: isBlocked(), hidden: pageHidden, frozen, inHistory, departed }; }

  function handle(type, event = {}) {
    const previous = getState();
    let historyRestored = false;
    if (!departed) {
      // Read the actual visibility at every event, since pageshow and
      // visibilitychange need not be delivered in the same order.
      if (typeof event.hidden === 'boolean') pageHidden = event.hidden;
      switch (type) {
        case 'freeze': frozen = true; break;
        case 'resume': frozen = false; break;
        case 'pagehide':
          if (event.persisted === true) inHistory = true;
          else departed = true;
          break;
        case 'pageshow':
          if (event.persisted === true && inHistory) {
            inHistory = false;
            historyRestored = true;
          }
          break;
      }
    }
    const state = getState();
    const changed = state.hidden !== previous.hidden || state.frozen !== previous.frozen
      || state.inHistory !== previous.inHistory || state.departed !== previous.departed;
    if (changed) onChange({ state, previous, type });
    return { ...state, changed, historyRestored };
  }

  return { handle, getState, isBlocked };
}

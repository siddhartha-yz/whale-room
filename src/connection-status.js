const OFFLINE_REASON = '本地服务未连接，请确认服务正在运行后重连。';
const LOGIN_REASON = '请先在终端运行 codex login，用 ChatGPT 账号登录后重连。';
const SCENE_ONLY_REASON = '离线场景模式：手动动作可用，聊天与自主模型请求已关闭。';

async function requestStatus({ signal }) {
  const response = await fetch('/api/status', { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(OFFLINE_REASON);
  return response.json();
}

/** Read-only connection checks. No polling and no model requests or retries. */
export function createConnectionStatus({ fetchStatus = requestStatus, timeoutMs = 7000, onChange = () => {} } = {}) {
  let state = { status: 'preparing', available: false, reason: '正在检查本机连接…', checking: false };
  let pending = null, disposed = false;
  const getState = () => ({ ...state });

  function publish(next) {
    const changed = Object.keys(state).some(key => state[key] !== next[key]);
    state = next;
    if (changed) onChange(getState());
  }

  function finish(run, next) {
    if (pending !== run || disposed) return;
    pending = null;clearTimeout(run.timer);
    publish({ ...next, checking: false });
    run.resolve(getState());
  }

  function replace(next) {
    if (disposed) return false;
    const run = pending;
    if (run) {
      finish(run, next);
      run.controller.abort();
    } else publish({ ...next, checking: false });
    return true;
  }

  function check() {
    if (disposed) return Promise.resolve(getState());
    if (pending) return pending.promise;
    let resolve;
    const run = { controller: new AbortController(), promise: new Promise(done => { resolve = done; }), resolve, timer: null };
    pending = run;
    publish(state.available ? { ...state, checking: true }
      : { status: 'preparing', available: false, reason: '正在检查本机连接…', checking: true });
    if (pending !== run || disposed) return run.promise;
    run.timer = setTimeout(() => {
      finish(run, { status: 'offline', available: false, reason: '本地连接检查超时，请稍后重连。' });
      run.controller.abort();
    }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 7000);
    Promise.resolve().then(() => {
      if (pending !== run || disposed) return;
      return fetchStatus({ signal: run.controller.signal });
    }).then(result => {
      if (pending !== run || disposed) return;
      if (typeof result?.available !== 'boolean') throw new Error('本地服务返回了无效的连接状态，请重连。');
      finish(run, result.available
        ? { status: 'ready', available: true, reason: '' }
        : result.offline === true ? { status: 'scene-only', available: false, reason: SCENE_ONLY_REASON }
        : { status: 'needs-login', available: false, reason: typeof result.reason === 'string' && result.reason.trim() ? result.reason : LOGIN_REASON });
    }).catch(() => {
      finish(run, { status: 'offline', available: false, reason: OFFLINE_REASON });
    });
    return run.promise;
  }

  function markSuccess() { return replace({ status: 'ready', available: true, reason: '' }); }

  function markFailure(error) {
    if (error?.code === 'OFFLINE_MODE') {
      return replace({ status: 'scene-only', available: false, reason: SCENE_ONLY_REASON });
    }
    if (error?.code === 'LOGIN_REQUIRED') {
      return replace({ status: 'needs-login', available: false, reason: error.message || LOGIN_REASON });
    }
    if (['CODEX_UNAVAILABLE', 'SHUTTING_DOWN'].includes(error?.code) || error?.transport === true) {
      return replace({ status: 'offline', available: false, reason: error.message || OFFLINE_REASON });
    }
    return false;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    const run = pending;pending = null;
    state = { ...state, checking: false };
    if (run) { clearTimeout(run.timer);run.controller.abort();run.resolve(getState()); }
  }

  return { check, getState, markSuccess, markFailure, dispose };
}

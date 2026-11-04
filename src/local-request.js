export { isRoomActionList as hasActionList } from '../shared/room-actions.js';

const offline = () => Object.assign(new Error('本地服务未连接，请在设置里重连。'), { transport: true });
export const invalidLocalResponse = () => Object.assign(new Error('本地服务返回了无法读取的内容，请在设置里重连。'), { transport: true });

// Both chat and idle decisions use the same localhost protocol. An HTML
// response (e.g. another server on this port) is a connection issue, whereas a
// structured model limit or cancellation must retain its original meaning.
export async function postLocalJson(path, payload, { signal, fallback, fetchRequest = globalThis.fetch } = {}) {
  let response;
  try {
    response = await fetchRequest(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    throw offline();
  }
  let body;
  try { body = await response.json(); }
  catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    throw invalidLocalResponse();
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidLocalResponse();
  if (!response.ok) {
    const message = [body.error, body.message, fallback].find(value => typeof value === 'string' && value.trim());
    throw Object.assign(new Error(message || '本地请求未完成，请稍后重试。'), { code: body.code, status: response.status, retryAt: body.retryAt });
  }
  return body;
}

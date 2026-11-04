const LEASE_MS = 5000;
const RENEW_MS = 1500;
const MAX_PEERS = 32;
const FIELDS = ['v', 'sender', 'seq', 'kind', 'at'];
const validSender = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(value);
const senderId = () => globalThis.crypto?.randomUUID?.()
  ?? `peer_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;

/** Ephemeral same-origin coordination only. Never pass draft text, history, or
 * a conversation identity here. A receiver owns cancellation of its autonomous
 * work; this helper neither cancels chat nor changes speech eligibility.
 *
 * pulse(): one short input/manual/stop signal.
 * setBusy(chatBusy || composing || speaking): renew only while actually busy.
 * isPeerActive(): include in the autonomous decision snapshot.
 * onPeerActive(): deferred, coalesced inactive -> active edge; do not rebroadcast.
 */
export function createPeerActivity({
  scope = 'normal', onPeerActive = () => {},
  channelFactory = name => new globalThis.BroadcastChannel(name),
  now = Date.now, newId = senderId,
  setIntervalFn = globalThis.setInterval, clearIntervalFn = globalThis.clearInterval,
  enqueue = globalThis.queueMicrotask,
} = {}) {
  if (!['normal', 'inspection'].includes(scope)) throw new Error('Unknown peer activity scope');
  const sender = newId();
  if (!validSender(sender)) throw new Error('Invalid ephemeral peer id');
  const peers = new Map();
  let channel = null, disposed = false, busy = false, renewal = null, sequence = 0;
  let peerActive = false, notificationPending = false;

  function prune(time = now()) {
    let active = false;
    for (const [id, peer] of peers) {
      if (peer.forgetAt <= time) { peers.delete(id); continue; }
      if (peer.until > time) active = true;
    }
    peerActive = active;
    return active;
  }

  function notify() {
    if (notificationPending) return;
    notificationPending = true;
    enqueue(() => {
      notificationPending = false;
      if (disposed || !prune()) return;
      try { onPeerActive(); } catch { /* A consumer must not break coordination. */ }
    });
  }

  function receive(event) {
    if (disposed) return;
    const value = event?.data, time = now();
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== FIELDS.length || FIELDS.some(key => !Object.hasOwn(value, key))
        || value.v !== 1 || !validSender(value.sender) || value.sender === sender
        || !Number.isSafeInteger(value.seq) || value.seq <= 0
        || !['moment', 'lease', 'release'].includes(value.kind)
        || !Number.isSafeInteger(value.at) || value.at < 0 || value.at > time + 1000
        || value.at + LEASE_MS <= time) return;
    const wasActive = prune(time), previous = peers.get(value.sender);
    if (previous && value.seq <= previous.sequence) return;
    if (!previous && peers.size >= MAX_PEERS) return;
    const expiry = Math.min(time + LEASE_MS, value.at + LEASE_MS);
    // Keep a short tombstone after release so a reordered lease cannot revive it.
    peers.set(value.sender, { sequence: value.seq, until: value.kind === 'release' ? 0 : expiry, forgetAt: expiry });
    if (prune(time) && !wasActive) notify();
  }

  function stopRenewal() {
    if (renewal !== null) clearIntervalFn(renewal);
    renewal = null;
  }

  function closeChannel() {
    stopRenewal();
    try { channel?.removeEventListener?.('message', receive); } catch { /* Optional teardown. */ }
    try { channel?.close(); } catch { /* The API may already be gone. */ }
    channel = null;peers.clear();peerActive = false;
  }

  function publish(kind) {
    if (!channel || disposed) return false;
    try {
      channel.postMessage({ v: 1, sender, seq: ++sequence, kind, at: Math.floor(now()) });
      return true;
    } catch { closeChannel(); return false; }
  }

  try {
    channel = channelFactory(`room-companion-peer-activity-v1:${scope}`);
    if (!channel || typeof channel.postMessage !== 'function' || typeof channel.addEventListener !== 'function') throw new Error('Unavailable channel');
    channel.addEventListener('message', receive);
  } catch { closeChannel(); }

  function pulse() { return publish('moment'); }

  function setBusy(value) {
    if (disposed || !channel || typeof value !== 'boolean') return false;
    if (busy === value) return true;
    busy = value;
    if (!busy) { stopRenewal();return publish('release'); }
    if (!publish('lease')) return false;
    renewal = setIntervalFn(() => { if (busy) publish('lease'); }, RENEW_MS);
    renewal?.unref?.();
    return true;
  }

  function getState() {
    const time = now();prune(time);
    let peerCount = 0, remainingMs = 0;
    for (const peer of peers.values()) if (peer.until > time) {
      peerCount++;remainingMs = Math.max(remainingMs, peer.until - time);
    }
    return { supported: Boolean(channel), peerActive, peerCount, remainingMs };
  }

  function dispose() {
    if (disposed) return;
    publish('release');disposed = true;busy = false;closeChannel();
  }

  return { pulse, setBusy, isPeerActive: () => prune(), getState, dispose };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeerActivity } from '../src/peer-activity.js';

function fixture() {
  let clock = 100_000, serial = 0;
  const channels = new Set(), timers = new Map(), jobs = [], sent = [];
  function channelFactory(name) {
    const listeners = new Set();
    const channel = {
      name, closed: false,
      addEventListener: (_, listener) => listeners.add(listener),
      removeEventListener: (_, listener) => listeners.delete(listener),
      deliver: value => { for (const listener of listeners) listener({ data: value }); },
      postMessage(value) {
        if (channel.closed) throw new Error('closed');
        const copy = structuredClone(value);sent.push({ name, value: copy });
        for (const other of channels) if (other !== channel && !other.closed && other.name === name) other.deliver(copy);
      },
      close() { channel.closed = true;channels.delete(channel); },
    };
    channels.add(channel);return channel;
  }
  const flush = () => { while (jobs.length) jobs.shift()(); };
  const advance = (ms, runTimers = true) => {
    const end = clock + ms;
    if (runTimers) while (true) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      clock = next[1].at;next[1].at += next[1].period;next[1].callback();flush();
    }
    clock = end;flush();
  };
  const make = options => createPeerActivity({
    channelFactory, now: () => clock, newId: () => `ephemeral_${++serial}`,
    enqueue: callback => jobs.push(callback),
    setIntervalFn: (callback, period) => { const id = ++serial;timers.set(id, { callback, period, at: clock + period });return id; },
    clearIntervalFn: id => timers.delete(id), ...options,
  });
  return { make, channels, sent, timers, flush, advance, now: () => clock };
}

test('moment signals expire without a draft lease and the first edge is deferred without feedback', () => {
  const f = fixture();let callbacks = 0, insidePulse = false;
  const a = f.make(), b = f.make({ onPeerActive: () => { callbacks++;assert.equal(insidePulse, false);assert.equal(b.isPeerActive(), true); } });
  insidePulse = true;a.pulse();a.pulse();insidePulse = false;
  assert.equal(b.isPeerActive(), true);assert.equal(callbacks, 0);
  f.flush();assert.equal(callbacks, 1);assert.equal(f.sent.length, 2, 'receiving never publishes');
  f.advance(5000);assert.equal(b.isPeerActive(), false);
  a.pulse();f.flush();assert.equal(callbacks, 2);
  a.dispose();assert.equal(b.isPeerActive(), false);b.dispose();
});

test('busy renews briefly, lost senders expire, and releases respect other peers', () => {
  const f = fixture();let callbacks = 0;
  const a = f.make(), b = f.make(), receiver = f.make({ onPeerActive: () => callbacks++ });
  a.setBusy(true);b.pulse();f.flush();assert.equal(receiver.getState().peerCount, 2);
  f.advance(12_000);assert.equal(receiver.getState().peerCount, 1);assert.equal(callbacks, 1);
  b.setBusy(true);a.setBusy(false);f.flush();assert.equal(receiver.getState().peerCount, 1);
  assert.equal(receiver.isPeerActive(), true);
  f.advance(5001, false);assert.equal(receiver.isPeerActive(), false, 'a suspended sender cannot hold a lease forever');
  a.dispose();b.dispose();receiver.dispose();assert.equal(f.timers.size, 0);
});

test('strict wire schema rejects content, invalid ids, old timestamps and reordered leases', () => {
  const f = fixture();let edges = 0;
  const receiver = f.make({ onPeerActive: () => edges++ }), channel = [...f.channels][0];
  const base = { v: 1, sender: 'other_ephemeral', seq: 1, kind: 'lease', at: f.now() };
  const invalid = [null, [], {}, { ...base, text: 'never share this' }, { ...base, identity: 'private' },
    { ...base, sender: 'x' }, { ...base, sender: '../unsafe-name' }, { ...base, seq: NaN }, { ...base, seq: 0 },
    { ...base, seq: 1.2 }, { ...base, at: f.now() - 5000 }, { ...base, at: f.now() + 1001 },
    { ...base, kind: 'draft' }, { ...base, v: 2 }];
  for (const value of invalid) channel.deliver(value);
  f.flush();assert.equal(receiver.isPeerActive(), false);assert.equal(edges, 0);
  channel.deliver(base);f.flush();assert.equal(edges, 1);
  channel.deliver({ ...base, seq: 3, kind: 'release' });
  channel.deliver({ ...base, seq: 2 });
  channel.deliver(base);f.flush();assert.equal(receiver.isPeerActive(), false);assert.equal(edges, 1);
  f.advance(5001);channel.deliver({ ...base, seq: 4 });assert.equal(receiver.isPeerActive(), false, 'delayed old traffic never revives a lease');
  receiver.dispose();
});

test('scope separates inspection, outbound data is minimal, and teardown cancels pending edge callbacks', () => {
  const f = fixture();let edges = 0;
  const a = f.make(), b = f.make({ onPeerActive: () => edges++ }), inspection = f.make({ scope: 'inspection' });
  a.pulse();assert.equal(b.isPeerActive(), true);assert.equal(inspection.isPeerActive(), false);
  assert.deepEqual(Object.keys(f.sent[0].value).sort(), ['at', 'kind', 'sender', 'seq', 'v']);
  assert.deepEqual(Object.keys(b.getState()).sort(), ['peerActive', 'peerCount', 'remainingMs', 'supported']);
  b.dispose();f.flush();assert.equal(edges, 0);
  a.setBusy(true);a.dispose();assert.equal(f.timers.size, 0);
  assert.equal(f.sent.at(-1).value.kind, 'release');assert.equal(a.pulse(), false);
  inspection.dispose();assert.equal(f.channels.size, 0);
});

test('missing or broken APIs are inert and malformed busy values never start renewals', () => {
  const f = fixture();let edges = 0;
  const unsupported = f.make({ channelFactory: () => { throw new Error('Unavailable'); }, onPeerActive: () => edges++ });
  assert.equal(unsupported.getState().supported, false);assert.equal(unsupported.pulse(), false);
  assert.equal(unsupported.setBusy(true), false);assert.equal(unsupported.isPeerActive(), false);unsupported.dispose();
  const broken = f.make({ channelFactory: () => ({ addEventListener() {}, postMessage() { throw Error('closed'); }, close() {} }) });
  assert.equal(broken.setBusy(true), false);assert.equal(broken.getState().supported, false);
  const a = f.make();assert.equal(a.setBusy('draft text'), false);assert.equal(f.timers.size, 0);
  a.dispose();broken.dispose();f.flush();assert.equal(edges, 0);
});

test('peer bookkeeping is bounded and a callback cannot synchronously reenter itself', () => {
  const f = fixture();let depth = 0, maxDepth = 0, edges = 0;
  const receiver = f.make({ onPeerActive: () => {
    depth++;maxDepth = Math.max(maxDepth, depth);edges++;
    if (edges === 1) {
      channel.deliver({ ...base, seq: 2, kind: 'release' });
      channel.deliver({ ...base, seq: 3 });
    }
    depth--;
  } });
  const channel = [...f.channels][0], base = { v: 1, sender: 'first_ephemeral', seq: 1, kind: 'lease', at: f.now() };
  channel.deliver(base);f.flush();assert.equal(edges, 2);assert.equal(maxDepth, 1);
  for (let index = 0; index < 50; index++) channel.deliver({ ...base, sender: `ephemeral_peer_${index}`, at: f.now() + 999 });
  assert.equal(receiver.getState().peerCount, 32);
  assert.equal(receiver.getState().remainingMs, 5000, 'a slightly future clock never extends retention beyond five seconds');
  f.advance(5001);assert.equal(receiver.isPeerActive(), false);
  channel.deliver({ ...base, sender: 'fresh_ephemeral', at: f.now() });f.flush();
  assert.equal(receiver.getState().peerCount, 1);receiver.dispose();
});

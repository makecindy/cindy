import { afterEach, expect, it, vi } from 'vitest';
import { createDirectRuntimeBridge, type DirectRuntimeCommand } from '../directRuntimeBridge.js';
import { DirectLinkNegotiator, parseDirectSignal, type DirectRuntimeEvents, type DirectRuntime,
  type DirectDiagnostic, type DirectSignal } from '../directNegotiation.js';
import { createDirectRuntimeHost } from '../directRuntimeBridge.js';
import { createDirectRtcRuntime } from '../directRtcRuntime.js';

// Production bridge/negotiator lifetimes absent from #6825: native queue pressure,
// stale callbacks, pending handshake cancellation and authenticated stream binding.
// Unit tier: in-memory native messages, fake time, no sockets or platform processes.
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const observers = () => ({ open: vi.fn(), message: vi.fn(), drained: vi.fn(), closed: vi.fn() });

it('counts UTF-8 bytes still crossing the native bridge and ignores stale buffer acknowledgements', async () => {
  const bridge = createDirectRuntimeBridge(), events = observers(), sent: DirectRuntimeCommand[] = [];
  const detach = bridge.attach(c => sent.push(c));
  const session = bridge.runtime.create('one', events);
  bridge.receive({ type: 'open', connection: 'one' });
  session.send('😀');
  expect(session.bufferedAmount).toBe(4);
  bridge.receive({ type: 'buffer', connection: 'one', sequence: 1, buffered: 512 });
  expect(session.bufferedAmount).toBe(512);
  bridge.receive({ type: 'buffer', connection: 'one', sequence: 0, buffered: 0 });
  expect(session.bufferedAmount).toBe(512);
  bridge.receive({ type: 'buffer', connection: 'one', sequence: 1, buffered: 0 });
  await Promise.resolve();
  expect(session.bufferedAmount).toBe(0);
  expect(events.drained).toHaveBeenCalled();
  expect(sent[0]).toMatchObject({ action: 'send', sequence: 1, text: '😀' });
  detach();
});

it('releases pending operations on native loss and refuses late replies or frames from that process', async () => {
  const bridge = createDirectRuntimeBridge(), events = observers(), sent: DirectRuntimeCommand[] = [];
  const detach = bridge.attach(c => sent.push(c));
  const session = bridge.runtime.create('one', events);
  const result = session.offer();
  const rejected = expect(result).rejects.toThrow('CLOSED');
  detach(); await rejected;
  bridge.receive({ type: 'reply', id: sent[0].id, ok: true, value: 'late-sdp' });
  bridge.receive({ type: 'open', connection: 'one' });
  bridge.receive({ type: 'message', connection: 'one', text: 'late-frame' });
  expect(events.closed).toHaveBeenCalledOnce();
  expect(events.open).not.toHaveBeenCalled(); expect(events.message).not.toHaveBeenCalled();
  expect(() => session.send('late-send')).toThrow('CLOSED');
});

it('bounds a stalled native command without affecting another peer', async () => {
  vi.useFakeTimers();
  const bridge = createDirectRuntimeBridge(), one = observers(), two = observers();
  const detach = bridge.attach(() => {});
  const first = bridge.runtime.create('one', one), second = bridge.runtime.create('two', two);
  bridge.receive({ type: 'open', connection: 'two' });
  const result = first.offer(), rejected = expect(result).rejects.toThrow('TIMEOUT');
  await vi.advanceTimersByTimeAsync(10_000); await rejected;
  expect(one.closed).toHaveBeenCalledOnce(); expect(two.closed).not.toHaveBeenCalled();
  expect(() => second.send('healthy')).not.toThrow();
  detach();
});

it('does not revive an authorized peer after its in-flight offer is cancelled', async () => {
  vi.useFakeTimers();
  let resolve!: (sdp: string) => void, callbacks!: DirectRuntimeEvents;
  const close = vi.fn(), signal = vi.fn(), attach = vi.fn();
  const controller = new DirectLinkNegotiator({
    runtime: { create(_id, events) { callbacks = events; return { offer: () => new Promise(r => { resolve = r; }),
      accept: async () => 'answer', answer: async () => {}, send() {}, bufferedAmount: 0, close }; } },
    identity: () => 'a', streams: () => ({ local: 'a-stream', remote: 'b-stream' }),
    id: () => 'attempt', signal, attach,
  });
  controller.ready('b'); controller.forget('b');
  resolve('late-offer'); callbacks.open(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(65_000);
  expect(signal).not.toHaveBeenCalled(); expect(attach).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
});

it('binds incoming negotiation to both current transport streams', async () => {
  const create = vi.fn();
  const controller = new DirectLinkNegotiator({ runtime: { create }, identity: () => 'b',
    streams: () => ({ local: 'b-new', remote: 'a-new' }), id: () => 'id', signal() {}, attach: vi.fn(),
  });
  for (const [stream, targetStream] of [['a-old', 'b-new'], ['a-new', 'b-old']]) {
    controller.receive('a', { action: 'offer', id: 'old-offer', stream, targetStream, sdp: 'offer' });
  }
  expect(create).not.toHaveBeenCalled();
  expect(parseDirectSignal({ action: 'offer', id: 'valid', stream: 'a', targetStream: 'b', sdp: 'x'.repeat(128 * 1024 + 1) })).toBeNull();
  expect(parseDirectSignal({ action: 'offer', id: 'valid', stream: 'a', targetStream: 'b' })).toBeNull();
  controller.clear();
});

// Direct-link recovery contract (protocol-compatibility.md): failed LAN attempts
// retry independently without blocking relay traffic. Existing tests fence stale
// offers but do not cover retry timing, cancellation or stable-connection reset.
// Unit tier: virtual time and an in-memory runtime, with no sockets or real waits.
function negotiationFixture(identity = 'a') {
  const sessions: Array<{ events: DirectRuntimeEvents; close: ReturnType<typeof vi.fn> }> = [];
  const create = vi.fn((_id: string, events: DirectRuntimeEvents) => {
    const close = vi.fn();
    sessions.push({ events, close });
    return { offer: async () => 'offer', accept: async () => 'answer', answer: async () => {},
      send() {}, bufferedAmount: 0, close };
  });
  const signal = vi.fn();
  let nextId = 0;
  const controller = new DirectLinkNegotiator({
    runtime: { create }, identity: () => identity,
    streams: () => ({ local: 'local', remote: 'remote' }), id: () => `attempt-${++nextId}`,
    signal, attach: () => ({ receive() {}, drained() {}, closed() {}, isActive: () => true }),
  });
  return { controller, create, signal, sessions };
}

// Capacity regression: the old map limit retained failed/closed peers forever and
// silently discarded the 17th ready hint. Exercise admission/recovery, not constants.
it('admits a waiting peer when another peer leaves without another ready hint', async () => {
  vi.useFakeTimers();
  const fixture = negotiationFixture();
  try {
    for (let i = 0; i < 17; i++) fixture.controller.ready(`b-${i}`);
    expect(fixture.create).toHaveBeenCalledTimes(16);
    fixture.controller.forget('b-0');
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.create).toHaveBeenCalledTimes(17);
  } finally { fixture.controller.clear(); }
});

function capacityFixture(maxPeers: number, reservedPeers = 0) {
  const bridge = createDirectRuntimeBridge({ maxPeers, reservedPeers });
  const sessions = new Map<string, DirectRuntimeEvents>();
  const native: DirectRuntime = { create(id, events) {
    sessions.set(id, events);
    return { offer: async () => 'offer', accept: async () => 'answer', answer: async () => {},
      bufferedAmount: 0, send() {}, close() { sessions.delete(id); } };
  } };
  const host = createDirectRuntimeHost(native, e => bridge.receive(e));
  const detach = bridge.attach(c => { void host.command(c); });
  let sequence = 0;
  const diagnostics: Array<{ peer: string } & DirectDiagnostic> = [];
  const makeController = (kind: 'device' | 'share', identity = 'a',
    streams = (_id: string): { local: string; remote: string } | null => ({ local: 'local', remote: 'remote' }),
    busy = (_id: string) => false, runtime = bridge.runtime) => new DirectLinkNegotiator({
      runtime, identity: () => identity, kind: () => kind, streams, isBusy: busy,
      id: () => `capacity-${++sequence}`, signal() {},
      diagnostic: (peer, event) => diagnostics.push({ peer, ...event }),
      attach: () => ({ receive() {}, drained() {}, closed() {}, isActive: () => true }),
    });
  return { bridge, sessions, diagnostics, makeController, dispose() { detach(); host.dispose(); } };
}

// Capacity recovery/fairness contract: class reservations apply across clients,
// queues are FIFO within a class and alternating between classes. Unit tier;
// real bridge and browser host, virtual time, no external signaling or model calls.
it('reserves group capacity across clients and fairly drains both queues without displacing healthy channels', async () => {
  vi.useFakeTimers();
  const f = capacityFixture(4, 1), shares = f.makeController('share'), devices = f.makeController('device');
  try {
    for (const id of ['b-s1', 'b-s2', 'b-s3', 'b-s4', 'b-s5']) shares.ready(id);
    devices.ready('b-d1'); devices.ready('b-d2');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.bridge.runtime.capacity!.snapshot()).toMatchObject({ active: 4, queued: 3, share: 3, device: 1 });
    const healthy = [...f.sessions.keys()].slice(1, 3);
    shares.forget('b-s1');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.bridge.runtime.capacity!.snapshot()).toMatchObject({ active: 4, queued: 2, share: 2, device: 2 });
    devices.forget('b-d1');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.bridge.runtime.capacity!.snapshot()).toMatchObject({ active: 4, queued: 1, share: 3, device: 1 });
    shares.forget('b-s5'); // Cancellation must remove a queued candidate, not consume a slot.
    shares.forget('b-s4');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.bridge.runtime.capacity!.snapshot()).toMatchObject({ active: 3, queued: 0 });
    expect(healthy.every(id => f.sessions.has(id))).toBe(true);
    expect(f.diagnostics.filter(d => d.reason === 'capacity-full').map(d => d.peer)).toEqual(['b-s4', 'b-s5', 'b-d2']);
  } finally { shares.clear(); devices.clear(); f.dispose(); }
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['released', 'revoked', 'generation', 'close', 'expired'] as const)('handles a queued incoming offer after %s', async mode => {
  vi.useFakeTimers();
  const f = capacityFixture(1);
  let valid = true, generation = 'local';
  const controller = f.makeController('share', 'z', id => valid || id === 'a'
    ? { local: generation, remote: 'remote' } : null);
  const offer = (id: string): DirectSignal => ({ action: 'offer', id, stream: 'remote', targetStream: 'local', sdp: 'private-sdp' });
  try {
    controller.receive('a', offer('first')); controller.receive('b', offer('queued'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.bridge.runtime.capacity!.snapshot()).toMatchObject({ active: 1, queued: 1 });
    if (mode === 'revoked') valid = false;
    if (mode === 'generation') generation = 'new-local';
    if (mode === 'close') controller.receive('b', { ...offer('queued'), action: 'close' });
    if (mode === 'expired') await vi.advanceTimersByTimeAsync(15_000);
    controller.forget('a'); await vi.advanceTimersByTimeAsync(0);
    expect(f.sessions.has('queued')).toBe(mode === 'released');
    expect(f.bridge.runtime.capacity!.snapshot()).toMatchObject({ active: mode === 'released' ? 1 : 0, queued: 0 });
  } finally { controller.clear(); f.dispose(); }
});

it('recovers from an asynchronous desktop-style capacity rejection', async () => {
  vi.useFakeTimers();
  const f = capacityFixture(1), first = f.makeController('device');
  const lazy: DirectRuntime = { capacity: f.bridge.runtime.capacity, create(id, events, options) {
    let session: ReturnType<DirectRuntime['create']> | undefined;
    return { offer: async () => { session = f.bridge.runtime.create(id, events, options); return session.offer(); },
      accept: async () => '', answer: async () => {}, send() {}, bufferedAmount: 0, close() { session?.close(); } };
  } };
  const second = f.makeController('device', 'a', undefined, undefined, lazy);
  try {
    first.ready('b-first'); second.ready('b-second');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.bridge.runtime.capacity!.snapshot()).toMatchObject({ active: 1, queued: 1 });
    first.forget('b-first'); await vi.advanceTimersByTimeAsync(0);
    expect(f.sessions.size).toBe(1);
    expect(f.bridge.runtime.capacity!.snapshot()).toMatchObject({ active: 1, queued: 0 });
  } finally { first.clear(); second.clear(); f.dispose(); }
});

it('reclaims only long-idle channels under pressure and wakes them on later business traffic', async () => {
  vi.useFakeTimers();
  const f = capacityFixture(2);
  let busy = true;
  const controller = f.makeController('device', 'a', undefined, id => id === 'b-busy' && busy);
  try {
    controller.ready('b-idle'); controller.ready('b-busy');
    await vi.advanceTimersByTimeAsync(0);
    for (const events of f.sessions.values()) events.open();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    controller.ready('b-waiting');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.diagnostics.filter(e => e.reason === 'idle-retired').map(e => e.peer)).toEqual(['b-idle']);
    expect(f.bridge.runtime.capacity!.snapshot()).toMatchObject({ active: 2, queued: 0 });
    for (const events of f.sessions.values()) events.open();
    controller.activity('b-idle');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.bridge.runtime.capacity!.snapshot().queued).toBe(1);
    busy = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.diagnostics.filter(e => e.reason === 'idle-retired').map(e => e.peer)).toEqual(['b-idle', 'b-busy']);
  } finally { controller.clear(); f.dispose(); }
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps an idle reserved channel when releasing it cannot admit the waiting class', async () => {
  vi.useFakeTimers();
  const f = capacityFixture(4, 1), devices = f.makeController('device', 'a', undefined, () => true), shares = f.makeController('share');
  try {
    for (let i = 0; i < 4; i++) devices.ready(`b-device-${i}`);
    shares.ready('b-share'); await vi.advanceTimersByTimeAsync(0);
    for (const events of f.sessions.values()) events.open();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(f.bridge.runtime.capacity!.snapshot()).toMatchObject({ active: 4, queued: 1 });
    expect(f.diagnostics.filter(e => e.reason === 'idle-retired')).toEqual([]);
  } finally { devices.clear(); shares.clear(); f.dispose(); }
});

it('admits the desktop budget through the browser host while retaining a bounded mobile default', async () => {
  vi.useFakeTimers();
  const f = capacityFixture(64, 8), sessions: Array<ReturnType<DirectRuntime['create']>> = [];
  try {
    for (let i = 0; i < 64; i++) {
      const s = f.bridge.runtime.create(`desktop-${i}`, observers(), { kind: i < 8 ? 'device' : 'share' });
      sessions.push(s); await expect(s.offer()).resolves.toBe('offer');
    }
    expect(f.sessions.size).toBe(64);
    expect(() => f.bridge.runtime.create('overflow', observers())).toThrow('DIRECT_CAPACITY_FULL');
    sessions[0].close();
    const replacement = f.bridge.runtime.create('replacement', observers());
    await expect(replacement.offer()).resolves.toBe('offer');
    replacement.close();
    const mobile = createDirectRuntimeBridge(), detach = mobile.attach(() => {});
    for (let i = 0; i < 16; i++) mobile.runtime.create(`mobile-${i}`, observers());
    expect(() => mobile.runtime.create('mobile-overflow', observers())).toThrow('DIRECT_CAPACITY_FULL');
    detach();
  } finally { sessions.forEach(s => s.close()); f.dispose(); }
});

it('distinguishes capacity, network loss and negotiation timeout without affecting a healthy peer', async () => {
  vi.useFakeTimers();
  const f = capacityFixture(2), controller = f.makeController('device');
  try {
    controller.ready('b-network'); controller.ready('b-healthy'); controller.ready('b-waiting');
    await vi.advanceTimersByTimeAsync(0);
    const [failed, healthy] = [...f.sessions];
    failed[1].open(); healthy[1].open();
    failed[1].closed('network-failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.diagnostics).toContainEqual(expect.objectContaining({ peer: 'b-waiting', reason: 'capacity-full', active: 2, queued: 1 }));
    expect(f.diagnostics).toContainEqual(expect.objectContaining({ peer: 'b-network', reason: 'network-failed', active: 1 }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.diagnostics).toContainEqual(expect.objectContaining({ peer: 'b-waiting', reason: 'negotiation-timeout' }));
    expect(f.sessions.has(healthy[0])).toBe(true);
  } finally { controller.clear(); f.dispose(); }
});

it('bounds the shared wait queue and reports overflow instead of retaining rejected candidates', async () => {
  vi.useFakeTimers();
  const f = capacityFixture(1), occupied = f.makeController('device'), queued = f.makeController('share'), extra = f.makeController('share');
  try {
    occupied.ready('b-occupied');
    for (let i = 0; i < 256; i++) queued.ready(`b-${i}`);
    extra.ready('b-overflow');
    expect(f.bridge.runtime.capacity!.snapshot()).toMatchObject({ active: 1, queued: 256 });
    expect(f.diagnostics).toContainEqual(expect.objectContaining({ peer: 'b-overflow', reason: 'queue-full' }));
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(f.bridge.runtime.capacity!.snapshot()).toMatchObject({ active: 0, queued: 0 });
  } finally { occupied.clear(); queued.clear(); extra.clear(); f.dispose(); }
  expect(vi.getTimerCount()).toBe(0);
});

it('spreads simultaneous failed peers across the first retry window', async () => {
  vi.useFakeTimers();
  let sample = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => (sample++ % 16) / 16);
  const fixture = negotiationFixture();
  const started = Date.now();
  const retries: number[] = [];
  fixture.create.mockImplementation(() => {
    retries.push(Date.now() - started);
    throw new Error('runtime unavailable');
  });
  try {
    for (let i = 0; i < 16; i++) fixture.controller.ready(`b-${i}`);
    await vi.advanceTimersByTimeAsync(5_000);
    const wave = retries.slice(16);
    expect(wave).toHaveLength(16);
    expect(wave.every(delay => delay >= 4_000 && delay <= 5_000)).toBe(true);
    const buckets = new Map<number, number>();
    for (const delay of wave) {
      const bucket = Math.floor(delay / 100);
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
    expect(Math.max(...buckets.values())).toBeLessThanOrEqual(2);
  } finally { fixture.controller.clear(); }
});

it.each([0, 0.999999])('bounds jittered exponential retries through the capped stage (random=%s)', async random => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(random);
  const fixture = negotiationFixture();
  fixture.create.mockImplementation(() => { throw new Error('runtime unavailable'); });
  try {
    fixture.controller.ready('b');
    for (const base of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      const before = fixture.create.mock.calls.length;
      const delay = Math.floor(base * (0.8 + random * 0.2));
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fixture.create).toHaveBeenCalledTimes(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(fixture.create).toHaveBeenCalledTimes(before + 1);
    }
  } finally { fixture.controller.clear(); }
});

it('times out negotiation and schedules only one retry for repeated ready hints', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const fixture = negotiationFixture();
  try {
    fixture.controller.ready('b');
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fixture.sessions[0].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.sessions[0].close).toHaveBeenCalledOnce();
    for (let i = 0; i < 5; i++) fixture.controller.ready('b');
    await vi.advanceTimersByTimeAsync(4_499);
    expect(fixture.create).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.create).toHaveBeenCalledTimes(2);
    expect(fixture.signal.mock.calls.filter(([, signal]) => signal.action === 'offer')).toHaveLength(2);
  } finally { fixture.controller.clear(); }
});

it.each(['forget', 'clear'] as const)('cancels a pending direct retry on %s', async action => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const fixture = negotiationFixture();
  fixture.create.mockImplementation(() => { throw new Error('runtime unavailable'); });
  fixture.controller.ready('b');
  if (action === 'forget') fixture.controller.forget('b');
  else fixture.controller.clear();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(fixture.create).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('leaves retry initiation to the offerer when an incoming offer fails', async () => {
  vi.useFakeTimers();
  const fixture = negotiationFixture('b');
  fixture.create.mockImplementation(() => { throw new Error('runtime unavailable'); });
  try {
    fixture.controller.receive('a', { action: 'offer', id: 'incoming', stream: 'remote', targetStream: 'local', sdp: 'offer' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fixture.create).toHaveBeenCalledOnce();
    expect(fixture.signal).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { fixture.controller.clear(); }
});

it.each([59_999, 60_000])('resets retry backoff only after a connection stays open for 60 seconds (open=%ims)', async duration => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const fixture = negotiationFixture();
  fixture.create.mockImplementationOnce(() => { throw new Error('runtime unavailable'); });
  try {
    fixture.controller.ready('b');
    await vi.advanceTimersByTimeAsync(4_500);
    expect(fixture.create).toHaveBeenCalledTimes(2);
    fixture.sessions[0].events.open();
    await vi.advanceTimersByTimeAsync(duration);
    fixture.sessions[0].events.closed();
    const delay = duration < 60_000 ? 9_000 : 4_500;
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(fixture.create).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.create).toHaveBeenCalledTimes(3);
  } finally { fixture.controller.clear(); }
});

it.each(['small-then-large', 'progress-under-pressure'])('reports native RTC drain through the real bridge (%s)', async mode => {
  vi.useFakeTimers();
  // A real DataChannel only fires bufferedamountlow when it crosses its threshold.
  // Model that contract rather than unconditionally notifying on drain.
  class Channel {
    label = 'device-link-v1'; ordered = true; maxRetransmits = null; maxPacketLifeTime = null;
    readyState = 'open'; bufferedAmount = 0; bufferedAmountLowThreshold = 0;
    onopen?: () => void; onclose?: () => void; onbufferedamountlow?: () => void;
    send(bytes: ArrayBuffer) { this.bufferedAmount += bytes.byteLength; }
    drain(amount = 0) {
      const previous = this.bufferedAmount; this.bufferedAmount = amount;
      if (previous > this.bufferedAmountLowThreshold && amount <= this.bufferedAmountLowThreshold) this.onbufferedamountlow?.();
    }
    close() { this.readyState = 'closed'; this.onclose?.(); }
  }
  const channel = new Channel();
  vi.stubGlobal('RTCPeerConnection', class {
    iceGatheringState = 'complete'; localDescription?: unknown;
    createDataChannel() { return channel; }
    async createOffer() { return { type: 'offer', sdp: 'fixture' }; }
    async setLocalDescription(value: unknown) { this.localDescription = value; }
    close() {}
  });
  const bridge = createDirectRuntimeBridge(), events = observers();
  const host = createDirectRuntimeHost(createDirectRtcRuntime(), e => bridge.receive(e));
  const detach = bridge.attach(c => { void host.command(c); });
  const session = bridge.runtime.create('one', events);
  try {
    await session.offer(); channel.onopen?.();
    if (mode === 'small-then-large') {
      session.send('small');
      expect(session.bufferedAmount).toBeGreaterThan(0);
      channel.drain(); await Promise.resolve();
      expect(session.bufferedAmount).toBe(0);
      session.send('😀'.repeat(300_000));
      expect(session.bufferedAmount).toBeGreaterThan(1024 * 1024);
      channel.drain(); await Promise.resolve();
      expect(session.bufferedAmount).toBe(0);
    } else {
      session.send('x'.repeat(1_200_000));
      channel.drain(700_000);
      await vi.advanceTimersByTimeAsync(100);
      expect(session.bufferedAmount).toBe(700_000);
      channel.drain(); await Promise.resolve();
      expect(session.bufferedAmount).toBe(0);
    }
  } finally { detach(); host.dispose(); }
});

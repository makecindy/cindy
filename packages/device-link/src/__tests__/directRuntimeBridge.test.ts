import { afterEach, expect, it, vi } from 'vitest';
import { createDirectRuntimeBridge, type DirectRuntimeCommand } from '../directRuntimeBridge.js';
import { DirectLinkNegotiator, parseDirectSignal, type DirectRuntimeEvents } from '../directNegotiation.js';
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

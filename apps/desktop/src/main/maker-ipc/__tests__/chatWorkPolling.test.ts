import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createChatWorkPolling, createWorkRequestGate, WorkRequestDeferred, type WorkActor, type WorkAvailability } from '../chatWorkPolling.js';

// Invariants of the public scheduler: only discovery batches, no cross-actor
// promise barrier, stale read protection and one immediately shared gate.
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
type Execution = { actor: string };
const errorInfo = (error: unknown) => error as { status?: number; retryAt?: number };
const cleanups: Array<() => void> = [];
function fixture(count = 2) {
  let active = true, probeEnabled = true, longIdle = true;
  const actors: WorkActor[] = Array.from({ length: count }, (_, index) => ({ id: `actor-${index}`, busy: false, ready: true }));
  const gate = createWorkRequestGate(errorInfo);
  const probe = vi.fn(async (ids: string[]): Promise<WorkAvailability[]> => ids.map(botId => ({ botId, pending: false, enabled: true })));
  const claim = vi.fn(async (_id: string): Promise<Execution | null> => null);
  const scan = vi.fn(async (_id: string) => {});
  const accept = vi.fn((execution: Execution) => { actors.find(actor => actor.id === execution.actor)!.busy = true; });
  const empty = vi.fn(), disabled = vi.fn(), failed = vi.fn();
  const poller = createChatWorkPolling({ current: () => active, actors: () => actors, gate, errorInfo,
    canProbe: () => probeEnabled, longIdle: () => longIdle, probe, claim, scan, accept, empty, disabled, failed });
  const timer = setInterval(poller.tick, 2000);
  cleanups.push(() => { clearInterval(timer); poller.dispose(); });
  return { actors, gate, probe, claim, scan, accept, empty, failed, poller,
    stop: () => { active = false; }, legacy: () => { probeEnabled = false; poller.reset(); },
    disconnect: () => { longIdle = false; poller.shortenIdle(); } };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-29T00:00:00Z')); });
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.useRealTimers(); });

it('batches only read-only discovery and bounds its concurrency without delaying a direct wake', async () => {
  const f = fixture(600);
  let active = 0, peak = 0;
  const reads: Array<{ ids: string[]; done: ReturnType<typeof deferred<WorkAvailability[]>> }> = [];
  f.probe.mockImplementation(ids => {
    active++; peak = Math.max(peak, active);
    const done = deferred<WorkAvailability[]>(); reads.push({ ids, done });
    return done.promise.finally(() => { active--; });
  });
  f.claim.mockImplementation(async actor => ({ actor }));
  f.poller.tick();
  expect(reads.map(read => read.ids.length)).toEqual([128, 128, 128, 128]);
  f.poller.wake(['actor-1', 'actor-599']);
  await vi.advanceTimersByTimeAsync(250);
  expect(f.accept.mock.calls.map(([execution]) => execution.actor)).toEqual(['actor-1', 'actor-599']);
  for (const read of reads.slice()) read.done.resolve(read.ids.map(botId => ({ botId, pending: false, enabled: true })));
  await vi.advanceTimersByTimeAsync(2);
  expect(peak).toBe(4);
  expect(reads).toHaveLength(5);
  expect(f.empty).not.toHaveBeenCalledWith('actor-1');
  expect(f.claim).toHaveBeenCalledTimes(2);
});

it('accepts a healthy actor result while another claim and another busy scan remain unresolved', async () => {
  const f = fixture(3); f.legacy();
  f.actors[0]!.busy = true;
  const scan = deferred<void>(), claim = deferred<Execution | null>();
  f.scan.mockImplementation(id => id === 'actor-0' ? scan.promise : Promise.resolve());
  f.claim.mockImplementation(id => id === 'actor-1' ? claim.promise : Promise.resolve({ actor: id }));
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.accept).toHaveBeenCalledExactlyOnceWith({ actor: 'actor-2' });
  for (let i = 0; i < 5; i++) { f.poller.wake(['actor-0', 'actor-1']); await vi.advanceTimersByTimeAsync(500); }
  expect(f.claim.mock.calls.filter(([id]) => id === 'actor-1')).toHaveLength(1);
  expect(f.scan.mock.calls.filter(([id]) => id === 'actor-0')).toHaveLength(1);
  claim.resolve({ actor: 'actor-1' }); scan.resolve();
  await vi.advanceTimersByTimeAsync(2);
  expect(f.accept).toHaveBeenCalledWith({ actor: 'actor-1' });
});

it('does not let a stale empty probe erase newer hints even after the intervening claim returned empty', async () => {
  const f = fixture(1), read = deferred<WorkAvailability[]>();
  f.probe.mockReturnValueOnce(read.promise);
  f.poller.tick(); f.poller.wake(['actor-0']);
  await vi.advanceTimersByTimeAsync(250);
  expect(f.claim).toHaveBeenCalledOnce();
  read.resolve([{ botId: 'actor-0', enabled: true, pending: false }]);
  await vi.advanceTimersByTimeAsync(2);
  expect(f.empty).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(4000);
  expect(f.empty).toHaveBeenCalledWith('actor-0');
});

it('coalesces wakes and keeps a newer wake received during a claim', async () => {
  const f = fixture(1), first = deferred<Execution | null>();
  f.claim.mockReturnValueOnce(first.promise);
  for (let i = 0; i < 20; i++) f.poller.wake(['actor-0']);
  await vi.advanceTimersByTimeAsync(249); expect(f.claim).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(f.claim).toHaveBeenCalledOnce();
  f.poller.wake(['actor-0']); await vi.advanceTimersByTimeAsync(250);
  expect(f.claim).toHaveBeenCalledOnce();
  first.resolve(null); await vi.advanceTimersByTimeAsync(2);
  expect(f.claim).toHaveBeenCalledTimes(2);
});

it('applies the longest restriction immediately across scans, claims and probes without discarding in-flight success', async () => {
  const f = fixture(3); f.legacy(); f.actors[0]!.busy = true;
  const read = deferred<void>(), positive = deferred<Execution | null>();
  const nextRequest = vi.fn();
  f.scan.mockImplementation(async () => { await read.promise; f.gate.check(); nextRequest(); });
  f.claim.mockImplementation(id => id === 'actor-1'
    ? Promise.reject({ status: 429, retryAt: Date.now() + 180_000 }) : positive.promise);
  await vi.advanceTimersByTimeAsync(2000);
  const until = f.gate.until;
  f.gate.observe({ status: 401 });
  expect(f.gate.until).toBe(until);
  read.resolve(); positive.resolve({ actor: 'actor-2' });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(nextRequest).not.toHaveBeenCalled();
  expect(f.accept).toHaveBeenCalledExactlyOnceWith({ actor: 'actor-2' });
  expect(f.claim).toHaveBeenCalledTimes(2);
  expect(() => f.gate.check()).toThrow(WorkRequestDeferred);
});

it('backs off a broken probe independently while a work notice can still claim', async () => {
  const f = fixture(2);
  f.probe.mockRejectedValue({ status: 503 });
  f.poller.tick(); await vi.advanceTimersByTimeAsync(2);
  f.claim.mockImplementation(async actor => ({ actor }));
  f.poller.wake(['actor-1']); await vi.advanceTimersByTimeAsync(250);
  expect(f.accept).toHaveBeenCalledExactlyOnceWith({ actor: 'actor-1' });
  expect(f.claim).toHaveBeenCalledTimes(1);
});

it('holds concurrent authentication renewals without erasing a longer rate limit on release', () => {
  const gate = createWorkRequestGate(errorInfo);
  const first = gate.hold(), second = gate.hold();
  first(); first();
  expect(() => gate.check()).toThrow(WorkRequestDeferred);
  second();
  expect(() => gate.check()).not.toThrow();
  const release = gate.hold();
  gate.observe({ status: 429, retryAt: Date.now() + 180_000 });
  release();
  vi.setSystemTime(Date.now() + 60_000);
  expect(() => gate.check()).toThrow(WorkRequestDeferred);
  vi.setSystemTime(Date.now() + 120_000);
  expect(() => gate.check()).not.toThrow();
});

it('uses long idle only after a complete empty read and shortens scheduled waits on disconnect', async () => {
  const f = fixture(2);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(f.claim).not.toHaveBeenCalled();
  expect(f.probe.mock.calls.length).toBeLessThan(10);
  const before = f.probe.mock.calls.length;
  f.disconnect(); await vi.advanceTimersByTimeAsync(18_000);
  expect(f.probe.mock.calls.length).toBeGreaterThan(before);
});

it('falls back without carrying an ambiguous mutation when the read-only endpoint is unavailable', async () => {
  const f = fixture(1);
  f.probe.mockImplementation(async () => { f.legacy(); throw { status: 404 }; });
  await vi.advanceTimersByTimeAsync(4000);
  expect(f.claim).toHaveBeenCalledOnce();
  expect(f.failed).not.toHaveBeenCalled();
});

it('drops stale account results and does not schedule more work after disposal', async () => {
  const f = fixture(1), result = deferred<Execution | null>();
  f.legacy(); f.claim.mockReturnValue(result.promise);
  await vi.advanceTimersByTimeAsync(2000);
  f.stop(); f.poller.dispose(); result.resolve({ actor: 'actor-0' });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.accept).not.toHaveBeenCalled();
  expect(f.claim).toHaveBeenCalledOnce();
});

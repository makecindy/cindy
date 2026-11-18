import { afterEach, expect, it, vi } from 'vitest';
import type { DirectRuntimeCommand, DirectRuntimeEvents } from '@cindy/device-link';
const fake = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(), commands: [] as DirectRuntimeCommand[],
  starts: 0, closes: 0, failed: undefined as (() => void) | undefined,
  ready: undefined as Promise<void> | undefined,
}));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => fake.handlers.set(name, fn) } }));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn() {} }) }));
vi.mock('../../remote-desktop/captureWindow', () => ({ DesktopCaptureWindow: class {
  constructor(failed: () => void) { fake.failed = failed; }
  contents = { isDestroyed: () => false, send: (_name: string, c: DirectRuntimeCommand) => {
    fake.commands.push(c);
    if (c.action === 'offer' || c.action === 'answer' || c.action === 'accept')
      fake.handlers.get('direct-link:host:event')!({ trusted: true }, { type: 'reply', id: c.id, ok: true, value: 'fixture-sdp' });
  } };
  async start() { fake.starts++; await fake.ready; }
  dispose() { fake.closes++; }
  registered(event: { trusted: boolean }) { this.assertSender(event); }
  assertSender(event: { trusted: boolean }) { if (!event.trusted) throw new Error('PERMISSION_DENIED'); }
} }));
import { desktopDirectRuntime } from '../directLink';

// Native startup and sender/lifetime boundary cannot be exercised by the browser-only
// transport tests. No real windows, sockets, credentials or module resets in unit tier.
afterEach(() => { desktopDirectRuntime.suspend?.(); fake.commands = []; fake.ready = undefined; vi.useRealTimers(); });
const events = (): DirectRuntimeEvents => ({ open: vi.fn(), closed: vi.fn(), message: vi.fn(), drained: vi.fn() });

it('starts one isolated process lazily and routes authorized native frames to their registered peer', async () => {
  const before = fake.starts, observer = events();
  const a = desktopDirectRuntime.create('one', observer), b = desktopDirectRuntime.create('two', events());
  expect(fake.starts).toBe(before);
  expect(await a.offer()).toBe('fixture-sdp'); expect(await b.offer()).toBe('fixture-sdp');
  expect(fake.starts).toBe(before + 1);
  const receive = fake.handlers.get('direct-link:host:event')!;
  receive({ trusted: true }, { type: 'open', connection: 'one' });
  receive({ trusted: true }, { type: 'message', connection: 'unknown', text: 'foreign' });
  receive({ trusted: true }, { type: 'message', connection: 'one', text: 'authorized' });
  expect(observer.open).toHaveBeenCalledOnce(); expect(observer.message).toHaveBeenCalledExactlyOnceWith('authorized');
  a.send('outbound'); expect(fake.commands.at(-1)).toMatchObject({ action: 'send', connection: 'one', text: 'outbound' });
});

it('rejects foreign senders before processing any bridge event', async () => {
  const observer = events(), session = desktopDirectRuntime.create('one', observer);
  await session.offer();
  expect(() => fake.handlers.get('direct-link:host:event')!({ trusted: false }, { type: 'open', connection: 'one' })).toThrow('PERMISSION_DENIED');
  expect(observer.open).not.toHaveBeenCalled();
});

it('does not create a late session after the authenticated owner was suspended during startup', async () => {
  let resolve!: () => void;
  fake.ready = new Promise(r => { resolve = r; });
  const session = desktopDirectRuntime.create('one', events());
  const opening = session.offer(), rejected = expect(opening).rejects.toThrow('CLOSED');
  desktopDirectRuntime.suspend?.(); resolve(); await rejected;
  expect(fake.commands).toHaveLength(0);
});

// Capacity regression, unit tier: the lazy Desktop adapter must expose one shared
// pool and claim a released slot synchronously when an admission callback runs.
// The shared-package bridge tests cannot catch a wrapper dropping those hooks.
it('uses the desktop budget and synchronously claims a released native slot', async () => {
  const before = fake.starts, sessions = [];
  let replacement: ReturnType<typeof desktopDirectRuntime.create> | undefined;
  let opening: Promise<string> | undefined;
  let cancel: (() => void) | undefined;
  try {
    for (let i = 0; i < 64; i++) {
      const session = desktopDirectRuntime.create(`capacity-${i}`, events(), { kind: i < 8 ? 'device' : 'share' });
      sessions.push(session); await session.offer();
    }
    expect(fake.starts).toBe(before + 1);
    expect(() => desktopDirectRuntime.create('overflow', events(), { kind: 'share' })).toThrow('DIRECT_CAPACITY_FULL');
    cancel = desktopDirectRuntime.capacity!.wait('share', () => {
      replacement = desktopDirectRuntime.create('replacement', events(), { kind: 'share' });
      opening = replacement.offer();
    });
    sessions[8].close();
    await Promise.resolve();
    expect(desktopDirectRuntime.capacity!.snapshot()).toMatchObject({ active: 64, queued: 0 });
    await expect(opening).resolves.toBe('fixture-sdp');
  } finally { cancel?.(); replacement?.close(); sessions.forEach(session => session.close()); }
});

// Regression: two transient renderer failures must not disable every peer's direct
// path until the app restarts. The bridge tests do not cover this native startup
// gate. Fake time covers cooldown, shared startup and healthy recovery in unit tier.
it('bounds crash-loop restarts but lets authorized demand recover after a cooldown', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
  const observer = events(), session = desktopDirectRuntime.create('one', observer);
  await session.offer();
  fake.failed!(); expect(observer.closed).toHaveBeenCalledOnce();
  const second = desktopDirectRuntime.create('two', events()); await second.offer();
  fake.failed!();
  const before = fake.starts;
  const stale = desktopDirectRuntime.create('stale', events());
  const cancelled = desktopDirectRuntime.create('cancelled', events());
  cancelled.close();
  desktopDirectRuntime.suspend?.();
  await expect(desktopDirectRuntime.create('three', events()).offer()).rejects.toThrow('UNAVAILABLE');
  vi.setSystemTime(Date.now() - 60 * 60_000); // Clock correction cannot prolong an elapsed cooldown.
  await vi.advanceTimersByTimeAsync(60_000);
  await expect(stale.offer()).rejects.toThrow('CLOSED');
  await expect(cancelled.offer()).rejects.toThrow('CLOSED');
  expect(fake.starts).toBe(before); // Cooling down never launches a process by itself.
  await Promise.all([
    desktopDirectRuntime.create('recovered-a', events()).offer(),
    desktopDirectRuntime.create('recovered-b', events()).offer(),
  ]);
  expect(fake.starts).toBe(before + 1);

  // A third rapid crash extends the shared cooldown instead of starting a loop.
  fake.failed!();
  await vi.advanceTimersByTimeAsync(60_000);
  await expect(desktopDirectRuntime.create('still-cooling', events()).offer()).rejects.toThrow('UNAVAILABLE');
  expect(fake.starts).toBe(before + 1);
  await vi.advanceTimersByTimeAsync(60_000);
  await desktopDirectRuntime.create('stable', events()).offer();
  expect(fake.starts).toBe(before + 2);

  // Continued failures back off to a bounded five minutes, not permanent denial.
  for (const cooldownMs of [240_000, 300_000, 300_000]) {
    fake.failed!();
    const attempts = fake.starts;
    await vi.advanceTimersByTimeAsync(cooldownMs - 1);
    await expect(desktopDirectRuntime.create('before-deadline', events()).offer()).rejects.toThrow('UNAVAILABLE');
    expect(fake.starts).toBe(attempts);
    await vi.advanceTimersByTimeAsync(1);
    await desktopDirectRuntime.create(`after-${cooldownMs}`, events()).offer();
    expect(fake.starts).toBe(attempts + 1);
  }

  // A healthy process clears old failures; a later isolated crash gets its retry.
  const stableStarts = fake.starts;
  await vi.advanceTimersByTimeAsync(60_000);
  fake.failed!();
  await desktopDirectRuntime.create('fresh-retry', events()).offer();
  expect(fake.starts).toBe(stableStarts + 1);
});

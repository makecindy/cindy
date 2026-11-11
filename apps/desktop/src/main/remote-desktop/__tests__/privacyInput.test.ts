import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { watchAwayGuardInput, watchPrivacyInput } from '../privacyInput';

vi.mock('../inputHost', () => ({ resolveDesktopInputBinary: vi.fn() }));
const platform = process.platform;
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', { value: platform });
});
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: { resume() {} },
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(), writableLength: 0 }),
    kill: vi.fn(),
  });
  const local = vi.fn();
  const failed = vi.fn();
  const runtime = {
    resolveBinary: async () => '/helper',
    spawn: () => child as unknown as ChildProcessWithoutNullStreams,
  };
  const line = (text: string) => child.stdout.emit('data', Buffer.from(text));
  return { child, local, failed, runtime, line };
}

it('requires native acknowledgement and parses split status words without exposing event data', async () => {
  const f = fixture();
  const starting = watchPrivacyInput(f.local, f.failed, f.runtime);
  await Promise.resolve();
  f.line('rea');
  f.line('dy\n');
  const monitor = await starting;
  f.line('local-in');
  f.line('put\n');
  expect(f.local).toHaveBeenCalledExactlyOnceWith();
  let confirmed = false;
  const confirming = monitor.confirm().then(() => {
    confirmed = true;
  });
  await Promise.resolve();
  expect(confirmed).toBe(false);
  expect(f.child.stdin.write).toHaveBeenLastCalledWith('confirm\n');
  f.line('confirmed\n');
  await confirming;
  const resuming = monitor.resume();
  f.line('ready\n');
  await resuming;
  monitor.stop();
  f.child.emit('exit');
  f.line('local-input\n');
  expect(f.local).toHaveBeenCalledOnce();
  expect(f.failed).not.toHaveBeenCalled();
});

it.each(['exit', 'timeout', 'oversized'])(
  'fails closed on %s during confirmation',
  async (mode) => {
    vi.useFakeTimers();
    const f = fixture();
    const starting = watchPrivacyInput(f.local, f.failed, f.runtime);
    await Promise.resolve();
    f.line('ready\n');
    const monitor = await starting;
    const checking = expect(monitor.confirm()).rejects.toThrow('DESKTOP_PRIVACY_UNAVAILABLE');
    if (mode === 'exit') f.child.emit('exit');
    else if (mode === 'oversized') f.line('a'.repeat(1025));
    else await vi.advanceTimersByTimeAsync(5000);
    await checking;
    expect(f.failed).toHaveBeenCalledOnce();
    expect(f.child.stdin.end).toHaveBeenCalledOnce();
    monitor.stop();
  },
);

it('waits for actual process close after EOF or fallback kill, including repeated stop', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const starting = watchPrivacyInput(f.local, f.failed, f.runtime);
  await Promise.resolve();
  f.line('ready\n');
  const monitor = await starting;
  let closed = false;
  const stopping = monitor.stop();
  expect(monitor.stop()).toBe(stopping);
  void stopping.then(() => {
    closed = true;
  });
  expect(f.child.stdin.end).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.child.kill).toHaveBeenCalledOnce();
  expect(closed).toBe(false);
  f.child.emit('exit');
  await Promise.resolve();
  expect(closed).toBe(false);
  f.child.emit('close');
  await stopping;
  expect(closed).toBe(true);
  expect(f.failed).not.toHaveBeenCalled();
});

// Away guard (Settings → Keep working while away): Main may remove the masks only
// after the helper itself confirmed the OS lock; a release never claims a lock.
it.each([
  ['lock', 'locked', true],
  ['lock', 'lock-failed', false],
  ['release', 'released', false],
] as const)('away guard %s reports %s as locked=%s', async (command, reply, locked) => {
  const f = fixture();
  Object.assign(f.child.stdin, { writable: true });
  const ended = vi.fn();
  const starting = watchAwayGuardInput(ended, undefined, f.runtime);
  await Promise.resolve();
  f.line(process.platform === 'win32' ? 'away-ready\n' : 'ready\n');
  const monitor = await starting;
  const finishing = command === 'lock' ? monitor.lock() : monitor.stop().then(() => false);
  expect(f.child.stdin.write).toHaveBeenLastCalledWith(`${command}\n`);
  f.line(`${reply}\n`);
  // A confirmed lock is reported at once: the helper is already exiting by itself, and
  // Main must not wait for (or kill) it before removing masks.
  if (!locked) f.child.emit('close');
  await expect(finishing).resolves.toBe(locked);
  expect(ended).toHaveBeenCalledExactlyOnceWith(locked);
  await monitor.stop();
  f.child.emit('close');
  expect(f.child.kill).not.toHaveBeenCalled();
  expect(ended).toHaveBeenCalledOnce();
});

// New Windows mode must not accept the ordinary ready emitted by old helpers.
// Unit: production startup parser + fake stdio/timers, no native process.
// Standalone vitest duration: 1.28 s on 2026-11-11.
it.each(['ready', 'away-ready'])('Windows away startup requires its own acknowledgement: %s', async (word) => {
  vi.useFakeTimers();
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const f = fixture();
  Object.assign(f.child.stdin, { writable: true });
  f.child.kill.mockImplementation(() => { f.child.emit('close'); });
  const starting = watchAwayGuardInput(vi.fn(), undefined, f.runtime);
  const rejected = word === 'ready'
    ? expect(starting).rejects.toThrow('DESKTOP_PRIVACY_UNAVAILABLE') : undefined;
  await Promise.resolve();
  f.line(`${word}\n`);
  if (rejected) {
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(f.child.kill).toHaveBeenCalledOnce();
  } else {
    const monitor = await starting;
    const stopping = monitor.stop();
    f.child.emit('close');
    await stopping;
    expect(f.child.kill).not.toHaveBeenCalled();
  }
});

// Greptile r4534014236: a failed lock must keep the native physical-input fence.
// Real monitor lock entry, fake stdio/timers; previous timeout killed the helper.
// tier: unit; standalone duration: 0.925 s on 2026-11-11.
it('keeps Windows away helper alive when lock confirmation times out', async () => {
  vi.useFakeTimers();
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const f = fixture();
  const starting = watchAwayGuardInput(f.local, f.failed, f.runtime);
  await Promise.resolve();
  f.line('away-ready\n');
  const monitor = await starting;
  const locking = monitor.lock();
  await vi.advanceTimersByTimeAsync(6000);
  expect(await locking).toBe(false);
  expect(f.child.kill).not.toHaveBeenCalled();
  expect(f.local).not.toHaveBeenCalled();
  f.line('locked\n');
  expect(f.local).toHaveBeenCalledWith(true);
  f.child.emit('close');
});

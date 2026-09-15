import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { watchPrivacyInput } from '../privacyInput';

vi.mock('../inputHost', () => ({ resolveDesktopInputBinary: vi.fn() }));
afterEach(() => vi.useRealTimers());
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

import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ClipboardCounter } from '../clipboardCounter';
import { linuxClipboardVersion } from '../linuxClipboard';

vi.mock('../linuxClipboard', () => ({ linuxClipboardVersion: vi.fn() }));
const platform = process.platform;

function fixture(binary = async () => '/fake/helper') {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  vi.useFakeTimers();
  const children: Array<ChildProcessWithoutNullStreams> = [];
  const launch = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcessWithoutNullStreams;
    children.push(child);
    return child;
  });
  const counter = new ClipboardCounter(binary, launch);
  return { counter, launch, children };
}
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', { value: platform });
});

it('keeps Linux selection versions and failures on the existing Wayland adapter', async () => {
  const binary = vi.fn(async () => '/fake/helper');
  const { counter, launch } = fixture(binary);
  Object.defineProperty(process, 'platform', { value: 'linux' });
  vi.mocked(linuxClipboardVersion).mockResolvedValueOnce('opaque-linux-version');
  expect(await counter.read(true)).toBe('opaque-linux-version');
  vi.mocked(linuxClipboardVersion).mockRejectedValueOnce(
    new Error('DESKTOP_CLIPBOARD_UNAVAILABLE'),
  );
  await expect(counter.read()).rejects.toThrow('DESKTOP_CLIPBOARD_UNAVAILABLE');
  counter.stop();
  expect(binary).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});

it('reuses one process but queries fresh counters, including concurrent portable reads', async () => {
  const { counter, children, launch } = fixture();
  const first = counter.read();
  const second = counter.read(true);
  await vi.advanceTimersByTimeAsync(0);
  const child = children[0];
  expect((child.stdin as PassThrough).read()?.toString()).toBe('1 0\n2 1\n');
  child.stdout.emit('data', '1 10\n2 11\n');
  expect(await first).toBe('10');
  expect(await second).toBe('11');
  await vi.advanceTimersByTimeAsync(1500);
  const next = counter.read();
  await vi.advanceTimersByTimeAsync(0);
  child.stdout.emit('data', '3 12\n');
  expect(await next).toBe('12');
  expect(launch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(4000);
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});

it('cancels startup before a late binary resolution can spawn', async () => {
  let finish!: (value: string) => void;
  const { counter, launch } = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const result = expect(counter.read()).rejects.toThrow('DESKTOP_CLIPBOARD_UNAVAILABLE');
  counter.stop();
  await result;
  finish('/fake/helper');
  await vi.advanceTimersByTimeAsync(0);
  expect(launch).not.toHaveBeenCalled();
});

it.each(['exit', 'error', 'timeout', 'stop', 'write', 'read', 'stderr', 'malformed'])(
  'rejects on %s and isolates late events from the replacement process',
  async (failure) => {
    const { counter, children } = fixture();
    const rejected = expect(counter.read()).rejects.toThrow('DESKTOP_CLIPBOARD_UNAVAILABLE');
    await vi.advanceTimersByTimeAsync(0);
    const old = children[0];
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(2000);
    else if (failure === 'stop') counter.stop();
    else if (failure === 'write') old.stdin.emit('error', new Error('broken pipe'));
    else if (failure === 'read') old.stdout.emit('error', new Error('broken pipe'));
    else if (failure === 'stderr') old.stderr.emit('error', new Error('broken pipe'));
    else if (failure === 'malformed') old.stdout.emit('data', 'not a counter\n');
    else old.emit(failure, new Error('exit'));
    await rejected;
    const next = counter.read();
    await vi.advanceTimersByTimeAsync(0);
    old.stdout.emit('data', '1 900\n');
    old.emit('exit', 0);
    expect(children[1].kill).not.toHaveBeenCalled();
    children[1].stdout.emit('data', '2 12\n');
    expect(await next).toBe('12');
    counter.stop();
  },
);

it('preserves permission and portable-format refusal without caching it', async () => {
  const { counter, children, launch } = fixture();
  const unsupported = expect(counter.read(true)).rejects.toThrow('CLIPBOARD_UNSUPPORTED');
  await vi.advanceTimersByTimeAsync(0);
  children[0].stdout.emit('data', '1 unsupported\n');
  await unsupported;
  const denied = expect(counter.read()).rejects.toThrow('DESKTOP_CLIPBOARD_UNAVAILABLE');
  await vi.advanceTimersByTimeAsync(0);
  children[0].stdout.emit('data', '2 unavailable\n');
  await denied;
  const next = counter.read();
  await vi.advanceTimersByTimeAsync(0);
  children[0].stdout.emit('data', '3 15\n');
  expect(await next).toBe('15');
  expect(launch).toHaveBeenCalledOnce();
  counter.stop();
});

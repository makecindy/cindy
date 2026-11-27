import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { GnomeClipboardClient } from '../linuxGnomeClipboard';

// Production entry: GnomeClipboardClient drives linux-gnome-clipboard.py over
// private stdio, enforcing logind lock checks, lease revocation before write,
// fixed error sanitization, and idle/explicit teardown (unit, fake child).
function fixture(options: { hasLoginSession?: boolean; unlocked?: boolean } = {}) {
  vi.useFakeTimers();
  let unlocked = options.unlocked ?? true;
  const children: Array<{
    child: ChildProcessWithoutNullStreams;
    stdin: PassThrough;
    stdout: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  }> = [];
  const spawn = vi.fn(() => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const kill = vi.fn(() => true);
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      kill,
    }) as unknown as ChildProcessWithoutNullStreams;
    children.push({ child, stdin, stdout, kill });
    return child;
  });
  const isLogindUnlocked = vi.fn(async () => unlocked);
  const client = new GnomeClipboardClient({
    scriptPath: () => '/fake/linux-gnome-clipboard.py',
    spawn,
    hasLoginSession: () => options.hasLoginSession ?? true,
    isLogindUnlocked,
  });
  return {
    client,
    spawn,
    children,
    isLogindUnlocked,
    setUnlocked: (value: boolean) => {
      unlocked = value;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

it('reuses one helper for version, read and write, and returns empty for PRIMARY after checking lock', async () => {
  const f = fixture();
  const v = f.client.version();
  await vi.advanceTimersByTimeAsync(0);
  const proc = f.children[0];
  proc.stdout.emit('data', 'ready\n');
  await vi.advanceTimersByTimeAsync(0);
  expect(JSON.parse(proc.stdin.read().toString())).toEqual({ id: 1, op: 'version' });
  proc.stdout.emit('data', '{"id":1,"version":"123456789012000001"}\n');
  expect(await v).toBe('123456789012000001');

  const r = f.client.read(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(JSON.parse(proc.stdin.read().toString())).toEqual({ id: 2, op: 'read' });
  proc.stdout.emit(
    'data',
    '{"id":2,"formats":["text/plain;charset=utf-8","text/html"],"content":{"text":"你好","html":"<b>你好</b>"}}\n',
  );
  expect(await r).toEqual({
    formats: ['text/plain;charset=utf-8', 'text/html'],
    content: { text: '你好', html: '<b>你好</b>' },
  });

  // PRIMARY selection checks lock/version and falls back cleanly without sending read.
  const primary = f.client.read(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(JSON.parse(proc.stdin.read().toString())).toEqual({ id: 3, op: 'version' });
  proc.stdout.emit('data', '{"id":3,"version":"123456789012000001"}\n');
  expect(await primary).toEqual({ formats: [], content: {} });

  const w = f.client.write({ url: 'https://cindy.app' }, () => true);
  await vi.advanceTimersByTimeAsync(0);
  expect(JSON.parse(proc.stdin.read().toString())).toEqual({
    id: 4,
    op: 'write',
    content: { url: 'https://cindy.app', text: 'https://cindy.app' },
  });
  proc.stdout.emit('data', '{"id":4,"ok":true,"version":"123456789012000002"}\n');
  await w;
  expect(f.spawn).toHaveBeenCalledOnce();
  f.client.stop();
});

it('refuses access when logind reports locked before or during an operation and closes helper', async () => {
  const f = fixture({ unlocked: false });
  await expect(f.client.version()).rejects.toThrow('DESKTOP_CLIPBOARD_UNAVAILABLE');
  expect(f.spawn).not.toHaveBeenCalled();

  f.setUnlocked(true);
  const read = f.client.read();
  await vi.advanceTimersByTimeAsync(0);
  const proc = f.children[0];
  proc.stdout.emit('data', 'ready\n');
  await vi.advanceTimersByTimeAsync(0);
  proc.stdin.read();
  // Lock occurs before read finishes: discard snapshot and close helper.
  f.setUnlocked(false);
  proc.stdout.emit('data', '{"id":1,"formats":["text/plain"],"content":{"text":"secret"}}\n');
  await expect(read).rejects.toThrow('DESKTOP_CLIPBOARD_UNAVAILABLE');
  expect(proc.stdin.writableEnded).toBe(true);
});

it('rejects lease revocation while waiting for helper startup without writing clipboard', async () => {
  const f = fixture();
  let current = true;
  const writing = f.client.write({ text: 'hello' }, () => current);
  await vi.advanceTimersByTimeAsync(0);
  const proc = f.children[0];
  current = false;
  proc.stdout.emit('data', 'ready\n');
  await expect(writing).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
  expect(proc.stdin.read()).toBeNull();
  f.client.stop();
});

it('sanitizes unexpected helper errors, preserves known error codes, and retires on idle', async () => {
  const f = fixture();
  const req1 = f.client.read();
  await vi.advanceTimersByTimeAsync(0);
  const proc = f.children[0];
  proc.stdout.emit('data', 'ready\n');
  await vi.advanceTimersByTimeAsync(0);
  proc.stdin.read();
  proc.stdout.emit('data', '{"id":1,"error":"CLIPBOARD_TOO_LONG"}\n');
  await expect(req1).rejects.toThrow('CLIPBOARD_TOO_LONG');

  const req2 = f.client.read();
  await vi.advanceTimersByTimeAsync(0);
  proc.stdin.read();
  proc.stdout.emit('data', '{"id":2,"error":"leaked-raw-clipboard-details"}\n');
  await expect(req2).rejects.toThrow('DESKTOP_CLIPBOARD_UNAVAILABLE');

  // Idle timer gracefully closes stdin so Mutter's sharing indicator turns off.
  await vi.advanceTimersByTimeAsync(15_000);
  expect(proc.stdin.writableEnded).toBe(true);
  await vi.advanceTimersByTimeAsync(1500);
  expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
});

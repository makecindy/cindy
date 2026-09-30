import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ spawn: vi.fn(), binary: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: h.spawn, execFile: vi.fn() }));
vi.mock('../linuxCapture', () => ({ resolveLinuxCaptureBinary: h.binary }));
vi.mock('../windowsHost', () => ({ openWindowsDesktopConnection: vi.fn() }));
import { NativeDesktopCapture } from '../nativeCapture';
const owners: NativeDesktopCapture[] = [];
beforeEach(() => {
  vi.stubGlobal('process', { ...process, platform: 'linux' });
  h.spawn.mockReset();
  h.binary.mockReset().mockResolvedValue('/capture');
});
afterEach(() => {
  owners.splice(0).forEach((o) => o.stop());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setup() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  h.spawn.mockReturnValue(child);
  const owner = new NativeDesktopCapture();
  owners.push(owner);
  return { child, owner };
}
it('reuses one child for large bounded frames and releases it on cancellation', async () => {
  const { child, owner } = setup();
  const first = owner.frame('wayland-portal');
  await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce());
  expect(h.spawn).toHaveBeenCalledWith('/capture', ['video', '1', '65'], { stdio: 'pipe' });
  await expect(owner.frame('wayland-portal')).resolves.toBeNull();
  const jpeg = 'a'.repeat(400000);
  child.stdout.write(jpeg + '\n');
  await expect(first).resolves.toBe(jpeg);
  const next = owner.frame('wayland-portal');
  child.stdout.write('anBlZw==\n');
  await expect(next).resolves.toBe('anBlZw==');
  expect(h.spawn).toHaveBeenCalledOnce();
  const late = owner.frame('wayland-portal');
  owner.stop();
  child.stdout.write('anBlZw==\n');
  await expect(late).resolves.toBeNull();
  expect(child.kill).toHaveBeenCalledOnce();
  expect(child.stdout.listenerCount('data')).toBe(0);
});
it('does not spawn after a cancelled asynchronous build', async () => {
  const { owner } = setup();
  let finish!: (value: string) => void;
  h.binary.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = owner.frame('wayland-portal');
  owner.stop();
  finish('/capture');
  await expect(pending).resolves.toBeNull();
  expect(h.spawn).not.toHaveBeenCalled();
});
it('stops oversized native replies', async () => {
  const { child, owner } = setup();
  const pending = owner.frame('wayland-portal');
  await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce());
  child.stdout.write('a'.repeat(1500001));
  await expect(pending).resolves.toBeNull();
  expect(child.kill).toHaveBeenCalledOnce();
});
it('times out a stalled child and rejects unsupported display requests', async () => {
  const { child, owner } = setup();
  await expect(owner.frame('42')).resolves.toBeNull();
  expect(h.binary).not.toHaveBeenCalled();
  vi.useFakeTimers();
  const pending = owner.frame('wayland-portal');
  await vi.advanceTimersByTimeAsync(3000);
  await expect(pending).resolves.toBeNull();
  expect(child.kill).toHaveBeenCalledOnce();
});
it('parses a bounded Linux cursor frame and applies requested encoding quality', async () => {
  const { child, owner } = setup();
  const pending = owner.frame('wayland-portal', true, {
    fps: 60,
    bitrate: 20_000_000,
    audio: false,
  });
  await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce());
  expect(h.spawn).toHaveBeenCalledWith('/capture', ['cursor-overlay', '1', '95'], {
    stdio: 'pipe',
  });
  const frame = { jpeg: 'anBlZw==', cursor: null };
  child.stdout.write(JSON.stringify(frame) + '\n');
  await expect(pending).resolves.toEqual(frame);
});

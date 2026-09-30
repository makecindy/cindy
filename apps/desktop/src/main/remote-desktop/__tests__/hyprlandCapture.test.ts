import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  native: vi.fn(),
  stop: vi.fn(),
  exec: vi.fn(),
  access: vi.fn(),
  wayland: true,
}));
vi.mock('node:child_process', () => ({ execFile: h.exec }));
vi.mock('node:fs', () => ({ accessSync: h.access, constants: { X_OK: 1 } }));
vi.mock('../waylandCapture', () => ({
  WAYLAND_DISPLAY_ID: 'wayland-portal',
  isWaylandDesktop: () => h.wayland,
}));
vi.mock('../nativeCapture', () => ({
  NativeDesktopCapture: class {
    frame = h.native;
    stop = h.stop;
  },
}));
import { HyprlandCapture, supportsHyprlandCapture } from '../hyprlandCapture';
beforeEach(() => {
  h.native.mockReset().mockResolvedValue(null);
  h.stop.mockReset();
  h.exec.mockReset();
  h.access.mockReset();
  h.wayland = true;
  vi.stubEnv('HYPRLAND_INSTANCE_SIGNATURE', 'test');
});
afterEach(() => vi.unstubAllEnvs());
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
it('requires Hyprland, Wayland and an executable system helper', () => {
  expect(supportsHyprlandCapture()).toBe(true);
  h.wayland = false;
  expect(supportsHyprlandCapture()).toBe(false);
  h.wayland = true;
  vi.stubEnv('HYPRLAND_INSTANCE_SIGNATURE', '');
  expect(supportsHyprlandCapture()).toBe(false);
  vi.stubEnv('HYPRLAND_INSTANCE_SIGNATURE', 'test');
  h.access.mockImplementation(() => {
    throw new Error('missing');
  });
  expect(supportsHyprlandCapture()).toBe(false);
});
it('serializes bounded captures and discards late frames after stop', async () => {
  const capture = new HyprlandCapture();
  const first = capture.frame('wayland-portal');
  await vi.waitFor(() => expect(h.exec).toHaveBeenCalledOnce());
  const [executable, args, options, done] = h.exec.mock.calls[0];
  expect(executable).toBe('/usr/bin/grim');
  expect(args.at(-1)).toBe('-');
  expect(options).toMatchObject({
    timeout: 2500,
    maxBuffer: 8 * 1024 * 1024,
    killSignal: 'SIGKILL',
  });
  await expect(capture.frame('wayland-portal')).resolves.toBeNull();
  capture.stop();
  expect(options.signal.aborted).toBe(true);
  const next = capture.frame('wayland-portal');
  done(null, jpeg);
  await expect(first).resolves.toBeNull();
  await expect(capture.frame('wayland-portal')).resolves.toBeNull();
  h.exec.mock.calls[1][3](null, jpeg);
  await expect(next).resolves.toBe(jpeg.toString('base64'));
});
it('rejects foreign displays, failed helpers and malformed images', async () => {
  const capture = new HyprlandCapture();
  await expect(capture.frame('foreign')).resolves.toBeNull();
  expect(h.exec).not.toHaveBeenCalled();
  h.exec.mockImplementation((_file, _args, _options, done) => done(new Error('denied')));
  await expect(capture.frame('wayland-portal')).resolves.toBeNull();
  h.exec.mockImplementation((_file, _args, _options, done) => done(null, Buffer.from('bad')));
  await expect(capture.frame('wayland-portal')).resolves.toBeNull();
});
it('uses persistent capture without grim and retries unavailable helpers only after stop', async () => {
  const capture = new HyprlandCapture();
  h.native.mockResolvedValue(jpeg.toString('base64'));
  await expect(capture.frame('wayland-portal')).resolves.toBe(jpeg.toString('base64'));
  await capture.frame('wayland-portal');
  expect(h.exec).not.toHaveBeenCalled();
  h.native.mockRejectedValue(new Error('unsupported layout'));
  h.exec.mockImplementation((_file, _args, _options, done) => done(null, jpeg));
  await capture.frame('wayland-portal');
  await capture.frame('wayland-portal');
  expect(h.native).toHaveBeenCalledTimes(3);
  expect(h.exec).toHaveBeenCalledTimes(2);
  capture.stop();
  h.native.mockResolvedValue(jpeg.toString('base64'));
  await capture.frame('wayland-portal');
  expect(h.native).toHaveBeenCalledTimes(4);
  expect(h.exec).toHaveBeenCalledTimes(2);
  capture.stop();
});
it('discards a late persistent frame without poisoning the new lease', async () => {
  const capture = new HyprlandCapture();
  let finish!: (value: string | null) => void;
  h.native.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = capture.frame('wayland-portal');
  await expect(capture.frame('wayland-portal')).resolves.toBeNull();
  capture.stop();
  h.native.mockResolvedValue(jpeg.toString('base64'));
  const next = capture.frame('wayland-portal');
  finish(null);
  await expect(first).resolves.toBeNull();
  await expect(next).resolves.toBe(jpeg.toString('base64'));
  expect(h.exec).not.toHaveBeenCalled();
  capture.stop();
});

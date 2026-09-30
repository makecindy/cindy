import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeDesktopCapture } from '../nativeCapture';
import { openWindowsDesktopConnection } from '../windowsHost';

vi.mock('electron', () => ({
  app: {},
  nativeImage: { createFromBitmap: () => ({ toPNG: () => Buffer.from('iVBORw0KGgo=', 'base64') }) },
  screen: {
    getAllDisplays: () => [
      { id: 1, scaleFactor: 2, bounds: { x: -960, y: 0, width: 960, height: 540 } },
    ],
    dipToScreenRect: () => ({ x: -1920, y: 0, width: 1920, height: 1080 }),
  },
}));
vi.mock('../windowsHost', () => ({ openWindowsDesktopConnection: vi.fn() }));
let capture: NativeDesktopCapture;
const connections: Array<{ request: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> =
  [];
const packet = JSON.stringify({ jpeg: 'anBlZw==', cursor: null });
beforeEach(() => {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  connections.length = 0;
  vi.mocked(openWindowsDesktopConnection)
    .mockReset()
    .mockImplementation(async () => {
      const connection = { request: vi.fn(async () => packet), close: vi.fn() };
      connections.push(connection);
      return connection;
    });
  capture = new NativeDesktopCapture();
});
afterEach(() => {
  capture.stop();
  vi.unstubAllGlobals();
});

it('negotiates only the overlay path and preserves legacy init and response', async () => {
  await expect(
    capture.frame('1', true, { fps: 60, bitrate: 8_000_000, audio: false }),
  ).resolves.toEqual({ jpeg: 'anBlZw==', cursor: null });
  expect(openWindowsDesktopConnection).toHaveBeenLastCalledWith({
    mode: 'capture',
    rect: [-1920, 0, 1920, 1080],
    cursorOverlay: true,
    bitrate: 8_000_000,
  });
  const overlay = connections[0];
  vi.mocked(openWindowsDesktopConnection).mockImplementationOnce(async () => ({
    request: vi.fn(async () => 'anBlZw==\n'),
    close: vi.fn(),
  }));
  await expect(capture.frame('1')).resolves.toBe('anBlZw==');
  expect(overlay.close).toHaveBeenCalledOnce();
  expect(openWindowsDesktopConnection).toHaveBeenLastCalledWith({
    mode: 'capture',
    rect: [-1920, 0, 1920, 1080],
  });
});
it('reuses capture until video quality changes, then closes the old connection', async () => {
  await capture.frame('1', true);
  await capture.frame('1', true);
  expect(connections).toHaveLength(1);
  await capture.frame('1', true, { fps: 30, bitrate: 20_000_000, audio: true });
  expect(connections).toHaveLength(2);
  expect(connections[0].close).toHaveBeenCalledOnce();
});
it('closes an opening connection if its lease was stopped and never requests a frame', async () => {
  let finish!: (value: any) => void;
  vi.mocked(openWindowsDesktopConnection).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = capture.frame('1', true);
  capture.stop();
  const connection = { request: vi.fn(), close: vi.fn() };
  finish(connection);
  await expect(pending).resolves.toBeNull();
  expect(connection.close).toHaveBeenCalledOnce();
  expect(connection.request).not.toHaveBeenCalled();
});
it('ignores a late frame without clearing the replacement read backpressure', async () => {
  await capture.frame('1', true);
  let oldDone!: (value: string) => void;
  connections[0].request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        oldDone = resolve;
      }),
  );
  const old = capture.frame('1', true);
  await expect(capture.frame('1', true)).resolves.toBeNull();
  capture.stop();
  await capture.frame('1', true);
  let nextDone!: (value: string) => void;
  connections[1].request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        nextDone = resolve;
      }),
  );
  const next = capture.frame('1', true);
  oldDone(packet);
  await expect(old).resolves.toBeNull();
  await expect(capture.frame('1', true)).resolves.toBeNull();
  expect(connections[1].request).toHaveBeenCalledTimes(2);
  nextDone(packet);
  await expect(next).resolves.toEqual({ jpeg: 'anBlZw==', cursor: null });
});
it('closes malformed frame streams but does not close a stream for an unavailable cursor', async () => {
  await capture.frame('1', true);
  expect(connections[0].close).not.toHaveBeenCalled();
  connections[0].request.mockResolvedValueOnce('{"jpeg":42}');
  await expect(capture.frame('1', true)).resolves.toBeNull();
  expect(connections[0].close).toHaveBeenCalledOnce();
});

import type { Display } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnapshotHelper } from '../snapshotHost';

const mocks = vi.hoisted(() => ({ sources: vi.fn(), capture: vi.fn(), nativeOptions: vi.fn(), frame: vi.fn(), toPhysical: vi.fn(), createBitmap: vi.fn(), pixels: null as Buffer | null }));
vi.mock('electron', () => ({
  desktopCapturer: { getSources: mocks.sources },
  nativeImage: { createFromBuffer: () => bitmap(200, 400), createFromBitmap: mocks.createBitmap },
  screen: { dipToScreenRect: mocks.toPhysical },
}));
vi.mock('../../remote-desktop/nativeCapture', () => ({ NativeDesktopCapture: class {
  constructor(options: unknown) { mocks.nativeOptions(options); }
  frame = mocks.frame;
  stop() {}
} }));
import { captureLiveRegion, captureScreenshotDisplays, RegionVideoCapture } from '../liveCapture';

const display = { id: 1, bounds: { x: 0, y: 0, width: 100, height: 200 }, scaleFactor: 2 } as Display;
const selection = { x: 10, y: 20, width: 30, height: 40 };
const crop = vi.fn();
function bitmap(width: number, height: number) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    crop: (rect: { width: number; height: number }) => { crop(rect); return bitmap(rect.width, rect.height); },
    resize: (size: { width: number; height: number }) => bitmap(size.width, size.height),
    toBitmap: () => mocks.pixels ?? Buffer.alloc(width * height * 4),
  };
}
const helper = { capture: mocks.capture } as unknown as SnapshotHelper;
// Unit: exercise the real capture entry after a dead optional helper. The window
// suite mocks this module itself, so it cannot cover backend fallback or cancellation.
// Minimum failure: helper returns null, but Electron still offers the selected screen.
describe('live region capture recovery', () => {
  beforeEach(() => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
    vi.clearAllMocks();
    mocks.pixels = null;
    mocks.toPhysical.mockImplementation((_window, rect) => rect);
    mocks.createBitmap.mockImplementation((_pixels, size) => bitmap(size.width, size.height));
    mocks.capture.mockResolvedValue(null);
    mocks.sources.mockResolvedValue([{ display_id: '1', thumbnail: bitmap(200, 400) }]);
  });
  afterEach(() => vi.unstubAllGlobals());

  // Unit: the first-frame path now prefers native capture. Existing live tests
  // do not cover display selection, HDR fallback, or physical-pixel dimensions.
  // Minimal inputs: two offset/DPI displays and one missing/wrong-size native frame.
  const sdr = { ...display, depthPerComponent: 8, colorSpace: '{primaries:BT709, transfer:SRGB, matrix:RGB, range:FULL}' };
  it('captures SDR displays at physical resolution without enumerating Electron sources', async () => {
    const second = { ...sdr, id: 2, bounds: { x: -100, y: 0, width: 100, height: 200 }, scaleFactor: 1 };
    mocks.toPhysical.mockImplementation((_window, rect) => rect.x === 0 ? { ...rect, width: 200, height: 400 } : rect);
    mocks.capture.mockImplementation(async rect => ({ width: rect.width, height: rect.height, data: new Uint8Array(rect.width * rect.height * 4).fill(77) }));
    const result = await captureScreenshotDisplays([sdr, second], helper);
    expect(result.backend).toBe('native');
    expect(result.captures.map(c => [c.display.id, c.image.getSize()])).toEqual([
      [1, { width: 200, height: 400 }], [2, { width: 100, height: 200 }],
    ]);
    expect(mocks.capture.mock.calls).toEqual([
      [{ x: 0, y: 0, width: 200, height: 400 }, 32768],
      [{ x: -100, y: 0, width: 100, height: 200 }, 32768],
    ]);
    expect(mocks.createBitmap.mock.calls[0][0][0]).toBe(77);
    expect(mocks.createBitmap.mock.calls[0][1].scaleFactor).toBe(1);
    expect(mocks.sources).not.toHaveBeenCalled();
  });
  it.each([null, { width: 1, height: 1, data: new Uint8Array(4) }])('recaptures the complete set when native pixels are unavailable or wrong-sized (%j)', async badFrame => {
    mocks.capture.mockResolvedValueOnce({ width: 100, height: 200, data: new Uint8Array(80000) }).mockResolvedValueOnce(badFrame);
    const second = { ...sdr, id: 2 };
    const electronFirst = bitmap(200, 400), electronSecond = bitmap(300, 600);
    mocks.sources.mockResolvedValueOnce([{ display_id: '2', thumbnail: electronSecond }, { display_id: '1', thumbnail: electronFirst }]);
    const result = await captureScreenshotDisplays([sdr, second], helper);
    expect(result.backend).toBe('electron');
    expect(result.captures.map(c => c.image)).toEqual([electronFirst, electronSecond]);
  });
  it.each([
    ['darwin', sdr],
    ['win32', { ...sdr, depthPerComponent: 10 }],
    ['win32', { ...sdr, colorSpace: '{primaries:P3, transfer:SRGB, matrix:RGB, range:FULL}' }],
    ['win32', { ...sdr, colorSpace: undefined }],
  ] as const)('preserves Electron capture for unsupported color/platform (%s, %j)', async (platform, monitor) => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: platform } }));
    expect((await captureScreenshotDisplays([monitor as Display], helper)).backend).toBe('electron');
    expect(mocks.capture).not.toHaveBeenCalled();
  });
  it('never guesses a missing source on a multi-display desktop', async () => {
    const result = await captureScreenshotDisplays([display, { ...display, id: 2 }]);
    expect(result.captures.map(c => c.display.id)).toEqual([1]);
  });
  it.each(['scroll', 'video', 'gif'] as const)('recovers %s capture and only returns the selected pixels', async mode => {
    const recording = new RegionVideoCapture(helper);
    const frame = mode === 'scroll'
      ? await captureLiveRegion(display, selection, mode, helper)
      : await recording.frame(display, selection, mode);
    expect({ width: frame.width, height: frame.height, bytes: frame.data.byteLength })
      .toEqual({ width: 60, height: 80, bytes: 60 * 80 * 4 });
    expect(crop).toHaveBeenCalledWith({ x: 20, y: 40, width: 60, height: 80 });
    recording.stop();
  });
  it('never substitutes another display and can recover on the next request', async () => {
    mocks.sources.mockResolvedValueOnce([{ display_id: '2', thumbnail: bitmap(200, 400) }]);
    await expect(captureLiveRegion(display, selection, 'scroll', helper)).rejects.toThrow('Display capture unavailable');
    await expect(captureLiveRegion(display, selection, 'scroll', helper)).resolves.toMatchObject({ width: 60, height: 80 });
  });
  it('drops a Windows frame completed after recording stops', async () => {
    let resolve!: (value: null) => void;
    mocks.capture.mockReturnValueOnce(new Promise<null>(done => { resolve = done; }));
    const recording = new RegionVideoCapture(helper);
    const frame = recording.frame(display, selection, 'video');
    recording.stop();
    resolve(null);
    await expect(frame).rejects.toThrow('Region capture unavailable');
  });

  // Unit: avoiding a copy must not expose a larger backing buffer through IPC.
  // Electron's real native bitmap path is additionally covered by the benchmark.
  it('copies a sliced native buffer so only selection bytes can cross IPC', async () => {
    const bytes = 60 * 80 * 4;
    const backing = Buffer.alloc(bytes + 8, 99);
    mocks.pixels = backing.subarray(4, bytes + 4).fill(17);
    const frame = await captureLiveRegion(display, selection, 'scroll', helper);
    expect(frame.data.byteOffset).toBe(0);
    expect(frame.data.buffer.byteLength).toBe(bytes);
    expect(frame.data.every(value => value === 17)).toBe(true);
  });

  // Unit: only local Mac recording opts in, with the same crop and late-frame
  // rejection. The remote adapter tests cannot establish this caller boundary.
  it('uses on-request Mac frames and still discards a frame after stopping', async () => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }));
    mocks.frame.mockResolvedValue({ jpeg: 'anBlZw==', cursor: null });
    const recording = new RegionVideoCapture(helper);
    const frame = await recording.frame(display, selection, 'gif');
    expect(mocks.nativeOptions).toHaveBeenCalledWith({ encodeOnRequest: true });
    expect([frame.width, frame.height, frame.data.byteLength]).toEqual([60, 80, 60 * 80 * 4]);
    expect(crop).toHaveBeenCalledWith({ x: 20, y: 40, width: 60, height: 80 });
    let finish!: (value: { jpeg: string; cursor: null }) => void;
    mocks.frame.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = recording.frame(display, selection, 'gif');
    recording.stop();
    finish({ jpeg: 'anBlZw==', cursor: null });
    await expect(pending).rejects.toThrow('Region capture unavailable');
  });
});

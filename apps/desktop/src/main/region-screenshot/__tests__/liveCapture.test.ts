import type { Display } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnapshotHelper } from '../snapshotHost';

const mocks = vi.hoisted(() => ({ sources: vi.fn(), capture: vi.fn(), nativeOptions: vi.fn(), frame: vi.fn(), pixels: null as Buffer | null }));
vi.mock('electron', () => ({
  desktopCapturer: { getSources: mocks.sources },
  nativeImage: { createFromBuffer: () => bitmap(200, 400) },
  screen: { dipToScreenRect: (_window: unknown, rect: unknown) => rect },
}));
vi.mock('../../remote-desktop/nativeCapture', () => ({ NativeDesktopCapture: class {
  constructor(options: unknown) { mocks.nativeOptions(options); }
  frame = mocks.frame;
  stop() {}
} }));
import { captureLiveRegion, RegionVideoCapture } from '../liveCapture';

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
    mocks.capture.mockResolvedValue(null);
    mocks.sources.mockResolvedValue([{ display_id: '1', thumbnail: bitmap(200, 400) }]);
  });
  afterEach(() => vi.unstubAllGlobals());
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

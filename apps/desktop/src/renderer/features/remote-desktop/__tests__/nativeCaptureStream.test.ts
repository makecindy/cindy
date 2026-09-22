// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { nativeCaptureStream } from '../nativeCaptureStream';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setup() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const track = { stop: vi.fn() };
  const drawImage = vi.fn();
  const bitmap = { width: 1600, height: 1000, close: vi.fn() };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage, clearRect: vi.fn() }),
    captureStream: vi.fn(() => ({ getTracks: () => [track] })),
  };
  vi.spyOn(document, 'createElement').mockImplementation(
    (() => canvas) as unknown as typeof document.createElement,
  );
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => bitmap),
  );
  return { track, drawImage, bitmap, canvas };
}
it('subtracts capture/decode time from the interval without overlapping reads', async () => {
  const h = setup();
  const times: number[] = [];
  let active = 0,
    maximum = 0;
  const read = async () => {
    times.push(performance.now());
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    return 'anBlZw==';
  };
  const pending = nativeCaptureStream(read, () => true, vi.fn(), undefined, 30);
  await vi.advanceTimersByTimeAsync(20);
  const owner = await pending;
  await vi.advanceTimersByTimeAsync(160);
  owner.stop();
  expect(maximum).toBe(1);
  expect(times.length).toBeGreaterThanOrEqual(5);
  expect(times[2] - times[1]).toBeLessThanOrEqual(34);
  expect(h.canvas.captureStream).toHaveBeenCalledWith(30);
  expect(h.track.stop).toHaveBeenCalled();
});
it('drops an in-flight decoded image after stop', async () => {
  const h = setup();
  const owner = await nativeCaptureStream(
    async () => 'anBlZw==',
    () => true,
    vi.fn(),
  );
  let finish!: (value: ImageBitmap) => void;
  vi.mocked(createImageBitmap).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await vi.advanceTimersByTimeAsync(67);
  owner.stop();
  finish(h.bitmap);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.drawImage).toHaveBeenCalledOnce();
  expect(h.bitmap.close).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
it('clears the independent cursor when falling back to frames with a baked pointer', async () => {
  setup();
  const pointer = { visible: false };
  const read = vi
    .fn()
    .mockResolvedValueOnce({ jpeg: 'anBlZw==', cursor: pointer })
    .mockResolvedValue('anBlZw==');
  const cursor = vi.fn();
  const owner = await nativeCaptureStream(read, () => true, vi.fn(), cursor);
  expect(cursor).toHaveBeenLastCalledWith(pointer);
  await vi.advanceTimersByTimeAsync(67);
  expect(cursor).toHaveBeenLastCalledWith(null);
  owner.stop();
});

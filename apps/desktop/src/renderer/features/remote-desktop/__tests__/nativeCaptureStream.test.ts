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
  const track = {
    readyState: 'live',
    stop: vi.fn(() => {
      track.readyState = 'ended';
    }),
  };
  const drawImage = vi.fn();
  const bitmap = { width: 1600, height: 1000, close: vi.fn() };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage, clearRect: vi.fn() }),
    captureStream: vi.fn(() => ({ getTracks: () => [track], getVideoTracks: () => [track] })),
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
it('reports still after a quiet second and moving again on a large change', async () => {
  const h = setup();
  let pixels = new Uint8ClampedArray(64 * 36 * 4);
  h.canvas.getContext = () =>
    ({
      drawImage: h.drawImage,
      clearRect: vi.fn(),
      getImageData: () => ({ data: pixels }),
    }) as never;
  const onMotion = vi.fn();
  const owner = await nativeCaptureStream(
    async () => 'anBlZw==',
    () => true,
    vi.fn(),
    undefined,
    30,
    onMotion,
  );
  await vi.advanceTimersByTimeAsync(900);
  expect(onMotion).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(300);
  expect(onMotion).toHaveBeenLastCalledWith(false);
  // A single pixel (caret, pulsing button) is not motion.
  pixels = pixels.slice();
  pixels.set([255, 255, 255, 255], 400);
  await vi.advanceTimersByTimeAsync(200);
  expect(onMotion).toHaveBeenCalledTimes(1);
  pixels = new Uint8ClampedArray(64 * 36 * 4).fill(200);
  await vi.advanceTimersByTimeAsync(100);
  expect(onMotion).toHaveBeenLastCalledWith(true);
  owner.stop();
});
it('resumes after a display swap by dropping the old frame but keeping the stream and picture', async () => {
  const h = setup();
  const clearRect = vi.fn();
  h.canvas.getContext = () => ({ drawImage: h.drawImage, clearRect });
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
  expect(owner.resume()).toBe(true);
  finish(h.bitmap);
  await vi.advanceTimersByTimeAsync(0);
  // Only the initial frame was drawn; the stale one is dropped, not cleared.
  expect(h.drawImage).toHaveBeenCalledOnce();
  expect(clearRect).not.toHaveBeenCalled();
  expect(h.track.stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(67);
  expect(h.drawImage).toHaveBeenCalledTimes(2);
  owner.stop();
});
it('keeps a held stream through a display change slower than the no-frame limit', async () => {
  const h = setup();
  let frames = true;
  const failed = vi.fn();
  const owner = await nativeCaptureStream(
    async () => (frames ? 'anBlZw==' : null),
    () => true,
    failed,
  );
  owner.hold();
  frames = false;
  // Creating a virtual display can take up to 8 seconds.
  await vi.advanceTimersByTimeAsync(8000);
  expect(failed).not.toHaveBeenCalled();
  expect(h.track.stop).not.toHaveBeenCalled();
  expect(owner.resume()).toBe(true);
  frames = true;
  await vi.advanceTimersByTimeAsync(67);
  expect(h.drawImage).toHaveBeenCalledTimes(2);
  owner.stop();
});
it('still ends an unheld stream after five seconds without frames and refuses to resume', async () => {
  const h = setup();
  let frames = true;
  const failed = vi.fn();
  const owner = await nativeCaptureStream(
    async () => (frames ? 'anBlZw==' : null),
    () => true,
    failed,
  );
  frames = false;
  await vi.advanceTimersByTimeAsync(5200);
  expect(failed).toHaveBeenCalledOnce();
  expect(h.track.stop).toHaveBeenCalled();
  expect(owner.resume()).toBe(false);
});

import { REMOTE_DESKTOP_MAX_FRAME_BYTES } from '@cindy/device-link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PREVIEW_CAPTURE_TIMEOUT_MS,
  PREVIEW_CAPTURE_UNAVAILABLE_MS,
  PREVIEW_FRAME_MAX_EDGE,
  TabCaptureSource,
  encodeTabFrame,
  type CaptureGuest,
  type TabImage,
} from '../previewTabCapture';

function image(width: number, height: number, jpegBytes: (quality: number) => number = () => 1000) {
  const make = (w: number, h: number): TabImage => ({
    isEmpty: () => false,
    getSize: () => ({ width: w, height: h }),
    resize: vi.fn((options: { width: number; height: number }) =>
      make(options.width, options.height),
    ),
    toJPEG: vi.fn((quality: number) => Buffer.alloc(jpegBytes(quality), 1)),
  });
  return make(width, height);
}

describe('encodeTabFrame', () => {
  it('shrinks the long edge to 1280 and keeps a small JPEG as is', () => {
    const source = image(2880, 1800);
    const frame = encodeTabFrame(source);
    expect(frame).toBe(Buffer.alloc(1000, 1).toString('base64'));
    expect(source.resize).toHaveBeenCalledWith({ width: 1280, height: 800, quality: 'good' });
    const small = image(800, 600);
    encodeTabFrame(small);
    expect(small.resize).not.toHaveBeenCalled();
  });

  it('lowers quality, then size, until the frame fits; gives up on an impossible one', () => {
    const qualities: number[] = [];
    const heavy = image(1000, 1000, (quality) => {
      qualities.push(quality);
      return quality > 40 ? REMOTE_DESKTOP_MAX_FRAME_BYTES + 1 : 100_000;
    });
    expect(encodeTabFrame(heavy, 0.9)).not.toBeNull();
    expect(qualities).toEqual([90, 70, 50, 30]);
    expect(encodeTabFrame(image(1000, 1000, () => REMOTE_DESKTOP_MAX_FRAME_BYTES + 1))).toBeNull();
    const empty = { ...image(10, 10), isEmpty: () => true };
    expect(encodeTabFrame(empty)).toBeNull();
    expect(PREVIEW_FRAME_MAX_EDGE).toBe(1280);
  });
});

describe('TabCaptureSource', () => {
  let clock = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
  });
  afterEach(() => vi.useRealTimers());

  function setup(capturePage: () => Promise<TabImage>, current = { value: true }) {
    const guest: CaptureGuest = { isDestroyed: () => false, capturePage };
    const onUnavailable = vi.fn();
    const source = new TabCaptureSource({
      guest: () => guest,
      isCurrent: () => current.value,
      onUnavailable,
      now: () => clock,
    });
    return { source, onUnavailable };
  }

  it('produces frames and counts them', async () => {
    const { source } = setup(async () => image(400, 300));
    clock = 50;
    expect(await source.frame()).not.toBeNull();
    clock = 100;
    expect(await source.frame()).not.toBeNull();
    expect(source.stats).toEqual({ sequence: 2, lastFrameAt: 100 });
  });

  it('keeps one capture in flight: a second caller gets no frame, not a second capture', async () => {
    let resolve!: (value: TabImage) => void;
    const capturePage = vi.fn(() => new Promise<TabImage>((r) => (resolve = r)));
    const { source } = setup(capturePage);
    const first = source.frame();
    expect(await source.frame()).toBeNull();
    expect(capturePage).toHaveBeenCalledOnce();
    resolve(image(100, 100));
    expect(await first).not.toBeNull();
    resolve = () => {};
    void source.frame();
    expect(capturePage).toHaveBeenCalledTimes(2);
  });

  it('abandons a hung capture by generation and drops its late result', async () => {
    const late: Array<(value: TabImage) => void> = [];
    const capturePage = vi.fn(() => new Promise<TabImage>((r) => late.push(r)));
    const { source, onUnavailable } = setup(capturePage);
    const first = source.frame();
    clock = PREVIEW_CAPTURE_TIMEOUT_MS;
    await vi.advanceTimersByTimeAsync(PREVIEW_CAPTURE_TIMEOUT_MS);
    expect(await first).toBeNull();
    expect(onUnavailable).not.toHaveBeenCalled();
    // The abandoned call finishing now must not become a frame, and a new capture can start.
    late[0](image(100, 100));
    const second = source.frame();
    expect(capturePage).toHaveBeenCalledTimes(2);
    late[1](image(100, 100));
    expect(await second).not.toBeNull();
    expect(source.stats.sequence).toBe(1);
  });

  it('reports the tab unavailable after failing for too long, once, and then stops', async () => {
    const capturePage = vi.fn(async () => {
      throw new Error('boom');
    });
    const { source, onUnavailable } = setup(capturePage);
    clock = 1_000;
    expect(await source.frame()).toBeNull();
    expect(onUnavailable).not.toHaveBeenCalled();
    clock = 1_000 + PREVIEW_CAPTURE_UNAVAILABLE_MS + 1;
    expect(await source.frame()).toBeNull();
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(await source.frame()).toBeNull();
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(capturePage).toHaveBeenCalledTimes(1);
  });

  it('does not count time before a capture was attempted as a failure', async () => {
    const { source, onUnavailable } = setup(async () => image(100, 100));
    // A slow offer, or a pause before the next one, is not the tab failing.
    clock = 10 * PREVIEW_CAPTURE_UNAVAILABLE_MS;
    expect(await source.frame()).not.toBeNull();
    expect(onUnavailable).not.toHaveBeenCalled();
    clock += 10 * PREVIEW_CAPTURE_UNAVAILABLE_MS;
    expect(await source.frame()).not.toBeNull();
    expect(onUnavailable).not.toHaveBeenCalled();

    let broken = false;
    const failing = setup(async () => {
      if (broken) throw new Error('boom');
      return image(100, 100);
    });
    clock += 10 * PREVIEW_CAPTURE_UNAVAILABLE_MS;
    broken = true;
    expect(await failing.source.frame()).toBeNull();
    expect(failing.onUnavailable).not.toHaveBeenCalled();
    // The budget runs from the first failed capture, and a success clears it.
    clock += PREVIEW_CAPTURE_UNAVAILABLE_MS - 1;
    expect(await failing.source.frame()).toBeNull();
    expect(failing.onUnavailable).not.toHaveBeenCalled();
    broken = false;
    expect(await failing.source.frame()).not.toBeNull();
    clock += 3 * PREVIEW_CAPTURE_UNAVAILABLE_MS;
    broken = true;
    expect(await failing.source.frame()).toBeNull();
    expect(failing.onUnavailable).not.toHaveBeenCalled();
    clock += PREVIEW_CAPTURE_UNAVAILABLE_MS + 1;
    expect(await failing.source.frame()).toBeNull();
    expect(failing.onUnavailable).toHaveBeenCalledOnce();
  });

  it('reports a wedged tab (too many abandoned captures) and ignores a replaced tab', async () => {
    const hung = vi.fn(() => new Promise<TabImage>(() => {}));
    const { source, onUnavailable } = setup(hung);
    for (let i = 0; i < 3; i++) {
      const pending = source.frame();
      await vi.advanceTimersByTimeAsync(PREVIEW_CAPTURE_TIMEOUT_MS);
      clock += PREVIEW_CAPTURE_TIMEOUT_MS;
      await pending;
    }
    expect(onUnavailable).toHaveBeenCalledOnce();

    const current = { value: false };
    const capturePage = vi.fn(async () => image(10, 10));
    const other = setup(capturePage, current);
    expect(await other.source.frame()).toBeNull();
    expect(capturePage).not.toHaveBeenCalled();
    expect(other.onUnavailable).not.toHaveBeenCalled();
  });
});

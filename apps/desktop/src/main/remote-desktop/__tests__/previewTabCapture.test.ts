import { REMOTE_DESKTOP_MAX_FRAME_BYTES } from '@cindy/device-link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PREVIEW_ACTIVE_HOLD_MS,
  PREVIEW_FULL_REFRESH_MS,
  PREVIEW_INPUT_ACTIVE_MS,
  PREVIEW_MAX_STREAM_FPS,
  PREVIEW_RESEND_MS,
  PREVIEW_STILL_INTERVAL_MS,
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
    expect(source.stats).toMatchObject({ sequence: 2, lastFrameAt: 100 });
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

  it('tells onStall about a timed-out capture (not a thrown one), and survives a throwing hook', async () => {
    const onStall = vi.fn(() => {
      throw new Error('hook');
    });
    const make = (capturePage: () => Promise<TabImage>) =>
      new TabCaptureSource({
        guest: () => ({ isDestroyed: () => false, capturePage }),
        isCurrent: () => true,
        onUnavailable: vi.fn(),
        onStall,
        now: () => clock,
      });
    const hung = make(() => new Promise<TabImage>(() => {}));
    const first = hung.frame();
    clock = PREVIEW_CAPTURE_TIMEOUT_MS;
    await vi.advanceTimersByTimeAsync(PREVIEW_CAPTURE_TIMEOUT_MS);
    expect(await first).toBeNull();
    expect(onStall).toHaveBeenCalledOnce();
    const thrown = make(async () => {
      throw new Error('boom');
    });
    expect(await thrown.frame()).toBeNull();
    expect(onStall).toHaveBeenCalledOnce();
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

// ---- Stream purpose: encode once, skip what did not change, adapt the pull rate ----

interface Pixels {
  width: number;
  height: number;
  bytes: Buffer;
}
/** An image with real BGRA pixels, so change detection has something to read. */
function pixelImage(
  pixels: Pixels,
  jpegBytes = 1000,
  spy?: { toJPEG: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn> },
): TabImage {
  const make = (w: number, h: number): TabImage => ({
    isEmpty: () => false,
    getSize: () => ({ width: w, height: h }),
    resize: (options: { width: number; height: number }) => {
      spy?.resize(options);
      return make(options.width, options.height);
    },
    toJPEG: (quality: number) => {
      spy?.toJPEG(quality);
      return Buffer.alloc(jpegBytes, 7);
    },
    toBitmap: () => Buffer.from(pixels.bytes),
  });
  return make(pixels.width, pixels.height);
}
const blank = (width: number, height: number, fill = 0): Pixels => ({
  width,
  height,
  bytes: Buffer.alloc(width * height * 4, fill),
});
const poke = (pixels: Pixels, x: number, y: number, value: number): void => {
  pixels.bytes.writeUInt32LE(value, (y * pixels.width + x) * 4);
};
const STREAM = { purpose: 'stream', fps: 30, quality: 0.8, maxBytes: 1_500_000 } as const;

describe('TabCaptureSource stream frames', () => {
  let clock = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
  });
  afterEach(() => vi.useRealTimers());

  function setup(pixels: Pixels, jpegBytes = 1000) {
    const spy = { toJPEG: vi.fn(), resize: vi.fn() };
    const capturePage = vi.fn(async () => pixelImage(pixels, jpegBytes, spy));
    const guest: CaptureGuest = { isDestroyed: () => false, capturePage };
    const onUnavailable = vi.fn();
    const source = new TabCaptureSource({
      guest: () => guest,
      isCurrent: () => true,
      onUnavailable,
      now: () => clock,
      // Waiting is advancing the clock: the schedule is what is under test.
      sleep: async (ms) => {
        clock += ms;
      },
    });
    return { source, spy, capturePage, onUnavailable, pixels };
  }

  it('encodes a changed frame once, at the profile quality, whatever its size', async () => {
    const h = setup(blank(1238, 1428), 400_000);
    const frame = await h.source.frame(STREAM);
    expect(frame).toBe(Buffer.alloc(400_000, 7).toString('base64'));
    // 400 KB is far over the relay budget, but the stream path allows the profile's own.
    expect(h.spy.toJPEG).toHaveBeenCalledTimes(1);
    expect(h.spy.toJPEG).toHaveBeenCalledWith(80);
    expect(h.spy.resize).toHaveBeenCalledOnce();
    expect(h.source.stats).toMatchObject({ sequence: 1, skipped: 0, resent: 0 });
  });

  it('keeps the relay path to its small budget with re-encoding', async () => {
    const heavy = vi.fn((quality: number) => (quality > 40 ? 400_000 : 100_000));
    const guest: CaptureGuest = {
      isDestroyed: () => false,
      capturePage: async () => ({
        ...pixelImage(blank(1000, 1000)),
        toJPEG: (quality: number) => Buffer.alloc(heavy(quality), 1),
      }),
    };
    const source = new TabCaptureSource({
      guest: () => guest,
      isCurrent: () => true,
      onUnavailable: vi.fn(),
      now: () => clock,
    });
    expect(await source.frame({ purpose: 'relay' })).not.toBeNull();
    expect(heavy.mock.calls.length).toBeGreaterThan(1);
  });

  it('skips resize and encoding when nothing changed, and resends the cached frame about once a second', async () => {
    const h = setup(blank(1238, 1428));
    const first = await h.source.frame(STREAM);
    expect(first).not.toBeNull();
    const encodedAt = h.source.stats.lastFrameAt;
    let resends = 0;
    const seen: Array<string | null> = [];
    // Everything up to just before the periodic full refresh.
    while (clock - encodedAt < PREVIEW_FULL_REFRESH_MS - 400) {
      const frame = await h.source.frame(STREAM);
      seen.push(frame);
      if (frame !== null) {
        resends++;
        expect(frame).toBe(first);
      }
    }
    expect(h.spy.toJPEG).toHaveBeenCalledOnce();
    expect(h.spy.resize).toHaveBeenCalledOnce();
    expect(h.source.stats.skipped).toBeGreaterThan(0);
    expect(h.source.stats.resent).toBe(resends);
    // About one resend per second of stillness, never one per pull.
    expect(resends).toBeGreaterThanOrEqual(1);
    expect(resends).toBeLessThanOrEqual(3);
    // A resend is not a new picture: the freshness of the source does not move.
    expect(h.source.stats.sequence).toBe(1);
    expect(h.source.stats.lastFrameAt).toBe(encodedAt);
    // Between resends the viewer is given nothing; its watchdog still hears about every second.
    expect(seen.filter((frame) => frame === null).length).toBeGreaterThan(resends);
  });

  it('encodes again as soon as a sampled pixel changes', async () => {
    const h = setup(blank(1238, 1428));
    await h.source.frame(STREAM);
    for (let i = 0; i < 3; i++) await h.source.frame(STREAM);
    expect(h.spy.toJPEG).toHaveBeenCalledOnce();
    poke(h.pixels, 0, 0, 0xff00ff00); // the grid always includes the origin
    expect(await h.source.frame(STREAM)).not.toBeNull();
    expect(h.spy.toJPEG).toHaveBeenCalledTimes(2);
    expect(h.source.stats.sequence).toBe(2);
  });

  it('bounds how long a change between sample points can go unseen', async () => {
    const h = setup(blank(1238, 1428));
    await h.source.frame(STREAM);
    const first = h.source.stats.lastFrameAt;
    // One pixel off every sample point: the cheap comparison cannot see it.
    poke(h.pixels, 5, 5, 0xffffffff);
    let reported = false;
    while (clock - first < PREVIEW_FULL_REFRESH_MS + 2_000 && !reported) {
      await h.source.frame(STREAM);
      reported = h.spy.toJPEG.mock.calls.length > 1;
    }
    expect(reported).toBe(true);
    expect(h.source.stats.lastFrameAt - first).toBeLessThanOrEqual(
      PREVIEW_FULL_REFRESH_MS + PREVIEW_RESEND_MS,
    );
    expect(h.source.stats.lastFrameAt - first).toBeGreaterThanOrEqual(PREVIEW_FULL_REFRESH_MS);
  });

  it('pulls at the viewer rate (capped at 30) while the picture moves, and at about 5 fps once it is still', async () => {
    const h = setup(blank(300, 300));
    let value = 1;
    const times: number[] = [];
    // Moving: every pull differs.
    for (let i = 0; i < 6; i++) {
      poke(h.pixels, 0, 0, value++);
      await h.source.frame({ ...STREAM, fps: 60 });
      times.push(clock);
    }
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(1000 / PREVIEW_MAX_STREAM_FPS - 1);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(1000 / PREVIEW_MAX_STREAM_FPS + 1);
    // Still: after the hold the schedule relaxes.
    clock += PREVIEW_INPUT_ACTIVE_MS + PREVIEW_ACTIVE_HOLD_MS + 10;
    const before = clock;
    await h.source.frame(STREAM);
    const pulls: number[] = [];
    for (let i = 0; i < 4; i++) {
      await h.source.frame(STREAM);
      pulls.push(clock);
    }
    expect(h.source.stats.skipped).toBeGreaterThan(0);
    const stillGaps = pulls.slice(1).map((t, i) => t - pulls[i]);
    for (const gap of stillGaps) expect(gap).toBeGreaterThanOrEqual(PREVIEW_STILL_INTERVAL_MS - 1);
    expect(before).toBeLessThan(clock);
  });

  it('caps a background viewer at 10 fps while moving', async () => {
    const h = setup(blank(300, 300));
    h.source.setView({ background: true });
    let value = 1;
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      poke(h.pixels, 0, 0, value++);
      await h.source.frame(STREAM);
      times.push(clock);
    }
    for (const gap of times.slice(1).map((t, i) => t - times[i]))
      expect(gap).toBeGreaterThanOrEqual(99);
  });

  it('goes back to the full rate right away when input arrives, even from a long still', async () => {
    const h = setup(blank(300, 300));
    await h.source.frame(STREAM);
    clock += PREVIEW_ACTIVE_HOLD_MS + PREVIEW_INPUT_ACTIVE_MS + 10;
    await h.source.frame(STREAM);
    const settled = clock;
    const sequence = h.source.stats.sequence;
    h.source.nudge();
    poke(h.pixels, 0, 0, 0xabcdef);
    await h.source.frame(STREAM);
    // No waiting out a still interval: the input's effect is captured at once.
    expect(clock - settled).toBeLessThan(PREVIEW_STILL_INTERVAL_MS);
    expect(h.source.stats.sequence).toBe(sequence + 1);
  });

  it('does not capture at all while the viewer is hidden, and keeps its watchdog fed', async () => {
    const h = setup(blank(300, 300));
    const first = await h.source.frame(STREAM);
    h.source.setView({ hidden: true });
    const calls = h.capturePage.mock.calls.length;
    const started = clock;
    let fed = 0;
    for (let i = 0; i < 4; i++) {
      const frame = await h.source.frame(STREAM);
      if (frame !== null) {
        fed++;
        expect(frame).toBe(first);
      }
    }
    expect(h.capturePage.mock.calls.length).toBe(calls);
    expect(fed).toBe(4);
    expect(clock - started).toBeGreaterThanOrEqual(3 * PREVIEW_RESEND_MS);
    h.source.setView({ hidden: false });
    poke(h.pixels, 0, 0, 5);
    expect(await h.source.frame(STREAM)).not.toBeNull();
    expect(h.capturePage.mock.calls.length).toBe(calls + 1);
  });

  it('treats a bitmap it cannot read as always changed rather than freezing the picture', async () => {
    const h = setup(blank(300, 300));
    const capturePage = vi.fn(async () => ({
      ...pixelImage(h.pixels),
      toBitmap: () => {
        throw new Error('no bitmap');
      },
    }));
    const source = new TabCaptureSource({
      guest: () => ({ isDestroyed: () => false, capturePage }),
      isCurrent: () => true,
      onUnavailable: vi.fn(),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(await source.frame(STREAM)).not.toBeNull();
    expect(await source.frame(STREAM)).not.toBeNull();
    expect(source.stats.sequence).toBe(2);
    expect(source.stats.skipped).toBe(0);
  });

  it('wakes a sleeping pull when stopped', async () => {
    let release: (() => void) | undefined;
    const capturePage = vi.fn(async () => pixelImage(blank(300, 300)));
    const source = new TabCaptureSource({
      guest: () => ({ isDestroyed: () => false, capturePage }),
      isCurrent: () => true,
      onUnavailable: vi.fn(),
      now: () => clock,
      sleep: () => new Promise<void>((resolve) => (release = resolve)),
    });
    await source.frame(STREAM);
    const sleeping = source.frame(STREAM);
    await vi.advanceTimersByTimeAsync(0);
    source.stop();
    expect(await sleeping).toBeNull();
    expect(release).toBeDefined();
    expect(capturePage).toHaveBeenCalledOnce();
  });
});

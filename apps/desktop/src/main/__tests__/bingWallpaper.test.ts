import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { fetchSingleHopWithSsrFGuard } from '@cindy/browser-control-runtime/ssrf-runtime';
import {
  bingWallpaperMarket,
  fetchBingImage,
  fetchBingMetadata,
  parseBingImageMetadata,
  type BingImageMetadata,
  requestBingWallpaper,
  BingWallpaperRequestError,
} from '../bing-wallpaper-source';
import { createBingWallpaperService } from '../bing-wallpaper-service';
import type { BingWallpaperCache } from '../bing-wallpaper-settings';
import type { BingWallpaperImage } from '../../shared/bingWallpaper';

vi.mock('../maker-host/outbound-fetch.desktop.js', () => ({ createPinnedProxyDispatcher: vi.fn() }));
vi.mock('@cindy/browser-control-runtime/ssrf-runtime', () => ({
  fetchSingleHopWithSsrFGuard: vi.fn(),
}));

// #9640, unit: real source/service public entries; existing wallpaper tests only cover
// immutable CDN assets. Minimal inputs: one Bing JSON image, blocked requests, source changes
// during fetch, local-date rollover, and re-selection during failure backoff. Fake clock/network.
const raw = {
  images: [
    {
      url: '/th?id=OHR.Test_EN-US123_1920x1080.jpg&pid=hp',
      startdate: '20261109',
      title: 'A landscape',
      copyright: 'Example Photographer',
      copyrightlink: 'https://www.bing.com/search?q=landscape',
      wp: true,
    },
  ],
};
const metadata = () => parseBingImageMetadata(raw, 'en-US');
const url = 'cindy-media://client-wallpaper/' + 'a'.repeat(64) + '.webp';
const saved = (): BingWallpaperImage => {
  const { imageUrl: _remote, ...info } = metadata();
  void _remote;
  return { ...info, url };
};
let png: Buffer;
beforeAll(async () => {
  png = await sharp({ create: { width: 8, height: 4, channels: 3, background: 'blue' } })
    .png()
    .toBuffer();
});

describe('Bing image source', () => {
  it('uses a pinned fixed-origin fake-IP policy without granting arbitrary hosts or private networks', async () => {
    const release = vi.fn();
    const guard = vi.mocked(fetchSingleHopWithSsrFGuard);
    guard.mockResolvedValueOnce({
      response: new Response('{}'),
      release,
    });
    await requestBingWallpaper(
      'https://www.bing.com/HPImageArchive.aspx?format=js',
      { redirect: 'error' },
      () => {},
    );
    expect(guard.mock.calls[0][0]).toMatchObject({
      requireHttps: true,
      policy: { hostnameAllowlist: ['www.bing.com'], allowRfc2544BenchmarkRange: true },
    });
    const policy = guard.mock.calls[0][0].policy!;
    expect(policy.allowPrivateNetwork).not.toBe(true);
    expect(policy.dangerouslyAllowPrivateNetwork).not.toBe(true);
    expect(policy.allowIpv6UniqueLocalRange).not.toBe(true);
    for (const url of [
      'https://localhost/th',
      'https://www.bing.com:444/th',
      'http://www.bing.com/th',
      'https://www.bing.com/other',
    ]) {
      await expect(requestBingWallpaper(url, { redirect: 'error' }, () => {})).rejects.toThrow();
    }
    expect(guard).toHaveBeenCalledOnce();
  });
  it('parses a dated image with safe attribution and maps classical locales', () => {
    expect(metadata()).toMatchObject({
      date: '20261109',
      market: 'en-US',
      imageKey: 'en-US:OHR.Test_EN-US123_1920x1080.jpg',
    });
    expect(bingWallpaperMarket('zh-Hans-x-lzh')).toBe('zh-CN');
    expect(bingWallpaperMarket('zh-Hant-x-lzh')).toBe('zh-TW');
  });
  it.each([
    { images: [] },
    { images: [{ ...raw.images[0], url: '//localhost/th?id=OHR.Test.jpg' }] },
    { images: [{ ...raw.images[0], url: '/th?id=not-a-wallpaper' }] },
    { images: [{ ...raw.images[0], startdate: '20260231' }] },
    { images: [{ ...raw.images[0], wp: false }] },
  ])('rejects unavailable or malformed metadata before any image request: %j', (value) => {
    expect(() => parseBingImageMetadata(value, 'en-US')).toThrow();
  });
  it('bounds metadata, releases resources and never follows redirects or sends credentials', async () => {
    const release = vi.fn();
    const request = vi.fn().mockResolvedValue({
      response: new Response(JSON.stringify(raw)),
      release,
    });
    const signal = new AbortController().signal;
    expect(await fetchBingMetadata('en-US', signal, request)).toEqual(metadata());
    expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
    expect(release).toHaveBeenCalledOnce();
    request.mockResolvedValueOnce({ response: new Response('x'.repeat(128 * 1024 + 1)), release });
    await expect(fetchBingMetadata('en-US', signal, request)).rejects.toThrow();
    expect(release).toHaveBeenCalledTimes(2);
  });
  it('reports Retry-After and verifies image bytes through the existing decoder', async () => {
    const release = vi.fn();
    const request = vi.fn().mockResolvedValue({
      response: new Response('', { status: 429, headers: { 'Retry-After': '120' } }),
      release,
    });
    const signal = new AbortController().signal;
    await expect(fetchBingMetadata('en-US', signal, request)).rejects.toMatchObject({
      retryAfterMs: 120_000,
    });
    request.mockResolvedValueOnce({ response: new Response(new Uint8Array(png)), release });
    const bytes = await fetchBingImage(metadata(), signal, request);
    expect(await sharp(bytes).metadata()).toMatchObject({ format: 'webp', width: 8, height: 4 });
    request.mockResolvedValueOnce({ response: new Response('<html>not an image</html>'), release });
    await expect(fetchBingImage(metadata(), signal, request)).rejects.toThrow();
  });
  it('rejects a forged absolute image origin before dispatch', async () => {
    const request = vi.fn();
    await expect(
      fetchBingImage(
        { ...metadata(), imageUrl: 'https://localhost/th?id=OHR.Test.jpg' },
        new AbortController().signal,
        request,
      ),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});

function harness() {
  let active: string | null = null;
  let cache: BingWallpaperCache = { current: null, previous: null, checkedAt: 0, nextCheckAt: 0 };
  const h = {
    metadata: vi.fn().mockResolvedValue(metadata()),
    image: vi.fn().mockResolvedValue(Buffer.from('verified webp')),
    validate: vi.fn().mockResolvedValue(true),
    status: vi.fn(),
    publish: vi.fn(
      async (
        info: BingImageMetadata,
        _bytes: Buffer | null,
        checkedAt: number,
        nextCheckAt: number,
        isCurrent: () => boolean,
      ) => {
        if (!isCurrent()) return;
        const { imageUrl: _remote, ...fields } = info;
        void _remote;
        cache = { current: { ...fields, url }, previous: cache.current, checkedAt, nextCheckAt };
      },
    ),
  };
  const service = createBingWallpaperService({
    ...h,
    activeMarket: () => active,
    readCache: () => cache,
    jitter: () => 0,
  });
  return {
    ...h,
    service,
    active: (value: string | null) => {
      active = value;
      service.reconcile();
    },
    cache: (value: BingWallpaperCache) => {
      cache = value;
    },
    state: () => cache,
    changeSourceWithoutNotification: (value: string | null) => { active = value; },
  };
}
describe('daily wallpaper lifecycle', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T12:00:00Z'));
    h = harness();
  });
  afterEach(() => {
    h.service.dispose();
    vi.useRealTimers();
  });

  // #9640, unit: migration can write appearance preferences without an IPC
  // reconcile. At the next due check, an inactive source must not retain a
  // one-second cache-validation loop. Existing switches notify reconcile directly.
  it('stops scheduling when the source changes outside the IPC notification path', async () => {
    h.active('en-US');
    await h.service.refresh();
    h.changeSourceWithoutNotification(null);
    const due = h.state().nextCheckAt;
    await vi.advanceTimersByTimeAsync(due - Date.now());
    expect(h.metadata).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const validations = h.validate.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.validate).toHaveBeenCalledTimes(validations);
  });

  it('does no background work while unselected and coalesces requests across windows', async () => {
    h.service.reconcile();
    await h.service.refresh();
    expect(h.metadata).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    h.active('en-US');
    await Promise.all([h.service.refresh(), h.service.refresh(), h.service.refresh()]);
    expect(h.metadata).toHaveBeenCalledOnce();
    expect(h.image).toHaveBeenCalledOnce();
    expect(h.state().current).toEqual(saved());
    expect(h.status).toHaveBeenLastCalledWith('ready');
    h.active(null);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reuses a valid cache offline and checks the same image later without redownloading', async () => {
    const at = Date.now();
    h.cache({ current: saved(), previous: null, checkedAt: at, nextCheckAt: at + 3600_000 });
    h.active('en-US');
    await h.service.refresh();
    expect(h.metadata).not.toHaveBeenCalled();
    expect(h.status).toHaveBeenLastCalledWith('ready');
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(h.metadata).toHaveBeenCalledOnce();
    expect(h.image).not.toHaveBeenCalled();
    expect(h.publish.mock.calls[0][1]).toBeNull();
  });
  it('publishes the next image after its scheduled local-date rollover', async () => {
    vi.setSystemTime(new Date(2026, 10, 9, 23, 50));
    const yesterday = metadata();
    const today = {
      ...metadata(),
      imageKey: 'en-US:OHR.NextDay.jpg',
      imageUrl: 'https://www.bing.com/th?id=OHR.NextDay_EN-US.jpg&pid=hp',
      date: '20261110',
      title: 'Next day',
    };
    h.metadata.mockResolvedValueOnce(yesterday).mockResolvedValueOnce(today);
    h.active('en-US');
    await h.service.refresh();

    const nextCheckAt = h.state().nextCheckAt;
    expect(new Date(nextCheckAt).getDate()).toBe(10);
    expect(new Date(nextCheckAt).getHours()).toBe(0);
    await vi.advanceTimersByTimeAsync(nextCheckAt - Date.now());

    expect(h.metadata).toHaveBeenCalledTimes(2);
    expect(h.image).toHaveBeenCalledTimes(2);
    expect(h.state().current).toMatchObject({ date: '20261110', imageKey: today.imageKey });
  });
  it('repairs missing/corrupt cached bytes even before the metadata TTL expires', async () => {
    h.cache({
      current: saved(),
      previous: null,
      checkedAt: Date.now(),
      nextCheckAt: Date.now() + 3600_000,
    });
    h.validate.mockResolvedValue(false);
    h.active('en-US');
    await h.service.refresh();
    expect(h.image).toHaveBeenCalledOnce();
  });
  it('retains the image and respects server backoff across focus and manual retry', async () => {
    h.cache({ current: saved(), previous: null, checkedAt: 0, nextCheckAt: 0 });
    h.metadata.mockRejectedValue(new BingWallpaperRequestError(15 * 60_000));
    h.active('en-US');
    await h.service.refresh();
    expect(h.status).toHaveBeenLastCalledWith('stale');
    await vi.advanceTimersByTimeAsync(60_000);
    h.service.reconcile();
    await h.service.refresh();
    h.active(null);
    h.active('en-US');
    await h.service.refresh();
    expect(h.metadata).toHaveBeenCalledOnce();
    expect(h.state().current).toEqual(saved());
    expect(h.status).toHaveBeenLastCalledWith('stale');
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(h.metadata).toHaveBeenCalledTimes(2);
  });
  it.each([
    [true, 'stale'],
    [false, 'failed'],
  ] as const)('restores the %s refresh state while waiting out backoff', async (cached, expectedStatus) => {
    if (cached) h.cache({ current: saved(), previous: null, checkedAt: 0, nextCheckAt: 0 });
    h.metadata.mockRejectedValue(new BingWallpaperRequestError(15 * 60_000));
    h.active('en-US');
    await h.service.refresh();
    expect(h.status).toHaveBeenLastCalledWith(expectedStatus);

    h.active(null);
    expect(h.status).toHaveBeenLastCalledWith('idle');
    h.active('en-US');
    expect(h.status).toHaveBeenLastCalledWith(expectedStatus);
    await h.service.refresh();
    expect(h.metadata).toHaveBeenCalledOnce();
  });
  it('cancels late metadata after changing source without publishing or restarting', async () => {
    let finish!: (value: ReturnType<typeof metadata>) => void;
    h.metadata.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    h.active('en-US');
    await Promise.resolve();
    h.active(null);
    finish(metadata());
    await h.service.refresh();
    expect(h.image).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.status).toHaveBeenLastCalledWith('idle');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not publish a decoded image after cancellation and clears timers on quit', async () => {
    let finish!: (value: Buffer) => void;
    h.image.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    h.active('en-US');
    await vi.advanceTimersByTimeAsync(0);
    h.service.dispose();
    finish(Buffer.from('late'));
    await h.service.refresh();
    expect(h.publish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

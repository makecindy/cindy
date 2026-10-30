import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadOptions } from '../downloader/types';

const m = vi.hoisted(() => ({
  dir: '',
  version: '1.0.0',
  download: vi.fn(),
  endpoint: vi.fn(),
  recycle: vi.fn(),
  hash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
}));
vi.mock('electron', () => ({ app: { getPath: () => m.dir, getVersion: () => m.version } }));
vi.mock('../../shared/wallpaper-video-manifest.json', () => ({
  default: {
    'cindy-window': {
      delivery: 'cdn',
      bytes: 3,
      sha256: m.hash,
      image: { bytes: 3, sha256: m.hash },
    },
    'cindy-studio': {
      delivery: 'bundled',
      bytes: 3,
      sha256: m.hash,
      image: { bytes: 3, sha256: m.hash },
    },
    'cindy-whisper': {
      delivery: 'cdn',
      image: { bytes: 3, sha256: m.hash },
    },
  },
}));
vi.mock('../downloader/index.js', () => ({ createDownloader: () => m.download }));
vi.mock('../clientEndpointsService.js', () => ({ getClientEndpoint: m.endpoint }));
vi.mock('../maker-host/outbound-fetch.js', () => ({ guardedOutboundFetch: vi.fn() }));
vi.mock('../cindy-media/ingest.js', async () => {
  const { writeBlob } = await import('../cindy-media/blobStore');
  return {
    ingestClientWallpaper: (args: { buffer: Buffer; mimeType: string }) =>
      writeBlob({ ...args, scope: 'client-wallpaper' }),
  };
});
vi.mock('../cindy-media/recycler.js', () => ({ recycleClientWallpapers: m.recycle }));
vi.mock('../custom-wallpaper-settings.js', () => ({
  readReferencedClientWallpaperUrls: () =>
    ['.mp4', '.webp'].map((ext) => `cindy-media://client-wallpaper/${m.hash}${ext}`),
}));
import { ensureWallpaperVideo, ensureWallpaperImage, __testing } from '../wallpaper-video';
import { resolveHashRef, readClientWallpaperFile } from '../cindy-media/blobStore';

beforeEach(() => {
  vi.clearAllMocks();
  __testing.reset();
  m.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-download-test-'));
  m.version = '1.0.0';
  m.endpoint.mockReturnValue('https://cdn.example/cindy');
  m.download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
    fs.writeFileSync(targetPath, 'abc');
    return { path: targetPath };
  });
  m.recycle.mockResolvedValue(undefined);
});
afterEach(() => fs.rmSync(m.dir, { recursive: true, force: true }));

function url(ext: string) {
  return `cindy-media://client-wallpaper/${m.hash}${ext}`;
}

describe('official wallpaper downloads', () => {
  // User request 2026-10-17: still-only entries must use the existing verified
  // downloader/cache, without inventing MP4 downloads. Unit tier; previous
  // fixtures only represented scenes that always had both media kinds.
  it('rejects arbitrary paths, URLs, prototype keys and unknown scenes before any IO', async () => {
    for (const id of ['https://example/a.mp4', '../secret', 'constructor', 'none', null]) {
      await expect(ensureWallpaperVideo(id)).rejects.toThrow('INVALID_PARAMS');
      await expect(ensureWallpaperImage(id)).rejects.toThrow('INVALID_PARAMS');
    }
    expect(m.download).not.toHaveBeenCalled();
    expect(m.endpoint).not.toHaveBeenCalled();
  });
  it('does not download bundled entries', async () => {
    expect(await ensureWallpaperVideo('cindy-studio')).toBeNull();
    expect(m.download).not.toHaveBeenCalled();
  });
  it.each([
    [ensureWallpaperVideo, '.mp4', 'cindy-window'],
    [ensureWallpaperImage, '.webp', 'cindy-window'],
    [ensureWallpaperImage, '.webp', 'cindy-whisper'],
  ] as const)('deduplicates windows and publishes verified %s media', async (ensure, ext, id) => {
    expect(await Promise.all([ensure(id), ensure(id)])).toEqual([url(ext), url(ext)]);
    expect(m.download).toHaveBeenCalledOnce();
    const options = m.download.mock.calls[0][0];
    expect(options).toMatchObject({
      sha256: m.hash,
      expectedSize: 3,
      maxBytes: 3,
      redirect: 'error',
      resume: false,
    });
    expect(options.url).toBe(`https://cdn.example/cindy/wallpapers/${m.hash}${ext}`);
    expect(options.isUrlAllowed(options.url)).toBe(true);
    expect(options.isUrlAllowed(options.url + '?redirect=1')).toBe(false);
    expect(options.isUrlAllowed('http://127.0.0.1/a')).toBe(false);
    expect((await readClientWallpaperFile(url(ext))).buffer.toString()).toBe('abc');
    expect(fs.existsSync(path.dirname(options.targetPath))).toBe(false);
    expect(m.recycle).toHaveBeenCalledWith([url('.mp4'), url('.webp')], ext);
  });
  it('reuses a still-only image offline and never requests a video for it', async () => {
    expect(await ensureWallpaperVideo('cindy-whisper')).toBeNull();
    expect(m.download).not.toHaveBeenCalled();
    expect(m.endpoint).not.toHaveBeenCalled();
    expect(await ensureWallpaperImage('cindy-whisper')).toBe(url('.webp'));
    m.download.mockClear().mockRejectedValue(new Error('offline'));
    m.endpoint.mockClear().mockReturnValue(null);
    expect(await ensureWallpaperImage('cindy-whisper')).toBe(url('.webp'));
    expect(m.download).not.toHaveBeenCalled();
    expect(m.endpoint).not.toHaveBeenCalled();
    expect((await readClientWallpaperFile(url('.webp'))).buffer.toString()).toBe('abc');
  });
  it('reuses both files after an app upgrade, module restart and loss of network configuration', async () => {
    await ensureWallpaperVideo('cindy-window');
    await ensureWallpaperImage('cindy-window');
    expect(m.download).toHaveBeenCalledTimes(2);
    const oldPaths = ['.mp4', '.webp'].map(
      (ext) => resolveHashRef(m.hash, ext, 'client-wallpaper').absPath,
    );
    // reset-modules: prove durable media reuse after a new app runtime loads.
    vi.resetModules();
    m.version = '2.0.0';
    m.download.mockClear().mockRejectedValue(new Error('offline'));
    m.endpoint.mockClear().mockReturnValue(null);
    const upgraded = await import('../wallpaper-video');
    expect(await upgraded.ensureWallpaperVideo('cindy-window')).toBe(url('.mp4'));
    expect(await upgraded.ensureWallpaperImage('cindy-window')).toBe(url('.webp'));
    expect(m.download).not.toHaveBeenCalled();
    expect(m.endpoint).not.toHaveBeenCalled();
    expect(oldPaths.every((file) => fs.readFileSync(file, 'utf8') === 'abc')).toBe(true);
  });
  it('shares actual byte progress with late requesters and resets it when a transfer restarts', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let options!: DownloadOptions;
    m.download.mockImplementationOnce(async (request: DownloadOptions) => {
      options = request;
      request.onProgress?.({ loaded: 1, total: 99, percent: 1, speedBps: 1 });
      await gate;
      fs.writeFileSync(request.targetPath, 'abc');
    });
    const first = vi.fn();
    const firstResult = ensureWallpaperVideo('cindy-window', first);
    await vi.waitFor(() =>
      expect(first).toHaveBeenLastCalledWith({
        wallpaperId: 'cindy-window',
        kind: 'video',
        loaded: 1,
        total: 3,
      }),
    );
    const second = vi.fn();
    const secondResult = ensureWallpaperVideo('cindy-window', second);
    expect(second).toHaveBeenLastCalledWith({
      wallpaperId: 'cindy-window',
      kind: 'video',
      loaded: 1,
      total: 3,
    });
    const closingResult = ensureWallpaperVideo('cindy-window', () => {
      throw new Error('closed frame');
    });
    options.onRetry?.({ attempt: 2, delayMs: 1, cause: new Error('connection reset') });
    expect(second).toHaveBeenLastCalledWith({
      wallpaperId: 'cindy-window',
      kind: 'video',
      loaded: 0,
      total: 3,
    });
    options.onProgress?.({ loaded: 5, total: 99, percent: 5, speedBps: 1 });
    expect(second).toHaveBeenLastCalledWith({
      wallpaperId: 'cindy-window',
      kind: 'video',
      loaded: 3,
      total: 3,
    });
    finish();
    expect(await Promise.all([firstResult, secondResult, closingResult])).toEqual([
      url('.mp4'),
      url('.mp4'),
      url('.mp4'),
    ]);
    expect(m.download).toHaveBeenCalledOnce();
    const callCount = second.mock.calls.length;
    options.onProgress?.({ loaded: 1, total: 3, percent: 33, speedBps: 1 });
    expect(second).toHaveBeenCalledTimes(callCount);
  });
  it('repairs a corrupted disk cache and reuses the repair without another download', async () => {
    await ensureWallpaperVideo('cindy-window');
    fs.writeFileSync(resolveHashRef(m.hash, '.mp4', 'client-wallpaper').absPath, 'bad');
    expect(await ensureWallpaperVideo('cindy-window')).toBe(url('.mp4'));
    expect(await ensureWallpaperVideo('cindy-window')).toBe(url('.mp4'));
    expect(m.download).toHaveBeenCalledTimes(2);
    expect((await readClientWallpaperFile(url('.mp4'))).buffer.toString()).toBe('abc');
  });
  it.each(['offline', 'size', 'hash'])(
    'keeps the preview on %s and allows an immediate explicit retry',
    async (failure) => {
      m.download.mockImplementationOnce(async ({ targetPath }: { targetPath: string }) => {
        if (failure === 'offline') throw new Error('offline');
        fs.writeFileSync(targetPath, failure === 'size' ? 'abcd' : 'bad');
      });
      expect(await ensureWallpaperVideo('cindy-window')).toBeNull();
      expect(fs.existsSync(resolveHashRef(m.hash, '.mp4', 'client-wallpaper').absPath)).toBe(false);
      expect(fs.readdirSync(m.dir).some((name) => name.startsWith('cindy-wallpaper-'))).toBe(false);
      expect(await ensureWallpaperVideo('cindy-window')).toBe(url('.mp4'));
      expect(m.download).toHaveBeenCalledTimes(2);
    },
  );
  it.each(['http://cdn.example', 'https://user:password@cdn.example'])(
    'rejects unsafe CDN configuration %s',
    async (base) => {
      m.endpoint.mockReturnValue(base);
      expect(await ensureWallpaperImage('cindy-window')).toBeNull();
      expect(m.download).not.toHaveBeenCalled();
    },
  );
});

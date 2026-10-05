import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  snapshot: { client: { drizzle: {} } }, owner: 'one', boundary: false,
  cached: vi.fn(), read: vi.fn(), touch: vi.fn(), ingest: vi.fn(), remove: vi.fn(),
  fetch: vi.fn(), release: vi.fn(), assert: vi.fn(),
}));
vi.mock('../../shared/wallpaper-video-manifest.json', () => ({ default: {
  'cindy-window': { delivery: 'cdn', bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
  'cindy-studio': { delivery: 'bundled', bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
} }));
vi.mock('../appSessionState.js', () => ({ activeOwnerScopeKey: () => m.owner, isAppSessionBoundaryPending: () => m.boundary }));
vi.mock('../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot: () => m.snapshot }));
vi.mock('../cindy-media/refCompensationJournal.js', () => ({ captureMediaRefCompensationScope: () => ({ assertStillValid: m.assert }) }));
vi.mock('../cindy-media/ingest.js', () => ({ ingestClientWallpaper: m.ingest }));
vi.mock('../cindy-media/ledger.js', () => ({ getIntegrationCacheHash: m.cached, touchBlob: m.touch }));
vi.mock('../cindy-media/blobStore.js', () => ({
  resolveHashRef: () => ({ absPath: '/safe/video.mp4' }),
  blobUrl: (hash: string, ext: string) => 'cindy-media://client-wallpaper/' + hash + ext,
}));
vi.mock('../cindy-media/clientWallpaperLock.js', () => ({ withClientWallpaperLock: (action: () => Promise<unknown>) => action() }));
vi.mock('../cindy-media/recycler.js', () => ({ recycleClientWallpapers: m.remove }));
vi.mock('../utils/readBoundedFile.js', () => ({ readBoundedFileNoFollow: m.read }));
vi.mock('../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://cdn.example/cindy' }));
vi.mock('../maker-host/outbound-fetch.js', () => ({ guardedOutboundFetch: m.fetch }));
import { ensureWallpaperVideo, matchesWallpaperVideo, __testing } from '../wallpaper-video';

const hash = createHash('sha256').update('abc').digest('hex');
const url = 'cindy-media://client-wallpaper/' + hash + '.mp4';
beforeEach(() => {
  vi.clearAllMocks();
  __testing.reset();
  m.snapshot = { client: { drizzle: {} } };
  m.owner = 'one'; m.boundary = false;
  m.cached.mockResolvedValue(null); m.read.mockResolvedValue(null);
  m.ingest.mockResolvedValue({ url, refIds: ['ref-1'] });
  m.remove.mockResolvedValue(undefined);
  m.fetch.mockImplementation(async () => ({ response: new Response('abc'), release: m.release }));
});

describe('optional CDN wallpaper video', () => {
  it('never accesses the cache or network for bundled official scenes', async () => {
    expect(await ensureWallpaperVideo('cindy-studio')).toBeNull();
    expect(m.cached).not.toHaveBeenCalled();
    expect(m.fetch).not.toHaveBeenCalled();
  });
  it('rejects arbitrary URLs, paths and prototype keys without network access', async () => {
    for (const id of ['https://example/a.mp4', '../secret', 'constructor', 'none', null])
      await expect(ensureWallpaperVideo(id)).rejects.toThrow('Unsupported');
    expect(m.fetch).not.toHaveBeenCalled();
  });
  it('checks exact reviewed bytes rather than accepting a MIME or size claim', () => {
    expect(matchesWallpaperVideo(Buffer.from('abc'), { bytes: 3, sha256: hash })).toBe(true);
    expect(matchesWallpaperVideo(Buffer.from('abd'), { bytes: 3, sha256: hash })).toBe(false);
  });
  it('downloads once for concurrent windows and publishes a client-owned video', async () => {
    const result = await Promise.all([ensureWallpaperVideo('cindy-window'), ensureWallpaperVideo('cindy-window')]);
    expect(result).toEqual([url, url]);
    expect(m.fetch).toHaveBeenCalledOnce();
    expect(m.fetch.mock.calls[0][0]).toBe('https://cdn.example/cindy/wallpapers/' + hash + '.mp4');
    expect(m.ingest).toHaveBeenCalledWith({ buffer: Buffer.from('abc'), mimeType: 'video/mp4' });
    expect(m.remove).toHaveBeenCalledWith([url], '.mp4');
    expect(m.release).toHaveBeenCalledOnce();
  });
  it('validates and reuses cached media offline without adding references', async () => {
    m.cached.mockResolvedValue(hash); m.read.mockResolvedValue(Buffer.from('abc'));
    expect(await ensureWallpaperVideo('cindy-window')).toBe(url);
    expect(m.fetch).not.toHaveBeenCalled(); expect(m.ingest).not.toHaveBeenCalled();
    expect(m.touch).not.toHaveBeenCalled();
  });
  it.each([null, Buffer.from('bad')])('redownloads a missing or damaged cache', async bytes => {
    m.cached.mockResolvedValue(hash); m.read.mockResolvedValue(bytes);
    expect(await ensureWallpaperVideo('cindy-window')).toBe(url);
    expect(m.fetch).toHaveBeenCalledOnce();
  });
  it.each(['404', 'offline', 'oversize', 'hash', 'length'])('returns fallback on %s and backs off retries', async reason => {
    m.fetch.mockImplementation(async () => {
      if (reason === 'offline') throw new Error('offline');
      return { response: reason === '404' ? new Response('', { status: 404 }) :
        new Response(reason === 'oversize' ? 'abcd' : 'bad', reason === 'length' ? { headers: { 'content-length': '100' } } : undefined), release: m.release };
    });
    expect(await ensureWallpaperVideo('cindy-window')).toBeNull();
    expect(await ensureWallpaperVideo('cindy-window')).toBeNull();
    expect(m.fetch).toHaveBeenCalledOnce(); expect(m.ingest).not.toHaveBeenCalled();
    if (reason !== 'offline') expect(m.release).toHaveBeenCalledOnce();
  });
  it('shares downloads during account transitions without an account database', async () => {
    m.boundary = true;
    m.fetch.mockImplementation(async () => {
      m.owner = 'two';
      return { response: new Response('abc'), release: m.release };
    });
    expect(await ensureWallpaperVideo('cindy-window')).toBe(url);
    expect(m.ingest).toHaveBeenCalledOnce();
    expect(m.cached).not.toHaveBeenCalled();
    expect(m.release).toHaveBeenCalledOnce();
  });
});

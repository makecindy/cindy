import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadOptions } from '../downloader/types';

// #9208, unit tier: existing wallpaper tests replace the downloader. This fixture
// exercises image/video -> real single-attempt transport -> real outbound/DNS guard
// -> size/SHA check -> media sink. DNS and HTTP are synthetic, never actual TUN.
// Minimal failing inputs: benchmark DNS, or a DNS Error hidden by NETWORK wrapping.
const m = vi.hoisted(() => ({
  dir: '',
  answers: [{ address: '43.174.128.71', family: 4 }],
  network: vi.fn(),
  warn: vi.fn(),
  ingest: vi.fn(),
  hash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  transportErrors: [] as string[],
}));
vi.mock('node:dns/promises', () => ({ lookup: async () => m.answers }));
vi.mock('undici', async (original) => ({ ...(await original<object>()), fetch: m.network }));
vi.mock('electron', () => ({ app: { getPath: () => m.dir } }));
vi.mock('../../shared/wallpaper-video-manifest.json', () => ({
  default: {
    synthetic: { delivery: 'cdn', bytes: 3, sha256: m.hash, image: { bytes: 3, sha256: m.hash } },
  },
}));
vi.mock('../clientEndpointsService.js', () => ({
  getClientEndpoint: () => 'https://cdn.example/cindy',
}));
vi.mock('../logger.js', () => ({
  createLogger: () => ({ warn: m.warn, debug: vi.fn(), info: vi.fn() }),
}));
vi.mock('../maker-host/outbound-fetch.desktop.js', async () => {
  const { createOutboundTransport } = await import('../maker-host/outbound-fetch');
  return createOutboundTransport(() => null, { warn: vi.fn(), debug: vi.fn() });
});
vi.mock('../downloader/index.js', async () => {
  const { executeOnce } = await import('../downloader/transport');
  return {
    createDownloader: () => async (opts: DownloadOptions) => {
      try {
        return await executeOnce({ opts, logger: opts.logger!, resumedFromBytes: 0 });
      } catch (error) {
        m.transportErrors.push((error as Error).message);
        throw error;
      }
    },
  };
});
vi.mock('../cindy-media/blobStore.desktop.js', () => ({
  resolveHashRef: () => ({ absPath: path.join(m.dir, 'absent') }),
  blobUrl: () => 'unused-cache-url',
}));
vi.mock('../cindy-media/ingest.js', () => ({ ingestClientWallpaper: m.ingest }));
vi.mock('../cindy-media/clientWallpaperLock.js', () => ({
  withClientWallpaperLock: (fn: () => unknown) => fn(),
}));
vi.mock('../cindy-media/recycler.js', () => ({ recycleClientWallpapers: async () => undefined }));
vi.mock('../custom-wallpaper-settings.js', () => ({ readReferencedClientWallpaperUrls: () => [] }));
import { ensureWallpaperImage, ensureWallpaperVideo, __testing } from '../wallpaper-video';

beforeEach(() => {
  vi.clearAllMocks();
  __testing.reset();
  m.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-fake-ip-'));
  m.answers = [{ address: '43.174.128.71', family: 4 }];
  m.transportErrors = [];
  m.network.mockImplementation(
    async () => new Response('abc', { headers: { 'content-length': '3' } }),
  );
  m.ingest.mockImplementation(async ({ mimeType }: { mimeType: string }) => ({
    url: `cindy-media://client-wallpaper/${m.hash}${mimeType === 'image/webp' ? '.webp' : '.mp4'}`,
  }));
});
afterEach(() => {
  expect(fs.readdirSync(m.dir)).toEqual([]);
  fs.rmSync(m.dir, { recursive: true, force: true });
});

describe.each([
  ['image', ensureWallpaperImage, '.webp'],
  ['video', ensureWallpaperVideo, '.mp4'],
] as const)('%s production wallpaper chain', (_kind, ensure, ext) => {
  it.each([
    ['IPv4', ['198.18.0.73']],
    ['IPv6', ['2001:2::4d']],
    ['dual', ['198.18.0.73', '2001:2::4d']],
    ['public control', ['43.174.128.71']],
  ])('publishes verified bytes for %s DNS', async (_label, addresses) => {
    m.answers = addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    expect(await ensure('synthetic')).toBe(`cindy-media://client-wallpaper/${m.hash}${ext}`);
    expect(m.network).toHaveBeenCalledOnce();
    expect(m.ingest).toHaveBeenCalledWith({
      buffer: Buffer.from('abc'),
      mimeType: ext === '.webp' ? 'image/webp' : 'video/mp4',
    });
  });

  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', 'fd00::1', '::1', 'fe80::1'])(
    'blocks mixed benchmark/private DNS %s before dispatch and logs the cause',
    async (address) => {
      m.answers = [
        { address: '198.18.0.73', family: 4 },
        { address, family: address.includes(':') ? 6 : 4 },
      ];
      expect(await ensure('synthetic')).toBeNull();
      expect(m.network).not.toHaveBeenCalled();
      expect(m.ingest).not.toHaveBeenCalled();
      expect(m.transportErrors).toEqual(['Download network request failed']);
      expect(m.warn).toHaveBeenCalledWith(
        'Wallpaper request failed',
        expect.objectContaining({ code: 'SSRF_BLOCKED' }),
      );
    },
  );

  it.each([
    [() => new Response('bad', { headers: { 'content-length': '3' } })],
    [() => new Response('abcd', { headers: { 'content-length': '4' } })],
    [
      () =>
        new Response(null, { status: 302, headers: { location: 'https://other.example/secret' } }),
    ],
  ])('rejects corrupt, oversized or redirected responses without ingestion', async (response) => {
    m.network.mockImplementation(async () => response());
    expect(await ensure('synthetic')).toBeNull();
    expect(m.network).toHaveBeenCalledOnce();
    expect(m.ingest).not.toHaveBeenCalled();
  });
});

it('keeps nested DNS diagnostics before NETWORK wrapping without disclosing signed URLs', async () => {
  const secret = 'https://user:password@cdn.example/file?signature=private#token';
  m.network.mockRejectedValueOnce(
    new TypeError(`fetch failed ${secret}`, {
      cause: Object.assign(new Error(`lookup failed ${secret}`), { code: 'ENOTFOUND' }),
    }),
  );
  expect(await ensureWallpaperImage('synthetic')).toBeNull();
  expect(m.transportErrors).toEqual(['Download network request failed']);
  expect(m.warn).toHaveBeenCalledWith(
    'Wallpaper request failed',
    expect.objectContaining({ code: 'ENOTFOUND' }),
  );
  expect(JSON.stringify(m.warn.mock.calls)).not.toMatch(/password|signature|private#token/);
});

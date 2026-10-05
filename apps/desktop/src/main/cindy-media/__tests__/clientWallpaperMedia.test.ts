import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dir: '',
  handle: vi.fn(),
  touch: vi.fn(),
  record: vi.fn(),
  ref: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => h.dir }, protocol: { handle: h.handle } }));
vi.mock('../ledger', () => ({ touchBlob: h.touch, recordBlob: h.record, addRef: h.ref }));
import * as store from '../blobStore';
import { ingestClientWallpaper } from '../ingest';
import { recycleClientWallpapers } from '../recycler';
import { registerCindyMediaProtocolHandler } from '../cindyMediaProtocol';

beforeEach(() => {
  h.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-wallpaper-media-'));
  vi.clearAllMocks();
});
afterEach(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('client wallpaper media scope', () => {
  it('isolates deletion and deduplication from identical account-owned blobs', async () => {
    const params = { buffer: Buffer.from('image-content'), mimeType: 'image/webp' as const };
    const account = await store.writeBlob(params);
    const client = await ingestClientWallpaper(params);
    expect(client.hash).toBe(account.hash);
    expect(client.url).not.toBe(account.url);
    expect(client.deduplicated).toBe(false);
    expect((await ingestClientWallpaper(params)).deduplicated).toBe(true);
    expect(h.record).not.toHaveBeenCalled();
    expect(h.ref).not.toHaveBeenCalled();
    await store.deleteBlobFile(account.hash, account.ext);
    expect((await store.readClientWallpaperFile(client.url)).buffer).toEqual(params.buffer);
    await store.writeBlob(params);
    await recycleClientWallpapers([], '.webp');
    await expect(store.readClientWallpaperFile(client.url)).rejects.toThrow();
    expect((await store.readFile(account.url)).buffer).toEqual(params.buffer);
  });

  it('retains the selected image and current catalog videos while removing unused client files', async () => {
    const old = await ingestClientWallpaper({ buffer: Buffer.from('old'), mimeType: 'image/webp' });
    const selected = await ingestClientWallpaper({
      buffer: Buffer.from('new'),
      mimeType: 'image/webp',
    });
    const video = await ingestClientWallpaper({
      buffer: Buffer.from('video'),
      mimeType: 'video/mp4',
    });
    const oldVideo = await ingestClientWallpaper({
      buffer: Buffer.from('old-video'),
      mimeType: 'video/mp4',
    });
    await recycleClientWallpapers([selected.url], '.webp');
    await recycleClientWallpapers([video.url], '.mp4');
    await expect(store.readClientWallpaperFile(old.url)).rejects.toThrow();
    await expect(store.readClientWallpaperFile(oldVideo.url)).rejects.toThrow();
    await expect(store.readClientWallpaperFile(selected.url)).resolves.toBeDefined();
    await expect(store.readClientWallpaperFile(video.url)).resolves.toBeDefined();
  });

  it('serves images and video ranges through the existing protocol without touching an account ledger', async () => {
    const media = await ingestClientWallpaper({
      buffer: Buffer.from('0123456789'),
      mimeType: 'video/mp4',
    });
    registerCindyMediaProtocolHandler();
    const handler = h.handle.mock.calls[0][1];
    const response: Response = await handler(
      new Request(media.url, { headers: { Range: 'bytes=2-5' } }),
    );
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('2345');
    expect(h.touch).not.toHaveBeenCalled();
    const image = await ingestClientWallpaper({
      buffer: Buffer.from('webp'),
      mimeType: 'image/webp',
    });
    const picture: Response = await handler(new Request(image.url));
    expect(picture.status).toBe(200);
    expect(picture.headers.get('content-type')).toContain('image/webp');
  });

  it('keeps account URL parsers strict and rejects noncanonical client paths and other media types', async () => {
    const url = `cindy-media://client-wallpaper/${'a'.repeat(64)}.webp`;
    expect(store.parseBlobUrl(url)).toBeNull();
    expect(() => store.resolveSafe(url)).toThrow('invalid url');
    for (const bad of [
      url + '?a=1',
      url + '#x',
      url.replace('/client-wallpaper/', '/client-wallpaper/../'),
      url.replace('.webp', '.png'),
      url.replace('client-wallpaper', 'other'),
      url.replace('://', '://user@'),
    ]) {
      expect(store.parseClientWallpaperUrl(bad)).toBeNull();
      await expect(store.readClientWallpaperFile(bad)).rejects.toThrow();
    }
    await expect(
      ingestClientWallpaper({ buffer: Buffer.from('x'), mimeType: 'image/png' as never }),
    ).rejects.toThrow();
    expect(() => store.getBlobsRoot('../outside' as never)).toThrow();
  });

  it('rejects symlinked client roots without reading or deleting the target', async () => {
    const external = path.join(h.dir, 'outside');
    const mediaRoot = path.join(h.dir, 'cindy-media');
    fs.mkdirSync(external);
    fs.mkdirSync(mediaRoot);
    const hash = 'a'.repeat(64);
    fs.mkdirSync(path.join(external, 'aa'));
    const file = path.join(external, 'aa', hash + '.webp');
    fs.writeFileSync(file, 'private');
    fs.symlinkSync(
      external,
      path.join(mediaRoot, 'client-wallpaper'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const url = `cindy-media://client-wallpaper/${hash}.webp`;
    await expect(store.readClientWallpaperFile(url)).rejects.toThrow('symlink');
    await expect(store.deleteBlobFile(hash, '.webp', 'client-wallpaper')).rejects.toThrow(
      'symlink',
    );
    await expect(
      ingestClientWallpaper({ buffer: Buffer.from('new'), mimeType: 'image/webp' }),
    ).rejects.toThrow('symlink');
    expect(fs.readFileSync(file, 'utf8')).toBe('private');
  });
});

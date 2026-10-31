import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileSymlinkFixture } from './fileSymlinkFixture';

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

const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';

// #8109: production ingest/read/protocol/delete must work through a redirected
// userData root, while links below that root remain forbidden. Existing tests
// only used a regular root; this unit matrix uses real temporary directories.
describe.each(['regular', 'redirected'] as const)('client wallpaper media scope (%s userData)', (kind) => {
  let scratch: string;
  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'client-wallpaper-media-'));
    const target = path.join(scratch, 'target');
    fs.mkdirSync(target);
    h.dir = target;
    if (kind === 'redirected') {
      h.dir = path.join(scratch, 'userData');
      fs.symlinkSync(target, h.dir, directoryLinkType);
    }
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
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

  it.each(['media', 'scope', 'bucket', 'file'] as const)(
    'rejects a linked %s without reading, writing or deleting its target', async (level) => {
      const bytes = Buffer.from('private');
      const hash = createHash('sha256').update(bytes).digest('hex');
      const parts = ['cindy-media', 'client-wallpaper', hash.slice(0, 2), `${hash}.webp`];
      const depth = ['media', 'scope', 'bucket', 'file'].indexOf(level);
      const external = path.join(scratch, 'outside');
      const target = level === 'file' ? path.join(external, 'private.webp') : path.join(external, ...parts.slice(depth + 1));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
      // Use the physical root so the Windows file-link fallback observes the
      // same filesystem identity as production after resolving userData.
      const link = path.join(await fs.promises.realpath(h.dir), ...parts.slice(0, depth + 1));
      fs.mkdirSync(path.dirname(link), { recursive: true });
      const fixture = level === 'file' ? fileSymlinkFixture(target, link) : undefined;
      if (!fixture) fs.symlinkSync(external, link, directoryLinkType);
      try {
        const url = `cindy-media://client-wallpaper/${hash}.webp`;
        await expect(store.readClientWallpaperFile(url)).rejects.toThrow('symlink');
        await expect(store.deleteBlobFile(hash, '.webp', 'client-wallpaper')).rejects.toThrow('symlink');
        await expect(ingestClientWallpaper({ buffer: bytes, mimeType: 'image/webp' })).rejects.toThrow('symlink');
        registerCindyMediaProtocolHandler();
        const response: Response = await h.handle.mock.calls[0][1](new Request(url));
        expect(response.status).toBe(403);
        expect(fs.readFileSync(target)).toEqual(bytes);
        expect(fs.readdirSync(path.dirname(target))).toEqual([path.basename(target)]);
        fixture?.expectIntact();
      } finally {
        fixture?.restore();
      }
    },
  );
});

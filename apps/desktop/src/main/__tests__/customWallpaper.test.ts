import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

const h = vi.hoisted(() => ({ dir: '', picker: vi.fn(), account: 'a', db: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => h.dir },
  dialog: { showOpenDialog: h.picker },
}));
vi.mock('../../shared/wallpaper-video-manifest.json', () => ({
  default: {
    official: {
      delivery: 'cdn',
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    },
  },
}));
vi.mock('../localDb/client/current.js', () => ({
  getDbClient: h.db,
  getCurrentDbClientSnapshot: h.db,
}));
vi.mock('../appSessionState.js', () => ({
  getActiveAppSession: () => {
    throw new Error('Wallpaper must not read the account');
  },
  activeOwnerScopeKey: () => {
    throw new Error('Wallpaper must not read the account');
  },
}));
import {
  importCustomWallpaper,
  removeCustomWallpaper,
  prepareWallpaperImage,
} from '../custom-wallpaper';
import {
  customWallpaperStore,
  readCustomWallpaperUrl,
  readReferencedClientWallpaperUrls,
} from '../custom-wallpaper-settings';
import {
  writeBlob,
  readFile,
  readClientWallpaperFile,
  listBlobFiles,
} from '../cindy-media/blobStore';
import * as recycler from '../cindy-media/recycler';

beforeEach(() => {
  h.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-wallpaper-test-'));
  h.account = 'a';
  h.db.mockImplementation(() => {
    throw new Error('No account database');
  });
  h.picker.mockReset();
});
afterEach(() => {
  expect(h.db).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  fs.rmSync(h.dir, { recursive: true, force: true });
});

async function selectImage(color = 'blue') {
  const bytes = await sharp({ create: { width: 8, height: 4, channels: 3, background: color } })
    .png()
    .toBuffer();
  const file = path.join(h.dir, color + '.png');
  fs.writeFileSync(file, bytes);
  h.picker.mockResolvedValue({ canceled: false, filePaths: [file] });
  return bytes;
}
const parent = {} as never;

describe('client-owned custom wallpaper lifecycle', () => {
  it('rejects a 20–100 MB image after only the header, even with an MP4 filename', async () => {
    const png = await selectImage();
    const file = path.join(h.dir, 'oversized.mp4');
    fs.writeFileSync(file, png);
    fs.truncateSync(file, 50 * 1024 * 1024);
    h.picker.mockResolvedValue({ canceled: false, filePaths: [file] });
    const realOpen = fs.promises.open;
    const lengths: number[] = [];
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (args[0] === file) {
        const realRead = handle.read.bind(handle);
        vi.spyOn(handle, 'read').mockImplementation((async (...readArgs: unknown[]) => {
          lengths.push((readArgs[0] as Buffer).length);
          return realRead(
            readArgs[0] as Buffer,
            readArgs[1] as number,
            readArgs[2] as number,
            readArgs[3] as number,
          );
        }) as typeof handle.read);
      }
      return handle;
    });
    await expect(importCustomWallpaper(parent)).rejects.toThrow('INVALID_PARAMS');
    expect(lengths).toEqual([4096]);
  });

  it.each([false, true])(
    'cleans failed imports from durable references (published=%s)',
    async (published) => {
      await selectImage();
      await importCustomWallpaper(parent);
      const official = await writeBlob({
        buffer: Buffer.from('abc'),
        mimeType: 'video/mp4',
        scope: 'client-wallpaper',
      });
      const oldUrl = readCustomWallpaperUrl();
      const video = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex');
      const file = path.join(h.dir, 'replacement.mp4');
      fs.writeFileSync(file, video);
      h.picker.mockResolvedValue({ canceled: false, filePaths: [file] });
      const write = customWallpaperStore.writePatchAtomic.bind(customWallpaperStore);
      vi.spyOn(customWallpaperStore, 'writePatchAtomic').mockImplementationOnce(async (patch) => {
        if (published) await write(patch);
        throw new Error('save failed');
      });
      await expect(importCustomWallpaper(parent)).rejects.toThrow('save failed');
      const current = readCustomWallpaperUrl();
      expect((await listBlobFiles('client-wallpaper')).entries).toHaveLength(2);
      await expect(readClientWallpaperFile(official.url)).resolves.toBeDefined();
      if (published) {
        expect(current).not.toBe(oldUrl);
        expect((await readClientWallpaperFile(current)).buffer).toEqual(video);
      } else {
        expect(current).toBe(oldUrl);
        await expect(readClientWallpaperFile(oldUrl)).resolves.toBeDefined();
      }
      expect(fs.readFileSync(file)).toEqual(video);
    },
  );

  it('preserves the original save error if compensating cleanup also fails', async () => {
    await selectImage();
    await importCustomWallpaper(parent);
    const oldUrl = readCustomWallpaperUrl();
    await selectImage('red');
    vi.spyOn(customWallpaperStore, 'writePatchAtomic').mockRejectedValueOnce(
      new Error('save failed'),
    );
    vi.spyOn(recycler, 'recycleClientWallpapers').mockRejectedValueOnce(
      new Error('cleanup failed'),
    );
    await expect(importCustomWallpaper(parent)).rejects.toThrow('save failed');
    await expect(readClientWallpaperFile(oldUrl)).resolves.toBeDefined();
    expect((await listBlobFiles('client-wallpaper')).entries).toHaveLength(2);
    await removeCustomWallpaper();
    expect((await listBlobFiles('client-wallpaper')).entries).toHaveLength(0);
  });
  it('retains an official CDN video when removing custom media', async () => {
    const official = await writeBlob({
      buffer: Buffer.from('abc'),
      mimeType: 'video/mp4',
      scope: 'client-wallpaper',
    });
    await selectImage();
    await importCustomWallpaper(parent);
    await removeCustomWallpaper();
    expect((await readClientWallpaperFile(official.url)).buffer).toEqual(Buffer.from('abc'));
    expect((await listBlobFiles('client-wallpaper')).entries).toHaveLength(1);
  });

  it('rejects oversized or fake MP4 files without replacing the current image', async () => {
    await selectImage();
    await importCustomWallpaper(parent);
    const current = readCustomWallpaperUrl();
    const file = path.join(h.dir, 'invalid.mp4');
    fs.writeFileSync(file, 'not a video');
    h.picker.mockResolvedValue({ canceled: false, filePaths: [file] });
    await expect(importCustomWallpaper(parent)).rejects.toThrow('INVALID_PARAMS');
    fs.truncateSync(file, 100 * 1024 * 1024 + 1);
    await expect(importCustomWallpaper(parent)).rejects.toThrow('INVALID_PARAMS');
    expect(readCustomWallpaperUrl()).toBe(current);
    await expect(readClientWallpaperFile(current)).resolves.toBeDefined();
  });
  it('imports a video by its real bytes and recycles it when replaced by an image', async () => {
    await selectImage();
    await importCustomWallpaper(parent);
    const previousImage = readCustomWallpaperUrl();
    // A small ISO BMFF container fixture, independent of the selected filename.
    const video = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex');
    const file = path.join(h.dir, 'wallpaper.bin');
    fs.writeFileSync(file, video);
    h.picker.mockResolvedValue({ canceled: false, filePaths: [file] });
    await importCustomWallpaper(parent);
    const url = readCustomWallpaperUrl();
    await expect(readClientWallpaperFile(previousImage)).rejects.toThrow();
    expect(url).toMatch(/\.mp4$/);
    expect((await readClientWallpaperFile(url)).buffer).toEqual(video);
    expect(h.picker.mock.calls[0][1].filters[0].extensions).toContain('mp4');
    await selectImage();
    await importCustomWallpaper(parent);
    await expect(readClientWallpaperFile(url)).rejects.toThrow();
    expect((await listBlobFiles('client-wallpaper')).entries).toHaveLength(1);
  });

  it('refuses recycling when custom references are unreadable or invalid instead of dropping the video', () => {
    const file = path.join(h.dir, 'custom-wallpaper.json');
    for (const content of ['{broken', '[]', 'null', '{"url":"file:///private.mp4"}']) {
      fs.writeFileSync(file, content);
      expect(() => readReferencedClientWallpaperUrls()).toThrow();
    }
  });

  it('keeps the old video when replacement fails, and removes it only after a successful save', async () => {
    const file = path.join(h.dir, 'wallpaper.mp4');
    fs.writeFileSync(file, Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex'));
    h.picker.mockResolvedValue({ canceled: false, filePaths: [file] });
    await importCustomWallpaper(parent);
    const url = readCustomWallpaperUrl();
    await selectImage();
    vi.spyOn(customWallpaperStore, 'writePatchAtomic').mockRejectedValueOnce(new Error('disk'));
    await expect(importCustomWallpaper(parent)).rejects.toThrow('disk');
    expect(readCustomWallpaperUrl()).toBe(url);
    await expect(readClientWallpaperFile(url)).resolves.toBeDefined();
    await removeCustomWallpaper();
    expect((await listBlobFiles('client-wallpaper')).entries).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(true);
  });
  it('imports without a database, then replaces and removes across account switches without touching identical chat bytes', async () => {
    const original = await selectImage();
    const chat = await writeBlob({
      buffer: await prepareWallpaperImage(original),
      mimeType: 'image/webp',
    });
    expect(await importCustomWallpaper(parent)).toBe(true);
    const first = readCustomWallpaperUrl();
    expect(first).toContain('cindy-media://client-wallpaper/');
    expect((await readClientWallpaperFile(first)).buffer).toEqual(
      (await readFile(chat.url)).buffer,
    );
    h.account = 'b';
    await selectImage('red');
    await importCustomWallpaper(parent);
    await expect(readClientWallpaperFile(first)).rejects.toThrow();
    const second = readCustomWallpaperUrl();
    expect(second).not.toBe(first);
    expect((await listBlobFiles('client-wallpaper')).entries).toHaveLength(1);
    h.account = ''; // Signed out: removing the client preference still works.
    await removeCustomWallpaper();
    expect(readCustomWallpaperUrl()).toBe('');
    expect((await listBlobFiles('client-wallpaper')).entries).toHaveLength(0);
    expect((await readFile(chat.url)).buffer).toEqual(await prepareWallpaperImage(original));
    await removeCustomWallpaper(); // Idempotent, with no owner reference to release.
  });

  it('allows remove while a picker is open and publishes the later choice even after switching accounts', async () => {
    await selectImage();
    await importCustomWallpaper(parent);
    await selectImage('red');
    const file = path.join(h.dir, 'red.png');
    let close!: (value: unknown) => void;
    h.picker.mockReturnValueOnce(
      new Promise((resolve) => {
        close = resolve;
      }),
    );
    const pending = importCustomWallpaper(parent);
    h.account = 'b';
    await removeCustomWallpaper();
    expect(readCustomWallpaperUrl()).toBe('');
    close({ canceled: false, filePaths: [file] });
    expect(await pending).toBe(true);
    expect(readCustomWallpaperUrl()).not.toBe('');
  });

  it('serializes concurrent publications and retains only the final client reference', async () => {
    await selectImage();
    const a = path.join(h.dir, 'blue.png');
    await selectImage('red');
    const b = path.join(h.dir, 'red.png');
    h.picker.mockResolvedValueOnce({ canceled: false, filePaths: [a] });
    h.picker.mockResolvedValueOnce({ canceled: false, filePaths: [b] });
    await Promise.all([importCustomWallpaper(parent), importCustomWallpaper(parent)]);
    const current = readCustomWallpaperUrl();
    expect((await listBlobFiles('client-wallpaper')).entries).toHaveLength(1);
    expect((await readClientWallpaperFile(current)).buffer.length).toBeGreaterThan(0);
  });

  it('keeps the published image after save failure and allows subsequent removal', async () => {
    await selectImage();
    await importCustomWallpaper(parent);
    const first = readCustomWallpaperUrl();
    await selectImage('red');
    vi.spyOn(customWallpaperStore, 'writePatchAtomic').mockRejectedValueOnce(new Error('disk'));
    await expect(importCustomWallpaper(parent)).rejects.toThrow('disk');
    expect(readCustomWallpaperUrl()).toBe(first);
    await expect(readClientWallpaperFile(first)).resolves.toBeDefined();
    await removeCustomWallpaper();
    expect((await listBlobFiles('client-wallpaper')).entries).toHaveLength(0);
  });

  it('does not recycle files when settings cannot be parsed or removal cannot be saved', async () => {
    await selectImage();
    await importCustomWallpaper(parent);
    const first = readCustomWallpaperUrl();
    fs.writeFileSync(path.join(h.dir, 'custom-wallpaper.json'), '{broken');
    await selectImage('red');
    await expect(importCustomWallpaper(parent)).rejects.toThrow('unreadable');
    await expect(readClientWallpaperFile(first)).resolves.toBeDefined();
    vi.spyOn(customWallpaperStore, 'resetAtomic').mockRejectedValueOnce(new Error('disk'));
    await expect(removeCustomWallpaper()).rejects.toThrow('disk');
    await expect(readClientWallpaperFile(first)).resolves.toBeDefined();
    await removeCustomWallpaper();
    expect((await listBlobFiles('client-wallpaper')).entries).toHaveLength(0);
  });

  it('retains a successful publication when recycling fails and retries on the next removal', async () => {
    await selectImage();
    await importCustomWallpaper(parent);
    await selectImage('red');
    vi.spyOn(recycler, 'recycleClientWallpapers').mockRejectedValueOnce(new Error('busy'));
    await importCustomWallpaper(parent);
    await expect(readClientWallpaperFile(readCustomWallpaperUrl())).resolves.toBeDefined();
    await removeCustomWallpaper();
    expect((await listBlobFiles('client-wallpaper')).entries).toHaveLength(0);
  });

  it('cancels and rejects invalid input without changing the current image', async () => {
    await selectImage();
    await importCustomWallpaper(parent);
    const original = readCustomWallpaperUrl();
    h.picker.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await importCustomWallpaper(parent)).toBe(false);
    fs.writeFileSync(path.join(h.dir, 'blue.png'), 'invalid');
    await expect(importCustomWallpaper(parent)).rejects.toThrow('INVALID_PARAMS');
    expect(readCustomWallpaperUrl()).toBe(original);
    await expect(prepareWallpaperImage(Buffer.from('<svg/>'))).rejects.toThrow('INVALID_PARAMS');
    await expect(prepareWallpaperImage(Buffer.alloc(0))).rejects.toThrow('INVALID_PARAMS');
  });
});

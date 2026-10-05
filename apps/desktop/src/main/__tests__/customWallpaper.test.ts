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
import { customWallpaperStore, readCustomWallpaperUrl } from '../custom-wallpaper-settings';
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

  it('keeps the published image after save failure and collects the unused bytes on the next successful operation', async () => {
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

/**
 * copyFromPath must preserve the original extension of NON-image attachments
 * (device-link OSS-ref materializer) instead of collapsing them to `.bin`.
 * Regression for #306.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createChatAttachmentSaveHandler } from '../chatAttachmentSave';

const userDataDir = path.join(os.tmpdir(), `image-cache-ext-${randomUUID()}`);

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
}));

const imageCacheStore = await import('../imageCacheStore');

async function makeSource(contents = 'data'): Promise<string> {
  const dir = path.join(os.tmpdir(), `ext-src-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, 'src.tmp');
  await fs.writeFile(p, contents);
  return p;
}

async function copiedExt(originalName: string): Promise<string> {
  const sourcePath = await makeSource();
  const { filename } = await imageCacheStore.copyFromPath({
    sessionId: 'sess-ext',
    sourcePath,
    originalName,
    lifecycle: 'committed',
  });
  return path.extname(filename).toLowerCase();
}

describe('imageCacheStore.copyFromPath — extension preservation', () => {
  beforeEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it('preserves non-image attachment extensions instead of .bin', async () => {
    expect(await copiedExt('spec.pdf')).toBe('.pdf');
    expect(await copiedExt('report.docx')).toBe('.docx');
    expect(await copiedExt('sheet.xlsx')).toBe('.xlsx');
    expect(await copiedExt('notes.txt')).toBe('.txt');
    expect(await copiedExt('readme.MD')).toBe('.md'); // lowercased
  });

  it('still preserves image extensions (unchanged behavior)', async () => {
    expect(await copiedExt('photo.png')).toBe('.png');
    expect(await copiedExt('scan.jpeg')).toBe('.jpeg');
  });

  it('falls back to .bin when there is no usable extension', async () => {
    expect(await copiedExt('no-extension')).toBe('.bin');
    expect(await copiedExt('trailing.')).toBe('.bin'); // dot with nothing after
    expect(await copiedExt('archive.tar.gz')).toBe('.bin'); // .gz is not a supported attachment type
  });

  it('does NOT preserve executable/installer extensions (→ .bin, so the chip can not openPath-exec)', async () => {
    expect(await copiedExt('setup.exe')).toBe('.bin');
    expect(await copiedExt('pkg.msi')).toBe('.bin');
    expect(await copiedExt('image.dmg')).toBe('.bin');
    expect(await copiedExt('tool.app')).toBe('.bin');
    expect(await copiedExt('lib.jar')).toBe('.bin');
  });

  it('round-trips setup.exe → .bin cache → Save As setup.exe without opening it', async () => {
    const sourcePath = await makeSource('installer-bytes');
    const cached = await imageCacheStore.copyFromPath({
      sessionId: 'sess-ext',
      sourcePath,
      originalName: 'setup.exe',
      lifecycle: 'committed',
    });
    const cachedPath = imageCacheStore.resolveSafe(cached.url).absPath;
    expect(path.extname(cachedPath).toLowerCase()).toBe('.bin');

    const targetDir = path.join(os.tmpdir(), `ext-save-${randomUUID()}`);
    const targetPath = path.join(targetDir, 'chosen-setup.exe');
    await fs.mkdir(targetDir, { recursive: true });
    const showSaveDialog = vi.fn(async () => ({ canceled: false, filePath: targetPath }));
    const result = await createChatAttachmentSaveHandler({
      isPathAllowed: () => true,
      realpath: (filePath) => fs.realpath(filePath),
      stat: (filePath) => fs.stat(filePath, { bigint: true }),
      openSource: async (filePath) => {
        const handle = await fs.open(filePath, fsSync.constants.O_RDONLY);
        return {
          stat: () => handle.stat({ bigint: true }),
          copyTo: (to) =>
            pipeline(
              handle.createReadStream({ autoClose: false, start: 0 }),
              fsSync.createWriteStream(to),
            ),
          close: () => handle.close(),
        };
      },
      showSaveDialog,
      getDownloadsDir: () => targetDir,
      getAllowedSourceRoots: () => [imageCacheStore.getCacheRoot()],
    })({ sourcePath: cachedPath, suggestedName: 'setup.exe' });

    expect(showSaveDialog).toHaveBeenCalledWith({
      defaultPath: path.join(targetDir, 'setup.exe'),
    });
    expect(result).toEqual({ status: 'saved', savedPath: targetPath });
    expect(await fs.readFile(targetPath, 'utf8')).toBe('installer-bytes');
  });
});

describe('imageCacheStore.writeBuffer — trusted mimeType wins over suggestedName', () => {
  beforeEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it('keeps the image extension from mimeType even when suggestedName has a doc extension', async () => {
    const { filename } = await imageCacheStore.writeBuffer({
      sessionId: 'sess-ext',
      buffer: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
      suggestedName: 'clipboard.pdf',
      lifecycle: 'committed',
    });
    expect(path.extname(filename).toLowerCase()).toBe('.png');
  });
});

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 });

const desktopRoot = path.resolve(__dirname, '../../..');
const resourcesDir = path.join(desktopRoot, 'resources');
const updaterIconsDir = path.join(desktopRoot, 'cindy-updater', 'src-tauri', 'icons');

interface DecodedIcoEntry {
  size: number;
  rgba: Buffer;
}

function decodeIcoEntries(ico: Buffer): DecodedIcoEntry[] {
  const count = ico.readUInt16LE(4);
  const entries: DecodedIcoEntry[] = [];

  for (let index = 0; index < count; index++) {
    const directoryOffset = 6 + index * 16;
    const width = ico[directoryOffset] || 256;
    const height = ico[directoryOffset + 1] || 256;
    const bitmapOffset = ico.readUInt32LE(directoryOffset + 12);
    const rgba = Buffer.alloc(width * height * 4);
    const pixelOffset = bitmapOffset + 40;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const source = pixelOffset + ((height - 1 - y) * width + x) * 4;
        const target = (y * width + x) * 4;
        rgba[target] = ico[source + 2];
        rgba[target + 1] = ico[source + 1];
        rgba[target + 2] = ico[source];
        rgba[target + 3] = ico[source + 3];
      }
    }

    entries.push({ size: width, rgba });
  }

  return entries;
}

function alphaBounds(rgba: Buffer, width: number, height: number, threshold = 128) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] >= threshold) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function alphaAt(rgba: Buffer, size: number, x: number, y: number) {
  return rgba[(y * size + x) * 4 + 3];
}

describe('Windows icon assets', () => {
  it('fill the taskbar canvas while preserving rounded corners and synchronized updater assets', async () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-win-icon-'));
    const generatedIcoPath = path.join(fixtureDir, 'icon.ico');
    const mainIcoPath = path.join(resourcesDir, 'icon.ico');
    const mainPngPath = path.join(resourcesDir, 'icon.png');
    const updaterIcoPath = path.join(updaterIconsDir, 'icon.ico');
    const updaterPngPath = path.join(updaterIconsDir, 'icon.png');

    try {
      execFileSync(process.execPath, [
        path.join(desktopRoot, 'scripts', 'generate-win-ico.mjs'),
        path.join(resourcesDir, 'icon-master-1024.png'),
        generatedIcoPath,
      ]);

      const mainIco = fs.readFileSync(mainIcoPath);
      expect(mainIco).toEqual(fs.readFileSync(generatedIcoPath));
      expect(mainIco).toEqual(fs.readFileSync(updaterIcoPath));
      expect(fs.readFileSync(mainPngPath)).toEqual(fs.readFileSync(updaterPngPath));

      const entries = decodeIcoEntries(mainIco);
      expect(entries.map(({ size }) => size)).toEqual([16, 24, 32, 48, 64, 128, 256]);

      const taskbarEntry = entries.find(({ size }) => size === 24);
      expect(taskbarEntry).toBeDefined();
      expect(alphaBounds(taskbarEntry!.rgba, 24, 24)).toEqual({
        x: 0,
        y: 0,
        width: 24,
        height: 24,
      });
      expect(alphaAt(taskbarEntry!.rgba, 24, 0, 0)).toBeLessThan(128);
      expect(alphaAt(taskbarEntry!.rgba, 24, 12, 0)).toBeGreaterThanOrEqual(128);

      const png = await sharp(mainPngPath).ensureAlpha().raw().toBuffer({
        resolveWithObject: true,
      });
      expect(alphaBounds(png.data, png.info.width, png.info.height)).toEqual({
        x: 0,
        y: 0,
        width: 512,
        height: 512,
      });
      expect(alphaAt(png.data, 512, 0, 0)).toBeLessThan(128);
      expect(alphaAt(png.data, 512, 256, 0)).toBeGreaterThanOrEqual(128);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

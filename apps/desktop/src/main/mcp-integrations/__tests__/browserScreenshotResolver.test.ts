import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { BrowserControlResult } from '@cindy/browser-control-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveBrowserScreenshot } from '../browserScreenshotResolver.js';

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('test-png'),
]);

const tempRoots: string[] = [];

async function makeRuntimeDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-browser-screenshot-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('resolveBrowserScreenshot', () => {
  it('strictly decodes an inline RSB screenshot and verifies its MIME', async () => {
    const result: BrowserControlResult = {
      ok: true,
      action: 'screenshot',
      data: {
        data: PNG_BYTES.toString('base64'),
        mimeType: 'image/png',
        bytes: PNG_BYTES.byteLength,
        tabId: 'tab-1',
      },
    };

    const resolved = await resolveBrowserScreenshot(result, { runtimeDir: undefined });

    expect(resolved).toEqual({ buffer: PNG_BYTES, mimeType: 'image/png' });
  });

  it('reads external screenshots only from the browser runtime media root', async () => {
    const runtimeDir = await makeRuntimeDir();
    const mediaRoot = path.join(runtimeDir, 'media', 'browser');
    const screenshotPath = path.join(mediaRoot, 'screen.png');
    await fs.mkdir(mediaRoot, { recursive: true });
    await fs.writeFile(screenshotPath, PNG_BYTES);
    const result: BrowserControlResult = {
      ok: true,
      action: 'screenshot',
      data: { path: screenshotPath, targetId: 'tab-1' },
    };

    const resolved = await resolveBrowserScreenshot(result, { runtimeDir });

    expect(resolved).toEqual({ buffer: PNG_BYTES, mimeType: 'image/png' });
  });

  it('rejects external paths outside the browser runtime media root', async () => {
    const runtimeDir = await makeRuntimeDir();
    const mediaRoot = path.join(runtimeDir, 'media', 'browser');
    const outsidePath = path.join(runtimeDir, 'outside.png');
    await fs.mkdir(mediaRoot, { recursive: true });
    await fs.writeFile(outsidePath, PNG_BYTES);
    const result: BrowserControlResult = {
      ok: true,
      action: 'screenshot',
      data: { path: outsidePath, targetId: 'tab-1' },
    };

    await expect(resolveBrowserScreenshot(result, { runtimeDir })).rejects.toThrow(
      'Browser screenshot file is unavailable',
    );
  });

  it('rejects a symlink inside the media root that points outside it', async () => {
    const runtimeDir = await makeRuntimeDir();
    const mediaRoot = path.join(runtimeDir, 'media', 'browser');
    const outsideTarget = path.join(runtimeDir, 'outside-target.png');
    const symlinkPath = path.join(mediaRoot, 'escape.png');
    await fs.mkdir(mediaRoot, { recursive: true });
    await fs.writeFile(outsideTarget, PNG_BYTES);
    await fs.symlink(outsideTarget, symlinkPath);
    const result: BrowserControlResult = {
      ok: true,
      action: 'screenshot',
      data: { path: symlinkPath, targetId: 'tab-1' },
    };

    await expect(resolveBrowserScreenshot(result, { runtimeDir })).rejects.toThrow(
      'Browser screenshot file is unavailable',
    );
  });

  it('rejects external screenshot files above the 5 MiB read cap', async () => {
    const runtimeDir = await makeRuntimeDir();
    const mediaRoot = path.join(runtimeDir, 'media', 'browser');
    const oversizedPath = path.join(mediaRoot, 'oversized.png');
    await fs.mkdir(mediaRoot, { recursive: true });
    await fs.writeFile(
      oversizedPath,
      Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024, 0x00)]),
    );
    const result: BrowserControlResult = {
      ok: true,
      action: 'screenshot',
      data: { path: oversizedPath, targetId: 'tab-1' },
    };

    await expect(resolveBrowserScreenshot(result, { runtimeDir })).rejects.toThrow(
      'Browser screenshot file is unavailable',
    );
  });

  it('rejects path-based screenshots when no runtimeDir is configured', async () => {
    const runtimeDir = await makeRuntimeDir();
    const mediaRoot = path.join(runtimeDir, 'media', 'browser');
    const screenshotPath = path.join(mediaRoot, 'screen.png');
    await fs.mkdir(mediaRoot, { recursive: true });
    await fs.writeFile(screenshotPath, PNG_BYTES);
    const result: BrowserControlResult = {
      ok: true,
      action: 'screenshot',
      data: { path: screenshotPath, targetId: 'tab-1' },
    };

    await expect(
      resolveBrowserScreenshot(result, { runtimeDir: undefined }),
    ).rejects.toThrow('Browser screenshot file is unavailable');
  });

  it('rejects non-object payloads, payloads without data/path, and unknown magic bytes', async () => {
    const nonObject: BrowserControlResult = {
      ok: true,
      action: 'screenshot',
      data: undefined,
    };
    await expect(resolveBrowserScreenshot(nonObject, { runtimeDir: undefined })).rejects.toThrow(
      'Browser screenshot payload is invalid',
    );

    const missingBoth: BrowserControlResult = {
      ok: true,
      action: 'screenshot',
      data: { targetId: 'tab-1' },
    };
    await expect(resolveBrowserScreenshot(missingBoth, { runtimeDir: undefined })).rejects.toThrow(
      'Browser screenshot payload is invalid',
    );

    // 合法 Base64,但内容既不是 PNG 也不是 JPEG 签名。
    const unknownMagic: BrowserControlResult = {
      ok: true,
      action: 'screenshot',
      data: { data: Buffer.alloc(64, 0x00).toString('base64'), targetId: 'tab-1' },
    };
    await expect(resolveBrowserScreenshot(unknownMagic, { runtimeDir: undefined })).rejects.toThrow(
      'Browser screenshot payload is invalid',
    );
  });

  it('rejects malformed Base64 and declared MIME mismatches', async () => {
    const malformed: BrowserControlResult = {
      ok: true,
      action: 'screenshot',
      data: { data: 'not-base64!', mimeType: 'image/png' },
    };
    await expect(resolveBrowserScreenshot(malformed, { runtimeDir: undefined })).rejects.toThrow(
      'Browser screenshot payload is invalid',
    );

    const mismatched: BrowserControlResult = {
      ok: true,
      action: 'screenshot',
      data: { data: PNG_BYTES.toString('base64'), mimeType: 'image/jpeg' },
    };
    await expect(resolveBrowserScreenshot(mismatched, { runtimeDir: undefined })).rejects.toThrow(
      'Browser screenshot MIME does not match its bytes',
    );
  });
});

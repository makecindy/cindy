/**
 * Covers the on-disk lifecycle metadata for session image cache files.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const userDataDir = path.join(os.tmpdir(), `image-cache-lifecycle-${randomUUID()}`);

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
  },
}));

const imageCacheStore = await import('../imageCacheStore');

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe('imageCacheStore lifecycle metadata', () => {
  beforeEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it('writes draft metadata and sweeps unreferenced previous-process drafts', async () => {
    const cached = await imageCacheStore.writeBuffer({
      sessionId: 'session-a',
      buffer: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
      lifecycle: 'draft',
    });
    const { absPath } = imageCacheStore.resolveSafe(cached.url);

    expect(await exists(absPath)).toBe(true);
    expect(await exists(`${absPath}.xdt-meta.json`)).toBe(true);

    const result = await imageCacheStore.sweepDraftImages({
      createdBeforeMs: Number.MAX_SAFE_INTEGER,
    });

    expect(result.removed).toBe(1);
    expect(await exists(absPath)).toBe(false);
    expect(await exists(`${absPath}.xdt-meta.json`)).toBe(false);
  });

  it('keeps draft images that are still referenced by message history', async () => {
    const cached = await imageCacheStore.writeBuffer({
      sessionId: 'session-a',
      buffer: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
      lifecycle: 'draft',
    });
    const { absPath } = imageCacheStore.resolveSafe(cached.url);

    const result = await imageCacheStore.sweepDraftImages({
      referencedUrls: [cached.url],
      createdBeforeMs: Number.MAX_SAFE_INTEGER,
    });

    expect(result.removed).toBe(0);
    expect(result.skippedReferenced).toBe(1);
    expect(await exists(absPath)).toBe(true);
  });

  it('keeps draft images created in the current process', async () => {
    const cached = await imageCacheStore.writeBuffer({
      sessionId: 'session-a',
      buffer: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
      lifecycle: 'draft',
    });
    const { absPath } = imageCacheStore.resolveSafe(cached.url);

    const result = await imageCacheStore.sweepDraftImages({
      createdBeforeMs: 0,
    });

    expect(result.removed).toBe(0);
    expect(result.skippedFresh).toBe(1);
    expect(await exists(absPath)).toBe(true);
  });

  it('keeps committed images even when they are not referenced by the current draft', async () => {
    const cached = await imageCacheStore.writeBuffer({
      sessionId: 'session-a',
      buffer: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
      lifecycle: 'committed',
    });
    const { absPath } = imageCacheStore.resolveSafe(cached.url);

    const result = await imageCacheStore.sweepDraftImages({
      createdBeforeMs: Number.MAX_SAFE_INTEGER,
    });

    expect(result.removed).toBe(0);
    expect(await exists(absPath)).toBe(true);
  });

  it('removeFile removes the image and its lifecycle metadata', async () => {
    const cached = await imageCacheStore.writeBuffer({
      sessionId: 'session-a',
      buffer: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
      lifecycle: 'committed',
    });
    const { absPath } = imageCacheStore.resolveSafe(cached.url);

    await imageCacheStore.removeFile(cached.url);

    expect(await exists(absPath)).toBe(false);
    expect(await exists(`${absPath}.xdt-meta.json`)).toBe(false);
  });

  it('markFilesCommitted turns a draft image into a sweep-safe history image', async () => {
    const cached = await imageCacheStore.writeBuffer({
      sessionId: 'session-a',
      buffer: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
      lifecycle: 'draft',
    });
    const { absPath } = imageCacheStore.resolveSafe(cached.url);

    const marked = await imageCacheStore.markFilesCommitted([cached.url]);
    expect(marked).toEqual({ marked: 1, skipped: 0, errors: 0 });

    const result = await imageCacheStore.sweepDraftImages({
      createdBeforeMs: Number.MAX_SAFE_INTEGER,
    });

    expect(result.removed).toBe(0);
    expect(await exists(absPath)).toBe(true);
  });

  it('ignores reserved xdt-image hosts when collecting session cache references', () => {
    const urls = imageCacheStore.collectSessionImageUrls({
      text: '![a](xdt-image://session-a/a.png) ![b](xdt-image://feishu-media-images/b.png)',
      nested: [{ url: 'xdt-image://session-b/c.webp' }],
    });

    expect(urls).toEqual(['xdt-image://session-a/a.png', 'xdt-image://session-b/c.webp']);
  });

  it('keeps the legacy session cleanup IPC out of the cindy-media ledger', async () => {
    const source = await fs.readFile(new URL('../bootstrap-electron.ts', import.meta.url), 'utf8');
    const start = source.indexOf("'image-cache:cleanup-session'");
    const end = source.indexOf('// F7: cleanup a list of files', start);
    const handler = source.slice(start, end);

    expect(handler).toContain('imageCacheStore.removeSession(sessionId)');
    expect(handler).not.toContain('removeSessionMediaRefs');
  });
});

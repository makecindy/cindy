import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashLocalFile, PluginPublisherHashCancelledError } from '../hashFile.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function tempFile(bytes: Buffer): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-publisher-hash-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'pkg.cindy');
  await fs.writeFile(filePath, bytes);
  return filePath;
}

describe('hashLocalFile', () => {
  it('hashes in chunks and reports progress', async () => {
    const payload = Buffer.alloc(64 * 1024, 7);
    const filePath = await tempFile(payload);
    const handle = await fs.open(filePath, 'r');
    const seen: number[] = [];
    try {
      const result = await hashLocalFile(handle, {
        chunkBytes: 16 * 1024,
        onProgress: ({ bytesRead }) => seen.push(bytesRead),
      });
      expect(result.sizeBytes).toBe(payload.length);
      expect(result.sha256).toBe(createHash('sha256').update(payload).digest('hex'));
      expect(seen[0]).toBe(0);
      expect(seen.at(-1)).toBe(payload.length);
      expect(seen.length).toBeGreaterThan(2);
    } finally {
      await handle.close();
    }
  });

  it('can be cancelled between chunks', async () => {
    const payload = Buffer.alloc(48 * 1024, 3);
    const filePath = await tempFile(payload);
    const handle = await fs.open(filePath, 'r');
    const controller = new AbortController();
    try {
      await expect(
        hashLocalFile(handle, {
          chunkBytes: 8 * 1024,
          signal: controller.signal,
          onProgress: ({ bytesRead }) => {
            if (bytesRead > 0) controller.abort();
          },
        }),
      ).rejects.toBeInstanceOf(PluginPublisherHashCancelledError);
    } finally {
      await handle.close();
    }
  });
});

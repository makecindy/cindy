import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PluginDownloadCache } from '../downloadCache';

it('shares quota across plugins, protects reserved/pinned files, and revokes evicted receipts', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'download-quota-test-')));
  const cache = new PluginDownloadCache(148000);
  const a = path.join(root, 'p', 'a'.repeat(64)),
    b = path.join(root, 'q', 'b'.repeat(64)),
    c = path.join(root, 'r', 'c'.repeat(64));
  try {
    await cache.reserve(root, a, 10000);
    await expect(cache.reserve(root, b, 10000)).rejects.toThrow('full');
    await fs.writeFile(path.join(a, 'artifact'), Buffer.alloc(10000));
    const token = await cache.issue(a, 'owner', 'p', 'approved');
    cache.release(a);
    const lease = await cache.acquire(token, 'owner', 'p', 'approved');
    await cache.reserve(root, b, 4000);
    await expect(cache.reserve(root, c, 4000)).rejects.toThrow('full');
    expect(await fs.readFile(lease.path)).toHaveLength(10000);
    cache.revokeAll();
    await expect(cache.acquire(token, 'owner', 'p', 'approved')).rejects.toThrow(
      'Invalid download receipt',
    );
    lease.release();
    const retainedToken = await cache.issue(a, 'owner', 'p', 'approved');
    cache.release(b);
    await fs.writeFile(path.join(b, 'artifact'), Buffer.alloc(80000));
    // Filesystem timestamp resolution differs across CI hosts. Establish LRU
    // order explicitly instead of assuming these writes occur in distinct ticks.
    const newer = new Date(Date.now() + 60000);
    await fs.utimes(path.join(b, 'artifact'), newer, newer);
    await cache.reserve(root, c, 4000);
    await expect(fs.stat(a)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(cache.acquire(retainedToken, 'owner', 'p', 'approved')).rejects.toThrow();
    await expect(cache.acquire(token, 'owner', 'p', 'approved')).rejects.toThrow();
    cache.release(c);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

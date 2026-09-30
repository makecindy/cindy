import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupExpiredIncomingShares } from '@/session/incomingShareCleanup';

const fs = vi.hoisted(() => {
  class Directory {
    uri: string;
    constructor(public name: string, public created?: number) {
      this.uri = `file:///app-group/${name}`;
    }
    info() { return { creationTime: this.created }; }
  }
  return { Directory, roots: {} as Record<string, { list: () => unknown[] }>, delete: vi.fn() };
});
vi.mock('expo-file-system', () => ({ Directory: fs.Directory, Paths: { appleSharedContainers: fs.roots } }));
vi.mock('expo-file-system/legacy', () => ({ deleteAsync: fs.delete }));

const week = 7 * 24 * 60 * 60 * 1000;
const now = 10 * week;
const name = 'cindy-share-12345678-1234-1234-1234-123456789abc';

describe('incoming share copy expiry', () => {
  beforeEach(() => {
    for (const key of Object.keys(fs.roots)) delete fs.roots[key];
    fs.delete.mockReset().mockResolvedValue(undefined);
  });

  it('reclaims orphan copies at seven days without needing a native payload or mailbox', async () => {
    const expired = new fs.Directory(name, now - week);
    fs.roots.sharing = { list: () => [expired] };
    await cleanupExpiredIncomingShares(now);
    expect(fs.delete).toHaveBeenCalledExactlyOnceWith(expired.uri, { idempotent: true });
  });

  it('preserves fresh directories even when their imported files are old', async () => {
    fs.roots.sharing = { list: () => [new fs.Directory(name, now - week + 1), new fs.Directory(name, now)] };
    await cleanupExpiredIncomingShares(now);
    expect(fs.delete).not.toHaveBeenCalled();
  });

  it('never deletes unrelated directories, plain files, or entries of unknown or future age', async () => {
    fs.roots.sharing = { list: () => [
      new fs.Directory('Library', 1), new fs.Directory('cindy-share-not-a-uuid', 1),
      new fs.Directory(`prefix-${name}`, 1), new fs.Directory(`${name}/nested`, 1),
      { name, uri: 'file:///original.pdf', info: () => ({ creationTime: 1 }) },
      ...[undefined, NaN, Infinity, 0, now + week].map((created) => new fs.Directory(name, created)),
    ] };
    await cleanupExpiredIncomingShares(now);
    expect(fs.delete).not.toHaveBeenCalled();
  });

  it('continues past inaccessible roots and failed deletes and retries on the next foreground', async () => {
    fs.roots.unavailable = { list: () => { throw new Error('unavailable'); } };
    const expired = new fs.Directory(name, 1);
    fs.roots.sharing = { list: () => [expired, new fs.Directory(name.toUpperCase(), 1)] };
    fs.delete.mockRejectedValueOnce(new Error('busy'));
    await expect(cleanupExpiredIncomingShares(now)).resolves.toBeUndefined();
    expect(fs.delete).toHaveBeenCalledTimes(2);
    await cleanupExpiredIncomingShares(now);
    expect(fs.delete).toHaveBeenCalledTimes(4);
  });
});

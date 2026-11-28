// Unit: the cloud storage usage channel. Owner-gated and read-only; one failed measurement
// leaves only its own figure unknown, and only byte counts cross (never paths or names).
import { describe, expect, it, vi } from 'vitest';
import { cloudStorageUsageSchema } from '../../../shared/cloudStorageUsage';
import { createStorageUsageChannel, type StorageUsageChannelDeps } from '../storageUsageChannel';

const OWNER = { dataOwnerId: 'owner-1', ownerGeneration: 5 };
const stats = {
  success: true,
  blobs: { totalCount: 3, totalBytes: 300, cacheCount: 1, cacheBytes: 10 },
  legacy: { bytes: 0, fileCount: 0 },
  fixedCaches: {
    legacyImages: { bytes: 40, fileCount: 2 },
    chatAttachments: { bytes: 60, fileCount: 3 },
  },
  deadDirs: [
    { name: 'example-dir', exists: true, bytes: 1, fileCount: 1, newestMtimeMs: 1, eligible: true },
  ],
};

function setup(overrides: Partial<StorageUsageChannelDeps> = {}) {
  let isOwner = true;
  const call = vi.fn<StorageUsageChannelDeps['call']>(async (channel) =>
    channel === 'cindy-media:storage-stats' ? stats : { databaseBytes: 1000, path: '/private/db' },
  );
  const channel = createStorageUsageChannel({
    isInstanceOwner: () => isOwner,
    owner: () => OWNER,
    call,
    disk: async () => ({ totalBytes: 10_000, freeBytes: 4_000 }),
    ...overrides,
  });
  return {
    channel,
    call,
    notOwner() {
      isOwner = false;
    },
  };
}

describe('cloud storage usage channel', () => {
  it('reports the local totals and the instance disk, without paths', async () => {
    const f = setup();
    const usage = await f.channel.handle('controller', { op: 'read' });
    expect(cloudStorageUsageSchema.parse(usage)).toEqual({
      version: 1,
      ownerGeneration: 5,
      disk: { totalBytes: 10_000, freeBytes: 4_000 },
      databaseBytes: 1000,
      mediaBytes: 300,
      legacyImagesBytes: 40,
      chatAttachmentsBytes: 60,
    });
    expect(JSON.stringify(usage)).not.toMatch(/private|example-dir/);
    expect(f.call.mock.calls.map(([channel, args]) => [channel, args])).toEqual([
      ['cindy-media:storage-stats', []],
      ['database-size-warning:measure', []],
    ]);
  });
  it('keeps the other figures when one measurement fails', async () => {
    const f = setup({
      disk: async () => {
        throw new Error('statfs failed');
      },
      call: async (channel) => {
        if (channel === 'database-size-warning:measure') throw new Error('busy');
        return { ...stats, success: false };
      },
    });
    expect(await f.channel.handle('controller', { op: 'read' })).toMatchObject({
      disk: null,
      databaseBytes: null,
      mediaBytes: null,
      legacyImagesBytes: null,
      chatAttachmentsBytes: null,
    });
  });
  it('rejects a disk report that cannot be right', async () => {
    const f = setup({ disk: async () => ({ totalBytes: 10, freeBytes: 20 }) });
    expect((await f.channel.handle('controller', { op: 'read' })).disk).toBeNull();
  });
  it('answers only the instance owner and only the read request', async () => {
    const f = setup();
    await expect(f.channel.handle('controller', { op: 'clean' })).rejects.toThrow(
      '[INVALID_PARAMS]',
    );
    f.notOwner();
    await expect(f.channel.handle('controller', { op: 'read' })).rejects.toThrow(
      '[PERMISSION_DENIED]',
    );
    expect(f.call).not.toHaveBeenCalled();
  });
  it('drops the reply when the instance account changes during the read', async () => {
    let owner = OWNER;
    const f = setup({
      owner: () => owner,
      call: async () => {
        owner = { dataOwnerId: 'owner-2', ownerGeneration: 6 };
        return stats;
      },
    });
    await expect(f.channel.handle('controller', { op: 'read' })).rejects.toThrow('[OWNER_CHANGED]');
  });
});

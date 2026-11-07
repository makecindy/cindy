/** Standard tier: exercise the production image reader at cache/network boundaries.
 * Missing coverage: cached reuse, account/turn revocation during awaits, and MIME rejection. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  snapshot: { client: { drizzle: {} }, userId: 'u', clientEpoch: 1 } as object | null,
  get: vi.fn(),
  put: vi.fn(),
  official: vi.fn(),
  read: vi.fn(),
  stat: vi.fn(),
  rollback: vi.fn(),
  blobInfo: vi.fn(),
}));
vi.mock('../../../cindy-media/blobStore', () => ({
  resolveSafe: () => ({ absPath: '/blob/image', hash: 'hash', mimeType: 'image/png' }),
}));
vi.mock('../../../cindy-media/ledger', () => ({ getBlobInfo: f.blobInfo }));
vi.mock('../../../localDb/client/current', () => ({
  getCurrentDbClientSnapshot: () => f.snapshot,
}));
vi.mock('../../../cindy-media/integrationCache', () => ({
  integrationCacheGet: f.get,
  integrationCachePut: f.put,
}));
vi.mock('../../../hook-control/groupImageBridge', () => ({ readOfficialGroupImage: f.official }));
vi.mock('node:fs/promises', () => ({ readFile: f.read, stat: f.stat }));
import { readGroupHistoryImage } from '../groupHistoryImages';
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const lane = { provider: 'telegram-personal:42', chatId: '-1', threadId: '2' };
function args() {
  return {
    lane,
    messageId: '7',
    ref: { fileId: 'file', name: 'photo.png', mimeType: 'image/png' },
    scope: {
      access: 'lane' as const,
      provider: lane.provider,
      lane,
      readImage: vi.fn(async () => png),
    },
    isCurrent: () => true,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  f.snapshot = { client: { drizzle: {} }, userId: 'u', clientEpoch: 1 };
  f.get.mockResolvedValue(null);
  f.put.mockResolvedValue({ rollbackRef: f.rollback });
  f.stat.mockResolvedValue({ size: png.length });
  f.read.mockResolvedValue(png);
});
describe('history image bytes and account cache', () => {
  it('requires the current account ledger even when a managed blob exists on disk', async () => {
    const input = args();
    input.ref.fileId = 'cindy-media://blobs/hash.png';
    f.blobInfo.mockResolvedValue(null);
    expect(await readGroupHistoryImage(input)).toBeNull();
    expect(f.read).not.toHaveBeenCalled();
    f.blobInfo.mockResolvedValue({ hash: 'hash' });
    expect(await readGroupHistoryImage(input)).toEqual({
      data: png.toString('base64'),
      mimeType: 'image/png',
    });
    expect(input.scope.readImage).not.toHaveBeenCalled();
  });
  it('reports cleaned managed media as unavailable', async () => {
    const input = args();
    input.ref.fileId = 'cindy-media://blobs/hash.png';
    f.blobInfo.mockResolvedValue({ hash: 'hash' });
    f.stat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    expect(await readGroupHistoryImage(input)).toBeNull();
  });
  it('reuses a cached image without any network call', async () => {
    f.get.mockResolvedValue({ absPath: '/cache/image', mimeType: 'image/png' });
    const input = args();
    expect(await readGroupHistoryImage(input)).toEqual({
      data: png.toString('base64'),
      mimeType: 'image/png',
    });
    expect(input.scope.readImage).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
  });
  // #7756 review: eviction between cache lookup and stat/read must be a miss, not
  // IMAGE_READ_FAILED. Existing reuse coverage has no disappearing file. Tier: unit.
  it.each(['stat', 'read'] as const)('redownloads when eviction races cached %s', async (stage) => {
    f.get.mockResolvedValue({ absPath: '/cache/image', mimeType: 'image/png' });
    f[stage].mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const input = args();
    expect(await readGroupHistoryImage(input)).toEqual({
      data: png.toString('base64'),
      mimeType: 'image/png',
    });
    expect(input.scope.readImage).toHaveBeenCalledWith('file');
  });
  it('downloads a personal image and stores it in the reclaimable shared cache', async () => {
    const input = args();
    await readGroupHistoryImage(input);
    expect(input.scope.readImage).toHaveBeenCalledWith('file');
    expect(f.put).toHaveBeenCalledWith(
      expect.objectContaining({ buffer: png, isCache: true, mimeType: 'image/png' }),
      expect.anything(),
    );
  });
  it('rejects mislabeled non-image bytes before caching', async () => {
    const input = args();
    input.scope.readImage.mockResolvedValue(Buffer.from('%PDF-1.7'));
    await expect(readGroupHistoryImage(input)).rejects.toThrow();
    expect(f.put).not.toHaveBeenCalled();
  });
  it('discards downloaded bytes when the account database changes mid-request', async () => {
    const input = args();
    input.scope.readImage.mockImplementation(async () => {
      f.snapshot = null;
      return png;
    });
    await expect(readGroupHistoryImage(input)).rejects.toThrow('HISTORY_SCOPE_EXPIRED');
    expect(f.put).not.toHaveBeenCalled();
  });
  it('rolls back the cache reference when the turn ends during storage', async () => {
    let active = true;
    f.put.mockImplementation(async () => {
      active = false;
      return { rollbackRef: f.rollback };
    });
    expect(await readGroupHistoryImage({ ...args(), isCurrent: () => active })).toBeNull();
    expect(f.rollback).toHaveBeenCalledOnce();
  });
  it('routes official proofs through the authenticated bridge, not a personal bot', async () => {
    const input = args();
    f.official.mockResolvedValue(png);
    await readGroupHistoryImage({
      ...input,
      lane: { ...lane, provider: 'telegram:101' },
      ref: { ...input.ref, downloadToken: 'proof' },
    });
    expect(f.official).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'telegram:101' }),
      'proof',
    );
    expect(input.scope.readImage).not.toHaveBeenCalled();
  });
});

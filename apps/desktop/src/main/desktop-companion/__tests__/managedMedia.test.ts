import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  owner: 'owner-a', pending: false,
  db: { userId: 'owner-a', client: { drizzle: {} } },
  prepare: vi.fn(), ingest: vi.fn(), remove: vi.fn(),
}));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ dataOwnerId: state.owner }),
  isAppSessionBoundaryPending: () => state.pending,
  ownerScopedUserDataPath: () => '/unused-owner-root',
}));
vi.mock('../../localDb/client/current.js', () => ({
  getCurrentDbClientSnapshot: () => state.db,
}));
vi.mock('../../cindy-media/ingest.js', () => ({ ingestMedia: state.ingest }));
vi.mock('../../cindy-media/ledger.js', () => ({ removeRefs: state.remove }));
vi.mock('../../cindy-media/refCompensationJournal.js', () => ({
  captureMediaRefCompensationScope: () => {
    const owner = state.owner;
    return {
      assertStillValid: () => { if (state.owner !== owner) throw new Error('ACCOUNT_CHANGED'); },
    };
  },
}));
vi.mock('../../cindy-media/blobStore.js', () => ({
  parseBlobUrl: (url: string) => /^cindy-media:\/\/blobs\/[a-f0-9]{64}\.webp$/.test(url)
    ? { hash: url.split('/').pop()!.slice(0, 64) } : null,
  resolveSafe: () => ({ absPath: '/unused-blob-path' }),
}));
vi.mock('../../custom-wallpaper.js', () => ({ prepareWallpaperImage: state.prepare }));
import { releaseCompanionMedia, storeCompanionMedia } from '../managedMedia.js';

beforeEach(() => {
  vi.clearAllMocks();
  state.owner = 'owner-a';
  state.pending = false;
  state.prepare.mockResolvedValue(Buffer.from('sanitized-image'));
  state.ingest.mockResolvedValue({ url: 'cindy-media://blobs/' + 'a'.repeat(64) + '.webp' });
});

describe('account-private wallpaper media', () => {
  it('uses the owner ledger and a guarded reference instead of client-wide wallpaper storage', async () => {
    const guard = vi.fn();
    const url = await storeCompanionMedia({ buffer: Buffer.from('image'), mimeType: 'image/png' }, 'still', guard);
    expect(url).toContain('cindy-media://blobs/');
    expect(state.ingest.mock.calls[0][0]).toMatchObject({
      mimeType: 'image/webp', isCache: false,
      refs: [{ refKind: 'integration-cache', originId: 'desktop-companion' }],
    });
    expect(state.ingest.mock.calls[0][1]).toBe(state.db.client.drizzle);
    expect(guard).toHaveBeenCalled();
  });

  it('rejects an account switch while image validation is pending', async () => {
    state.prepare.mockImplementation(async () => {
      state.owner = 'owner-b';
      return Buffer.from('sanitized');
    });
    await expect(storeCompanionMedia({ buffer: Buffer.from('image'), mimeType: 'image/png' }, 'still', () => {}))
      .rejects.toThrow('ACCOUNT_CHANGED');
    expect(state.ingest).not.toHaveBeenCalled();
  });

  it('releases only the wallpaper reference', async () => {
    await releaseCompanionMedia('cindy-media://blobs/' + 'a'.repeat(64) + '.webp');
    expect(state.remove).toHaveBeenCalledWith({
      refKind: 'integration-cache', refId: 'desktop-companion:' + 'a'.repeat(64),
    }, state.db.client.drizzle);
  });
});

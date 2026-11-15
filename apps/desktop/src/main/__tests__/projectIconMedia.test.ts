// Real image decoder; injected media persistence verifies the owner guard and thumbnail contract.
import sharp from 'sharp';
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  ingest: vi.fn(),
  read: vi.fn(),
  remove: vi.fn(),
  keep: vi.fn(),
  db: {},
  scope: {},
}));
vi.mock('../cindy-media/blobStore.js', () => ({
  createBlobStore: () => ({ readFile: h.read, parseBlobUrl: () => ({ hash: 'a'.repeat(64) }) }),
}));
vi.mock('../cindy-media/ingestCore.js', () => ({
  createMediaIngest: () => ({ ingestMedia: h.ingest }),
}));
vi.mock('../cindy-media/refCompensationJournal.js', () => ({
  createMediaRefCompensationJournal: () => ({
    captureMediaRefCompensationScope: () => h.scope,
    withMediaRefCompensation: vi.fn(),
  }),
}));
vi.mock('../cindy-media/ledger.js', () => ({ removeRefs: h.remove, removeRefsExceptHash: h.keep }));
vi.mock('../userDataPath.js', () => ({ getUserDataDir: () => '/unused' }));
vi.mock('../appSessionState.js', () => ({
  activeOwnerScopeKey: vi.fn(),
  getActiveAppSession: vi.fn(),
  isAppSessionBoundaryPending: vi.fn(),
}));
vi.mock('../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: h.db }) }));
import {
  importProjectIcon,
  releasePreviousProjectImages,
  readProjectIconBytes,
} from '../projectIconMedia';
beforeEach(() => {
  vi.resetAllMocks();
  h.ingest.mockResolvedValue({ url: `cindy-media://blobs/${'a'.repeat(64)}.png` });
});
it('normalizes a real image into a square PNG before guarded owner-scoped ingestion', async () => {
  const input = await sharp({
    create: { width: 800, height: 400, channels: 3, background: '#336699' },
  })
    .jpeg()
    .toBuffer();
  const guard = vi.fn();
  const url = await importProjectIcon(
    `data:image/jpeg;base64,${input.toString('base64')}`,
    'local:/repo',
    guard,
  );
  const [params, db] = h.ingest.mock.calls[0];
  expect(await sharp(params.buffer).metadata()).toMatchObject({
    width: 256,
    height: 256,
    format: 'png',
  });
  expect(params).toMatchObject({
    isCache: false,
    mimeType: 'image/png',
    assertStillValid: guard,
    refCompensationScope: h.scope,
    refs: [{ refKind: 'integration-cache', refId: 'project-icon:local:/repo' }],
  });
  expect(db).toBe(h.db);
  expect(guard).toHaveBeenCalled();
  expect(url).toMatch(/^cindy-media:/);
});
it.each(['data:image/png;base64,AAAA', 'data:image/svg+xml;base64,AAAA'])(
  'rejects malformed or active image content before ingestion',
  async (input) => {
    await expect(importProjectIcon(input, 'local:/repo', () => {})).rejects.toThrow(
      'INVALID_PARAMS',
    );
    expect(h.ingest).not.toHaveBeenCalled();
  },
);
it('does not ingest after an owner switch during decoding', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();
  await expect(
    importProjectIcon(`data:image/png;base64,${png.toString('base64')}`, 'local:/repo', () => {
      throw new Error('Account changed');
    }),
  ).rejects.toThrow('Account changed');
  expect(h.ingest).not.toHaveBeenCalled();
});
it('removes only superseded references and bounds the image read response', async () => {
  const uri = `cindy-media://blobs/${'a'.repeat(64)}.png`;
  await releasePreviousProjectImages('local:/repo', uri, () => {});
  expect(h.keep).toHaveBeenCalledWith(
    { refKind: 'integration-cache', refId: 'project-icon:local:/repo', keepHash: 'a'.repeat(64) },
    h.db,
  );
  h.read.mockResolvedValue({ buffer: Buffer.alloc(300001) });
  await expect(readProjectIconBytes(uri)).rejects.toThrow('INVALID_PARAMS');
});

// Review #10636: Windows case aliases must own the same media reference on import and reset.
// Existing coverage only used POSIX paths. Unit tier; two spellings are the minimal regression.
it('uses the same Windows media owner for import, replacement and automatic images', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  try {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#336699' } })
      .png()
      .toBuffer();
    for (const prefix of ['', 'auto:']) {
      await importProjectIcon(
        `data:image/png;base64,${png.toString('base64')}`,
        `${prefix}local:C:/Repo`,
        () => {},
      );
      await releasePreviousProjectImages(`${prefix}local:c:/repo`, null, () => {});
      expect(h.ingest.mock.lastCall![0].refs[0]).toEqual(h.remove.mock.lastCall![0]);
    }
  } finally {
    vi.unstubAllGlobals();
  }
});

import Database from 'better-sqlite3';
// Unit: host cache ownership and manual/automatic separation are new boundaries.
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  owner: { dataOwnerId: 'a', ownerGeneration: 1 },
  entries: {} as Record<string, any>,
  discover: vi.fn(),
  query: vi.fn(),
  ingest: vi.fn(),
  bytes: vi.fn(),
  clean: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock('../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.owner.dataOwnerId,
  ownerScopedUserDataPath: (p: string) => '/mock/' + p,
  getActiveDataOwnerPushStamp: () => ({ ...h.owner }),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../maker-host/override-settings-file.js', () => ({
  createOverrideSettingsFile: () => ({
    invalidateIfChanged: () => {},
    read: () => ({ entries: h.entries }),
    updateAtomic: async (fn: any) => {
      h.entries = fn({ value: { entries: h.entries } }).entries;
    },
  }),
}));
vi.mock('../localDb/client/current.js', () => ({ getDbClient: () => ({ query: h.query }) }));
vi.mock('../projectIconMedia.js', () => ({
  importProjectIcon: h.ingest,
  readProjectIconBytes: h.bytes,
  releasePreviousProjectImages: h.clean,
}));
vi.mock('../maker-host/outbound-fetch.js', () => ({
  createOutboundTransport: () => ({ guardedOutboundFetch: h.fetch }),
}));
vi.mock('../device-link/crossProcessLock.js', () => ({
  withCrossProcessLock: async (_p: any, _o: any, fn: any) => fn({ held: true }),
}));
vi.mock('../projectIconDiscovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../projectIconDiscovery.js')>()),
  discoverProjectIcon: h.discover,
}));
import { resolveAutomaticProjectIcon } from '../projectAutomaticIcon';
const artwork = {
  image: 'data:image/png;base64,YQ==',
  source: 'icon.png',
  kind: 'local',
  candidate: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  h.owner = { dataOwnerId: 'a', ownerGeneration: 1 };
  h.entries = {};
  h.query.mockResolvedValue([{ workingDir: '/repo', projectDir: null, remoteHostId: null }]);
  h.discover.mockResolvedValue(artwork);
  h.ingest.mockResolvedValue(`cindy-media://blobs/${'a'.repeat(64)}.png`);
  h.bytes.mockResolvedValue(artwork.image);
  h.clean.mockResolvedValue(undefined);
});
it('deduplicates callers, persists thumbnails separately from overrides and reuses cache', async () => {
  const [a, b] = await Promise.all([
    resolveAutomaticProjectIcon({ projectKey: 'local:/repo' }),
    resolveAutomaticProjectIcon({ projectKey: 'local:/repo' }),
  ]);
  expect(a).toEqual(artwork);
  expect(b).toEqual(a);
  expect(h.discover).toHaveBeenCalledTimes(1);
  expect(h.ingest.mock.calls[0]![1]).toBe('auto:local:/repo');
  await resolveAutomaticProjectIcon({ projectKey: 'local:/repo' });
  expect(h.discover).toHaveBeenCalledTimes(1);
});
it('does not probe unknown project paths and negatively caches missing icons', async () => {
  expect(await resolveAutomaticProjectIcon({ projectKey: 'local:/private' })).toMatchObject({
    image: null,
  });
  expect(h.discover).not.toHaveBeenCalled();
  h.discover.mockResolvedValue(null);
  await resolveAutomaticProjectIcon({ projectKey: 'local:/repo' });
  await resolveAutomaticProjectIcon({ projectKey: 'local:/repo' });
  expect(h.discover).toHaveBeenCalledTimes(1);
});
it('rejects an account change during discovery before publishing media or cache', async () => {
  h.discover.mockImplementation(async () => {
    h.owner = { dataOwnerId: 'b', ownerGeneration: 2 };
    return artwork;
  });
  await expect(resolveAutomaticProjectIcon({ projectKey: 'local:/repo' })).rejects.toThrow(
    'PRECONDITION_FAILED',
  );
  expect(h.ingest).not.toHaveBeenCalled();
  expect(h.entries).toEqual({});
});
it('keeps last successful artwork after offline refresh', async () => {
  await resolveAutomaticProjectIcon({ projectKey: 'local:/repo' });
  h.entries['local:/repo'].checkedAt = 0;
  h.discover.mockRejectedValue(new Error('offline'));
  expect(await resolveAutomaticProjectIcon({ projectKey: 'local:/repo' })).toEqual(artwork);
});
it('refuses insecure redirects and bounds response bytes through the guarded transport', async () => {
  const release = vi.fn(async () => {});
  h.fetch.mockResolvedValue({
    response: new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/private' },
    }),
    release,
  });
  h.discover.mockImplementation(async (io: any) => {
    expect(await io.fetch('https://site.example')).toBeNull();
    return null;
  });
  await resolveAutomaticProjectIcon({ projectKey: 'local:/repo' });
  expect(h.fetch).toHaveBeenCalledTimes(1);
  expect(h.fetch.mock.calls[0]![1]).toMatchObject({ redirect: 'manual', credentials: 'omit' });
  expect(release).toHaveBeenCalled();
  h.entries = {};
  h.fetch.mockResolvedValue({ response: new Response(new Uint8Array(1024 * 1024 + 1)), release });
  h.discover.mockImplementation(async (io: any) => {
    await expect(io.fetch('https://site.example')).rejects.toThrow('too large');
    return null;
  });
  await resolveAutomaticProjectIcon({ projectKey: 'local:/repo' });
});

// Review #10636: validate SQL filtering with real SQLite; the original fake returned all history.
// Unit tier: in-memory tables, no migration or external IO. Minimal history includes membership,
// a grouped worktree, an unrelated nested directory and a recent directory with SQL wildcards.
it('filters history by project while preserving worktrees, explicit membership and literal paths', async () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE sessions (working_dir TEXT, project_dir TEXT, remote_host_id TEXT);
      CREATE TABLE recent_workdirs (path TEXT);
      INSERT INTO sessions VALUES ('/repo/.cindy-worktrees/task', NULL, NULL),
        ('/elsewhere', '/member', NULL), ('/repo/nested', NULL, NULL);
      INSERT INTO recent_workdirs VALUES ('/with_%/');`);
    h.query.mockImplementation(async (sql: string, params: any[]) =>
      db.prepare(sql).all(...params),
    );
    for (const directory of ['/repo', '/member', '/with_%']) {
      h.entries = {};
      expect(await resolveAutomaticProjectIcon({ projectKey: `local:${directory}` })).toEqual(
        artwork,
      );
    }
    h.discover.mockClear();
    expect(await resolveAutomaticProjectIcon({ projectKey: 'local:/with_X' })).toMatchObject({
      image: null,
    });
    expect(h.discover).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});

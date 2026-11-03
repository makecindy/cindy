import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LedgerDb } from '../../cindy-media/ledger';

const state = vi.hoisted(() => ({ root: '', db: undefined as LedgerDb | undefined }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../../appSessionState', () => ({
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: 'owner' }),
}));
vi.mock('../../localDb/client/current', () => ({
  getDbClient: () => ({ drizzle: state.db }),
}));
vi.mock('../broadcast-tap', () => ({
  captureDataOwnerBroadcastScope: () => ({}),
  isDataOwnerBroadcastScopeCurrent: () => true,
}));
import * as schema from '../../localDb/schema';
import { addRef, getStorageStats, pinBlob, removeRefs } from '../../cindy-media/ledger';
import { integrationCacheGet, integrationCachePut } from '../../cindy-media/integrationCache';
import { CACHE_LIMIT_BYTES } from '../../cindy-media/recycler';
import { remoteFileVersionCache } from '../remoteFileVersionCache';

const { default: migration0071 } =
  (await import('../../../../drizzle/scripts/0071_bright_ultron')) as {
    default: { run: (db: Database.Database) => void };
  };

let raw: Database.Database;
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const metadata = { version: 'a'.repeat(64), size: png.length, mimeType: 'image/png' };

beforeEach(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-media-budget-'));
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  const migration = await fs.readFile(
    path.resolve(__dirname, '../../../../drizzle/0070_woozy_harpoon.sql'),
    'utf8',
  );
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) raw.exec(statement);
  }
  migration0071.run(raw);
  state.db = drizzle(raw, { schema }) as unknown as LedgerDb;
});
afterEach(async () => {
  raw.close();
  await fs.rm(state.root, { recursive: true, force: true });
});

async function seedOtherCache(bytes: number, integration = 'other') {
  const other = await integrationCachePut(
    {
      cacheKey: `${integration}:full`,
      integration,
      buffer: Buffer.from('other'),
      mimeType: 'image/png',
    },
    state.db,
  );
  // Exercise the real global accounting without allocating a 512 MiB fixture.
  await state
    .db!.update(schema.mediaBlobs)
    .set({ bytes })
    .where(eq(schema.mediaBlobs.hash, other.hash))
    .run();
  return other;
}

it.each([false, true])('excludes long-lived remote images from the automatic budget (shared=%s)', async (shared) => {
  const retained = await seedOtherCache(CACHE_LIMIT_BYTES * 2, 'remote-media');
  if (shared) await addRef({
    hash: retained.hash, refKind: 'integration-cache', refId: 'other:shared',
    originId: 'other', originKind: 'integration',
  }, state.db);
  const cache = remoteFileVersionCache('device', 'mutable-path', metadata)!;
  await cache.put(png);
  const cached = await cache.get();
  expect(cached).not.toBeNull();
  expect(await fs.readFile(cached!)).toEqual(png);
  expect((await getStorageStats(state.db)).cacheBytes).toBe(CACHE_LIMIT_BYTES * 2 + png.length);
  expect(await fs.readFile(retained.absPath)).toEqual(Buffer.from('other'));
});

it.each([
  { otherBytes: CACHE_LIMIT_BYTES - png.length, retained: true },
  { otherBytes: CACHE_LIMIT_BYTES, retained: false },
  { otherBytes: CACHE_LIMIT_BYTES + png.length, retained: false },
])(
  'first remote write respects global usage $otherBytes; retained=$retained',
  async ({ otherBytes, retained }) => {
    const other = await seedOtherCache(otherBytes);
    const consumer = path.join(state.root, 'consumer.png');
    await fs.writeFile(consumer, png);
    const cache = remoteFileVersionCache('device', 'url', metadata)!;
    await cache.put(consumer);
    const cached = await cache.get();
    expect(Boolean(cached)).toBe(retained);
    expect(await fs.readFile(consumer)).toEqual(png);
    if (cached) {
      expect(cached).not.toBe(consumer);
      expect(await fs.readFile(cached)).toEqual(png);
    }
    expect((await getStorageStats(state.db)).cacheBytes).toBe(
      otherBytes + (retained ? png.length : 0),
    );
    expect((await integrationCacheGet('other:full', state.db))?.absPath).toBe(other.absPath);
    expect(await fs.readFile(other.absPath)).toEqual(Buffer.from('other'));
  },
);

it.each(['shared', 'pinned'])('pressure preserves a newly reused %s blob', async (protection) => {
  await seedOtherCache(CACHE_LIMIT_BYTES);
  const existing = await integrationCachePut(
    {
      cacheKey: 'other:same',
      integration: 'other',
      buffer: png,
      mimeType: 'image/png',
    },
    state.db,
  );
  if (protection === 'pinned') {
    await pinBlob(existing.hash, state.db);
    await removeRefs({ refKind: 'integration-cache', refId: 'other:same' }, state.db);
  }
  const consumer = path.join(state.root, 'consumer.png');
  await fs.writeFile(consumer, png);
  const cache = remoteFileVersionCache('device', 'url', metadata)!;
  await cache.put(consumer);
  expect(await cache.get()).toBe(existing.absPath);
  expect(await fs.readFile(existing.absPath)).toEqual(png);
  expect(await fs.readFile(consumer)).toEqual(png);
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import originalFs from 'original-fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  adoptLocalProfileDatabase,
  createProductionLocalProfileDataMigrationDeps,
  LOCAL_PROFILE_MIGRATION_LOCK_DB_SUFFIX,
  LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX,
  LOCAL_PROFILE_MIGRATION_TMP_SUFFIX,
  reserveLocalProfileDataOwner,
  reserveLocalProfileDataOwnerDetailed,
  releaseLocalProfileDataOwner,
  type LocalProfileDataMigrationDeps,
} from '../localProfileDataMigration.js';
import { createBetterSqliteDatabase } from '../localDb/betterSqliteFactory.js';

const roots: string[] = [];

async function fixture(): Promise<{ root: string; deps: LocalProfileDataMigrationDeps }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-local-profile-migration-'));
  roots.push(root);
  return {
    root,
    deps: {
      userDataDir: root,
      dbFilePrefix: 'cindy',
      fs: {
        pathExists: async (file) =>
          fs.access(file).then(
            () => true,
            () => false,
          ),
        readFile: (file) => fs.readFile(file, 'utf8'),
        backupDatabase: (source, target) => fs.copyFile(source, target),
        link: (source, target) => fs.link(source, target),
        removeIfExists: (file) => fs.rm(file, { force: true }),
      },
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('adoptLocalProfileDatabase', () => {
  it('reserves the first cloud owner synchronously and rejects a different owner', async () => {
    const { root } = await fixture();

    expect(reserveLocalProfileDataOwner('owner-a', root, 'cindy')).toBe('claimed');
    expect(reserveLocalProfileDataOwner('owner-a', root, 'cindy')).toBe('already-owned');
    expect(reserveLocalProfileDataOwner('owner-b', root, 'cindy')).toBe('owned-by-other');
  });

  it.each(['', '{'])('recovers an interrupted owner marker containing %j', async (contents) => {
    const { root } = await fixture();
    const marker = path.join(root, `cindy-local-v1${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`);
    await fs.writeFile(marker, contents);

    expect(reserveLocalProfileDataOwner('owner-a', root, 'cindy')).toBe('claimed');
    expect(reserveLocalProfileDataOwner('owner-b', root, 'cindy')).toBe('owned-by-other');
  });

  it('does not reclaim an invalid marker while another process holds the migration lock', async () => {
    const { root } = await fixture();
    const marker = path.join(root, `cindy-local-v1${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`);
    const lockDb = createBetterSqliteDatabase(`${marker}${LOCAL_PROFILE_MIGRATION_LOCK_DB_SUFFIX}`);
    await fs.writeFile(marker, '{');
    lockDb.exec('BEGIN IMMEDIATE');
    try {
      expect(reserveLocalProfileDataOwner('owner-a', root, 'cindy')).toBe('failed');
      await expect(fs.readFile(marker, 'utf8')).resolves.toBe('{');
    } finally {
      lockDb.exec('ROLLBACK');
      lockDb.close();
    }

    expect(reserveLocalProfileDataOwner('owner-a', root, 'cindy')).toBe('claimed');
    expect(reserveLocalProfileDataOwner('owner-b', root, 'cindy')).toBe('owned-by-other');
  });

  it('releases only the marker created by the matching claim token', async () => {
    const { root } = await fixture();
    const reservation = reserveLocalProfileDataOwnerDetailed('owner-a', root, 'cindy');
    expect(reservation).toMatchObject({ status: 'claimed', claimToken: expect.any(String) });
    expect(reserveLocalProfileDataOwnerDetailed('owner-a', root, 'cindy')).toEqual({
      status: 'already-owned',
    });
    expect(releaseLocalProfileDataOwner('owner-a', root, 'cindy', 'wrong-token')).toBe(false);
    expect(reserveLocalProfileDataOwner('owner-b', root, 'cindy')).toBe('owned-by-other');
    expect(releaseLocalProfileDataOwner('owner-a', root, 'cindy', reservation.claimToken!)).toBe(
      true,
    );
    expect(reserveLocalProfileDataOwner('owner-b', root, 'cindy')).toBe('claimed');
  });

  it('reserves an empty local namespace for the first cloud owner', async () => {
    const { root, deps } = await fixture();

    await expect(adoptLocalProfileDatabase('owner-a', deps)).resolves.toEqual({
      status: 'no-local-db',
    });
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');

    await expect(adoptLocalProfileDatabase('owner-b', deps)).resolves.toEqual({
      status: 'claimed-by-other-owner',
    });
    await expect(fs.access(path.join(root, 'cindy-owner-b.db'))).rejects.toThrow();
    await expect(
      fs.readFile(
        path.join(root, `cindy-local-v1${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`),
        'utf8',
      ),
    ).resolves.toContain('owner-a');
  });

  it('adopts a standalone snapshot without deleting the local source', async () => {
    const { root, deps } = await fixture();
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');
    await fs.writeFile(path.join(root, 'cindy-local-v1.db-wal'), 'local-wal');
    await fs.writeFile(path.join(root, 'cindy-local-v1.db-shm'), 'local-shm');

    await expect(adoptLocalProfileDatabase('owner-a', deps)).resolves.toMatchObject({
      status: 'adopted',
    });
    await expect(fs.readFile(path.join(root, 'cindy-owner-a.db'), 'utf8')).resolves.toBe(
      'local-db',
    );
    await expect(fs.access(path.join(root, 'cindy-owner-a.db-wal'))).rejects.toThrow();
    await expect(fs.access(path.join(root, 'cindy-owner-a.db-shm'))).rejects.toThrow();
    await expect(fs.readFile(path.join(root, 'cindy-local-v1.db'), 'utf8')).resolves.toBe(
      'local-db',
    );
    await expect(
      fs.access(
        path.join(
          root,
          `cindy-local-v1${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}${LOCAL_PROFILE_MIGRATION_LOCK_DB_SUFFIX}`,
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it('captures committed WAL data through SQLite online backup while the source stays open', async () => {
    const { root } = await fixture();
    const source = path.join(root, 'cindy-local-v1.db');
    const sourceDb = createBetterSqliteDatabase(source);
    const openSpy = vi.spyOn(originalFs, 'openSync');
    try {
      sourceDb.pragma('journal_mode = WAL');
      sourceDb.exec('CREATE TABLE items (value TEXT NOT NULL)');
      sourceDb.prepare('INSERT INTO items (value) VALUES (?)').run('from-wal');
      await expect(fs.access(`${source}-wal`)).resolves.toBeUndefined();

      const deps = createProductionLocalProfileDataMigrationDeps(root, 'cindy');
      await expect(adoptLocalProfileDatabase('owner-a', deps)).resolves.toMatchObject({
        status: 'adopted',
      });
      if (process.platform !== 'win32') {
        expect(openSpy).toHaveBeenCalledWith(root, 'r');
      }

      const targetDb = createBetterSqliteDatabase(path.join(root, 'cindy-owner-a.db'), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        expect(targetDb.prepare('SELECT value FROM items').pluck().get()).toBe('from-wal');
      } finally {
        targetDb.close();
      }
    } finally {
      sourceDb.close();
    }
  });

  it('never overwrites an existing cloud database', async () => {
    const { root, deps } = await fixture();
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');
    await fs.writeFile(path.join(root, 'cindy-owner-a.db'), 'cloud-db');

    await expect(adoptLocalProfileDatabase('owner-a', deps)).resolves.toEqual({
      status: 'target-exists',
    });
    await expect(fs.readFile(path.join(root, 'cindy-owner-a.db'), 'utf8')).resolves.toBe(
      'cloud-db',
    );
  });

  it('does not publish into an existing cloud database file group', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');
    await fs.writeFile(`${target}-wal`, 'cloud-wal');

    await expect(adoptLocalProfileDatabase('owner-a', deps)).resolves.toEqual({
      status: 'target-exists',
    });
    await expect(fs.access(target)).rejects.toThrow();
    await expect(fs.readFile(`${target}-wal`, 'utf8')).resolves.toBe('cloud-wal');
  });

  it('assigns the retained local source to only the first cloud owner', async () => {
    const { root, deps } = await fixture();
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');

    await expect(adoptLocalProfileDatabase('owner-a', deps)).resolves.toMatchObject({
      status: 'adopted',
    });
    await fs.rm(path.join(root, 'cindy-owner-a.db'));

    await expect(adoptLocalProfileDatabase('owner-b', deps)).resolves.toEqual({
      status: 'claimed-by-other-owner',
    });
    await expect(fs.access(path.join(root, 'cindy-owner-b.db'))).rejects.toThrow();
  });

  it('does not replace a target when same-owner adoption races across processes', async () => {
    const { root, deps } = await fixture();
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');
    await fs.writeFile(path.join(root, 'cindy-local-v1.db-wal'), 'local-wal');
    await fs.writeFile(path.join(root, 'cindy-local-v1.db-shm'), 'local-shm');

    const results = await Promise.all([
      adoptLocalProfileDatabase('owner-a', deps),
      adoptLocalProfileDatabase('owner-a', deps),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['adopted', 'target-exists']);
    await expect(fs.readFile(path.join(root, 'cindy-owner-a.db'), 'utf8')).resolves.toBe(
      'local-db',
    );
    await expect(fs.access(path.join(root, 'cindy-owner-a.db-wal'))).rejects.toThrow();
    await expect(fs.access(path.join(root, 'cindy-owner-a.db-shm'))).rejects.toThrow();
  });

  it('does not publish WAL sidecars when the main target loses the race', async () => {
    const { root, deps } = await fixture();
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');
    await fs.writeFile(path.join(root, 'cindy-local-v1.db-wal'), 'local-wal');
    const racingDeps: LocalProfileDataMigrationDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        link: async (source, target) => {
          if (target === path.join(root, 'cindy-owner-a.db')) {
            await fs.writeFile(target, 'cloud-db');
            const error = Object.assign(new Error('target already exists'), { code: 'EEXIST' });
            throw error;
          }
          return deps.fs.link(source, target);
        },
      },
    };

    await expect(adoptLocalProfileDatabase('owner-a', racingDeps)).resolves.toEqual({
      status: 'target-exists',
    });
    await expect(fs.access(path.join(root, 'cindy-owner-a.db-wal'))).rejects.toThrow();
    await expect(fs.access(path.join(root, 'cindy-owner-a.db-shm'))).rejects.toThrow();
    await expect(fs.readFile(path.join(root, 'cindy-owner-a.db'), 'utf8')).resolves.toBe(
      'cloud-db',
    );
  });

  it('does not publish a database when the online backup fails', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');
    const failingDeps: LocalProfileDataMigrationDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        backupDatabase: async (_source, destination) => {
          await fs.writeFile(destination, 'partial-snapshot');
          throw Object.assign(new Error('online backup failed'), { code: 'EIO' });
        },
      },
    };

    await expect(adoptLocalProfileDatabase('owner-a', failingDeps)).resolves.toMatchObject({
      status: 'failed',
      error: 'online backup failed',
    });
    await expect(fs.access(target)).rejects.toThrow();
    expect(
      (await fs.readdir(root)).filter((entry) =>
        entry.includes(LOCAL_PROFILE_MIGRATION_TMP_SUFFIX),
      ),
    ).toEqual([]);
  });

  it('ignores a stale legacy lease even when its PID has been recycled', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    const legacyLease = `${target}.local-profile-migration-lease`;
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');
    await fs.writeFile(
      legacyLease,
      JSON.stringify({ ownerId: 'owner-a', leaseId: 'stale', pid: process.pid, claimedAt: 1 }),
    );

    await expect(adoptLocalProfileDatabase('owner-a', deps)).resolves.toMatchObject({
      status: 'adopted',
    });
    await expect(fs.access(legacyLease)).resolves.toBeUndefined();
  });

  it('fails promptly when the SQLite migration lock cannot be opened', async () => {
    const { root, deps } = await fixture();
    const marker = path.join(root, `cindy-local-v1${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`);
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');
    await fs.mkdir(`${marker}${LOCAL_PROFILE_MIGRATION_LOCK_DB_SUFFIX}`, { recursive: true });

    await expect(adoptLocalProfileDatabase('owner-a', deps)).resolves.toEqual({
      status: 'failed',
      error: expect.stringContaining('failed to acquire local profile migration lock'),
    });
  });

  it('cleans interrupted temporary files before retrying', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');
    await fs.writeFile(`${target}${LOCAL_PROFILE_MIGRATION_TMP_SUFFIX}`, 'stale');
    await fs.writeFile(`${target}-wal${LOCAL_PROFILE_MIGRATION_TMP_SUFFIX}`, 'stale-wal');

    await expect(adoptLocalProfileDatabase('owner-a', deps)).resolves.toMatchObject({
      status: 'adopted',
    });
    await expect(fs.access(`${target}${LOCAL_PROFILE_MIGRATION_TMP_SUFFIX}`)).rejects.toThrow();
    await expect(fs.access(`${target}-wal${LOCAL_PROFILE_MIGRATION_TMP_SUFFIX}`)).rejects.toThrow();
  });
});

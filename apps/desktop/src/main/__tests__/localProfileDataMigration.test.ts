import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import originalFs from 'original-fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  adoptLocalProfileDatabase,
  createProductionLocalProfileDataMigrationDeps,
  inspectPassiveLocalProfileAdoption,
  LOCAL_PROFILE_MIGRATION_LOCK_DB_SUFFIX,
  LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX,
  LOCAL_PROFILE_MIGRATION_TMP_SUFFIX,
  recoverPendingLocalProfileDataOwner,
  reserveCommittedLocalProfileDataOwner,
  reserveCommittedLocalProfileDataOwnerDetailed,
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
        readDir: (directory) => fs.readdir(directory),
        backupDatabase: (source, target) => fs.copyFile(source, target),
        link: (source, target) => fs.link(source, target),
        copyNoReplace: (source, target) => fs.copyFile(source, target),
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

  it.each(['', '{'])('fails closed for a malformed owner marker containing %j', async (contents) => {
    const { root } = await fixture();
    const marker = path.join(root, `cindy-local-v1${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`);
    await fs.writeFile(marker, contents);

    expect(reserveLocalProfileDataOwner('owner-a', root, 'cindy')).toBe('failed');
    expect(reserveLocalProfileDataOwner('owner-b', root, 'cindy')).toBe('failed');
    await expect(fs.readFile(marker, 'utf8')).resolves.toBe(contents);
  });

  it('falls back to an exclusive marker copy when hard links are unsupported', async () => {
    const { root } = await fixture();
    const linkSpy = vi.spyOn(originalFs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('hard links unsupported'), { code: 'EOPNOTSUPP' });
    });

    expect(reserveLocalProfileDataOwner('owner-a', root, 'cindy')).toBe('claimed');
    expect(reserveLocalProfileDataOwner('owner-b', root, 'cindy')).toBe('owned-by-other');
    expect(linkSpy).toHaveBeenCalled();
    const marker = path.join(root, `cindy-local-v1${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`);
    await expect(fs.readFile(marker, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      ownerId: 'owner-a',
    });
  });

  it('recovers a truncated fallback marker from its pending publication', async () => {
    const { root } = await fixture();
    const marker = path.join(root, `cindy-local-v1${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`);
    const pending = `${marker}.pending`;
    vi.spyOn(originalFs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('hard links unsupported'), { code: 'EOPNOTSUPP' });
    });
    const originalCopyFileSync = originalFs.copyFileSync;
    let interrupted = true;
    vi.spyOn(originalFs, 'copyFileSync').mockImplementation((...args) => {
      if (interrupted && String(args[1]) === pending) {
        interrupted = false;
        originalFs.writeFileSync(pending, '{"ownerId":');
        throw Object.assign(new Error('marker copy interrupted'), { code: 'EIO' });
      }
      return originalCopyFileSync.apply(originalFs, args);
    });

    expect(reserveLocalProfileDataOwner('owner-a', root, 'cindy')).toBe('failed');
    await expect(fs.access(marker)).rejects.toThrow();
    await expect(fs.readFile(pending, 'utf8')).resolves.toBe('{"ownerId":');

    expect(reserveLocalProfileDataOwner('owner-a', root, 'cindy')).toBe('claimed');
    await expect(fs.readFile(marker, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      ownerId: 'owner-a',
    });
    await expect(fs.access(pending)).rejects.toThrow();
  });

  it('restores an atomic-write backup before deciding ownership', async () => {
    const { root } = await fixture();
    const marker = path.join(root, `cindy-local-v1${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`);
    await fs.writeFile(`${marker}.bak`, JSON.stringify({ ownerId: 'owner-a' }));

    expect(reserveLocalProfileDataOwner('owner-b', root, 'cindy')).toBe('owned-by-other');
    await expect(fs.readFile(marker, 'utf8')).resolves.toContain('owner-a');
    await expect(fs.access(`${marker}.bak`)).rejects.toThrow();
  });

  it('falls back to exclusive snapshot copy when hard links are unsupported', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');
    const fallbackDeps: LocalProfileDataMigrationDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        link: async () => {
          throw Object.assign(new Error('hard links unsupported'), { code: 'EOPNOTSUPP' });
        },
      },
    };

    await expect(adoptLocalProfileDatabase('owner-a', fallbackDeps)).resolves.toMatchObject({
      status: 'adopted',
    });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('local-db');
  });

  it('keeps the cloud target when exclusive snapshot copy loses the race', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');
    const fallbackDeps: LocalProfileDataMigrationDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        link: async () => {
          throw Object.assign(new Error('hard links unsupported'), { code: 'EXDEV' });
        },
        copyNoReplace: async (_source, destination) => {
          await fs.writeFile(destination, 'cloud-db');
          throw Object.assign(new Error('target already exists'), { code: 'EEXIST' });
        },
      },
    };

    await expect(adoptLocalProfileDatabase('owner-a', fallbackDeps)).resolves.toEqual({
      status: 'target-exists',
    });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('cloud-db');
  });

  it('retries after an interrupted fallback copy leaves a pending target', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    const pending = `${target}.local-profile-copy-pending`;
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');
    let interrupted = true;
    const recoveringDeps: LocalProfileDataMigrationDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        link: async () => {
          throw Object.assign(new Error('hard links unsupported'), { code: 'EOPNOTSUPP' });
        },
        copyNoReplace: async (source, destination) => {
          if (interrupted) {
            interrupted = false;
            await fs.writeFile(
              pending,
              JSON.stringify({ version: 1, attemptId: 'interrupted', phase: 'copying' }),
            );
            await fs.writeFile(destination, 'partial');
            throw Object.assign(new Error('copy interrupted'), { code: 'EIO' });
          }
          await fs.copyFile(source, destination);
        },
      },
    };

    await expect(adoptLocalProfileDatabase('owner-a', recoveringDeps)).resolves.toMatchObject({
      status: 'failed',
    });
    await expect(adoptLocalProfileDatabase('owner-a', recoveringDeps)).resolves.toMatchObject({
      status: 'adopted',
    });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('local-db');
    await expect(fs.access(pending)).rejects.toThrow();
  });

  it('preserves a raced cloud target when pending-marker cleanup fails', async () => {
    const { root } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    const pending = `${target}.local-profile-copy-pending`;
    const source = path.join(root, 'cindy-local-v1.db');
    await fs.writeFile(source, 'local-db');
    const productionDeps = createProductionLocalProfileDataMigrationDeps(root, 'cindy');
    const racingDeps: LocalProfileDataMigrationDeps = {
      ...productionDeps,
      fs: {
        ...productionDeps.fs,
        backupDatabase: async (sourcePath, destination) => fs.copyFile(sourcePath, destination),
        link: async () => {
          throw Object.assign(new Error('hard links unsupported'), { code: 'EXDEV' });
        },
      },
    };
    const originalOpen = originalFs.promises.open;
    const originalRemove = originalFs.promises.rm;
    let cleanupFailed = false;
    vi.spyOn(originalFs.promises, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) === target && args[1] === 'wx') {
        await fs.writeFile(target, 'cloud-db');
        throw Object.assign(new Error('target already exists'), { code: 'EEXIST' });
      }
      return originalOpen.apply(originalFs.promises, args);
    });
    vi.spyOn(originalFs.promises, 'rm').mockImplementation(async (...args) => {
      if (String(args[0]) === pending) {
        cleanupFailed = true;
        throw Object.assign(new Error('pending marker is locked'), { code: 'EBUSY' });
      }
      return originalRemove.apply(originalFs.promises, args);
    });

    await expect(adoptLocalProfileDatabase('owner-a', racingDeps)).resolves.toEqual({
      status: 'target-exists',
    });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('cloud-db');
    expect(cleanupFailed).toBe(true);
    await expect(fs.access(pending)).resolves.toBeUndefined();

    await expect(adoptLocalProfileDatabase('owner-a', racingDeps)).resolves.toEqual({
      status: 'target-exists',
    });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('cloud-db');
  });

  it('persists the fallback claiming marker before opening the exclusive target', async () => {
    const { root } = await fixture();
    const source = path.join(root, 'cindy-local-v1.db');
    const target = path.join(root, 'cindy-owner-a.db');
    const pending = `${target}.local-profile-copy-pending`;
    const sourceDb = createBetterSqliteDatabase(source);
    sourceDb.exec('CREATE TABLE items (value TEXT NOT NULL)');
    sourceDb.prepare('INSERT INTO items (value) VALUES (?)').run('local');
    sourceDb.close();

    const deps = createProductionLocalProfileDataMigrationDeps(root, 'cindy');
    const fallbackDeps: LocalProfileDataMigrationDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        link: async () => {
          throw Object.assign(new Error('hard links unsupported'), { code: 'EOPNOTSUPP' });
        },
      },
    };
    const originalOpen = originalFs.promises.open;
    let markerBeforeTargetClaim: string | undefined;
    const openSpy = vi.spyOn(originalFs.promises, 'open').mockImplementation(async (...args) => {
      const file = String(args[0]);
      if (file === target && args[1] === 'wx') {
        markerBeforeTargetClaim = await fs.readFile(pending, 'utf8');
      }
      return originalOpen.apply(originalFs.promises, args);
    });

    await expect(adoptLocalProfileDatabase('owner-a', fallbackDeps)).resolves.toMatchObject({
      status: 'adopted',
    });
    expect(JSON.parse(markerBeforeTargetClaim!)).toMatchObject({
      version: 1,
      phase: 'claiming',
    });
    expect(openSpy).toHaveBeenCalled();
    await expect(fs.access(pending)).rejects.toThrow();
  });

  it('fails closed when target ownership is unproven after the fallback claim is interrupted', async () => {
    const { root } = await fixture();
    const source = path.join(root, 'cindy-local-v1.db');
    const target = path.join(root, 'cindy-owner-a.db');
    const pending = `${target}.local-profile-copy-pending`;
    const sourceDb = createBetterSqliteDatabase(source);
    sourceDb.exec('CREATE TABLE items (value TEXT NOT NULL)');
    sourceDb.prepare('INSERT INTO items (value) VALUES (?)').run('local');
    sourceDb.close();

    const deps = createProductionLocalProfileDataMigrationDeps(root, 'cindy');
    const fallbackDeps: LocalProfileDataMigrationDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        link: async () => {
          throw Object.assign(new Error('hard links unsupported'), { code: 'EOPNOTSUPP' });
        },
      },
    };
    const originalOpen = originalFs.promises.open;
    let interruptTargetOpen = true;
    vi.spyOn(originalFs.promises, 'open').mockImplementation(async (...args) => {
      const file = String(args[0]);
      if (interruptTargetOpen && file === target && args[1] === 'wx') {
        interruptTargetOpen = false;
        await fs.writeFile(target, '');
        throw Object.assign(new Error('process interrupted after target claim'), { code: 'EIO' });
      }
      return originalOpen.apply(originalFs.promises, args);
    });

    await expect(adoptLocalProfileDatabase('owner-a', fallbackDeps)).resolves.toMatchObject({
      status: 'failed',
    });
    await expect(fs.readFile(pending, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      phase: 'claiming',
    });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('');

    await expect(adoptLocalProfileDatabase('owner-a', fallbackDeps)).resolves.toEqual({
      status: 'failed',
      error: 'database copy publication has an unproven target owner',
    });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('');
    await expect(fs.readFile(pending, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      phase: 'claiming',
    });
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

    expect(reserveLocalProfileDataOwner('owner-a', root, 'cindy')).toBe('failed');
    expect(reserveLocalProfileDataOwner('owner-b', root, 'cindy')).toBe('failed');
    await expect(fs.readFile(marker, 'utf8')).resolves.toBe('{');
  });

  it('releases only the marker created by the matching claim token', async () => {
    const { root } = await fixture();
    const reservation = reserveLocalProfileDataOwnerDetailed('owner-a', root, 'cindy');
    expect(reservation).toMatchObject({ status: 'claimed', claimToken: expect.any(String) });
    expect(reserveLocalProfileDataOwnerDetailed('owner-a', root, 'cindy')).toEqual({
      status: 'already-owned',
      ownerId: 'owner-a',
    });
    const marker = path.join(root, `cindy-local-v1${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`);
    const beforeWrongToken = await fs.readFile(marker, 'utf8');
    expect(releaseLocalProfileDataOwner('owner-a', root, 'cindy', 'wrong-token')).toBe(false);
    await expect(fs.readFile(marker, 'utf8')).resolves.toBe(beforeWrongToken);
    expect(reserveLocalProfileDataOwner('owner-b', root, 'cindy')).toBe('owned-by-other');
    expect(releaseLocalProfileDataOwner('owner-a', root, 'cindy', reservation.claimToken!)).toBe(
      true,
    );
    expect(reserveLocalProfileDataOwner('owner-b', root, 'cindy')).toBe('claimed');
  });

  it('fails closed when a released marker cannot be restored atomically', async () => {
    const { root } = await fixture();
    const marker = path.join(root, `cindy-local-v1${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`);
    const candidate = `${marker}.release`;
    const reservation = reserveLocalProfileDataOwnerDetailed('owner-a', root, 'cindy');
    expect(reservation).toMatchObject({ status: 'claimed', claimToken: expect.any(String) });

    const originalRenameSync = originalFs.renameSync;
    vi.spyOn(originalFs, 'renameSync').mockImplementation((source, destination) => {
      if (String(source) === candidate && String(destination) === marker) {
        throw Object.assign(new Error('marker restore temporarily unavailable'), { code: 'EBUSY' });
      }
      return originalRenameSync.apply(originalFs, [source, destination]);
    });

    expect(releaseLocalProfileDataOwner('owner-a', root, 'cindy', 'c1-deadbeef')).toBe(false);
    await expect(fs.access(marker)).rejects.toThrow();
    await expect(fs.access(candidate)).resolves.toBeUndefined();
    expect(reserveLocalProfileDataOwner('owner-b', root, 'cindy')).toBe('failed');
  });

  it('finalizes a pending claim for the committed owner', async () => {
    const { root } = await fixture();
    const marker = path.join(root, `cindy-local-v1${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`);
    const openSpy = vi.spyOn(originalFs, 'openSync');
    const reservation = reserveLocalProfileDataOwnerDetailed('owner-a', root, 'cindy');
    expect(reservation).toMatchObject({ status: 'claimed', claimToken: expect.any(String) });

    expect(recoverPendingLocalProfileDataOwner('owner-a', root, 'cindy')).toBe('finalized');
    expect(openSpy).toHaveBeenCalledWith(marker, 'r+');
    expect(releaseLocalProfileDataOwner('owner-a', root, 'cindy', reservation.claimToken!)).toBe(
      false,
    );
    expect(reserveLocalProfileDataOwner('owner-b', root, 'cindy')).toBe('owned-by-other');
  });

  it('finalizes a committed claim stranded in a release candidate', async () => {
    const { root } = await fixture();
    const marker = path.join(root, `cindy-local-v1${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`);
    const candidate = `${marker}.release`;
    const reservation = reserveLocalProfileDataOwnerDetailed('owner-a', root, 'cindy');
    expect(reservation).toMatchObject({ status: 'claimed', claimToken: expect.any(String) });
    originalFs.renameSync(marker, candidate);

    expect(recoverPendingLocalProfileDataOwner('owner-a', root, 'cindy')).toBe('finalized');
    await expect(fs.access(candidate)).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(marker, 'utf8'))).toMatchObject({ ownerId: 'owner-a' });
    expect(JSON.parse(await fs.readFile(marker, 'utf8'))).not.toHaveProperty('claimToken');
    expect(reserveLocalProfileDataOwner('owner-b', root, 'cindy')).toBe('owned-by-other');
  });

  it('releases an uncommitted claim stranded in a release candidate', async () => {
    const { root } = await fixture();
    const marker = path.join(root, `cindy-local-v1${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`);
    const candidate = `${marker}.release`;
    expect(reserveLocalProfileDataOwner('owner-a', root, 'cindy')).toBe('claimed');
    originalFs.renameSync(marker, candidate);

    expect(recoverPendingLocalProfileDataOwner(null, root, 'cindy')).toBe('released');
    await expect(fs.access(marker)).rejects.toThrow();
    await expect(fs.access(candidate)).rejects.toThrow();
    expect(reserveLocalProfileDataOwner('owner-b', root, 'cindy')).toBe('claimed');
  });

  it('restores a tokenless owner stranded in a release candidate', async () => {
    const { root } = await fixture();
    const marker = path.join(root, `cindy-local-v1${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`);
    const candidate = `${marker}.release`;
    expect(reserveCommittedLocalProfileDataOwner('owner-a', root, 'cindy')).toBe('claimed');
    originalFs.renameSync(marker, candidate);

    expect(recoverPendingLocalProfileDataOwner(null, root, 'cindy')).toBe('none');
    await expect(fs.access(candidate)).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(marker, 'utf8'))).toMatchObject({ ownerId: 'owner-a' });
    expect(reserveLocalProfileDataOwner('owner-b', root, 'cindy')).toBe('owned-by-other');
  });

  it('restores an atomic-write backup before settling a pending claim', async () => {
    const { root } = await fixture();
    const marker = path.join(root, `cindy-local-v1${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`);
    await fs.writeFile(
      `${marker}.bak`,
      JSON.stringify({ ownerId: 'owner-a', claimToken: 'claim-a' }),
    );

    expect(recoverPendingLocalProfileDataOwner('owner-a', root, 'cindy')).toBe('finalized');
    await expect(fs.access(`${marker}.bak`)).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(marker, 'utf8'))).toMatchObject({ ownerId: 'owner-a' });
    expect(JSON.parse(await fs.readFile(marker, 'utf8'))).not.toHaveProperty('claimToken');
    expect(reserveLocalProfileDataOwner('owner-b', root, 'cindy')).toBe('owned-by-other');
  });

  it('creates a tokenless claim for an already durable cloud owner', async () => {
    const { root } = await fixture();
    expect(reserveCommittedLocalProfileDataOwner('owner-a', root, 'cindy')).toBe('claimed');
    const marker = JSON.parse(
      await fs.readFile(
        path.join(root, `cindy-local-v1${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`),
        'utf8',
      ),
    );
    expect(marker).toMatchObject({ ownerId: 'owner-a' });
    expect(marker).not.toHaveProperty('claimToken');
    expect(recoverPendingLocalProfileDataOwner(null, root, 'cindy')).toBe('none');
    expect(reserveLocalProfileDataOwner('owner-b', root, 'cindy')).toBe('owned-by-other');
  });

  it('reports the authoritative owner when a later cloud owner is rejected', async () => {
    const { root } = await fixture();
    expect(reserveCommittedLocalProfileDataOwner('owner-a', root, 'cindy')).toBe('claimed');

    expect(reserveCommittedLocalProfileDataOwnerDetailed('owner-b', root, 'cindy')).toEqual({
      status: 'owned-by-other',
      ownerId: 'owner-a',
    });
  });

  it('recovers an interrupted pending claim before a different owner commits', async () => {
    const { root } = await fixture();
    expect(reserveLocalProfileDataOwner('owner-a', root, 'cindy')).toBe('claimed');

    expect(recoverPendingLocalProfileDataOwner(null, root, 'cindy')).toBe('released');
    expect(reserveLocalProfileDataOwner('owner-b', root, 'cindy')).toBe('claimed');
  });

  it('keeps a pending claim recoverable when the migration lock is temporarily busy', async () => {
    const { root } = await fixture();
    const marker = path.join(root, `cindy-local-v1${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`);
    expect(reserveLocalProfileDataOwner('owner-a', root, 'cindy')).toBe('claimed');
    const lockDb = createBetterSqliteDatabase(`${marker}${LOCAL_PROFILE_MIGRATION_LOCK_DB_SUFFIX}`);
    lockDb.exec('BEGIN IMMEDIATE');
    try {
      expect(recoverPendingLocalProfileDataOwner(null, root, 'cindy')).toBe('failed');
      await expect(fs.readFile(marker, 'utf8')).resolves.toContain('owner-a');
    } finally {
      lockDb.exec('ROLLBACK');
      lockDb.close();
    }

    expect(recoverPendingLocalProfileDataOwner(null, root, 'cindy')).toBe('released');
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

  it('defers an absent source while another instance could still create it', async () => {
    const { root, deps } = await fixture();

    await expect(
      adoptLocalProfileDatabase('owner-a', {
        ...deps,
        hasExclusiveSourceAccess: () => false,
      }),
    ).resolves.toEqual({
      status: 'failed',
      error: 'local profile database adoption deferred: concurrent live instance',
    });
    await expect(fs.access(path.join(root, 'cindy-owner-a.db'))).rejects.toThrow();
  });

  it('opens an existing cloud database without requiring source exclusivity', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    await fs.writeFile(target, 'cloud-db');

    await expect(
      adoptLocalProfileDatabase('owner-a', {
        ...deps,
        hasExclusiveSourceAccess: () => false,
      }),
    ).resolves.toEqual({ status: 'target-exists' });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('cloud-db');
  });

  it('blocks initialization when source sidecars exist without the main database', async () => {
    const { root, deps } = await fixture();
    const source = path.join(root, 'cindy-local-v1.db');
    const target = path.join(root, 'cindy-owner-a.db');
    await fs.writeFile(`${source}-wal`, 'orphaned-wal');

    await expect(adoptLocalProfileDatabase('owner-a', deps)).resolves.toEqual({
      status: 'failed',
      error: 'source database sidecar exists without its main database',
    });
    await expect(fs.access(target)).rejects.toThrow();
    await expect(fs.readFile(`${source}-wal`, 'utf8')).resolves.toBe('orphaned-wal');
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
    const marker = JSON.parse(
      await fs.readFile(
        path.join(root, `cindy-local-v1${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`),
        'utf8',
      ),
    );
    expect(marker).not.toHaveProperty('claimToken');
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
      expect(openSpy).toHaveBeenCalledWith(path.join(root, 'cindy-owner-a.db'), 'r+');
      if (process.platform !== 'win32') {
        expect(openSpy).toHaveBeenCalledWith(root, 'r');
      }
      if (process.platform !== 'win32') {
        expect((await fs.stat(path.join(root, 'cindy-owner-a.db'))).mode & 0o777).toBe(0o600);
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
    await fs.writeFile(target, 'cloud-db');
    await fs.writeFile(`${target}-wal`, 'cloud-wal');

    await expect(adoptLocalProfileDatabase('owner-a', deps)).resolves.toEqual({
      status: 'target-exists',
    });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('cloud-db');
    await expect(fs.readFile(`${target}-wal`, 'utf8')).resolves.toBe('cloud-wal');
  });

  it('blocks initialization when target sidecars exist without the main database', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');
    await fs.writeFile(`${target}-wal`, 'orphaned-wal');

    await expect(adoptLocalProfileDatabase('owner-a', deps)).resolves.toMatchObject({
      status: 'failed',
      error: 'target database sidecar exists without its main database',
    });
    await expect(fs.access(target)).rejects.toThrow();
    await expect(fs.readFile(`${target}-wal`, 'utf8')).resolves.toBe('orphaned-wal');
  });

  it('requires the primary instance when the retained source belongs to this owner', async () => {
    const { root, deps } = await fixture();
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');

    await expect(inspectPassiveLocalProfileAdoption('owner-a', deps)).resolves.toEqual({
      status: 'required',
    });
    expect(reserveCommittedLocalProfileDataOwner('owner-a', root, 'cindy')).toBe('claimed');

    await expect(inspectPassiveLocalProfileAdoption('owner-a', deps)).resolves.toEqual({
      status: 'required',
    });
    await expect(fs.access(path.join(root, 'cindy-owner-a.db'))).rejects.toThrow();
  });

  it('allows passive initialization when adoption is not applicable', async () => {
    const { root, deps } = await fixture();

    await expect(inspectPassiveLocalProfileAdoption('owner-a', deps)).resolves.toEqual({
      status: 'not-required',
      reason: 'no-local-db',
    });

    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');
    await fs.writeFile(path.join(root, 'cindy-owner-a.db'), 'cloud-db');
    await expect(inspectPassiveLocalProfileAdoption('owner-a', deps)).resolves.toEqual({
      status: 'not-required',
      reason: 'target-exists',
    });

    await fs.rm(path.join(root, 'cindy-owner-a.db'));
    expect(reserveCommittedLocalProfileDataOwner('owner-b', root, 'cindy')).toBe('claimed');
    await expect(inspectPassiveLocalProfileAdoption('owner-a', deps)).resolves.toEqual({
      status: 'not-required',
      reason: 'claimed-by-other-owner',
    });
  });

  it('blocks passive initialization for orphaned source sidecars', async () => {
    const { root, deps } = await fixture();
    const source = path.join(root, 'cindy-local-v1.db');
    await fs.writeFile(`${source}-shm`, 'orphaned-shm');

    await expect(inspectPassiveLocalProfileAdoption('owner-a', deps)).resolves.toEqual({
      status: 'failed',
      error: 'source database sidecar exists without its main database',
    });
    await expect(fs.readFile(`${source}-shm`, 'utf8')).resolves.toBe('orphaned-shm');
  });

  it('blocks passive initialization while another instance could create the source', async () => {
    const { deps } = await fixture();

    await expect(
      inspectPassiveLocalProfileAdoption('owner-a', {
        ...deps,
        hasExclusiveSourceAccess: () => false,
      }),
    ).resolves.toEqual({
      status: 'failed',
      error: 'local profile database adoption deferred: concurrent live instance',
    });
  });

  it('keeps an existing passive cloud target authoritative when source access is unavailable', async () => {
    const { root, deps } = await fixture();
    await fs.writeFile(path.join(root, 'cindy-owner-a.db'), 'cloud-db');

    await expect(
      inspectPassiveLocalProfileAdoption('owner-a', {
        ...deps,
        hasExclusiveSourceAccess: () => false,
      }),
    ).resolves.toEqual({
      status: 'not-required',
      reason: 'target-exists',
    });
  });

  it('blocks passive initialization when a fallback copy is still in progress', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');
    await fs.writeFile(target, 'partial');
    await fs.writeFile(
      `${target}.local-profile-copy-pending`,
      JSON.stringify({ version: 1, attemptId: 'interrupted', phase: 'copying' }),
    );

    await expect(inspectPassiveLocalProfileAdoption('owner-a', deps)).resolves.toEqual({
      status: 'failed',
      error: 'target database copy is incomplete',
    });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('partial');
  });

  it('leaves a pending-copy backup for recovery under the migration lock', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    const pending = `${target}.local-profile-copy-pending`;
    const backup = `${pending}.bak`;
    await fs.writeFile(target, 'partial');
    await fs.writeFile(
      backup,
      JSON.stringify({ version: 1, attemptId: 'interrupted-windows-swap', phase: 'copying' }),
    );

    await expect(inspectPassiveLocalProfileAdoption('owner-a', deps)).resolves.toEqual({
      status: 'failed',
      error: 'database copy pending marker recovery requires migration lock',
    });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('partial');
    await expect(fs.access(pending)).rejects.toThrow();
    await expect(fs.readFile(backup, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      attemptId: 'interrupted-windows-swap',
      phase: 'copying',
    });

    // The lock holder must still be able to publish its replacement marker;
    // passive inspection must not recreate the canonical path first.
    const writerTemp = `${pending}.writer.tmp`;
    await fs.writeFile(
      writerTemp,
      JSON.stringify({ version: 1, attemptId: 'writer', phase: 'copying' }),
    );
    await fs.rename(writerTemp, pending);
    await expect(fs.readFile(pending, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      attemptId: 'writer',
      phase: 'copying',
    });
  });

  it('blocks passive initialization when target ownership is unproven', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    const pending = `${target}.local-profile-copy-pending`;
    await fs.writeFile(target, 'partial');
    await fs.writeFile(
      pending,
      JSON.stringify({ version: 1, attemptId: 'interrupted', phase: 'claiming' }),
    );

    await expect(inspectPassiveLocalProfileAdoption('owner-a', deps)).resolves.toEqual({
      status: 'failed',
      error: 'database copy publication has an unproven target owner',
    });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('partial');
    await expect(fs.readFile(pending, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      phase: 'claiming',
    });
  });

  it('allows passive initialization after a published fallback copy', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    await fs.writeFile(target, 'cloud-db');
    await fs.writeFile(
      `${target}.local-profile-copy-pending`,
      JSON.stringify({ version: 1, attemptId: 'interrupted', phase: 'published' }),
    );

    await expect(inspectPassiveLocalProfileAdoption('owner-a', deps)).resolves.toEqual({
      status: 'not-required',
      reason: 'target-exists',
    });
  });

  it('allows passive initialization after a raced fallback copy', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    await fs.writeFile(target, 'cloud-db');
    await fs.writeFile(
      `${target}.local-profile-copy-pending`,
      JSON.stringify({ version: 1, attemptId: 'interrupted', phase: 'raced' }),
    );

    await expect(inspectPassiveLocalProfileAdoption('owner-a', deps)).resolves.toEqual({
      status: 'not-required',
      reason: 'target-exists',
    });
  });

  it('blocks passive initialization when the pending copy marker is malformed', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    await fs.writeFile(target, 'cloud-db');
    await fs.writeFile(`${target}.local-profile-copy-pending`, '{');

    await expect(inspectPassiveLocalProfileAdoption('owner-a', deps)).resolves.toEqual({
      status: 'failed',
      error: 'database copy pending marker is malformed',
    });
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

  it('keeps the first same-owner snapshot when concurrent publishers produce different bytes', async () => {
    const { root, deps } = await fixture();
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');
    let backupCount = 0;
    const racingDeps: LocalProfileDataMigrationDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        backupDatabase: async (_source, target) => {
          backupCount += 1;
          await fs.writeFile(target, `snapshot-${backupCount}`);
        },
      },
    };

    const results = await Promise.all([
      adoptLocalProfileDatabase('owner-a', racingDeps),
      adoptLocalProfileDatabase('owner-a', racingDeps),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['adopted', 'target-exists']);
    expect(backupCount).toBe(1);
    await expect(fs.readFile(path.join(root, 'cindy-owner-a.db'), 'utf8')).resolves.toBe(
      'snapshot-1',
    );
  });

  it('does not replace a cloud database created after the target preflight', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');

    const racingDeps: LocalProfileDataMigrationDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        link: async (source, destination) => {
          // Model another initializer winning the target race after the
          // adoption preflight but before publication.
          await fs.writeFile(destination, 'cloud-db');
          return fs.link(source, destination);
        },
      },
    };

    await expect(adoptLocalProfileDatabase('owner-a', racingDeps)).resolves.toEqual({
      status: 'target-exists',
    });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('cloud-db');
  });

  it('keeps a cloud database created during the online backup', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');

    let backupStarted!: () => void;
    let releaseBackup!: () => void;
    const backupStartedPromise = new Promise<void>((resolve) => {
      backupStarted = resolve;
    });
    const backupRelease = new Promise<void>((resolve) => {
      releaseBackup = resolve;
    });
    const racingDeps: LocalProfileDataMigrationDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        backupDatabase: async (_source, destination) => {
          await fs.writeFile(destination, 'local-snapshot');
          backupStarted();
          await backupRelease;
        },
      },
    };

    const adoption = adoptLocalProfileDatabase('owner-a', racingDeps);
    await backupStartedPromise;
    // A separate initializer can create the cloud target after the adoption
    // preflight; the atomic target claim must preserve that database.
    await fs.writeFile(target, 'cloud-db');
    releaseBackup();

    await expect(adoption).resolves.toEqual({ status: 'target-exists' });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('cloud-db');
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

  it('blocks initialization when probing the local database fails', async () => {
    const { root, deps } = await fixture();
    const source = path.join(root, 'cindy-local-v1.db');
    const target = path.join(root, 'cindy-owner-a.db');
    await fs.writeFile(source, 'local-db');
    const failingDeps: LocalProfileDataMigrationDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        pathExists: async (file) => {
          if (file === source)
            throw Object.assign(new Error('local database probe failed'), { code: 'EIO' });
          return deps.fs.pathExists(file);
        },
      },
    };

    await expect(adoptLocalProfileDatabase('owner-a', failingDeps)).resolves.toMatchObject({
      status: 'failed',
      error: 'local database probe failed',
    });
    await expect(fs.access(target)).rejects.toThrow();
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
    const target = path.join(root, 'cindy-owner-a.db');
    const activeSnapshot = `${target}${LOCAL_PROFILE_MIGRATION_TMP_SUFFIX}.active-holder`;
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');
    await fs.writeFile(activeSnapshot, 'active-snapshot');
    await fs.mkdir(`${marker}${LOCAL_PROFILE_MIGRATION_LOCK_DB_SUFFIX}`, { recursive: true });

    await expect(adoptLocalProfileDatabase('owner-a', deps)).resolves.toEqual({
      status: 'failed',
      error: expect.stringContaining('failed to acquire local profile migration lock'),
    });
    await expect(fs.readFile(activeSnapshot, 'utf8')).resolves.toBe('active-snapshot');
  });

  it('defers adoption while another live instance can still write local-v1', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');

    await expect(
      adoptLocalProfileDatabase('owner-a', {
        ...deps,
        hasExclusiveSourceAccess: () => false,
      }),
    ).resolves.toEqual({
      status: 'failed',
      error: 'local profile database adoption deferred: concurrent live instance',
    });
    await expect(fs.access(target)).rejects.toThrow();
  });

  it('keeps the first owner reservation and retries after a legacy packaged instance exits', async () => {
    const { root, deps } = await fixture();
    const source = path.join(root, 'cindy-local-v1.db');
    const target = path.join(root, 'cindy-owner-a.db');
    await fs.writeFile(source, 'local-db');
    let packagedInstanceRunning = true;
    const acquireSourcePublicationBarrier = vi.fn(async () => {
      if (packagedInstanceRunning) {
        throw new Error(
          'local profile database adoption deferred: legacy packaged instance 4242 is using shared userData',
        );
      }
      return { isHeld: () => true, release: vi.fn(async () => undefined) };
    });

    await expect(
      adoptLocalProfileDatabase('owner-a', { ...deps, acquireSourcePublicationBarrier }),
    ).resolves.toEqual({
      status: 'failed',
      error:
        'local profile database adoption deferred: legacy packaged instance 4242 is using shared userData',
    });
    await expect(fs.access(target)).rejects.toThrow();
    expect(reserveLocalProfileDataOwner('owner-b', root, 'cindy')).toBe('owned-by-other');

    packagedInstanceRunning = false;
    await expect(
      adoptLocalProfileDatabase('owner-a', { ...deps, acquireSourcePublicationBarrier }),
    ).resolves.toMatchObject({ status: 'adopted', sourceDb: source, targetDb: target });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('local-db');
    expect(acquireSourcePublicationBarrier).toHaveBeenCalledTimes(2);
  });

  it('holds the packaged startup barrier through snapshot publication', async () => {
    const { root, deps } = await fixture();
    const source = path.join(root, 'cindy-local-v1.db');
    const target = path.join(root, 'cindy-owner-a.db');
    await fs.writeFile(source, 'local-db');
    let held = true;
    const release = vi.fn(async () => {
      held = false;
    });
    const acquireSourcePublicationBarrier = vi.fn(async () => ({
      isHeld: () => held,
      release,
    }));
    const guardedDeps: LocalProfileDataMigrationDeps = {
      ...deps,
      acquireSourcePublicationBarrier,
      fs: {
        ...deps.fs,
        backupDatabase: async (from, to) => {
          expect(held).toBe(true);
          await fs.copyFile(from, to);
        },
        link: async (from, to) => {
          expect(held).toBe(true);
          await fs.link(from, to);
        },
      },
    };

    await expect(adoptLocalProfileDatabase('owner-a', guardedDeps)).resolves.toMatchObject({
      status: 'adopted',
    });
    expect(acquireSourcePublicationBarrier).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(held).toBe(false);
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('local-db');
  });

  it('removes its published target when the packaged startup barrier is lost', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');
    let heldChecks = 0;
    const release = vi.fn(async () => undefined);

    await expect(
      adoptLocalProfileDatabase('owner-a', {
        ...deps,
        acquireSourcePublicationBarrier: async () => ({
          // Entry and post-backup checks pass. Losing the helper before the
          // final post-publication check must retract our target.
          isHeld: () => ++heldChecks <= 2,
          release,
        }),
      }),
    ).resolves.toEqual({
      status: 'failed',
      error: 'local profile database adoption deferred: concurrent live instance',
    });
    expect(heldChecks).toBe(3);
    expect(release).toHaveBeenCalledOnce();
    await expect(fs.access(target)).rejects.toThrow();
  });

  it('checks the packaged startup barrier before accepting an absent local database', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    let packagedInstanceRunning = true;
    const release = vi.fn(async () => undefined);
    const acquireSourcePublicationBarrier = vi.fn(async () => {
      if (packagedInstanceRunning) {
        throw new Error(
          'local profile database adoption deferred: legacy packaged instance 4242 is using shared userData',
        );
      }
      return { isHeld: () => true, release };
    });

    await expect(
      adoptLocalProfileDatabase('owner-a', { ...deps, acquireSourcePublicationBarrier }),
    ).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('legacy packaged instance 4242'),
    });
    await expect(fs.access(target)).rejects.toThrow();

    packagedInstanceRunning = false;
    await expect(
      adoptLocalProfileDatabase('owner-a', { ...deps, acquireSourcePublicationBarrier }),
    ).resolves.toEqual({ status: 'no-local-db' });
    expect(acquireSourcePublicationBarrier).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it('discards the snapshot if exclusive source access is lost before publication', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');
    let accessChecks = 0;

    await expect(
      adoptLocalProfileDatabase('owner-a', {
        ...deps,
        hasExclusiveSourceAccess: () => ++accessChecks === 1,
      }),
    ).resolves.toEqual({
      status: 'failed',
      error: 'local profile database adoption deferred: concurrent live instance',
    });
    expect(accessChecks).toBe(2);
    await expect(fs.access(target)).rejects.toThrow();
  });

  it('cleans interrupted temporary files before retrying', async () => {
    const { root, deps } = await fixture();
    const target = path.join(root, 'cindy-owner-a.db');
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');
    await fs.writeFile(`${target}${LOCAL_PROFILE_MIGRATION_TMP_SUFFIX}`, 'stale');
    await fs.writeFile(`${target}${LOCAL_PROFILE_MIGRATION_TMP_SUFFIX}.attempt-a`, 'stale-copy');
    await fs.writeFile(`${target}-wal${LOCAL_PROFILE_MIGRATION_TMP_SUFFIX}`, 'stale-wal');
    await fs.writeFile(
      `${target}-shm${LOCAL_PROFILE_MIGRATION_TMP_SUFFIX}.attempt-b`,
      'stale-shm-copy',
    );

    await expect(adoptLocalProfileDatabase('owner-a', deps)).resolves.toMatchObject({
      status: 'adopted',
    });
    await expect(fs.access(`${target}${LOCAL_PROFILE_MIGRATION_TMP_SUFFIX}`)).rejects.toThrow();
    await expect(
      fs.access(`${target}${LOCAL_PROFILE_MIGRATION_TMP_SUFFIX}.attempt-a`),
    ).rejects.toThrow();
    await expect(fs.access(`${target}-wal${LOCAL_PROFILE_MIGRATION_TMP_SUFFIX}`)).rejects.toThrow();
    await expect(
      fs.access(`${target}-shm${LOCAL_PROFILE_MIGRATION_TMP_SUFFIX}.attempt-b`),
    ).rejects.toThrow();
  });
});

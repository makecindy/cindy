import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  adoptLocalProfileDatabase,
  LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX,
  LOCAL_PROFILE_MIGRATION_TMP_SUFFIX,
  type LocalProfileDataMigrationDeps,
} from '../localProfileDataMigration.js';

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
        createFileExclusive: async (file, contents) => {
          try {
            const handle = await fs.open(file, 'wx');
            try {
              await handle.writeFile(contents, 'utf8');
            } finally {
              await handle.close();
            }
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
            throw error;
          }
        },
        copyFile: (source, target) => fs.copyFile(source, target),
        rename: (source, target) => fs.rename(source, target),
        removeIfExists: (file) => fs.rm(file, { force: true }),
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('adoptLocalProfileDatabase', () => {
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

  it('adopts local-v1 database and sidecars without deleting the local source', async () => {
    const { root, deps } = await fixture();
    await fs.writeFile(path.join(root, 'cindy-local-v1.db'), 'local-db');
    await fs.writeFile(path.join(root, 'cindy-local-v1.db-wal'), 'local-wal');

    await expect(adoptLocalProfileDatabase('owner-a', deps)).resolves.toMatchObject({
      status: 'adopted',
    });
    await expect(fs.readFile(path.join(root, 'cindy-owner-a.db'), 'utf8')).resolves.toBe(
      'local-db',
    );
    await expect(fs.readFile(path.join(root, 'cindy-owner-a.db-wal'), 'utf8')).resolves.toBe(
      'local-wal',
    );
    await expect(fs.readFile(path.join(root, 'cindy-local-v1.db'), 'utf8')).resolves.toBe(
      'local-db',
    );
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

import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  excludeDirectoryGrantConflicts,
  excludeDirectoryGrantConflictsWithSlots,
  extraDirsForRuntime,
  EXTRA_DIRS_MAX,
  LIBRARY_EXTRA_DIR_SLOT_PREFIX,
  libraryExtraDirSlot,
  nextLibraryExtraDirs,
  splitExtraDirSlots,
  validateExtraDirs,
} from '../extraDirsValidator';

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('excludeDirectoryGrantConflicts', () => {
  it('keeps a read-only directory out of writable grants, including symlink aliases', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-dir-grants-'));
    cleanupDirs.push(root);
    const reference = path.join(root, 'reference');
    const alias = path.join(root, 'reference-alias');
    const output = path.join(root, 'output');
    mkdirSync(reference);
    mkdirSync(output);
    symlinkSync(reference, alias, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(
      excludeDirectoryGrantConflicts([reference, alias, output], [reference]),
    ).resolves.toEqual([output]);
  });

  it('rejects ancestor and descendant overlaps in both grant directions', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-dir-grants-nested-'));
    cleanupDirs.push(root);
    const shared = path.join(root, 'shared');
    const specs = path.join(shared, 'specs');
    const output = path.join(root, 'output');
    mkdirSync(specs, { recursive: true });
    mkdirSync(output);

    await expect(excludeDirectoryGrantConflicts([shared, output], [specs])).resolves.toEqual([
      output,
    ]);
    await expect(excludeDirectoryGrantConflicts([specs, output], [shared])).resolves.toEqual([
      output,
    ]);
  });

  it('keeps only the first canonical root when candidates overlap within one grant group', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-dir-grants-same-group-'));
    cleanupDirs.push(root);
    const shared = path.join(root, 'shared');
    const specs = path.join(shared, 'specs');
    const alias = path.join(root, 'shared-alias');
    mkdirSync(specs, { recursive: true });
    symlinkSync(shared, alias, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(excludeDirectoryGrantConflicts([shared, specs], [])).resolves.toEqual([shared]);
    await expect(excludeDirectoryGrantConflicts([specs, shared], [])).resolves.toEqual([specs]);
    await expect(excludeDirectoryGrantConflicts([shared, alias], [])).resolves.toEqual([shared]);
  });

  it('uses canonical paths for nested aliases without rejecting sibling prefixes', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-dir-grants-alias-nested-'));
    cleanupDirs.push(root);
    const shared = path.join(root, 'shared');
    const specs = path.join(shared, 'specs');
    const sharedAlias = path.join(root, 'shared-alias');
    const sibling = path.join(root, 'shared-other');
    mkdirSync(specs, { recursive: true });
    mkdirSync(sibling);
    symlinkSync(shared, sharedAlias, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(
      excludeDirectoryGrantConflicts([sharedAlias, sibling], [specs]),
    ).resolves.toEqual([sibling]);
  });

  it('writable 候选与 cindy-library 槽指向同一根时互斥', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-dir-grants-library-slot-'));
    cleanupDirs.push(root);
    const library = path.join(root, 'library');
    const output = path.join(root, 'output');
    mkdirSync(library);
    mkdirSync(output);
    const slot = libraryExtraDirSlot(library);
    await expect(excludeDirectoryGrantConflictsWithSlots([library, output], [slot])).resolves.toEqual([
      output,
    ]);
    await expect(excludeDirectoryGrantConflictsWithSlots([slot], [library])).resolves.toEqual([]);
  });
});

describe('validateExtraDirs library slot', () => {
  it('满 10 个用户目录时 library 槽仍通过,over-limit 不误伤槽', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-extra-dirs-max-'));
    cleanupDirs.push(root);
    const workdir = path.join(root, 'workdir');
    mkdirSync(workdir);
    const users: string[] = [];
    for (let i = 0; i < EXTRA_DIRS_MAX; i += 1) {
      const dir = path.join(root, `user-${i}`);
      mkdirSync(dir);
      users.push(dir);
    }
    const eleventh = path.join(root, 'user-overflow');
    mkdirSync(eleventh);
    const libraryRoot = path.join(root, 'library');
    mkdirSync(libraryRoot);
    const librarySlot = `${LIBRARY_EXTRA_DIR_SLOT_PREFIX}${libraryRoot}`;

    const overflow = await validateExtraDirs([...users, eleventh], workdir);
    expect(overflow.valid).toEqual(users);
    expect(overflow.rejected).toEqual([{ path: eleventh, reason: 'over-limit' }]);

    const withSlot = await validateExtraDirs([...users, librarySlot], workdir);
    expect(withSlot.valid).toEqual([...users, librarySlot]);
    expect(withSlot.rejected).toEqual([]);
  });

  it('library 槽相对路径不当绝对根,越界键拒绝', async () => {
    const overflow = await validateExtraDirs(
      [`${LIBRARY_EXTRA_DIR_SLOT_PREFIX}../escape`, `${LIBRARY_EXTRA_DIR_SLOT_PREFIX}relative/root`],
      '/tmp/workdir',
    );
    expect(overflow.valid).toEqual([]);
    expect(overflow.rejected.map((entry) => entry.reason)).toEqual(['not-absolute', 'not-absolute']);
  });
});

describe('nextLibraryExtraDirs', () => {
  it('注入 library 槽且不挤掉满额用户目录', () => {
    const users = Array.from({ length: EXTRA_DIRS_MAX }, (_, i) => `/user/${i}`);
    const next = nextLibraryExtraDirs(users, '/var/libraries/xd-mivo');
    expect(splitExtraDirSlots(next).user).toEqual(users);
    expect(next).toContain(libraryExtraDirSlot('/var/libraries/xd-mivo'));
    expect(extraDirsForRuntime(next)).toEqual([...users, '/var/libraries/xd-mivo']);
  });

  it('generation 变更时新根替换旧根,用户目录保留', () => {
    const current = ['/user/a', libraryExtraDirSlot('/old/libraries/xd-mivo'), '/user/b'];
    const next = nextLibraryExtraDirs(current, '/new/libraries/xd-mivo');
    expect(next).toEqual([
      '/user/a',
      '/user/b',
      libraryExtraDirSlot('/new/libraries/xd-mivo'),
    ]);
    expect(next).not.toContain(libraryExtraDirSlot('/old/libraries/xd-mivo'));
  });

  it('root 为 null 时撤槽,用户目录原样', () => {
    const current = ['/user/a', libraryExtraDirSlot('/var/libraries/xd-mivo')];
    expect(nextLibraryExtraDirs(current, null)).toEqual(['/user/a']);
  });
});

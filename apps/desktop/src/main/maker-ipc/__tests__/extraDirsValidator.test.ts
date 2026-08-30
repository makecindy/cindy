import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { excludeDirectoryGrantConflicts } from '../extraDirsValidator';

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
    symlinkSync(reference, alias, 'dir');

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
    symlinkSync(shared, sharedAlias, 'dir');

    await expect(
      excludeDirectoryGrantConflicts([sharedAlias, sibling], [specs]),
    ).resolves.toEqual([sibling]);
  });
});

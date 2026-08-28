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
});

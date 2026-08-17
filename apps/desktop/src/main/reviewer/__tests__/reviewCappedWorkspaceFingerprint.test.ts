import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  fingerprintReviewCappedWorkspaceFiles,
  ReviewCappedWorkspaceFingerprintError,
  ReviewCappedWorkspaceFingerprintLimitError,
} from '../reviewCappedWorkspaceFingerprint.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-review-capped-fingerprint-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('capped Review workspace fingerprint', () => {
  it('fully fingerprints same-size content changes', async () => {
    const repoRoot = await makeTempDir();
    const file = path.join(repoRoot, 'large.ts');
    await fs.writeFile(file, 'aaa111zzz');
    const before = await fingerprintReviewCappedWorkspaceFiles(repoRoot, ['large.ts']);

    await fs.writeFile(file, 'aaa222zzz');
    const after = await fingerprintReviewCappedWorkspaceFiles(repoRoot, ['large.ts']);

    expect(after).not.toBe(before);
  });

  it('distinguishes a present file from a deleted capped path', async () => {
    const repoRoot = await makeTempDir();
    const file = path.join(repoRoot, 'deleted.ts');
    await fs.writeFile(file, 'content');
    const before = await fingerprintReviewCappedWorkspaceFiles(repoRoot, ['deleted.ts']);

    await fs.unlink(file);
    const after = await fingerprintReviewCappedWorkspaceFiles(repoRoot, ['deleted.ts']);

    expect(after).not.toBe(before);
  });

  it('never reads sensitive capped paths', async () => {
    const repoRoot = await makeTempDir();
    const sensitive = path.join(repoRoot, '.env.local');
    await fs.writeFile(sensitive, 'TOKEN=first');
    const before = await fingerprintReviewCappedWorkspaceFiles(repoRoot, ['.env.local']);

    await fs.writeFile(sensitive, 'TOKEN=other');
    const after = await fingerprintReviewCappedWorkspaceFiles(repoRoot, ['.env.local']);

    expect(after).toBe(before);
  });

  it('fails closed for traversal and an outside symlink', async () => {
    const repoRoot = await makeTempDir();
    await expect(
      fingerprintReviewCappedWorkspaceFiles(repoRoot, ['../outside.ts']),
    ).rejects.toBeInstanceOf(ReviewCappedWorkspaceFingerprintError);

    if (process.platform === 'win32') return;
    const outside = await makeTempDir();
    await fs.writeFile(path.join(outside, 'outside.ts'), 'outside');
    await fs.symlink(path.join(outside, 'outside.ts'), path.join(repoRoot, 'linked.ts'));
    await expect(
      fingerprintReviewCappedWorkspaceFiles(repoRoot, ['linked.ts']),
    ).rejects.toBeInstanceOf(ReviewCappedWorkspaceFingerprintError);

    await fs.writeFile(path.join(repoRoot, '.env.local'), 'TOKEN=secret');
    await fs.symlink('.env.local', path.join(repoRoot, 'safe-name.ts'));
    await expect(
      fingerprintReviewCappedWorkspaceFiles(repoRoot, ['safe-name.ts']),
    ).rejects.toBeInstanceOf(ReviewCappedWorkspaceFingerprintError);
  });

  it('fails closed instead of degrading to metadata above the byte limit', async () => {
    const repoRoot = await makeTempDir();
    await fs.writeFile(path.join(repoRoot, 'large.ts'), '1234');

    await expect(
      fingerprintReviewCappedWorkspaceFiles(repoRoot, ['large.ts'], { maxTotalBytes: 3 }),
    ).rejects.toBeInstanceOf(ReviewCappedWorkspaceFingerprintLimitError);
  });
});

import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fingerprintReviewArtifacts,
  prepareWithStableReviewArtifacts,
  ReviewArtifactChangedDuringPreparationError,
  ReviewArtifactFingerprintChangedError,
  ReviewArtifactFingerprintLimitError,
} from '../reviewArtifactFingerprint.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-review-fingerprint-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('review artifact fingerprint', () => {
  it('changes for same-size file edits and nested directory edits', async () => {
    const dir = await makeTempDir();
    const nested = path.join(dir, 'nested');
    await fs.mkdir(nested);
    const file = path.join(nested, 'draft.txt');
    await fs.writeFile(file, 'alpha');
    const before = await fingerprintReviewArtifacts([dir]);

    await fs.writeFile(file, 'bravo');
    const after = await fingerprintReviewArtifacts([dir]);

    expect(after).not.toBe(before);
  });

  it('hashes the unchanged-metadata middle of large files instead of sampling their ends', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'large.bin');
    const fixedTime = new Date('2024-01-01T00:00:00.000Z');
    await fs.writeFile(file, Buffer.alloc(9 * 1024 * 1024, 0x61));
    await fs.utimes(file, fixedTime, fixedTime);
    const beforeStat = await fs.stat(file);
    const before = await fingerprintReviewArtifacts([file]);

    const handle = await fs.open(file, 'r+');
    try {
      await handle.write(Buffer.from('changed!'), 0, 8, 4 * 1024 * 1024);
    } finally {
      await handle.close();
    }
    await fs.utimes(file, fixedTime, fixedTime);
    const afterStat = await fs.stat(file);
    const after = await fingerprintReviewArtifacts([file]);

    expect(afterStat.size).toBe(beforeStat.size);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(after).not.toBe(before);
  });

  it('uses locale-independent ordering for directory entries', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'z.txt'), 'z');
    await fs.writeFile(path.join(dir, 'ä.txt'), 'a');
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('locale-dependent ordering must not be used');
    });

    try {
      await expect(fingerprintReviewArtifacts([dir])).resolves.toMatch(/^[a-f0-9]{64}$/);
    } finally {
      localeCompare.mockRestore();
    }
  });

  it('does not read or fingerprint credential paths', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'draft.txt'), 'public');
    await fs.writeFile(path.join(dir, '.env.local'), 'TOKEN=first');
    const before = await fingerprintReviewArtifacts([dir]);

    await fs.writeFile(path.join(dir, '.env.local'), 'TOKEN=other');
    const after = await fingerprintReviewArtifacts([dir]);

    expect(after).toBe(before);
  });

  it('does not read or fingerprint denied dependency trees', async () => {
    const dir = await makeTempDir();
    const dependencyDir = path.join(dir, 'node_modules', 'dependency');
    await fs.mkdir(dependencyDir, { recursive: true });
    await fs.writeFile(path.join(dir, 'draft.txt'), 'public');
    await fs.writeFile(path.join(dependencyDir, 'index.js'), 'first');
    const before = await fingerprintReviewArtifacts([dir]);

    await fs.writeFile(path.join(dependencyDir, 'index.js'), 'other');
    const after = await fingerprintReviewArtifacts([dir]);

    expect(after).toBe(before);
  });

  it('changes when an explicit artifact disappears', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'draft.txt');
    await fs.writeFile(file, 'draft');
    const before = await fingerprintReviewArtifacts([file]);

    await fs.unlink(file);
    const after = await fingerprintReviewArtifacts([file]);

    expect(after).not.toBe(before);
  });

  it('fails closed instead of returning a truncated directory fingerprint', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'a.txt'), 'a');
    await fs.writeFile(path.join(dir, 'b.txt'), 'b');

    await expect(
      fingerprintReviewArtifacts([dir], { maxDirectoryEntries: 2 }),
    ).rejects.toBeInstanceOf(ReviewArtifactFingerprintLimitError);
  });

  it('fails closed instead of using metadata when the complete-content budget is exhausted', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'draft.txt');
    await fs.writeFile(file, '12345');

    await expect(fingerprintReviewArtifacts([file], { maxContentBytes: 4 })).rejects.toBeInstanceOf(
      ReviewArtifactFingerprintLimitError,
    );
  });

  it('rejects an atomic replacement between lstat and open', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'approved.txt');
    const replacement = path.join(dir, 'replacement.txt');
    await fs.writeFile(file, 'approved bytes');
    await fs.writeFile(replacement, 'different bytes');
    const artifactPath = await fs.realpath(file);
    let replaced = false;

    await expect(
      fingerprintReviewArtifacts([artifactPath], {
        openFile: async (filePath, flags) => {
          if (filePath === artifactPath && !replaced) {
            replaced = true;
            await fs.rm(file);
            await fs.rename(replacement, file);
          }
          return fs.open(filePath, flags);
        },
      }),
    ).rejects.toBeInstanceOf(ReviewArtifactFingerprintChangedError);
  });

  it('opens files with O_NOFOLLOW when the host supports it', async () => {
    if (typeof constants.O_NOFOLLOW !== 'number' || constants.O_NOFOLLOW === 0) return;
    const dir = await makeTempDir();
    const file = path.join(dir, 'approved.txt');
    const sensitive = path.join(dir, 'private-key');
    await fs.writeFile(file, 'approved bytes');
    await fs.writeFile(sensitive, 'sensitive bytes');
    const artifactPath = await fs.realpath(file);
    let capturedFlags = 0;

    await expect(
      fingerprintReviewArtifacts([artifactPath], {
        openFile: async (filePath, flags) => {
          capturedFlags = flags;
          await fs.rm(file);
          await fs.symlink(sensitive, file);
          return fs.open(filePath, flags);
        },
      }),
    ).rejects.toBeInstanceOf(ReviewArtifactFingerprintChangedError);
    expect(capturedFlags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
  });

  it('does not follow a symlink that already replaced an artifact root', async () => {
    if (process.platform === 'win32') return;
    const dir = await makeTempDir();
    const link = path.join(dir, 'approved.txt');
    const sensitive = path.join(dir, 'private-key');
    await fs.writeFile(sensitive, 'sensitive bytes');
    await fs.symlink(sensitive, link);
    const openFile = vi.fn((filePath: string, flags: number) => fs.open(filePath, flags));

    await expect(fingerprintReviewArtifacts([link], { openFile })).resolves.toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(openFile).not.toHaveBeenCalled();
  });

  it('rejects a hard link that already exists inside the artifact workspace', async () => {
    if (process.platform === 'win32') return;
    const root = await makeTempDir();
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside-secret.txt');
    const linked = path.join(workspace, 'linked.txt');
    await fs.mkdir(workspace);
    await fs.writeFile(outside, 'sensitive bytes');
    await fs.link(outside, linked);

    await expect(fingerprintReviewArtifacts([workspace])).rejects.toBeInstanceOf(
      ReviewArtifactFingerprintChangedError,
    );
  });

  it('rejects a same-size replacement between extraction and the first baseline', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'draft.txt');
    await fs.writeFile(file, 'alpha');

    await expect(
      prepareWithStableReviewArtifacts([file], async () => {
        const extracted = await fs.readFile(file, 'utf8');
        await fs.writeFile(file, 'bravo');
        return extracted;
      }),
    ).rejects.toBeInstanceOf(ReviewArtifactChangedDuringPreparationError);
  });
});

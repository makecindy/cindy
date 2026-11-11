import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ReviewRunOwner } from '../../../shared/reviewRun.js';
import {
  reviewArtifactPathIdentity,
  ReviewArtifactAuthorizationError,
  type ReviewExplicitArtifactGrant,
} from '../reviewArtifactAuthorization.js';
import {
  cleanupActiveReviewArtifactSnapshots,
  cleanupOrphanedReviewArtifactSnapshots,
  materializeReviewArtifactSnapshots,
  prepareStableReviewArtifactSnapshots,
  reviewArtifactSnapshotStatMatches,
} from '../reviewArtifactSnapshot.js';
import { ReviewArtifactChangedDuringPreparationError } from '../reviewArtifactFingerprint.js';

const tempDirs: string[] = [];
const canLinkFile = (() => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'review-snapshot-file-link-probe-'));
  try {
    const target = path.join(root, 'target');
    fsSync.writeFileSync(target, 'probe');
    fsSync.symlinkSync(target, path.join(root, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fsSync.rmSync(root, { recursive: true, force: true });
  }
})();
const TEST_OWNER: ReviewRunOwner = {
  instanceId: 'snapshot-test-owner',
  processId: process.pid,
  liveness: { version: 1, port: 65_534, token: 'snapshot-test-owner-token' },
};

async function writeSnapshotOwner(
  snapshotRoot: string,
  owner: ReviewRunOwner,
  createdAt = Date.now(),
): Promise<string> {
  const ownerPath = `${snapshotRoot}.owner.json`;
  await fs.writeFile(ownerPath, JSON.stringify({ version: 1, createdAt, owner }), {
    mode: 0o600,
  });
  return ownerPath;
}

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-review-snapshot-test-'));
  tempDirs.push(dir);
  return dir;
}

async function grantFor(paths: string[]): Promise<ReviewExplicitArtifactGrant> {
  return {
    paths,
    pathIdentities: new Map(
      await Promise.all(
        paths.map(
          async (artifactPath) =>
            [artifactPath, reviewArtifactPathIdentity(await fs.lstat(artifactPath))] as const,
        ),
      ),
    ),
    inlineAttachmentKeys: [],
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('materializeReviewArtifactSnapshots', () => {
  it('treats permission-mode drift as a snapshot stability failure', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'draft.md');
    await fs.writeFile(file, 'draft');
    const before = await fs.stat(file);
    const after = { ...before, mode: before.mode ^ 0o100 } as typeof before;

    expect(reviewArtifactSnapshotStatMatches(before, before)).toBe(true);
    expect(reviewArtifactSnapshotStatMatches(before, after)).toBe(false);
  });

  it('gives the reviewer a private immutable copy and removes it after the run', async () => {
    const workingDir = await tempDir();
    const externalDir = await tempDir();
    const sourcePath = path.join(externalDir, 'contract.md');
    await fs.writeFile(sourcePath, 'authorized version');
    const artifactPath = await fs.realpath(sourcePath);

    const materialized = await materializeReviewArtifactSnapshots({
      workingDir,
      grant: await grantFor([artifactPath]),
      owner: TEST_OWNER,
    });
    const snapshotPath = materialized.grant.snapshotPaths?.get(artifactPath);
    if (!snapshotPath) throw new Error('expected snapshot path');

    await fs.writeFile(sourcePath, 'replacement version');
    expect(await fs.readFile(snapshotPath, 'utf8')).toBe('authorized version');
    const snapshotRoot = path.dirname(snapshotPath);
    const ownerPath = `${snapshotRoot}.owner.json`;
    await expect(fs.readdir(snapshotRoot)).resolves.not.toContain(path.basename(ownerPath));
    await expect(fs.readFile(ownerPath, 'utf8')).resolves.toContain(TEST_OWNER.instanceId);
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.dirname(snapshotPath))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(snapshotPath)).mode & 0o777).toBe(0o600);
    }

    await materialized.cleanup();
    await expect(fs.stat(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(ownerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await materialized.cleanup();
  });

  it('snapshots an explicit scoped pnpm mirror inside the source workspace', async () => {
    if (process.platform === 'win32') return;
    const workingDir = await tempDir();
    const packageRoot = path.join(workingDir, 'packages', 'maker-core');
    const sourcePath = path.join(packageRoot, 'src', 'index.ts');
    const mirrorPath = path.join(
      workingDir,
      'node_modules',
      '@cindy',
      'maker-core',
      'src',
      'index.ts',
    );
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.mkdir(path.dirname(mirrorPath), { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'package.json'), '{"name":"@cindy/maker-core"}');
    await fs.writeFile(sourcePath, 'export const value = 1;');
    await fs.link(sourcePath, mirrorPath);
    const artifactPath = await fs.realpath(sourcePath);

    const prepared = await prepareStableReviewArtifactSnapshots({
      workingDir,
      grant: await grantFor([artifactPath]),
      owner: TEST_OWNER,
      prepare: async (snapshotGrant) => {
        const snapshotPath = snapshotGrant.snapshotPaths?.get(artifactPath);
        if (!snapshotPath) throw new Error('expected snapshot path');
        return fs.readFile(snapshotPath, 'utf8');
      },
    });
    expect(prepared.value).toBe('export const value = 1;');
    await prepared.cleanup();
  });

  it('keeps a scoped pnpm package-directory focus live while fingerprinting it', async () => {
    if (process.platform === 'win32') return;
    const workingDir = await tempDir();
    const packageRoot = path.join(workingDir, 'packages', 'maker-core');
    const sourcePath = path.join(packageRoot, 'src', 'index.ts');
    const mirrorPath = path.join(
      workingDir,
      'node_modules',
      '@cindy',
      'maker-core',
      'src',
      'index.ts',
    );
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.mkdir(path.dirname(mirrorPath), { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'package.json'), '{"name":"@cindy/maker-core"}');
    await fs.writeFile(sourcePath, 'export const value = 1;');
    await fs.link(sourcePath, mirrorPath);
    const artifactPath = await fs.realpath(packageRoot);

    const prepared = await prepareStableReviewArtifactSnapshots({
      workingDir,
      grant: await grantFor([artifactPath]),
      owner: TEST_OWNER,
      prepare: async (snapshotGrant) => snapshotGrant.liveDirectoryPaths,
    });
    expect(prepared.value).toEqual([artifactPath]);
    await prepared.cleanup();
  });

  it('rejects a pnpm mirror replaced with an outside link after validation', async () => {
    if (process.platform === 'win32') return;
    const workingDir = await tempDir();
    const outsideDir = await tempDir();
    const packageRoot = path.join(workingDir, 'packages', 'maker-core');
    const sourcePath = path.join(packageRoot, 'src', 'index.ts');
    const mirrorPath = path.join(
      workingDir,
      'node_modules',
      '@cindy',
      'maker-core',
      'src',
      'index.ts',
    );
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.mkdir(path.dirname(mirrorPath), { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'package.json'), '{"name":"@cindy/maker-core"}');
    await fs.writeFile(sourcePath, 'export const value = 1;');
    await fs.link(sourcePath, mirrorPath);
    const artifactPath = await fs.realpath(sourcePath);
    const grant = await grantFor([artifactPath]);
    let replaced = false;

    await expect(
      materializeReviewArtifactSnapshots({
        workingDir,
        grant,
        owner: TEST_OWNER,
        openFile: async (filePath, flags) => {
          if (filePath === artifactPath && !replaced) {
            replaced = true;
            await fs.unlink(mirrorPath);
            await fs.link(sourcePath, path.join(outsideDir, 'outside-link.ts'));
          }
          return fs.open(filePath, flags);
        },
      }),
    ).rejects.toBeInstanceOf(ReviewArtifactAuthorizationError);
  });

  it('rejects a symlink substituted after the original path was authorized', async () => {
    if (!canLinkFile) return;
    const workingDir = await tempDir();
    const externalDir = await tempDir();
    const sourcePath = path.join(externalDir, 'poster.png');
    const sensitivePath = path.join(externalDir, 'private-key');
    await fs.writeFile(sourcePath, 'approved image');
    await fs.writeFile(sensitivePath, 'sensitive bytes');
    const artifactPath = await fs.realpath(sourcePath);
    const grant = await grantFor([artifactPath]);
    await fs.rm(sourcePath);
    await fs.symlink(sensitivePath, sourcePath);

    await expect(
      materializeReviewArtifactSnapshots({
        workingDir,
        grant,
        owner: TEST_OWNER,
      }),
    ).rejects.toBeInstanceOf(ReviewArtifactAuthorizationError);
  });

  it('rejects a hard link substituted after the original path was authorized', async () => {
    if (process.platform === 'win32') return;
    const workingDir = await tempDir();
    const externalDir = await tempDir();
    const sourcePath = path.join(externalDir, 'approved.txt');
    const sensitivePath = path.join(externalDir, 'private-key');
    await fs.writeFile(sourcePath, 'approved bytes');
    await fs.writeFile(sensitivePath, 'sensitive bytes');
    const artifactPath = await fs.realpath(sourcePath);
    const grant = await grantFor([artifactPath]);

    await fs.rm(sourcePath);
    await fs.link(sensitivePath, sourcePath);

    await expect(
      materializeReviewArtifactSnapshots({ workingDir, grant, owner: TEST_OWNER }),
    ).rejects.toBeInstanceOf(ReviewArtifactAuthorizationError);
  });

  it('rejects a hard link that already exists when snapshotting starts', async () => {
    if (process.platform === 'win32') return;
    const workingDir = await tempDir();
    const externalDir = await tempDir();
    const outside = path.join(externalDir, 'outside-secret.txt');
    const linked = path.join(externalDir, 'linked.txt');
    await fs.writeFile(outside, 'sensitive bytes');
    await fs.link(outside, linked);

    await expect(
      materializeReviewArtifactSnapshots({
        workingDir,
        grant: await grantFor([linked]),
        owner: TEST_OWNER,
      }),
    ).rejects.toThrow(/multiply linked/i);
  });

  it('rejects an atomic replacement after the original path was authorized', async () => {
    const workingDir = await tempDir();
    const externalDir = await tempDir();
    const sourcePath = path.join(externalDir, 'approved.txt');
    const replacementPath = path.join(externalDir, 'replacement.txt');
    await fs.writeFile(sourcePath, 'approved bytes');
    await fs.writeFile(replacementPath, 'different bytes');
    const artifactPath = await fs.realpath(sourcePath);
    const grant = await grantFor([artifactPath]);

    await fs.rename(replacementPath, sourcePath);

    await expect(
      materializeReviewArtifactSnapshots({ workingDir, grant, owner: TEST_OWNER }),
    ).rejects.toBeInstanceOf(ReviewArtifactAuthorizationError);
  });

  it('rejects an atomic replacement between lstat and open', async () => {
    const workingDir = await tempDir();
    const externalDir = await tempDir();
    const sourcePath = path.join(externalDir, 'approved.txt');
    const replacementPath = path.join(externalDir, 'replacement.txt');
    await fs.writeFile(sourcePath, 'approved bytes');
    await fs.writeFile(replacementPath, 'different bytes');
    const artifactPath = await fs.realpath(sourcePath);
    const grant = await grantFor([artifactPath]);
    let replaced = false;

    await expect(
      materializeReviewArtifactSnapshots({
        workingDir,
        grant,
        owner: TEST_OWNER,
        openFile: async (filePath, flags) => {
          if (filePath === artifactPath && !replaced) {
            replaced = true;
            await fs.rm(sourcePath);
            await fs.rename(replacementPath, sourcePath);
          }
          return fs.open(filePath, flags);
        },
      }),
    ).rejects.toBeInstanceOf(ReviewArtifactAuthorizationError);
  });

  it('does not grant an unsnapshotted external directory to a reviewer', async () => {
    const workingDir = await tempDir();
    const externalDir = await tempDir();

    await expect(
      materializeReviewArtifactSnapshots({
        workingDir,
        grant: await grantFor([externalDir]),
        owner: TEST_OWNER,
      }),
    ).rejects.toThrow('one file at a time');
  });

  it('keeps snapshot creation inside the live-artifact stability window', async () => {
    const workingDir = await tempDir();
    const externalDir = await tempDir();
    const sourcePath = path.join(externalDir, 'draft.md');
    await fs.writeFile(sourcePath, 'first version');
    const artifactPath = await fs.realpath(sourcePath);

    await expect(
      prepareStableReviewArtifactSnapshots({
        workingDir,
        grant: await grantFor([artifactPath]),
        owner: TEST_OWNER,
        prepare: async (snapshotGrant) => {
          const snapshotPath = snapshotGrant.snapshotPaths?.get(artifactPath);
          if (!snapshotPath) throw new Error('expected snapshot path');
          const extracted = await fs.readFile(snapshotPath, 'utf8');
          await fs.writeFile(sourcePath, 'later version');
          return extracted;
        },
      }),
    ).rejects.toBeInstanceOf(ReviewArtifactChangedDuringPreparationError);
  });

  it('reaps only strict dead-process snapshot roots', async () => {
    const scanRoot = await tempDir();
    const deadRoot = path.join(scanRoot, 'cindy-review-artifacts-v1-424242-Ab12Cd');
    const lookalikeRoot = path.join(scanRoot, 'cindy-review-artifacts-424242-Ab12Cd');
    const liveRoot = path.join(scanRoot, 'cindy-review-artifacts-v1-313131-Ef34Gh');
    await fs.mkdir(deadRoot);
    await fs.mkdir(lookalikeRoot);
    await fs.mkdir(liveRoot);
    await fs.writeFile(path.join(deadRoot, 'artifact.txt'), 'stale');

    await cleanupOrphanedReviewArtifactSnapshots({
      currentOwner: TEST_OWNER,
      tempRoot: scanRoot,
      processIsAlive: (pid) => pid === 313131,
    });

    await expect(fs.lstat(deadRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(lookalikeRoot)).resolves.toBeDefined();
    await expect(fs.lstat(liveRoot)).resolves.toBeDefined();
  });

  it('does not follow a snapshot-shaped symlink while reaping orphans', async () => {
    const scanRoot = await tempDir();
    const targetRoot = await tempDir();
    const targetFile = path.join(targetRoot, 'keep.txt');
    const linkPath = path.join(scanRoot, 'cindy-review-artifacts-v1-424242-Ij56Kl');
    await fs.writeFile(targetFile, 'keep');
    await fs.symlink(
      targetRoot,
      linkPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await cleanupOrphanedReviewArtifactSnapshots({
      currentOwner: TEST_OWNER,
      tempRoot: scanRoot,
      processIsAlive: () => false,
    });

    await expect(fs.lstat(linkPath)).resolves.toMatchObject({ mode: expect.any(Number) });
    await expect(fs.readFile(targetFile, 'utf8')).resolves.toBe('keep');
  });

  it('reaps a crashed v2 snapshot even when its PID belongs to another live process', async () => {
    const scanRoot = await tempDir();
    const staleRoot = path.join(scanRoot, 'cindy-review-artifacts-v2-424242-Kl78Mn');
    const staleOwner: ReviewRunOwner = {
      instanceId: 'crashed-owner',
      processId: 424242,
      liveness: { version: 1, port: 12_345, token: 'crashed-owner-token' },
    };
    await fs.mkdir(staleRoot);
    const ownerPath = await writeSnapshotOwner(staleRoot, staleOwner);
    await fs.writeFile(path.join(staleRoot, 'artifact.txt'), 'sensitive snapshot');

    await cleanupOrphanedReviewArtifactSnapshots({
      currentOwner: TEST_OWNER,
      tempRoot: scanRoot,
      processIsAlive: () => true,
      ownerLivenessProbe: (owner) =>
        owner.instanceId === staleOwner.instanceId ? 'ended' : 'unknown',
    });

    await expect(fs.lstat(staleRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(ownerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a v2 snapshot owned by the exact live Main instance', async () => {
    const scanRoot = await tempDir();
    const liveRoot = path.join(scanRoot, 'cindy-review-artifacts-v2-424242-Op90Qr');
    const liveOwner: ReviewRunOwner = {
      instanceId: 'live-owner',
      processId: 424242,
      liveness: { version: 1, port: 23_456, token: 'live-owner-token-1' },
    };
    await fs.mkdir(liveRoot);
    const ownerPath = await writeSnapshotOwner(liveRoot, liveOwner);

    await cleanupOrphanedReviewArtifactSnapshots({
      currentOwner: TEST_OWNER,
      tempRoot: scanRoot,
      processIsAlive: () => true,
      ownerLivenessProbe: () => 'alive',
    });

    await expect(fs.lstat(liveRoot)).resolves.toBeDefined();
    await expect(fs.lstat(ownerPath)).resolves.toBeDefined();
  });

  it('bounds cleanup of an unverifiable legacy snapshot whose PID stays alive', async () => {
    const scanRoot = await tempDir();
    const staleRoot = path.join(scanRoot, 'cindy-review-artifacts-v1-424242-St12Uv');
    const now = Date.now() + 10_000;
    await fs.mkdir(staleRoot);
    await fs.utimes(staleRoot, new Date(1_000), new Date(1_000));

    await cleanupOrphanedReviewArtifactSnapshots({
      currentOwner: TEST_OWNER,
      tempRoot: scanRoot,
      processIsAlive: () => true,
      now: () => now,
      maxUnverifiableAgeMs: 1_000,
    });

    await expect(fs.lstat(staleRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes active snapshots during normal process cleanup', async () => {
    const workingDir = await tempDir();
    const externalDir = await tempDir();
    const sourcePath = path.join(externalDir, 'contract.md');
    await fs.writeFile(sourcePath, 'authorized version');
    const artifactPath = await fs.realpath(sourcePath);
    const materialized = await materializeReviewArtifactSnapshots({
      workingDir,
      grant: await grantFor([artifactPath]),
      owner: TEST_OWNER,
    });
    const snapshotPath = materialized.grant.snapshotPaths?.get(artifactPath);
    if (!snapshotPath) throw new Error('expected snapshot path');

    await cleanupActiveReviewArtifactSnapshots();

    await expect(fs.lstat(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await materialized.cleanup();
  });
});

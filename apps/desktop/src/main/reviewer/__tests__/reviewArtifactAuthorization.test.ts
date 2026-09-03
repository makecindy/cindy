import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BigIntStats } from 'node:fs';

import {
  assertReviewExplicitPathGranted,
  authorizeReviewExplicitArtifacts,
  isPathWithinReviewWorkspace,
  reviewArtifactHandleIdentityMatches,
  reviewArtifactPathIdentityMatches,
  ReviewArtifactAuthorizationError,
  type ResolvedReviewArtifactPath,
  type ReviewArtifactPathIdentity,
} from '../reviewArtifactAuthorization.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-review-auth-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('authorizeReviewExplicitArtifacts', () => {
  it('grants workspace paths without prompting', async () => {
    const workingDir = await tempDir();
    const requestedPath = path.join(workingDir, 'draft.md');
    await fs.writeFile(requestedPath, 'draft');
    const artifactPath = await fs.realpath(requestedPath);
    const confirm = vi.fn(async () => true);

    const grant = await authorizeReviewExplicitArtifacts({
      workingDir,
      focus: 'draft.md',
      attachments: [],
      resolvePath: async () => ({ absPath: artifactPath, managed: false }),
      confirm,
    });

    expect(grant.paths).toEqual([artifactPath]);
    expect(grant.inlineAttachmentKeys).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('grants an explicit scoped pnpm mirror but rejects an additional outside link', async () => {
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
    const confirm = vi.fn(async () => true);
    const authorize = () =>
      authorizeReviewExplicitArtifacts({
        workingDir,
        focus: sourcePath,
        attachments: [],
        resolvePath: async () => ({ absPath: artifactPath, managed: false }),
        confirm,
      });

    await expect(authorize()).resolves.toMatchObject({ paths: [artifactPath] });
    expect(confirm).not.toHaveBeenCalled();

    const outsideDir = await tempDir();
    await fs.link(sourcePath, path.join(outsideDir, 'third-link.ts'));
    await expect(authorize()).rejects.toThrow(/multiply linked/i);
  });

  it('rejects a pre-existing hard-linked artifact before confirmation', async () => {
    if (process.platform === 'win32') return;
    const workingDir = await tempDir();
    const externalDir = await tempDir();
    const outside = path.join(externalDir, 'outside-secret.txt');
    const linked = path.join(externalDir, 'linked.txt');
    await fs.writeFile(outside, 'sensitive bytes');
    await fs.link(outside, linked);
    const confirm = vi.fn(async () => true);

    await expect(
      authorizeReviewExplicitArtifacts({
        workingDir,
        attachments: [{ name: 'linked.txt', path: linked }],
        resolvePath: async () => ({ absPath: linked, managed: false }),
        confirm,
      }),
    ).rejects.toThrow(/multiply linked/i);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('requires a one-run confirmation for external paths and rejects cancellation', async () => {
    const workingDir = await tempDir();
    const externalDir = await tempDir();
    const artifactPath = path.join(externalDir, 'contract.pdf');
    await fs.writeFile(artifactPath, 'pdf');
    const resolvePath = async (): Promise<ResolvedReviewArtifactPath> => ({
      absPath: artifactPath,
      managed: false,
    });
    const confirm = vi.fn(async () => false);

    await expect(
      authorizeReviewExplicitArtifacts({
        workingDir,
        attachments: [{ name: 'contract.pdf', path: artifactPath }],
        resolvePath,
        confirm,
      }),
    ).rejects.toBeInstanceOf(ReviewArtifactAuthorizationError);
    expect(confirm).toHaveBeenCalledWith([
      { kind: 'external-path', label: 'contract.pdf', path: artifactPath },
    ]);
  });

  it('uses the first resolvable managed URL and never grants its unused raw path', async () => {
    const workingDir = await tempDir();
    const managedPath = path.join(await tempDir(), 'cached.png');
    const externalPath = path.join(await tempDir(), 'original.png');
    await fs.writeFile(managedPath, 'managed image');
    const resolvePath = vi.fn(async (rawPath: string) =>
      rawPath.startsWith('xdt-image://')
        ? { absPath: managedPath, managed: true }
        : { absPath: externalPath, managed: false },
    );
    const confirm = vi.fn(async () => true);

    const grant = await authorizeReviewExplicitArtifacts({
      workingDir,
      attachments: [
        {
          name: 'poster.png',
          url: 'xdt-image://cached.png',
          path: externalPath,
        },
      ],
      resolvePath,
      confirm,
    });

    expect(grant.paths).toEqual([managedPath]);
    expect(grant.pathIdentities.has(managedPath)).toBe(true);
    expect(resolvePath).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('requires confirmation before accepting renderer-only inline bytes', async () => {
    const workingDir = await tempDir();
    const confirm = vi.fn(async () => true);

    const grant = await authorizeReviewExplicitArtifacts({
      workingDir,
      attachments: [{ name: 'fallback.png', base64: 'aW1hZ2U=' }],
      resolvePath: async () => null,
      confirm,
    });

    expect(grant.inlineAttachmentKeys).toHaveLength(1);
    expect(confirm).toHaveBeenCalledWith([{ kind: 'inline', label: 'fallback.png' }]);
  });

  it('binds native consent to each distinct inline payload even when labels collide', async () => {
    const workingDir = await tempDir();
    const confirm = vi.fn(async () => true);
    const attachments = [
      {
        name: 'a.png',
        originalName: 'same.png',
        base64: 'Zmlyc3Q=',
        category: 'image' as const,
        mimeType: 'image/png',
      },
      {
        name: 'b.png',
        originalName: 'same.png',
        base64: 'c2Vjb25k',
        category: 'image' as const,
        mimeType: 'image/png',
      },
    ];

    const grant = await authorizeReviewExplicitArtifacts({
      workingDir,
      attachments,
      resolvePath: async () => null,
      confirm,
    });

    expect(grant.inlineAttachmentKeys).toHaveLength(2);
    expect(confirm).toHaveBeenCalledWith([
      { kind: 'inline', label: 'same.png' },
      { kind: 'inline', label: 'same.png' },
    ]);
  });

  it('fails closed if a path resolves somewhere else after the grant', () => {
    expect(() =>
      assertReviewExplicitPathGranted('/outside/replaced.pdf', {
        paths: ['/outside/original.pdf'],
        pathIdentities: new Map(),
        inlineAttachmentKeys: [],
      }),
    ).toThrow(ReviewArtifactAuthorizationError);
  });
});

describe('isPathWithinReviewWorkspace', () => {
  it('does not mistake a sibling with the same prefix for a workspace child', () => {
    expect(isPathWithinReviewWorkspace('/work/project', '/work/project/src/a.ts')).toBe(true);
    expect(isPathWithinReviewWorkspace('/work/project', '/work/project-other/a.ts')).toBe(false);
  });
});

describe('reviewArtifactHandleIdentityMatches vs reviewArtifactPathIdentityMatches', () => {
  function makeIdentity(overrides: Partial<ReviewArtifactPathIdentity> = {}): ReviewArtifactPathIdentity {
    return {
      dev: 0n,
      ino: 123n,
      size: 10n,
      mode: 0o100644n,
      mtimeNs: 1000n,
      ctimeNs: 1000n,
      ...overrides,
    };
  }

  it('the path-vs-path helper trusts ino alone once both sides report dev=0 (expected for two path stats, Windows-only fallback)', () => {
    // dev=0 on both sides only falls back to ino-only trust on win32 (see fileIdentity.ts's
    // own tests for the same explicit-platform pattern); on POSIX a real dev is always
    // available and dev=0 is never trusted, so this must pin 'win32' rather than rely on
    // whichever OS happens to run the suite.
    const before = makeIdentity({ dev: 0n });
    const after = makeIdentity({ dev: 0n }) as unknown as BigIntStats;
    expect(reviewArtifactPathIdentityMatches(before, after, 'win32')).toBe(true);
  });

  it('the path-vs-handle helper refuses the same dev=0/dev=0 pair a path-vs-path check would accept', () => {
    // Regression for the P1 finding on reviewArtifactFingerprint.ts / reviewArtifactSnapshot.ts:
    // path stats report dev=0 on Windows, but an opened handle reports the real volume id.
    // Accepting two dev=0 sides here means trusting ino alone, and NTFS FileIds are only
    // unique within a volume -- a cross-volume swap with a colliding ino would pass.
    const pathIdentity = makeIdentity({ dev: 0n });
    const handleStatBothZero = makeIdentity({ dev: 0n }) as unknown as BigIntStats;
    expect(reviewArtifactHandleIdentityMatches(pathIdentity, handleStatBothZero, 'win32')).toBe(false);
  });

  it('the path-vs-handle helper accepts the pair once the handle side reports a real volume id (Windows-only fallback)', () => {
    const pathIdentity = makeIdentity({ dev: 0n });
    const handleStatRealDev = makeIdentity({ dev: 7n }) as unknown as BigIntStats;
    expect(reviewArtifactHandleIdentityMatches(pathIdentity, handleStatRealDev, 'win32')).toBe(true);
  });

  it('the path-vs-handle helper still rejects on a genuine ino mismatch', () => {
    const pathIdentity = makeIdentity({ dev: 0n, ino: 123n });
    const handleStatDifferentFile = makeIdentity({ dev: 7n, ino: 456n }) as unknown as BigIntStats;
    expect(reviewArtifactHandleIdentityMatches(pathIdentity, handleStatDifferentFile)).toBe(false);
  });
});

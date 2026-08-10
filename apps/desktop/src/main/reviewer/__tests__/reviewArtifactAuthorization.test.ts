import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertReviewExplicitPathGranted,
  authorizeReviewExplicitArtifacts,
  isPathWithinReviewWorkspace,
  ReviewArtifactAuthorizationError,
  type ResolvedReviewArtifactPath,
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

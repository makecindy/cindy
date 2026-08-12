import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readReviewDataMock, readReviewBranchDiffMock, reviewRows, utilityProcessFork } = vi.hoisted(
  () => ({
    readReviewDataMock: vi.fn(),
    readReviewBranchDiffMock: vi.fn(),
    reviewRows: [] as Array<Record<string, unknown>>,
    utilityProcessFork: vi.fn(),
  }),
);

vi.mock('electron', () => ({ utilityProcess: { fork: utilityProcessFork } }));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    drizzle: {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: async (limit: number) => reviewRows.slice(0, limit) }),
          }),
        }),
      }),
    },
  }),
}));
vi.mock('../../git-review/ipc.js', () => ({
  readReviewData: readReviewDataMock,
  readReviewBranchDiff: readReviewBranchDiffMock,
}));
vi.mock('../../turn-change-set/store.js', () => ({
  listTurnChangeSets: async () => [],
  getTurnChangeSets: async () => [],
}));
vi.mock('../../imageCacheStore.js', () => ({
  collectSessionImageUrls: () => [],
  resolveSafe: () => {
    throw new Error('not used');
  },
}));
vi.mock('../../cindy-media/chatAttachments.js', () => ({
  collectCindyMediaUrls: () => [],
}));
vi.mock('../../cindy-media/blobStore.js', () => ({
  resolveSafe: () => {
    throw new Error('not used');
  },
}));

import {
  authorizeReviewExplicitArtifacts,
  ReviewArtifactAuthorizationError,
} from '../reviewArtifactAuthorization.js';
import type { ReviewPdfUtilityChildLike } from '../reviewPdfProcess.js';
import type { ReviewPdfUtilityRequest } from '../reviewPdfProcessProtocol.js';
import type { ReviewData } from '../../../shared/gitReviewWire.js';
import {
  fingerprintReviewCappedWorkspaceFiles,
  ReviewCappedWorkspaceChangedError,
} from '../reviewCappedWorkspaceFingerprint.js';
import {
  listReviewHistoricalAttachments,
  loadReviewEvidence,
  readReviewContextFingerprint,
  readReviewWorkspaceSnapshot,
  reviewBranchBaselineIsCurrent,
  reviewWorkspaceFingerprintIsCurrent,
} from '../reviewEvidence.js';

const tempDirs: string[] = [];

class RejectingPdfUtility extends EventEmitter implements ReviewPdfUtilityChildLike {
  postMessage(message: unknown): void {
    const request = message as ReviewPdfUtilityRequest;
    queueMicrotask(() => {
      this.emit('message', {
        kind: 'result',
        id: request.id,
        ok: false,
        error: 'invalid PDF fixture',
      });
    });
  }

  kill(): boolean {
    return true;
  }
}

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-review-evidence-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  readReviewDataMock.mockResolvedValue(nonGitReviewData());
  readReviewBranchDiffMock.mockResolvedValue({
    scope: null,
    baseRef: null,
    baseOid: null,
    headOid: null,
    mergeBaseOid: null,
    candidates: [],
    diffs: [],
    capped: null,
    warning: null,
  });
  utilityProcessFork.mockImplementation(() => new RejectingPdfUtility());
});

afterEach(async () => {
  reviewRows.splice(0);
  readReviewDataMock.mockReset();
  readReviewBranchDiffMock.mockReset();
  utilityProcessFork.mockReset();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function cappedReviewData(repoRoot: string, filePath: string): ReviewData {
  const scope = {
    sessionId: 'source',
    workdir: repoRoot,
    worktreePath: repoRoot,
    workingDir: repoRoot,
    repoRoot,
    branch: 'feature',
    headOid: 'a'.repeat(40),
    isDetached: false,
    isUnborn: false,
    source: 'workingDir' as const,
    aheadBehind: { ahead: 0, behind: 0, upstream: null, stale: false },
    disabledReason: null,
    disabledMessage: null,
    resolutionChain: [],
  };
  const statusFile = {
    path: filePath,
    oldPath: null,
    indexStatus: null,
    worktreeStatus: 'modified' as const,
    isUntracked: false,
    isUnmerged: false,
    isSubmodule: false,
    sources: ['unstaged' as const],
    rawXY: ' M',
  };
  const cappedFile = {
    id: `unstaged:${filePath}`,
    source: 'unstaged' as const,
    path: filePath,
    oldPath: null,
    status: 'modified' as const,
    additions: 1,
    deletions: 1,
    changedLines: 2,
    changedBytes: 9,
    isBinary: false,
    isSubmodule: false,
  };
  return {
    scope,
    status: {
      scope,
      files: [statusFile],
      stagedCount: 0,
      unstagedCount: 1,
      untrackedCount: 0,
      unmergedCount: 0,
      inProgress: [],
      writeDisabledReasons: [],
      dirty: true,
    },
    diffs: {
      staged: [],
      unstaged: [],
      capped: {
        staged: null,
        unstaged: {
          reason: 'changed-bytes',
          stats: { fileCount: 1, totalChangedLines: 2, totalChangedBytes: 9 },
          files: [cappedFile],
        },
      },
    },
    summary: {
      sessionId: 'source',
      disabledReason: null,
      disabledMessage: null,
      totalFiles: 1,
      stagedFiles: 0,
      unstagedFiles: 1,
      untrackedFiles: 0,
      unmergedFiles: 0,
      dirty: true,
    },
  };
}

function branchFileDiff(filePath: string) {
  return {
    id: `branch:${filePath}`,
    source: 'branch' as const,
    path: filePath,
    oldPath: null,
    status: 'modified' as const,
    kind: 'text' as const,
    size: 12,
    additions: 1,
    deletions: 0,
    isBinary: false,
    isSubmodule: false,
    isTooLarge: false,
    mode: { old: null, new: null },
    index: { oldOid: null, newOid: null },
    rawHeader: `diff --git a/${filePath} b/${filePath}`,
    rawPatch: '@@ -1 +1 @@\n-old\n+new',
    hunks: [],
    error: null,
  };
}

/** A dirty workspace whose only change is a binary file — a diff with no content. */
function binaryReviewData(repoRoot: string, filePath: string): ReviewData {
  const data = cappedReviewData(repoRoot, filePath);
  return {
    ...data,
    diffs: {
      staged: [],
      unstaged: [
        {
          ...branchFileDiff(filePath),
          id: `unstaged:${filePath}`,
          source: 'unstaged' as const,
          kind: 'binary' as const,
          isBinary: true,
          rawHeader: '',
          rawPatch: '',
          additions: 0,
          deletions: 0,
          error: 'Binary file',
        },
      ],
      capped: { staged: null, unstaged: null },
    },
  };
}

/** A Git workspace with everything committed, which is when branch review applies. */
function cleanGitReviewData(repoRoot: string): ReviewData {
  const scope = {
    sessionId: 'source',
    workdir: repoRoot,
    worktreePath: repoRoot,
    workingDir: repoRoot,
    repoRoot,
    branch: 'feature',
    headOid: 'a'.repeat(40),
    isDetached: false,
    isUnborn: false,
    source: 'workingDir' as const,
    aheadBehind: { ahead: 1, behind: 0, upstream: 'origin/main', stale: false },
    disabledReason: null,
    disabledMessage: null,
    resolutionChain: [],
  };
  return {
    scope,
    status: {
      scope,
      files: [],
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      unmergedCount: 0,
      inProgress: [],
      writeDisabledReasons: [],
      dirty: false,
    },
    diffs: { staged: [], unstaged: [], capped: { staged: null, unstaged: null } },
    summary: {
      sessionId: 'source',
      disabledReason: null,
      disabledMessage: null,
      totalFiles: 0,
      stagedFiles: 0,
      unstagedFiles: 0,
      untrackedFiles: 0,
      unmergedFiles: 0,
      dirty: false,
    },
  };
}

function nonGitReviewData(): ReviewData {
  const scope = {
    sessionId: 'source',
    workdir: '/tmp/non-git-review',
    worktreePath: null,
    workingDir: '/tmp/non-git-review',
    repoRoot: null,
    branch: null,
    headOid: null,
    isDetached: false,
    isUnborn: false,
    source: 'workingDir' as const,
    aheadBehind: { ahead: 0, behind: 0, upstream: null, stale: false },
    disabledReason: 'non-git' as const,
    disabledMessage: 'Not a Git repository',
    resolutionChain: [],
  };
  return {
    scope,
    status: null,
    diffs: { staged: [], unstaged: [], capped: { staged: null, unstaged: null } },
    summary: {
      sessionId: 'source',
      disabledReason: 'non-git',
      disabledMessage: 'Not a Git repository',
      totalFiles: 0,
      stagedFiles: 0,
      unstagedFiles: 0,
      untrackedFiles: 0,
      unmergedFiles: 0,
      dirty: false,
    },
  };
}

describe('readReviewWorkspaceSnapshot', () => {
  it('fails closed when the Git evidence read throws instead of treating it as non-Git', async () => {
    const failure = new Error('git index is locked');
    readReviewDataMock.mockRejectedValue(failure);

    await expect(readReviewWorkspaceSnapshot('source')).rejects.toBe(failure);
    expect(readReviewDataMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the confirming Git evidence read throws', async () => {
    const repoRoot = await tempDir();
    const relativePath = 'large.ts';
    await fs.writeFile(path.join(repoRoot, relativePath), 'aaa111zzz');
    const failure = new Error('git diff became unreadable');
    readReviewDataMock
      .mockResolvedValueOnce(cappedReviewData(repoRoot, relativePath))
      .mockRejectedValueOnce(failure);

    await expect(readReviewWorkspaceSnapshot('source')).rejects.toBe(failure);
    expect(readReviewDataMock).toHaveBeenCalledTimes(2);
  });

  it('changes the fingerprint for a same-size capped file replacement', async () => {
    const repoRoot = await tempDir();
    const relativePath = 'large.ts';
    const file = path.join(repoRoot, relativePath);
    await fs.writeFile(file, 'aaa111zzz');
    const reviewData = cappedReviewData(repoRoot, relativePath);
    readReviewDataMock.mockResolvedValue(reviewData);

    const before = await readReviewWorkspaceSnapshot('source');
    await fs.writeFile(file, 'aaa222zzz');
    const after = await readReviewWorkspaceSnapshot('source');

    expect(after?.workspace).toEqual(before?.workspace);
    expect(after?.fingerprint).not.toBe(before?.fingerprint);
  });

  it('changes the fingerprint for a same-size binary replacement', async () => {
    // A binary diff carries no patch and no blob oids — only path, kind and
    // size — so without its own content hash, swapping the bytes for different
    // ones of the same length would leave the Git digest identical.
    const repoRoot = await tempDir();
    const relativePath = 'assets/logo.png';
    const file = path.join(repoRoot, relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.from([1, 2, 3, 4]));
    readReviewDataMock.mockResolvedValue(binaryReviewData(repoRoot, relativePath));

    const before = await readReviewWorkspaceSnapshot('source');
    await fs.writeFile(file, Buffer.from([5, 6, 7, 8]));
    const after = await readReviewWorkspaceSnapshot('source');

    expect(after?.workspace).toEqual(before?.workspace);
    expect(after?.fingerprint).not.toBe(before?.fingerprint);
  });

  it('does not hand a dirty submodule to the file fingerprinter', async () => {
    // A gitlink is a directory and the fingerprinter accepts only regular
    // files, so including it would abort evidence loading and make the whole
    // dirty workspace unreviewable. The cost of excluding it — edits inside
    // the submodule are not bound — is stated at the call site and tracked in
    // #2463; it is not offset by the porcelain status, which keeps no oid.
    const repoRoot = await tempDir();
    const submodulePath = 'vendor/lib';
    await fs.mkdir(path.join(repoRoot, submodulePath), { recursive: true });
    const data = binaryReviewData(repoRoot, submodulePath);
    readReviewDataMock.mockResolvedValue({
      ...data,
      diffs: {
        ...data.diffs,
        unstaged: data.diffs.unstaged.map((diff) => ({
          ...diff,
          kind: 'unrenderable' as const,
          isBinary: false,
          isSubmodule: true,
          error: null,
        })),
      },
    });

    await expect(readReviewWorkspaceSnapshot('source')).resolves.toBeTruthy();
  });

  it('marks prepared Git evidence stale when the workspace changes before launch', async () => {
    const repoRoot = await tempDir();
    const relativePath = 'tracked.ts';
    const file = path.join(repoRoot, relativePath);
    await fs.writeFile(file, 'before-value');
    readReviewDataMock.mockResolvedValue(cappedReviewData(repoRoot, relativePath));

    const prepared = await readReviewWorkspaceSnapshot('source');
    expect(prepared?.fingerprint).toBeTruthy();
    await expect(
      reviewWorkspaceFingerprintIsCurrent('source', prepared!.fingerprint),
    ).resolves.toBe(true);

    await fs.writeFile(file, 'after--value');
    await expect(
      reviewWorkspaceFingerprintIsCurrent('source', prepared!.fingerprint),
    ).resolves.toBe(false);
  });

  it('retries until the capped Git summary and file content share one stable window', async () => {
    const repoRoot = await tempDir();
    const relativePath = 'large.ts';
    const file = path.join(repoRoot, relativePath);
    await fs.writeFile(file, 'aaa111zzz');
    const reviewData = cappedReviewData(repoRoot, relativePath);
    let reads = 0;
    readReviewDataMock.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) await fs.writeFile(file, 'aaa222zzz');
      return reviewData;
    });

    const recovered = await readReviewWorkspaceSnapshot('source');
    readReviewDataMock.mockResolvedValue(reviewData);
    const stable = await readReviewWorkspaceSnapshot('source');

    expect(reads).toBe(4);
    expect(recovered?.fingerprint).toBe(stable?.fingerprint);
  });

  it('restarts the whole snapshot after a transient during-hash change', async () => {
    const repoRoot = await tempDir();
    const relativePath = 'large.ts';
    await fs.writeFile(path.join(repoRoot, relativePath), 'aaa111zzz');
    const reviewData = cappedReviewData(repoRoot, relativePath);
    readReviewDataMock.mockResolvedValue(reviewData);
    let fingerprintCalls = 0;

    const snapshot = await readReviewWorkspaceSnapshot('source', {
      fingerprintCappedWorkspaceFiles: async (...args) => {
        fingerprintCalls += 1;
        if (fingerprintCalls === 1) {
          throw new ReviewCappedWorkspaceChangedError('transient write');
        }
        return fingerprintReviewCappedWorkspaceFiles(...args);
      },
    });

    expect(snapshot?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintCalls).toBe(3);
  });

  it('fails closed after repeated during-hash changes', async () => {
    const repoRoot = await tempDir();
    const relativePath = 'large.ts';
    await fs.writeFile(path.join(repoRoot, relativePath), 'aaa111zzz');
    readReviewDataMock.mockResolvedValue(cappedReviewData(repoRoot, relativePath));
    const fingerprintCappedWorkspaceFiles = vi.fn(async () => {
      throw new ReviewCappedWorkspaceChangedError('continuous writes');
    });

    await expect(
      readReviewWorkspaceSnapshot('source', { fingerprintCappedWorkspaceFiles }),
    ).rejects.toBeInstanceOf(ReviewCappedWorkspaceChangedError);
    expect(fingerprintCappedWorkspaceFiles).toHaveBeenCalledTimes(3);
  });
});

describe('loadReviewEvidence attachment boundaries', () => {
  it('fingerprints source-task activity while ignoring Review lifecycle cards', async () => {
    const workingDir = await tempDir();
    reviewRows.push({
      role: 'user',
      content: JSON.stringify({ text: 'original request' }),
      agentMeta: null,
      createdAt: 1,
      id: 'message-1',
    });

    const evidence = await loadReviewEvidence({
      sourceSessionId: 'source',
      workingDir,
      attachments: [],
      explicitArtifactGrant: {
        paths: [],
        pathIdentities: new Map(),
        inlineAttachmentKeys: [],
      },
    });
    expect(await readReviewContextFingerprint('source')).toBe(evidence.contextFingerprint);

    reviewRows.push({
      role: 'assistant',
      content: JSON.stringify({ text: 'new result without file changes' }),
      agentMeta: null,
      createdAt: 2,
      id: 'message-2',
    });
    const changedFingerprint = await readReviewContextFingerprint('source');
    expect(changedFingerprint).not.toBe(evidence.contextFingerprint);

    reviewRows.push({
      role: 'assistant',
      content: '',
      agentMeta: JSON.stringify({ internalOnly: true }),
      createdAt: 3,
      id: 'hidden-card',
    });
    expect(await readReviewContextFingerprint('source')).toBe(changedFingerprint);

    reviewRows.push({
      role: 'assistant',
      content: '',
      agentMeta: JSON.stringify({
        reviewRun: {
          version: 1,
          runId: 'review-run',
          sourceSessionId: 'source',
          reviewerSessionId: 'reviewer',
          status: 'running',
          targetKind: 'mixed',
          startedAt: 3,
        },
      }),
      createdAt: 4,
      id: 'review-card',
    });
    expect(await readReviewContextFingerprint('source')).toBe(changedFingerprint);
  });

  it('does not let a hidden lifecycle row evict the twentieth visible context message', async () => {
    reviewRows.push(
      ...Array.from({ length: 20 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: JSON.stringify({ text: `visible-${20 - index}` }),
        agentMeta: null,
        createdAt: 20 - index,
        id: `message-${String(20 - index).padStart(2, '0')}`,
      })),
    );
    const initialFingerprint = await readReviewContextFingerprint('source');

    reviewRows.unshift({
      role: 'assistant',
      content: '',
      agentMeta: JSON.stringify({ goalCompletion: { status: 'completed' } }),
      createdAt: 21,
      id: 'hidden-goal-card',
    });

    expect(await readReviewContextFingerprint('source')).toBe(initialFingerprint);
  });

  it('uses MIME-only image classification for the harness block', async () => {
    const workingDir = await tempDir();
    const requestedPath = path.join(workingDir, 'poster');
    const snapshotPath = path.join(workingDir, 'review-snapshot');
    await fs.writeFile(requestedPath, 'image bytes');
    await fs.writeFile(snapshotPath, 'immutable image bytes');
    const artifactPath = await fs.realpath(requestedPath);

    const evidence = await loadReviewEvidence({
      sourceSessionId: 'source',
      workingDir,
      attachments: [{ name: 'poster', path: artifactPath, mimeType: 'image/avif' }],
      explicitArtifactGrant: {
        paths: [artifactPath],
        pathIdentities: new Map(),
        inlineAttachmentKeys: [],
        snapshotPaths: new Map([[artifactPath, snapshotPath]]),
      },
    });

    expect(evidence.artifacts).toEqual([{ kind: 'image', label: 'poster' }]);
    expect(evidence.attachmentBlocks).toMatchObject([
      { type: 'image', path: snapshotPath, mimeType: 'image/avif' },
    ]);
    expect(evidence.reviewReadPaths).toEqual([snapshotPath]);
  });

  it('caps local PDF extraction while preserving every harness reference', async () => {
    const workingDir = await tempDir();
    const paths = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const requestedPath = path.join(workingDir, `contract-${index + 1}.pdf`);
        await fs.writeFile(requestedPath, 'not a pdf');
        return fs.realpath(requestedPath);
      }),
    );

    const evidence = await loadReviewEvidence({
      sourceSessionId: 'source',
      workingDir,
      attachments: paths.map((artifactPath, index) => ({
        name: `contract-${index + 1}.pdf`,
        path: artifactPath,
        category: 'pdf' as const,
      })),
      explicitArtifactGrant: {
        paths,
        pathIdentities: new Map(),
        inlineAttachmentKeys: [],
      },
    });

    expect(evidence.attachmentBlocks).toHaveLength(5);
    expect(evidence.artifactWarnings).toContainEqual({
      label: 'contract-5.pdf',
      message: expect.stringContaining('最多本地解析 4 份 PDF'),
    });
  });

  it('rejects path drift and unconfirmed inline bytes before model dispatch', async () => {
    const workingDir = await tempDir();
    const requestedPath = path.join(workingDir, 'contract.pdf');
    await fs.writeFile(requestedPath, 'pdf');
    const artifactPath = await fs.realpath(requestedPath);

    await expect(
      loadReviewEvidence({
        sourceSessionId: 'source',
        workingDir,
        attachments: [{ name: 'contract.pdf', path: artifactPath }],
        explicitArtifactGrant: {
          paths: [path.join(workingDir, 'different.pdf')],
          pathIdentities: new Map(),
          inlineAttachmentKeys: [],
        },
      }),
    ).rejects.toBeInstanceOf(ReviewArtifactAuthorizationError);

    await expect(
      loadReviewEvidence({
        sourceSessionId: 'source',
        workingDir,
        attachments: [{ name: 'poster.png', base64: 'aW1hZ2U=', category: 'image' }],
        explicitArtifactGrant: {
          paths: [],
          pathIdentities: new Map(),
          inlineAttachmentKeys: [],
        },
      }),
    ).rejects.toBeInstanceOf(ReviewArtifactAuthorizationError);
  });

  it('rejects inline bytes that change after their exact payload was authorized', async () => {
    const workingDir = await tempDir();
    const authorized = {
      name: 'poster.png',
      base64: 'YXV0aG9yaXplZA==',
      category: 'image' as const,
      mimeType: 'image/png',
    };
    const grant = await authorizeReviewExplicitArtifacts({
      workingDir,
      attachments: [authorized],
      resolvePath: async () => null,
      confirm: async () => true,
    });

    await expect(
      loadReviewEvidence({
        sourceSessionId: 'source',
        workingDir,
        attachments: [{ ...authorized, base64: 'cmVwbGFjZWQ=' }],
        explicitArtifactGrant: grant,
      }),
    ).rejects.toBeInstanceOf(ReviewArtifactAuthorizationError);
  });

  it('requires the same native grant for an external path recovered from task history', async () => {
    const workingDir = await tempDir();
    const externalDir = await tempDir();
    const requestedPath = path.join(externalDir, 'historical-contract.pdf');
    await fs.writeFile(requestedPath, 'pdf');
    const artifactPath = await fs.realpath(requestedPath);
    reviewRows.push({
      role: 'user',
      content: JSON.stringify({ files: [{ name: 'historical-contract.pdf', path: artifactPath }] }),
      agentMeta: null,
      createdAt: 1,
      id: 'message-1',
    });

    const historical = await listReviewHistoricalAttachments('source');
    const confirm = vi.fn(async () => true);
    const grant = await authorizeReviewExplicitArtifacts({
      workingDir,
      attachments: historical,
      resolvePath: async (rawPath) => ({
        absPath: await fs.realpath(rawPath),
        managed: false,
      }),
      confirm,
    });

    expect(confirm).toHaveBeenCalledWith([
      {
        kind: 'external-path',
        label: 'historical-contract.pdf',
        path: artifactPath,
      },
    ]);
    await expect(
      loadReviewEvidence({
        sourceSessionId: 'source',
        workingDir,
        attachments: [],
        explicitArtifactGrant: {
          paths: [],
          pathIdentities: new Map(),
          inlineAttachmentKeys: [],
        },
      }),
    ).rejects.toBeInstanceOf(ReviewArtifactAuthorizationError);
    await expect(
      loadReviewEvidence({
        sourceSessionId: 'source',
        workingDir,
        attachments: [],
        explicitArtifactGrant: grant,
      }),
    ).resolves.toMatchObject({
      artifacts: [{ kind: 'file', label: 'historical-contract.pdf' }],
    });
  });

  it('forwards every separately authorized inline payload with a duplicate display label', async () => {
    const workingDir = await tempDir();
    const attachments = [
      {
        name: 'first.png',
        originalName: 'same.png',
        base64: 'Zmlyc3Q=',
        category: 'image' as const,
        mimeType: 'image/png',
      },
      {
        name: 'second.png',
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
      confirm: async () => true,
    });

    const evidence = await loadReviewEvidence({
      sourceSessionId: 'source',
      workingDir,
      attachments,
      explicitArtifactGrant: grant,
    });

    expect(evidence.attachmentBlocks).toEqual([
      expect.objectContaining({ type: 'image', base64: 'Zmlyc3Q=', originalName: 'same.png' }),
      expect.objectContaining({ type: 'image', base64: 'c2Vjb25k', originalName: 'same.png' }),
    ]);
  });

  it('does not read the branch diff while uncommitted work exists', async () => {
    // Uncommitted work is the review target; reading the branch as well would
    // bury it under commits the user is not asking about.
    const repoRoot = await tempDir();
    readReviewDataMock.mockResolvedValue(cappedReviewData(repoRoot, 'src/a.ts'));

    const evidence = await loadReviewEvidence({
      sourceSessionId: 'source',
      workingDir: repoRoot,
      attachments: [],
      explicitArtifactGrant: {
        paths: [],
        pathIdentities: new Map(),
        inlineAttachmentKeys: [],
      },
    });

    expect(readReviewBranchDiffMock).not.toHaveBeenCalled();
    expect(evidence.branch).toBeNull();
  });

  it('reports why a too-large branch diff is missing instead of falling back silently', async () => {
    // A guard like too-many-files returns a resolved base with no entries,
    // which looks identical to an unchanged branch. Falling through without
    // saying so would present one turn as the whole branch review.
    const repoRoot = await tempDir();
    readReviewDataMock.mockResolvedValue(cleanGitReviewData(repoRoot));
    readReviewBranchDiffMock.mockResolvedValue({
      scope: null,
      baseRef: 'origin/main',
      baseOid: 'b'.repeat(40),
      mergeBaseOid: 'c'.repeat(40),
      candidates: [],
      diffs: [],
      capped: null,
      warning: { code: 'too-many-files', message: 'too many files' },
    });

    const evidence = await loadReviewEvidence({
      sourceSessionId: 'source',
      workingDir: repoRoot,
      attachments: [],
      explicitArtifactGrant: {
        paths: [],
        pathIdentities: new Map(),
        inlineAttachmentKeys: [],
      },
    });

    expect(evidence.branch).toBeNull();
    expect(evidence.branchUnavailableReason).toBe('too-many-files');
  });

  it('refuses to compare against an unrelated local branch', async () => {
    // Unattended review picks no base. With no upstream or default present the
    // picker falls back to the first ordinary local branch, and presenting that
    // diff as "the branch's work" would be worse than presenting nothing.
    const repoRoot = await tempDir();
    readReviewDataMock.mockResolvedValue(cleanGitReviewData(repoRoot));
    readReviewBranchDiffMock.mockResolvedValue({
      scope: null,
      baseRef: 'some-other-feature',
      baseOid: 'b'.repeat(40),
      mergeBaseOid: 'c'.repeat(40),
      candidates: [
        {
          refName: 'some-other-feature',
          shortName: 'some-other-feature',
          kind: 'local',
          remote: null,
          oid: 'b'.repeat(40),
        },
      ],
      diffs: [],
      capped: null,
      warning: null,
    });

    const evidence = await loadReviewEvidence({
      sourceSessionId: 'source',
      workingDir: repoRoot,
      attachments: [],
      explicitArtifactGrant: {
        paths: [],
        pathIdentities: new Map(),
        inlineAttachmentKeys: [],
      },
    });

    expect(evidence.branch).toBeNull();
    expect(evidence.branchUnavailableReason).toBe('ambiguous-base');
  });

  it('refuses to compare against an unrelated remote branch', async () => {
    // Same rule as the local case: a candidate that merely sorted first is not
    // a base. `origin/foo` is no more meaningful than `some-other-feature`.
    const repoRoot = await tempDir();
    readReviewDataMock.mockResolvedValue(cleanGitReviewData(repoRoot));
    readReviewBranchDiffMock.mockResolvedValue({
      scope: null,
      baseRef: 'origin/foo',
      baseOid: 'b'.repeat(40),
      mergeBaseOid: 'c'.repeat(40),
      candidates: [
        {
          refName: 'origin/foo',
          shortName: 'foo',
          kind: 'remote',
          remote: 'origin',
          oid: 'b'.repeat(40),
        },
      ],
      diffs: [],
      capped: null,
      warning: null,
    });

    const evidence = await loadReviewEvidence({
      sourceSessionId: 'source',
      workingDir: repoRoot,
      attachments: [],
      explicitArtifactGrant: {
        paths: [],
        pathIdentities: new Map(),
        inlineAttachmentKeys: [],
      },
    });

    expect(evidence.branch).toBeNull();
    expect(evidence.branchUnavailableReason).toBe('ambiguous-base');
  });

  it('accepts origin/main when the remote publishes no HEAD', async () => {
    // Candidates carry `shortName === refName`, so the remote prefix has to be
    // stripped rather than re-attached; getting that backwards rejects the most
    // ordinary base there is and silently drops the review back to one turn.
    const repoRoot = await tempDir();
    readReviewDataMock.mockResolvedValue(cleanGitReviewData(repoRoot));
    readReviewBranchDiffMock.mockResolvedValue({
      scope: null,
      baseRef: 'origin/main',
      baseOid: 'b'.repeat(40),
      mergeBaseOid: 'c'.repeat(40),
      candidates: [
        {
          refName: 'origin/main',
          shortName: 'origin/main',
          kind: 'remote',
          remote: 'origin',
          oid: 'b'.repeat(40),
          isDefaultBranch: true,
        },
      ],
      diffs: [branchFileDiff('src/a.ts')],
      capped: null,
      warning: null,
    });

    const evidence = await loadReviewEvidence({
      sourceSessionId: 'source',
      workingDir: repoRoot,
      attachments: [],
      explicitArtifactGrant: {
        paths: [],
        pathIdentities: new Map(),
        inlineAttachmentKeys: [],
      },
    });

    expect(evidence.branch?.baseRef).toBe('origin/main');
  });

  it('accepts a configured default branch under any name', async () => {
    // `init.defaultBranch` can name anything. Only the branch reader can read
    // that config, so the flag it sets must be honoured rather than second-
    // guessed by matching against main/master here.
    const repoRoot = await tempDir();
    readReviewDataMock.mockResolvedValue(cleanGitReviewData(repoRoot));
    readReviewBranchDiffMock.mockResolvedValue({
      scope: null,
      baseRef: 'origin/stable',
      baseOid: 'b'.repeat(40),
      mergeBaseOid: 'c'.repeat(40),
      candidates: [
        {
          refName: 'origin/stable',
          shortName: 'origin/stable',
          kind: 'remote',
          remote: 'origin',
          oid: 'b'.repeat(40),
          isDefaultBranch: true,
        },
      ],
      diffs: [branchFileDiff('src/a.ts')],
      capped: null,
      warning: null,
    });

    const evidence = await loadReviewEvidence({
      sourceSessionId: 'source',
      workingDir: repoRoot,
      attachments: [],
      explicitArtifactGrant: {
        paths: [],
        pathIdentities: new Map(),
        inlineAttachmentKeys: [],
      },
    });

    expect(evidence.branch?.baseRef).toBe('origin/stable');
  });

  it('counts branch files before redaction, including an all-sensitive branch', async () => {
    // Deriving the count from the sanitized list would report zero here, which
    // resolveTargetKind reads as "no changes" and downgrades to a `task`
    // review even though the branch is the selected evidence. The count is
    // coverage metadata; the patches themselves stay excluded.
    const repoRoot = await tempDir();
    readReviewDataMock.mockResolvedValue(cleanGitReviewData(repoRoot));
    readReviewBranchDiffMock.mockResolvedValue({
      scope: null,
      baseRef: 'origin/main',
      baseOid: 'b'.repeat(40),
      mergeBaseOid: 'c'.repeat(40),
      candidates: [
        {
          refName: 'origin/main',
          shortName: 'origin/main',
          kind: 'remote-default',
          remote: 'origin',
          oid: 'b'.repeat(40),
        },
      ],
      diffs: [branchFileDiff('.env'), branchFileDiff('deploy/id_rsa')],
      capped: null,
      warning: null,
    });

    const evidence = await loadReviewEvidence({
      sourceSessionId: 'source',
      workingDir: repoRoot,
      attachments: [],
      explicitArtifactGrant: {
        paths: [],
        pathIdentities: new Map(),
        inlineAttachmentKeys: [],
      },
    });

    expect(evidence.branch?.fileCount).toBe(2);
    expect(evidence.branch?.sensitiveFilesOmitted).toBe(2);
    expect(evidence.branch?.diffs).toEqual([]);
  });

  it('refuses a branch whose last segment merely looks like a default', async () => {
    // `feature/main` is an ordinary branch. Judging by basename would let it
    // pass as a default and reintroduce the unrelated-sibling comparison.
    const repoRoot = await tempDir();
    readReviewDataMock.mockResolvedValue(cleanGitReviewData(repoRoot));
    readReviewBranchDiffMock.mockResolvedValue({
      scope: null,
      baseRef: 'feature/main',
      baseOid: 'b'.repeat(40),
      mergeBaseOid: 'c'.repeat(40),
      candidates: [
        {
          refName: 'feature/main',
          shortName: 'feature/main',
          kind: 'local',
          remote: null,
          oid: 'b'.repeat(40),
        },
      ],
      diffs: [],
      capped: null,
      warning: null,
    });

    const evidence = await loadReviewEvidence({
      sourceSessionId: 'source',
      workingDir: repoRoot,
      attachments: [],
      explicitArtifactGrant: {
        paths: [],
        pathIdentities: new Map(),
        inlineAttachmentKeys: [],
      },
    });

    expect(evidence.branch).toBeNull();
    expect(evidence.branchUnavailableReason).toBe('ambiguous-base');
  });

  it('accepts the branch upstream as a base', async () => {
    // An upstream is chosen by the user's own tracking config, so it is
    // meaningful even when its name looks nothing like a default.
    const repoRoot = await tempDir();
    readReviewDataMock.mockResolvedValue(cleanGitReviewData(repoRoot));
    readReviewBranchDiffMock.mockResolvedValue({
      scope: null,
      baseRef: 'origin/release-2026',
      baseOid: 'b'.repeat(40),
      mergeBaseOid: 'c'.repeat(40),
      candidates: [
        {
          refName: 'origin/release-2026',
          shortName: 'release-2026',
          kind: 'upstream',
          remote: 'origin',
          oid: 'b'.repeat(40),
        },
      ],
      diffs: [branchFileDiff('src/a.ts')],
      capped: null,
      warning: null,
    });

    const evidence = await loadReviewEvidence({
      sourceSessionId: 'source',
      workingDir: repoRoot,
      attachments: [],
      explicitArtifactGrant: {
        paths: [],
        pathIdentities: new Map(),
        inlineAttachmentKeys: [],
      },
    });

    expect(evidence.branch?.baseRef).toBe('origin/release-2026');
  });

  it('accepts a local default branch as a base', async () => {
    // A repository with no remote still has a meaningful base when it is named
    // like the default; rejecting it would disable branch review offline.
    const repoRoot = await tempDir();
    readReviewDataMock.mockResolvedValue(cleanGitReviewData(repoRoot));
    readReviewBranchDiffMock.mockResolvedValue({
      scope: null,
      baseRef: 'main',
      baseOid: 'b'.repeat(40),
      mergeBaseOid: 'c'.repeat(40),
      candidates: [
        {
          refName: 'main',
          shortName: 'main',
          kind: 'local',
          remote: null,
          oid: 'b'.repeat(40),
          isDefaultBranch: true,
        },
      ],
      diffs: [branchFileDiff('src/a.ts')],
      capped: null,
      warning: null,
    });

    const evidence = await loadReviewEvidence({
      sourceSessionId: 'source',
      workingDir: repoRoot,
      attachments: [],
      explicitArtifactGrant: {
        paths: [],
        pathIdentities: new Map(),
        inlineAttachmentKeys: [],
      },
    });

    expect(evidence.branch?.baseRef).toBe('main');
  });

  it('accepts a base tip that moved without moving the merge base', async () => {
    // Fetching commits onto the base after this branch diverged advances the
    // tip but not the merge base, so the patch is byte-for-byte the same.
    // Failing here would throw away a perfectly valid review.
    const branch = {
      baseRef: 'origin/main',
      baseOid: 'b'.repeat(40),
      mergeBaseOid: 'c'.repeat(40),
      fileCount: 1,
      diffs: [],
      capped: null,
    };
    readReviewBranchDiffMock.mockResolvedValue({
      scope: null,
      baseRef: 'origin/main',
      baseOid: 'd'.repeat(40),
      mergeBaseOid: 'c'.repeat(40),
      candidates: [],
      diffs: [],
      capped: null,
      warning: null,
    });

    await expect(reviewBranchBaselineIsCurrent('source', branch)).resolves.toBe(true);
  });

  it('detects a moved merge base even though HEAD did not change', async () => {
    // The workspace fingerprint pins the source HEAD. A merge base that moves
    // changes what the branch diff means without touching HEAD — so freshness
    // has to check the baseline separately.
    const branch = {
      baseRef: 'origin/main',
      baseOid: 'b'.repeat(40),
      mergeBaseOid: 'c'.repeat(40),
      fileCount: 1,
      diffs: [],
      capped: null,
    };
    readReviewBranchDiffMock.mockResolvedValue({
      scope: null,
      baseRef: 'origin/main',
      baseOid: 'd'.repeat(40),
      mergeBaseOid: 'e'.repeat(40),
      candidates: [],
      diffs: [],
      capped: null,
      warning: null,
    });

    await expect(reviewBranchBaselineIsCurrent('source', branch)).resolves.toBe(false);
  });

  it('accepts an unchanged comparison base', async () => {
    const branch = {
      baseRef: 'origin/main',
      baseOid: 'b'.repeat(40),
      mergeBaseOid: 'c'.repeat(40),
      fileCount: 1,
      diffs: [],
      capped: null,
    };
    readReviewBranchDiffMock.mockResolvedValue({
      scope: null,
      baseRef: 'origin/main',
      baseOid: 'b'.repeat(40),
      mergeBaseOid: 'c'.repeat(40),
      candidates: [],
      diffs: [],
      capped: null,
      warning: null,
    });

    await expect(reviewBranchBaselineIsCurrent('source', branch)).resolves.toBe(true);
  });

  it('fails closed when the comparison base cannot be re-read', async () => {
    readReviewBranchDiffMock.mockRejectedValue(new Error('git fetch in progress'));

    await expect(
      reviewBranchBaselineIsCurrent('source', {
        baseRef: 'origin/main',
        baseOid: 'b'.repeat(40),
        mergeBaseOid: 'c'.repeat(40),
        fileCount: 1,
        diffs: [],
        capped: null,
      }),
    ).resolves.toBe(false);
  });

  it('does not read the branch diff for a non-Git task', async () => {
    const evidence = await loadReviewEvidence({
      sourceSessionId: 'source',
      workingDir: '/tmp/non-git-review',
      attachments: [],
      explicitArtifactGrant: {
        paths: [],
        pathIdentities: new Map(),
        inlineAttachmentKeys: [],
      },
    });

    expect(readReviewBranchDiffMock).not.toHaveBeenCalled();
    expect(evidence.branch).toBeNull();
  });
});

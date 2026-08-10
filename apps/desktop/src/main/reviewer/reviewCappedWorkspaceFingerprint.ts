import { createHash, type Hash } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';

import { isReviewSensitiveCredentialPath } from '@cindy/maker-core';

import { isPathInside } from '../git-review/fsPathGuard.js';

const MAX_CAPPED_WORKSPACE_PATHS = 10_000;
const MAX_CAPPED_WORKSPACE_BYTES = 512 * 1024 * 1024;
const READ_BUFFER_BYTES = 256 * 1024;
const NOFOLLOW_FLAG = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;

export interface ReviewCappedWorkspaceFingerprintOptions {
  /** Test seam; production remains bounded and fails closed above the limit. */
  maxTotalBytes?: number;
}

export class ReviewCappedWorkspaceFingerprintError extends Error {}
export class ReviewCappedWorkspaceFingerprintLimitError extends ReviewCappedWorkspaceFingerprintError {}
export class ReviewCappedWorkspaceChangedError extends ReviewCappedWorkspaceFingerprintError {}

function addRecord(hash: Hash, ...parts: Array<string | number>): void {
  hash.update(JSON.stringify(parts)).update('\n');
}

function stableStatMatches(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs &&
    before.mode === after.mode
  );
}

function assertSafeGitPath(rawPath: string): void {
  if (
    !rawPath ||
    rawPath.includes('\0') ||
    path.posix.isAbsolute(rawPath) ||
    path.win32.isAbsolute(rawPath) ||
    rawPath.split(/[\\/]/).includes('..')
  ) {
    throw new ReviewCappedWorkspaceFingerprintError(
      'Review refused an invalid capped workspace path',
    );
  }
}

async function lstatOrNull(filePath: string): Promise<Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function hashRegularFile(input: {
  hash: Hash;
  repoRootReal: string;
  candidate: string;
  rawPath: string;
  entryBefore: Stats;
  remainingBytes: number;
}): Promise<number> {
  const linkTargetBefore = input.entryBefore.isSymbolicLink()
    ? await fs.readlink(input.candidate)
    : null;
  const targetReal = await fs.realpath(input.candidate).catch(() => null);
  const targetRelative = targetReal ? path.relative(input.repoRootReal, targetReal) : '';
  if (
    !targetReal ||
    !isPathInside(input.repoRootReal, targetReal) ||
    isReviewSensitiveCredentialPath(targetRelative)
  ) {
    throw new ReviewCappedWorkspaceFingerprintError(
      'Review refused a capped workspace path that resolves outside the repository',
    );
  }

  const handle = await fs.open(targetReal, constants.O_RDONLY | NOFOLLOW_FLAG);
  try {
    const openedTargetReal = await fs.realpath(targetReal).catch(() => null);
    if (!openedTargetReal || !isPathInside(input.repoRootReal, openedTargetReal)) {
      throw new ReviewCappedWorkspaceFingerprintError(
        'Review refused a capped workspace path that changed its repository boundary',
      );
    }
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new ReviewCappedWorkspaceFingerprintError(
        'Review can only content-fingerprint regular capped workspace files',
      );
    }
    if (before.size > input.remainingBytes) {
      throw new ReviewCappedWorkspaceFingerprintLimitError(
        'Capped Review files exceed the 512 MB full-content fingerprint limit',
      );
    }

    const contentHash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let offset = 0;
    while (offset < before.size) {
      const requested = Math.min(buffer.length, before.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, requested, offset);
      if (bytesRead === 0) break;
      contentHash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    const entryAfter = await lstatOrNull(input.candidate);
    const linkTargetAfter = entryAfter?.isSymbolicLink()
      ? await fs.readlink(input.candidate).catch(() => null)
      : null;
    if (
      offset !== before.size ||
      !stableStatMatches(before, after) ||
      !entryAfter ||
      !stableStatMatches(input.entryBefore, entryAfter) ||
      linkTargetAfter !== linkTargetBefore
    ) {
      throw new ReviewCappedWorkspaceChangedError(
        'A capped Review file changed while its content baseline was being prepared',
      );
    }

    addRecord(
      input.hash,
      input.entryBefore.isSymbolicLink() ? 'symlink-file' : 'file',
      input.rawPath,
      linkTargetBefore ?? '',
      before.size,
      before.mode,
      contentHash.digest('hex'),
    );
    return before.size;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Fully hashes every non-sensitive current worktree file whose Git patch was
 * replaced by a capped summary. Sampling is intentionally forbidden here:
 * this digest is the freshness authority for content the reviewer may read.
 */
export async function fingerprintReviewCappedWorkspaceFiles(
  repoRoot: string,
  rawPaths: readonly string[],
  options: ReviewCappedWorkspaceFingerprintOptions = {},
): Promise<string> {
  const maxTotalBytes = options.maxTotalBytes ?? MAX_CAPPED_WORKSPACE_BYTES;
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0) {
    throw new TypeError('maxTotalBytes must be a positive safe integer');
  }
  const repoRootReal = await fs.realpath(repoRoot);
  const paths = [...new Set(rawPaths)]
    .filter((rawPath) => !isReviewSensitiveCredentialPath(rawPath))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (paths.length > MAX_CAPPED_WORKSPACE_PATHS) {
    throw new ReviewCappedWorkspaceFingerprintLimitError(
      `Capped Review contains more than ${MAX_CAPPED_WORKSPACE_PATHS} file paths`,
    );
  }

  const hash = createHash('sha256');
  let totalBytes = 0;
  for (const rawPath of paths) {
    assertSafeGitPath(rawPath);
    const candidate = path.join(repoRootReal, ...rawPath.split('/'));
    if (!isPathInside(repoRootReal, candidate)) {
      throw new ReviewCappedWorkspaceFingerprintError(
        'Review refused a capped workspace path outside the repository',
      );
    }
    const entryBefore = await lstatOrNull(candidate);
    if (!entryBefore) {
      addRecord(hash, 'missing', rawPath);
      continue;
    }
    if (!entryBefore.isFile() && !entryBefore.isSymbolicLink()) {
      throw new ReviewCappedWorkspaceFingerprintError(
        'Review can only content-fingerprint regular capped workspace files',
      );
    }
    totalBytes += await hashRegularFile({
      hash,
      repoRootReal,
      candidate,
      rawPath,
      entryBefore,
      remainingBytes: maxTotalBytes - totalBytes,
    });
  }
  return hash.digest('hex');
}

import { createHash } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';

import { isReviewSensitiveCredentialPath, reviewFileLinkLayoutIsSafe } from '@cindy/maker-core';

import { reviewArtifactPathIdentityMatches } from './reviewArtifactAuthorization.js';

const MAX_DIRECTORY_ENTRIES = 50_000;
const READ_CHUNK_BYTES = 128 * 1024;
const MAX_TOTAL_CONTENT_BYTES = 512 * 1024 * 1024;
const NOFOLLOW_FLAG = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;

export type ReviewArtifactFileOpener = (
  filePath: string,
  flags: number,
) => ReturnType<typeof fs.open>;

interface FingerprintState {
  hash: ReturnType<typeof createHash>;
  entries: number;
  maxDirectoryEntries: number;
  contentBytesRemaining: number;
  openFile: ReviewArtifactFileOpener;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export interface ReviewArtifactFingerprintOptions {
  /** Test seam; production uses the bounded fail-closed default. */
  maxDirectoryEntries?: number;
  /** Test seam; production hashes at most the bounded total before failing closed. */
  maxContentBytes?: number;
  /** Test seam for deterministic lstat/open replacement coverage. */
  openFile?: ReviewArtifactFileOpener;
  /** Workspace root used only to validate confined pnpm hard-link mirrors. */
  linkConfinementRoot?: string;
}

export class ReviewArtifactFingerprintLimitError extends Error {}
export class ReviewArtifactFingerprintChangedError extends Error {}

async function assertCanonicalReviewArtifactPath(absolutePath: string): Promise<void> {
  const canonicalPath = await fs.realpath(absolutePath).catch(() => null);
  if (!canonicalPath || path.resolve(canonicalPath) !== path.resolve(absolutePath)) {
    throw new ReviewArtifactFingerprintChangedError(
      'A review artifact path changed while its content fingerprint was being prepared',
    );
  }
}

async function resolveFingerprintRoot(rawPath: string): Promise<string> {
  const normalizedPath = path.normalize(rawPath);
  const before = await fs.lstat(normalizedPath).catch(() => null);
  if (!before || before.isSymbolicLink()) return normalizedPath;

  const canonicalPath = await fs.realpath(normalizedPath).catch(() => null);
  if (!canonicalPath) return normalizedPath;
  const [afterRawPath, afterCanonicalPath] = await Promise.all([
    fs.lstat(normalizedPath).catch(() => null),
    fs.lstat(canonicalPath).catch(() => null),
  ]);
  if (
    !afterRawPath ||
    afterRawPath.isSymbolicLink() ||
    !afterCanonicalPath ||
    afterCanonicalPath.isSymbolicLink() ||
    !reviewArtifactPathIdentityMatches(before, afterRawPath) ||
    !reviewArtifactPathIdentityMatches(before, afterCanonicalPath)
  ) {
    throw new ReviewArtifactFingerprintChangedError(
      'A review artifact root changed while its content fingerprint was being prepared',
    );
  }
  return canonicalPath;
}

async function resolveLinkConfinementRoot(rawPath: string): Promise<string> {
  if (!path.isAbsolute(rawPath) || isSensitive(rawPath)) {
    throw new ReviewArtifactFingerprintChangedError(
      'Review artifact link confinement root is invalid',
    );
  }
  const canonicalPath = await fs.realpath(path.normalize(rawPath)).catch(() => null);
  const stat = canonicalPath ? await fs.lstat(canonicalPath).catch(() => null) : null;
  if (
    !canonicalPath ||
    isSensitive(canonicalPath) ||
    !stat ||
    stat.isSymbolicLink() ||
    !stat.isDirectory()
  ) {
    throw new ReviewArtifactFingerprintChangedError(
      'Review artifact link confinement root changed while its fingerprint was prepared',
    );
  }
  return canonicalPath;
}

function addRecord(state: FingerprintState, ...parts: Array<string | number>): void {
  state.hash.update(parts.join('\0')).update('\n');
}

function isSensitive(rawPath: string, relativePath = ''): boolean {
  return (
    isReviewSensitiveCredentialPath(rawPath) ||
    (!!relativePath && isReviewSensitiveCredentialPath(relativePath))
  );
}

async function hashRange(
  handle: Awaited<ReturnType<typeof fs.open>>,
  state: FingerprintState,
  start: number,
  length: number,
): Promise<number> {
  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(1, length)));
  let position = start;
  let remaining = length;
  let totalBytesRead = 0;
  while (remaining > 0) {
    const requested = Math.min(buffer.length, remaining);
    const { bytesRead } = await handle.read(buffer, 0, requested, position);
    if (bytesRead <= 0) break;
    state.hash.update(buffer.subarray(0, bytesRead));
    totalBytesRead += bytesRead;
    position += bytesRead;
    remaining -= bytesRead;
  }
  return totalBytesRead;
}

async function addFile(
  absolutePath: string,
  relativePath: string,
  linkConfinementRoot: string,
  stat: Stats,
  state: FingerprintState,
): Promise<void> {
  if (!(await reviewFileLinkLayoutIsSafe(absolutePath, linkConfinementRoot, stat))) {
    throw new ReviewArtifactFingerprintChangedError(
      'Review refused a multiply linked file in its artifact workspace',
    );
  }
  if (
    !Number.isSafeInteger(stat.size) ||
    stat.size < 0 ||
    stat.size > state.contentBytesRemaining
  ) {
    throw new ReviewArtifactFingerprintLimitError(
      'Review artifacts exceed the complete-content fingerprint byte limit',
    );
  }

  // Content, path, size and mode define the reusable result. Mutable file
  // timestamps are checked for TOCTOU below, but are intentionally omitted
  // from the digest so the regression exercises the complete content hash.
  addRecord(state, 'file', relativePath, stat.size, stat.mode);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await state.openFile(absolutePath, constants.O_RDONLY | NOFOLLOW_FLAG);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      !reviewArtifactPathIdentityMatches(stat, opened) ||
      !(await reviewFileLinkLayoutIsSafe(absolutePath, linkConfinementRoot, opened))
    ) {
      throw new ReviewArtifactFingerprintChangedError(
        'A review artifact changed while its content fingerprint was being prepared',
      );
    }

    const bytesRead = await hashRange(handle, state, 0, opened.size);
    const afterHandle = await handle.stat();
    const afterPath = await fs.lstat(absolutePath).catch(() => null);
    if (
      bytesRead !== opened.size ||
      !reviewArtifactPathIdentityMatches(opened, afterHandle) ||
      !afterPath ||
      afterPath.isSymbolicLink() ||
      !reviewArtifactPathIdentityMatches(opened, afterPath) ||
      afterHandle.nlink !== afterPath.nlink ||
      !(await reviewFileLinkLayoutIsSafe(absolutePath, linkConfinementRoot, afterHandle))
    ) {
      throw new ReviewArtifactFingerprintChangedError(
        'A review artifact changed while its content fingerprint was being prepared',
      );
    }
    state.contentBytesRemaining -= bytesRead;
    addRecord(state, 'file-end', relativePath, bytesRead);
  } catch (error) {
    if (error instanceof ReviewArtifactFingerprintChangedError) throw error;
    throw new ReviewArtifactFingerprintChangedError(
      'A review artifact could not be safely opened for content fingerprinting',
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function walk(
  absolutePath: string,
  relativePath: string,
  linkConfinementRoot: string,
  state: FingerprintState,
): Promise<void> {
  if (isSensitive(absolutePath, relativePath)) return;
  if (state.entries >= state.maxDirectoryEntries) {
    throw new ReviewArtifactFingerprintLimitError(
      `Review artifact directory exceeds the ${state.maxDirectoryEntries.toLocaleString('en-US')}-entry fingerprint limit`,
    );
  }
  state.entries += 1;

  let stat: Stats;
  try {
    stat = await fs.lstat(absolutePath);
  } catch (error) {
    addRecord(
      state,
      'missing-or-unreadable',
      relativePath,
      error instanceof Error ? error.name : 'unknown',
    );
    return;
  }

  if (stat.isSymbolicLink()) {
    let target = '';
    try {
      target = await fs.readlink(absolutePath);
    } catch {
      target = 'unreadable';
    }
    addRecord(state, 'symlink', relativePath, target, stat.mtimeMs, stat.ctimeMs);
    return;
  }
  if (stat.isFile() || stat.isDirectory()) {
    // Reject an intermediate directory that became a symlink after its parent
    // was enumerated; O_NOFOLLOW only protects the final path component.
    await assertCanonicalReviewArtifactPath(absolutePath);
  }
  if (stat.isFile()) {
    await addFile(absolutePath, relativePath, linkConfinementRoot, stat, state);
    return;
  }
  if (!stat.isDirectory()) {
    addRecord(state, 'other', relativePath, stat.size, stat.mtimeMs, stat.mode);
    return;
  }

  addRecord(state, 'directory', relativePath, stat.mtimeMs, stat.ctimeMs, stat.mode);
  let entries;
  try {
    entries = await fs.readdir(absolutePath, { withFileTypes: true });
  } catch (error) {
    addRecord(
      state,
      'directory-read-error',
      relativePath,
      error instanceof Error ? error.name : 'unknown',
    );
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (isSensitive(entry.name, childRelative)) continue;
    await walk(path.join(absolutePath, entry.name), childRelative, linkConfinementRoot, state);
  }
}

/**
 * Build a local-only identity for explicit review artifacts. The manifest is
 * deliberately bounded, ignores credential paths, and hashes every readable
 * file byte. Exceeding the byte budget fails closed instead of degrading to a
 * sampled or metadata-only identity that could reuse a stale Review result.
 */
export async function fingerprintReviewArtifacts(
  paths: readonly string[],
  options: ReviewArtifactFingerprintOptions = {},
): Promise<string> {
  const maxDirectoryEntries = options.maxDirectoryEntries ?? MAX_DIRECTORY_ENTRIES;
  if (!Number.isSafeInteger(maxDirectoryEntries) || maxDirectoryEntries <= 0) {
    throw new TypeError('maxDirectoryEntries must be a positive safe integer');
  }
  const maxContentBytes = options.maxContentBytes ?? MAX_TOTAL_CONTENT_BYTES;
  if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes < 0) {
    throw new TypeError('maxContentBytes must be a non-negative safe integer');
  }
  const state: FingerprintState = {
    hash: createHash('sha256'),
    entries: 0,
    maxDirectoryEntries,
    contentBytesRemaining: maxContentBytes,
    openFile: options.openFile ?? ((filePath, flags) => fs.open(filePath, flags)),
  };
  const linkConfinementRoot = options.linkConfinementRoot
    ? await resolveLinkConfinementRoot(options.linkConfinementRoot)
    : null;
  const canonicalRoots = new Set<string>();
  for (const rawPath of paths) {
    if (!path.isAbsolute(rawPath) || isSensitive(rawPath)) continue;
    const canonical = await resolveFingerprintRoot(rawPath);
    if (!isSensitive(canonical)) canonicalRoots.add(canonical);
  }
  const effectiveRoots: string[] = [];
  for (const root of [...canonicalRoots].sort(
    (left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0),
  )) {
    if (!effectiveRoots.some((parent) => isPathWithin(parent, root))) effectiveRoots.push(root);
  }
  for (const root of effectiveRoots.sort()) {
    addRecord(state, 'root', root);
    await walk(root, '.', linkConfinementRoot ?? root, state);
  }
  return state.hash.digest('hex');
}

export class ReviewArtifactChangedDuringPreparationError extends Error {}

/**
 * Brackets evidence extraction with the same content fingerprint. This closes
 * the window where an old excerpt could otherwise be paired with a new first
 * baseline and later be reported as a fresh completed review.
 */
export async function prepareWithStableReviewArtifacts<T>(
  paths: readonly string[],
  prepare: () => Promise<T>,
  options: ReviewArtifactFingerprintOptions = {},
): Promise<{ value: T; fingerprint: string }> {
  const before = await fingerprintReviewArtifacts(paths, options);
  const value = await prepare();
  const after = await fingerprintReviewArtifacts(paths, options);
  if (after !== before) {
    throw new ReviewArtifactChangedDuringPreparationError(
      'A review artifact changed while evidence was being prepared',
    );
  }
  return { value, fingerprint: after };
}

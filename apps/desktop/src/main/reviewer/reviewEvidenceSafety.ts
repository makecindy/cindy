import path from 'node:path';

import { isReviewSensitiveCredentialPath } from '@cindy/maker-core';

import type {
  FileDiff,
  ReviewCappedDiffData,
  ReviewDiffBucket,
  ReviewDiffSummaryEntry,
} from '../../shared/gitReviewWire.js';
import type { TurnChangeFileSummary, TurnChangeSetDetail } from '../../shared/turnChangeSet.js';

interface SanitizedEvidence<T> {
  value: T;
  omittedSensitiveFiles: number;
}

function hasSensitivePath(item: { path: string; oldPath: string | null }): boolean {
  return (
    isReviewSensitiveCredentialPath(item.path) ||
    (typeof item.oldPath === 'string' && isReviewSensitiveCredentialPath(item.oldPath))
  );
}

function evidenceKey(item: { path: string; oldPath: string | null }, source?: string): string {
  return `${source ?? ''}\0${item.path}\0${item.oldPath ?? ''}`;
}

function filterSensitive<T extends { path: string; oldPath: string | null }>(
  items: readonly T[],
  omitted: Set<string>,
  sourceOf?: (item: T) => string,
): T[] {
  return items.filter((item) => {
    if (!hasSensitivePath(item)) return true;
    omitted.add(evidenceKey(item, sourceOf?.(item)));
    return false;
  });
}

function sanitizeCappedDiff(
  capped: ReviewCappedDiffData | null,
  omitted: Set<string>,
): ReviewCappedDiffData | null {
  if (!capped) return null;
  return {
    ...capped,
    files: filterSensitive<ReviewDiffSummaryEntry>(capped.files, omitted, (file) => file.source),
  };
}

/** Remove credential-bearing paths before any Git evidence can reach a model prompt. */
export function sanitizeReviewDiffBucket(
  bucket: ReviewDiffBucket,
): SanitizedEvidence<ReviewDiffBucket> {
  const omitted = new Set<string>();
  const value: ReviewDiffBucket = {
    staged: filterSensitive<FileDiff>(bucket.staged, omitted, (diff) => diff.source),
    unstaged: filterSensitive<FileDiff>(bucket.unstaged, omitted, (diff) => diff.source),
    ...(bucket.capped
      ? {
          capped: {
            staged: sanitizeCappedDiff(bucket.capped.staged, omitted),
            unstaged: sanitizeCappedDiff(bucket.capped.unstaged, omitted),
          },
        }
      : {}),
  };
  return { value, omittedSensitiveFiles: omitted.size };
}

/** Sanitize the persisted latest-turn fallback as well as the live Git snapshot. */
export function sanitizeReviewChangeSet(
  changeSet: TurnChangeSetDetail | null,
): SanitizedEvidence<TurnChangeSetDetail | null> {
  if (!changeSet) return { value: null, omittedSensitiveFiles: 0 };
  const omitted = new Set<string>();
  const diffs = filterSensitive<FileDiff>(changeSet.diffs, omitted);
  const files = filterSensitive<TurnChangeFileSummary>(changeSet.files, omitted);
  const omittedSensitiveFiles = omitted.size;
  return {
    value: {
      ...changeSet,
      diffs,
      files,
      incompleteReasons:
        omittedSensitiveFiles > 0 && !changeSet.incompleteReasons.includes('sensitive-file')
          ? [...changeSet.incompleteReasons, 'sensitive-file']
          : changeSet.incompleteReasons,
    },
    omittedSensitiveFiles,
  };
}

/** Used for local freshness hashing; sensitive status paths never enter the digest input. */
export function sanitizeReviewStatusFiles<T extends { path: string; oldPath: string | null }>(
  files: readonly T[],
): T[] {
  return files.filter((file) => !hasSensitivePath(file));
}

function isSafeRelativeChangePath(rawPath: string): boolean {
  return (
    !!rawPath &&
    !rawPath.includes('\0') &&
    !path.posix.isAbsolute(rawPath) &&
    !path.win32.isAbsolute(rawPath) &&
    !rawPath.split(/[\\/]/).includes('..')
  );
}

export interface ReviewChangeSetContentPaths {
  paths: string[];
  /**
   * True when the change set records more files than it can enumerate, so the
   * returned paths cannot be a complete baseline for it.
   *
   * Persisted details are rebuilt through `toSummary()`, which caps `files` at
   * 50 entries while keeping the true `fileCount`. Callers that rely on these
   * paths for freshness must fail closed rather than publish a conclusion whose
   * baseline silently omitted the 51st file onward.
   */
  truncated: boolean;
}

/**
 * Absolute paths of the files a change set touches.
 *
 * Git evidence covers tracked content only: its fingerprint hashes Git identity,
 * porcelain status and patches, so a Git-ignored deliverable (a built report, a
 * generated bundle) produced by the reviewed turn is invisible to it. These
 * paths therefore matter even when a Git fingerprint exists — the caller decides
 * which of them Git already covers.
 *
 * Paths come from both `files` and `diffs` because those truncate independently.
 * Each is resolved against the change set's own recorded `cwd` and must stay
 * inside it; anything sensitive, unsafe or outside is dropped rather than
 * silently widening the review's read scope.
 */
export function reviewChangeSetContentPaths(
  changeSet: TurnChangeSetDetail | null,
  workingDir: string,
): ReviewChangeSetContentPaths {
  if (!changeSet) return { paths: [], truncated: false };
  const root = path.resolve(changeSet.cwd || workingDir);
  const paths = new Set<string>();
  const named = new Set<string>();
  const collect = (rawPath: string | null | undefined): void => {
    if (typeof rawPath !== 'string' || !isSafeRelativeChangePath(rawPath)) return;
    named.add(rawPath);
    if (isReviewSensitiveCredentialPath(rawPath)) return;
    const absolute = path.resolve(root, ...rawPath.split(/[\\/]/));
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return;
    if (isReviewSensitiveCredentialPath(absolute)) return;
    paths.add(absolute);
  };

  for (const file of changeSet.files) {
    collect(file.path);
    collect(file.oldPath);
  }
  // `diffs` is parsed from the full unified patch and can still describe files
  // the summarized `files` array dropped.
  for (const diff of changeSet.diffs) {
    collect(diff.path);
    collect(diff.oldPath);
  }

  // Compare against distinct names actually seen: a rename contributes two
  // names for one recorded file, so counting raw entries would misjudge this.
  return { paths: [...paths], truncated: named.size < changeSet.fileCount };
}

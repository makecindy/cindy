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

/**
 * Absolute paths of the files a non-Git change set touches.
 *
 * A non-Git task has no Git identity to bind, so without these the review would
 * carry no content baseline at all and could publish a conclusion drawn from
 * bytes that changed mid-review. Paths are resolved against the change set's own
 * recorded `cwd` and must stay inside it; anything sensitive, unsafe or outside
 * is dropped rather than silently widening the review's read scope.
 */
export function reviewChangeSetContentPaths(
  changeSet: TurnChangeSetDetail | null,
  workingDir: string,
): string[] {
  if (!changeSet) return [];
  const root = path.resolve(changeSet.cwd || workingDir);
  const paths = new Set<string>();
  for (const file of changeSet.files) {
    for (const rawPath of [file.path, file.oldPath]) {
      if (typeof rawPath !== 'string' || !isSafeRelativeChangePath(rawPath)) continue;
      if (isReviewSensitiveCredentialPath(rawPath)) continue;
      const absolute = path.resolve(root, ...rawPath.split(/[\\/]/));
      const relative = path.relative(root, absolute);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      if (isReviewSensitiveCredentialPath(absolute)) continue;
      paths.add(absolute);
    }
  }
  return [...paths];
}

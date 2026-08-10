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

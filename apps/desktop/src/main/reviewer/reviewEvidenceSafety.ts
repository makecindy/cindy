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
  const value: TurnChangeSetDetail = {
    ...changeSet,
    diffs,
    files,
    incompleteReasons:
      omittedSensitiveFiles > 0 && !changeSet.incompleteReasons.includes('sensitive-file')
        ? [...changeSet.incompleteReasons, 'sensitive-file']
        : changeSet.incompleteReasons,
  };
  // `fileCount` still counts the removed entries. Record which file identities
  // went away so a later completeness check can tell deliberate redaction from
  // a summary that lost files it can no longer name. Identity is used rather
  // than the source-prefixed evidence key so one file removed from both `files`
  // and `diffs` counts once, matching how `fileCount` counts it.
  if (omittedSensitiveFiles > 0) {
    const redacted = new Set<string>();
    for (const entry of [...changeSet.files, ...changeSet.diffs]) {
      if (hasSensitivePath(entry)) redacted.add(changeEntryIdentity(entry));
    }
    redactedChangeEntries.set(value, redacted);
  }
  return { value, omittedSensitiveFiles };
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
 * Gaps where the turn is known to have changed something it could not record.
 *
 * These leave no entry to count, so a change set carrying one can report
 * `fileCount: 0` and still be missing real deliverables. Redaction is excluded:
 * it is deliberate, and the removed files are accounted for separately.
 */
const UNENUMERABLE_CHANGE_REASONS: ReadonlySet<string> = new Set([
  'opaque-tool',
  'outside-workspace',
  'remote-session',
  'file-too-large',
  'binary-file',
  'read-failed',
  'diff-too-large',
  'provider-diff-conflict',
  'concurrent-workspace',
]);

export interface ReviewChangeSetContentPaths {
  paths: string[];
  /**
   * True when the change set cannot account for everything the turn changed, so
   * the returned paths cannot be a complete baseline for it.
   *
   * Two ways that happens. Persisted details are rebuilt through `toSummary()`,
   * which caps `files` at 50 entries while keeping the true `fileCount`. And a
   * turn can change something it could never enumerate at all — an opaque tool,
   * a file too large to diff — which leaves no entry and no count to compare.
   *
   * Deliberate redaction is neither: `sanitizeReviewChangeSet` removes
   * credential entries on purpose and records `sensitive-file`, so those files
   * are accounted for even though they are absent by design.
   */
  truncated: boolean;
}

/** Distinct file identity, so a rename's two path names still count as one file. */
function changeEntryIdentity(entry: { path: string; oldPath: string | null }): string {
  return `${entry.path}\0${entry.oldPath ?? ''}`;
}

/**
 * Entries `sanitizeReviewChangeSet` deliberately removed, keyed by file identity.
 *
 * Redaction keeps the original `fileCount` while dropping credential entries,
 * which from the outside looks identical to summary truncation. Recording the
 * removals as they happen is the only way to tell the two apart afterwards —
 * once sanitized, the entries are simply gone.
 */
const redactedChangeEntries = new WeakMap<TurnChangeSetDetail, Set<string>>();

function redactedChangeEntryCount(changeSet: TurnChangeSetDetail): number {
  return redactedChangeEntries.get(changeSet)?.size ?? 0;
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
  // Count file identities, not path names: a rename names two paths for one
  // recorded file, and counting names would let a rename mask a missing file.
  const seen = new Set<string>();
  const collect = (rawPath: string | null | undefined): void => {
    if (typeof rawPath !== 'string' || !isSafeRelativeChangePath(rawPath)) return;
    if (isReviewSensitiveCredentialPath(rawPath)) return;
    const absolute = path.resolve(root, ...rawPath.split(/[\\/]/));
    const relative = path.relative(root, absolute);
    // `..config` is an ordinary filename; only a bare `..` or a `../` prefix
    // actually leaves the root.
    const escapesRoot = relative === '..' || relative.startsWith(`..${path.sep}`);
    if (escapesRoot || path.isAbsolute(relative)) return;
    if (isReviewSensitiveCredentialPath(absolute)) return;
    paths.add(absolute);
  };

  for (const entry of [...changeSet.files, ...changeSet.diffs]) {
    // `files` and `diffs` truncate independently, so an entry missing from the
    // summarized list may still be described by the full unified patch.
    seen.add(changeEntryIdentity(entry));
    collect(entry.path);
    collect(entry.oldPath);
  }

  const unenumerable = changeSet.incompleteReasons.some((reason) =>
    UNENUMERABLE_CHANGE_REASONS.has(reason),
  );
  return {
    paths: [...paths],
    truncated:
      unenumerable || seen.size + redactedChangeEntryCount(changeSet) < changeSet.fileCount,
  };
}

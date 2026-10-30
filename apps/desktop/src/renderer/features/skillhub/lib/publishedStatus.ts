import { normalizeScanStatus } from './scanStatus';
import { specialPublishedStatus, type SpecialPublishedStatus } from '../../../../shared/skillhubPublishedStatus';

export * from '../../../../shared/skillhubPublishedStatus';

export type PublishedStatusLabelKey =
  | 'skillhub.publishedStatus.waitingReview'
  | 'skillhub.publishedStatus.machineReviewing'
  | 'skillhub.publishedStatus.manualReviewing'
  | 'skillhub.publishedStatus.rejected';

export function publishedStatusLabelKey(status: SpecialPublishedStatus): PublishedStatusLabelKey {
  if (status === 'pending') return 'skillhub.publishedStatus.waitingReview';
  if (status === 'quarantine') return 'skillhub.publishedStatus.manualReviewing';
  if (status === 'rejected') return 'skillhub.publishedStatus.rejected';
  return 'skillhub.publishedStatus.machineReviewing';
}

function readStringField(source: unknown, field: string): string {
  if (!source || typeof source !== 'object') return '';
  const value = (source as Record<string, unknown>)[field];
  return typeof value === 'string' ? value.trim() : '';
}

function compareDottedVersion(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const av = Number.isFinite(partsA[i]) ? partsA[i] : 0;
    const bv = Number.isFinite(partsB[i]) ? partsB[i] : 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

export function activePublishedReviewFromVersions(
  versions: unknown[] | null | undefined,
): { version: string; status: SpecialPublishedStatus } | null {
  let active: { version: string; status: SpecialPublishedStatus } | null = null;
  for (const item of versions ?? []) {
    const version = readStringField(item, 'version');
    const status = specialPublishedStatus(readStringField(item, 'scanStatus') || readStringField(item, 'status'));
    if (!version || status === null || status === 'rejected') continue;
    if (!active || compareDottedVersion(version, active.version) > 0) {
      active = { version, status };
    }
  }
  return active;
}

export function latestRejectedVersionFromVersions(
  versions: unknown[] | null | undefined,
): { version: string; status: 'rejected' } | null {
  let found: { version: string; status: 'rejected' } | null = null;
  for (const item of versions ?? []) {
    const version = readStringField(item, 'version');
    const status = specialPublishedStatus(readStringField(item, 'scanStatus') || readStringField(item, 'status'));
    if (!version || status !== 'rejected') continue;
    if (!found || compareDottedVersion(version, found.version) > 0) {
      found = { version, status: 'rejected' };
    }
  }
  return found;
}

export function rejectedPublishedReviewFromVersions(
  versions: unknown[] | null | undefined,
  latestVersion: string | null | undefined,
  latestVersionStatus?: string | null,
): { version: string; status: 'rejected' } | null {
  const rejected = latestRejectedVersionFromVersions(versions);
  if (!rejected) return null;
  const latest = latestVersion?.trim() ?? '';
  // On a first publication, latestVersion is the rejected version itself, not an approved market version.
  const isRejectedFirstVersion = rejected.version === latest
    && normalizeScanStatus(latestVersionStatus ?? '') === 'rejected'
    && (versions ?? []).some((item) => readStringField(item, 'version') === latest
      && normalizeScanStatus(readStringField(item, 'scanStatus') || readStringField(item, 'status')) === 'rejected');
  if (latest && compareDottedVersion(rejected.version, latest) <= 0 && !isRejectedFirstVersion) return null;
  return rejected;
}

export function publishedStatusClass(status: SpecialPublishedStatus): string {
  if (status === 'rejected') {
    return 'border-[var(--error-border)] bg-[var(--error-bg)] text-[var(--error-fg)]';
  }
  if (status === 'quarantine') {
    return 'border-[var(--skillhub-review-quarantine-border)] bg-[var(--skillhub-review-quarantine-bg)] text-[var(--skillhub-review-quarantine-fg)]';
  }
  return 'border-[var(--skillhub-review-pending-border)] bg-[var(--skillhub-review-pending-bg)] text-[var(--skillhub-review-pending-fg)]';
}

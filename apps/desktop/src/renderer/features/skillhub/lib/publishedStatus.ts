export type SpecialPublishedStatus = 'pending' | 'scanning' | 'quarantine' | 'rejected';

export interface PublishedStatusSource {
  moderationStatus?: string | null;
  latestVersion?: string | null;
  pendingVersion?: {
    version?: string | null;
    status?: string | null;
  } | null;
}

export function normalizePublishedStatus(
  status: string | null | undefined,
): SpecialPublishedStatus | 'published' | null {
  const value = String(status ?? '').trim().toLowerCase();
  if (!value) return null;
  if (value === 'pending' || value === 'machine_reviewing') return 'pending';
  if (value === 'scanning') return 'scanning';
  if (value === 'quarantine' || value === 'warning' || value === 'warn' || value === 'manual_reviewing') {
    return 'quarantine';
  }
  if (value === 'rejected' || value === 'failed' || value === 'fail' || value === 'blocked') {
    return 'rejected';
  }
  if (value === 'published' || value === 'passed' || value === 'pass' || value === 'approved') {
    return 'published';
  }
  return null;
}

export function specialPublishedStatus(status: string | null | undefined): SpecialPublishedStatus | null {
  const normalized = normalizePublishedStatus(status);
  return normalized === 'pending' || normalized === 'scanning' || normalized === 'quarantine' || normalized === 'rejected'
    ? normalized
    : null;
}

export function effectivePublishedStatus(source: PublishedStatusSource | null | undefined): SpecialPublishedStatus | null {
  const pendingVersion = source?.pendingVersion?.version?.trim();
  if (pendingVersion) {
    const pendingStatus = specialPublishedStatus(source?.pendingVersion?.status);
    if (pendingStatus) return pendingStatus;
    return specialPublishedStatus(source?.moderationStatus) ?? 'pending';
  }
  return specialPublishedStatus(source?.moderationStatus);
}

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

export function isActivePublishedReview(status: string | null | undefined): boolean {
  const normalized = specialPublishedStatus(status);
  return normalized === 'pending' || normalized === 'scanning' || normalized === 'quarantine';
}

export function isEffectiveActivePublishedReview(source: PublishedStatusSource | null | undefined): boolean {
  const normalized = effectivePublishedStatus(source);
  return normalized === 'pending' || normalized === 'scanning' || normalized === 'quarantine';
}

export function activePublishedReviewVersion(source: PublishedStatusSource | null | undefined): string | null {
  if (!source) return null;
  const pendingVersion = source.pendingVersion?.version?.trim() ?? '';
  if (pendingVersion && isEffectiveActivePublishedReview(source)) return pendingVersion;
  if (source.latestVersion && isActivePublishedReview(source.moderationStatus)) return source.latestVersion;
  return null;
}

export function effectivePublishedStatusVersion(source: PublishedStatusSource | null | undefined): string | null {
  if (!source) return null;
  const pendingVersion = source.pendingVersion?.version?.trim() ?? '';
  if (pendingVersion && effectivePublishedStatus(source)) return pendingVersion;
  return source.latestVersion?.trim() || null;
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
): { version: string; status: 'rejected' } | null {
  const rejected = latestRejectedVersionFromVersions(versions);
  if (!rejected) return null;
  const latest = latestVersion?.trim() ?? '';
  if (latest && compareDottedVersion(rejected.version, latest) <= 0) return null;
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

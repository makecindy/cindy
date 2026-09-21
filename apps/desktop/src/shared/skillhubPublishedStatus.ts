/** Shared publication status semantics for comparison and presentation. */
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


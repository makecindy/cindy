import type { GhostTrustInfo } from '../../shared/ghost.js';
import type { GhostInstallReceipt } from './ghostInstallReceipt.js';

const PACKAGE_SHA256_RE = /^[a-f0-9]{64}$/;

export interface GhostLocalUpdatePackageEvidence {
  ghostId: string;
  namespace: string | null;
  packageSha256: string;
  trust: GhostTrustInfo;
}

export interface GhostLocalUpdateMarketSource {
  resourceId: string;
  ghostId: string;
  namespace: string | null;
}

export interface GhostLocalUpdateSourceInput {
  existingSourceChanged: boolean;
  previousApprovedReceipt: Pick<GhostInstallReceipt,
    'id' | 'namespace' | 'packageSha256' | 'trust' | 'legacyFirstPartyEligible'> | null;
  inspectedPackage: GhostLocalUpdatePackageEvidence;
  currentTrustedMarketSource?: GhostLocalUpdateMarketSource | null;
  hostVerifiedRelease?: (GhostLocalUpdateMarketSource & { packageSha256: string }) | null;
}

export interface GhostLocalUpdateSourceDecision {
  sourceChanged: boolean;
  legacyFirstPartyEligible: boolean;
}

function verifiedPublisherKey(trust: GhostTrustInfo): string | null {
  return trust.publisherSigned && trust.publisherVerified &&
    typeof trust.publisherKeyId === 'string' && trust.publisherKeyId.length > 0
    ? trust.publisherKeyId : null;
}

export function classifyGhostLocalUpdateSource(
  input: GhostLocalUpdateSourceInput,
): GhostLocalUpdateSourceDecision {
  const previous = input.previousApprovedReceipt;
  const next = input.inspectedPackage;
  const identityMatches = previous !== null && previous.id === next.ghostId &&
    (previous.namespace ?? null) === next.namespace;
  const previousHashValid = previous?.packageSha256 !== undefined &&
    PACKAGE_SHA256_RE.test(previous.packageSha256);
  const nextHashValid = PACKAGE_SHA256_RE.test(next.packageSha256);
  const source = input.currentTrustedMarketSource;
  const release = input.hostVerifiedRelease;
  const exactTrustedRelease = source != null && release != null &&
    source.resourceId.length > 0 && source.resourceId === release.resourceId &&
    source.ghostId === next.ghostId && release.ghostId === next.ghostId &&
    source.namespace === next.namespace && release.namespace === next.namespace &&
    PACKAGE_SHA256_RE.test(release.packageSha256) &&
    release.packageSha256 === next.packageSha256;
  const previousPublisherKey = previous ? verifiedPublisherKey(previous.trust) : null;
  const sameSourceProven = identityMatches && previousHashValid && nextHashValid && (
    previous.packageSha256 === next.packageSha256 ||
    (previousPublisherKey !== null && previousPublisherKey === verifiedPublisherKey(next.trust)) ||
    exactTrustedRelease
  );
  const previousProtectedSource = previous?.legacyFirstPartyEligible === true ||
    previous?.trust.level === 'cindy-official' || previousPublisherKey !== null || source != null;
  const sourceChanged = input.existingSourceChanged || !identityMatches || !nextHashValid ||
    (previousProtectedSource && !sameSourceProven);
  return {
    sourceChanged,
    legacyFirstPartyEligible: !sourceChanged && previousHashValid &&
      previous?.legacyFirstPartyEligible === true,
  };
}

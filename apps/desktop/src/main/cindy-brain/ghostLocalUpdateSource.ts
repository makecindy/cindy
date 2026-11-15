import type { GhostTrustInfo } from '../../shared/ghost.js';
import type { GhostInstallReceipt } from './ghostInstallReceipt.js';
import { LOCAL_PLUGIN_NAMESPACE } from '../../shared/pluginIdentity.js';

const PACKAGE_SHA256_RE = /^[a-f0-9]{64}$/;

export interface GhostLocalUpdatePackageEvidence {
  ghostId: string;
  namespace: string | null;
  packageSha256: string;
  trust: GhostTrustInfo;
}

export interface GhostLocalUpdateSourceInput {
  existingSourceChanged: boolean;
  nextInstallOrigin?: 'manual' | 'agent-forge';
  previousApprovedReceipt: Pick<GhostInstallReceipt,
    'id' | 'namespace' | 'packageSha256' | 'trust' | 'legacyFirstPartyEligible' | 'installOrigin'> | null;
  inspectedPackage: GhostLocalUpdatePackageEvidence;
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
  const previousPublisherKey = previous ? verifiedPublisherKey(previous.trust) : null;
  const sameSourceProven = identityMatches && previousHashValid && nextHashValid && (
    previous.packageSha256 === next.packageSha256 ||
    (previousPublisherKey !== null && previousPublisherKey === verifiedPublisherKey(next.trust))
  );
  const previousProtectedSource = previous?.legacyFirstPartyEligible === true ||
    previous?.trust.level === 'cindy-official' || previousPublisherKey !== null;
  const originChanged = input.nextInstallOrigin !== undefined && next.namespace !== LOCAL_PLUGIN_NAMESPACE &&
    (previous?.installOrigin === 'agent-forge' ? 'agent-forge' : 'manual') !== input.nextInstallOrigin;
  const sourceChanged = input.existingSourceChanged || originChanged || !identityMatches || !nextHashValid ||
    (previousProtectedSource && !sameSourceProven);
  return {
    sourceChanged,
    legacyFirstPartyEligible: !sourceChanged && previousHashValid &&
      previous?.legacyFirstPartyEligible === true,
  };
}

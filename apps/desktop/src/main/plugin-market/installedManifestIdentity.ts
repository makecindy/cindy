import type { GhostManifest } from '../../shared/ghost.js';
import { isValidPluginNamespace } from '@cindy/plugin-protocol';
import type { InstalledGhostManifestSnapshot } from '../installedGhostManifest.js';
import {
  ghostManifestDigest,
  legacyNoSlotsGhostManifestDigest,
  type PluginMarketInstallationRecord,
} from './ledger.js';

export interface InstalledMarketManifestIdentity {
  manifest: GhostManifest;
  rawManifestSha256: string;
  /** Digest written by released clients; keep it stable for downgrade reads. */
  legacyManifestDigest: string;
  legacyManifestDigests: readonly string[];
}

/**
 * Convert the single-read installed snapshot into the market identity view.
 * Historical digests stay inside this adapter so normal callers cannot grow
 * their own compatibility candidate lists.
 */
export function installedMarketManifestIdentity(
  snapshot: InstalledGhostManifestSnapshot,
): InstalledMarketManifestIdentity {
  const legacyManifestDigests = new Set<string>();
  for (const format of snapshot.legacyDigestFormats) {
    legacyManifestDigests.add(ghostManifestDigest(format));
    legacyManifestDigests.add(legacyNoSlotsGhostManifestDigest(format));
  }
  return {
    manifest: snapshot.manifest,
    rawManifestSha256: snapshot.rawManifestSha256,
    legacyManifestDigest: ghostManifestDigest(snapshot.releasedLegacyDigestFormat),
    legacyManifestDigests: [...legacyManifestDigests],
  };
}

/**
 * New records are matched only by exact raw ghost.json bytes. Records written
 * by released clients enter the isolated legacy path until stable-owner
 * reconciliation can safely backfill the raw identity.
 */
export function verifyInstalledMarketManifest(
  record: PluginMarketInstallationRecord,
  identity: InstalledMarketManifestIdentity,
  options: { allowLegacyRecordWithoutDigest?: boolean } = {},
): boolean {
  if (record.rawManifestSha256 !== undefined) {
    return record.rawManifestSha256 === identity.rawManifestSha256;
  }
  if (record.manifestDigest !== undefined) {
    return identity.legacyManifestDigests.includes(record.manifestDigest);
  }
  return options.allowLegacyRecordWithoutDigest === true;
}

/** A missing raw field may be backfilled only from an exact released digest. */
export function legacyManifestIdentityMatches(
  record: PluginMarketInstallationRecord,
  identity: InstalledMarketManifestIdentity,
): boolean {
  return (
    record.rawManifestSha256 === undefined &&
    record.manifestDigest !== undefined &&
    identity.legacyManifestDigests.includes(record.manifestDigest)
  );
}

/** Compare a receipt's normalized Manifest with the installed legacy projections. */
export function installedIdentityMatchesManifest(
  identity: InstalledMarketManifestIdentity,
  manifest: GhostManifest,
): boolean {
  return identity.legacyManifestDigests.includes(ghostManifestDigest(manifest));
}

export function verifiedUnstampedOrganizationNamespace(input: {
  records: readonly PluginMarketInstallationRecord[];
  organizationId: string | null;
  orgSlug: string | null;
  evidence: { packageSha256: string | null; approvedManifest: GhostManifest; legacyMigrated: boolean } | null;
  identity: InstalledMarketManifestIdentity | null;
}): string | null {
  const installedRecords = input.records.filter((record) => record.installed);
  if (installedRecords.length !== 1 || !input.evidence || !input.identity ||
      !input.orgSlug || !isValidPluginNamespace(input.orgSlug)) return null;
  const record = installedRecords[0];
  if (record.scope !== 'organization' ||
      (record.source !== 'market' && record.source !== 'legacy-adopted') ||
      !record.organizationId || record.organizationId !== input.organizationId ||
      (record.namespace !== undefined && record.namespace !== input.orgSlug) ||
      (input.evidence.packageSha256 !== null && input.evidence.packageSha256 !== record.sha256) ||
      (input.evidence.packageSha256 === null && !input.evidence.legacyMigrated) ||
      !installedIdentityMatchesManifest(input.identity, input.evidence.approvedManifest)) return null;
  if (!verifyInstalledMarketManifest(record, input.identity) &&
      !(input.evidence.packageSha256 === record.sha256 &&
        record.rawManifestSha256 === undefined && record.manifestDigest === undefined)) return null;
  return input.orgSlug;
}

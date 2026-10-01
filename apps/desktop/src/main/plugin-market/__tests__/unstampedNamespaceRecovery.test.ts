import { describe, expect, it } from 'vitest';

import type { GhostManifest } from '../../../shared/ghost.js';
import { ghostManifestDigest, type PluginMarketInstallationRecord } from '../ledger.js';
import {
  verifiedUnstampedOrganizationNamespace,
  type InstalledMarketManifestIdentity,
} from '../installedManifestIdentity.js';

const manifest = {
  schemaVersion: 2, id: 'hello', name: 'Hello', version: '1.0.0', kind: 'chip', entry: 'main.js',
} as GhostManifest;
const digest = ghostManifestDigest(manifest);
const packageSha256 = 'b'.repeat(64);
const identity: InstalledMarketManifestIdentity = {
  manifest, rawManifestSha256: digest, legacyManifestDigest: digest,
  legacyManifestDigests: [digest],
};
const record: PluginMarketInstallationRecord = {
  pluginId: 'plugin', ghostId: 'hello', releaseId: 'release', version: '1.0.0',
  sha256: packageSha256, scope: 'organization', organizationId: 'org-acme',
  namespace: 'acme', source: 'market', installed: true, updatedAt: '2026-01-01T00:00:00Z',
  rawManifestSha256: digest,
};
const evidence = { packageSha256, approvedManifest: manifest, legacyMigrated: false };
const input = { records: [record], organizationId: 'org-acme', orgSlug: 'acme', evidence, identity };

describe('unstamped organization namespace recovery', () => {
  it('restores only the approved package for the current organization', () => {
    expect(verifiedUnstampedOrganizationNamespace(input)).toBe('acme');
    expect(verifiedUnstampedOrganizationNamespace({ ...input, organizationId: 'other' })).toBeNull();
    expect(verifiedUnstampedOrganizationNamespace({ ...input, records: [record, record] })).toBeNull();
    expect(verifiedUnstampedOrganizationNamespace({ ...input, records: [{ ...record, namespace: null }] })).toBeNull();
  });

  it('rejects changed package, installed manifest, or approval', () => {
    expect(verifiedUnstampedOrganizationNamespace({
      ...input, evidence: { ...evidence, packageSha256: 'c'.repeat(64) },
    })).toBeNull();
    expect(verifiedUnstampedOrganizationNamespace({
      ...input, identity: { ...identity, rawManifestSha256: 'c'.repeat(64) },
    })).toBeNull();
    expect(verifiedUnstampedOrganizationNamespace({
      ...input, evidence: { ...evidence, approvedManifest: { ...manifest, name: 'Other' } },
    })).toBeNull();
    expect(verifiedUnstampedOrganizationNamespace({
      ...input, records: [{ ...record, rawManifestSha256: undefined }],
      evidence: { ...evidence, packageSha256: null },
    })).toBeNull();
  });

  it('recovers a legacy-approved package only with completed migration and matched digest', () => {
    const legacyInput = {
      ...input,
      records: [{ ...record, rawManifestSha256: undefined, manifestDigest: digest }],
      evidence: { ...evidence, packageSha256: null, legacyMigrated: true },
    };
    expect(verifiedUnstampedOrganizationNamespace(legacyInput)).toBe('acme');
    expect(verifiedUnstampedOrganizationNamespace({
      ...legacyInput, evidence: { ...legacyInput.evidence, legacyMigrated: false },
    })).toBeNull();
    expect(verifiedUnstampedOrganizationNamespace({
      ...legacyInput, records: [{ ...legacyInput.records[0], manifestDigest: 'c'.repeat(64) }],
    })).toBeNull();
  });
});

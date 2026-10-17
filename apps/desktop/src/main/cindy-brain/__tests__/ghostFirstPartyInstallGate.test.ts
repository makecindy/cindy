import { describe, expect, it } from 'vitest';
import {
  bindPendingMarketRecordToInspectedPackage,
  loadGhostFirstPartyFactsLoader,
} from '../ghostFirstPartyFacts.js';
import { authorizeGhostHostPrimitive, authorizeGhostTokenBroker } from '../ghostFirstPartyPrivilege.js';

const PACKAGE_SHA256 = 'a'.repeat(64);
const PERSONAL = { membershipKind: 'personal' as const, orgId: null };
const XD = { membershipKind: 'org' as const, orgId: 'org-xd' };

function loader(namespace: string | null | undefined = undefined, pending = false, prefix?: 'xd') {
  return loadGhostFirstPartyFactsLoader({
    readInstalledBuiltin: () => false,
    readMarketInstallation: () => ({
      pluginId: 'plugin-helper', ghostId: 'helper', releaseId: 'release-1', version: '1.0.0',
      scope: 'organization', source: 'market', installed: true, organizationId: 'org-xd',
      sha256: PACKAGE_SHA256, updatedAt: '2026-09-30T00:00:00Z',
    }),
    readApprovedPackageSha256: () => PACKAGE_SHA256,
    readInstallOrigin: () => 'manual', readInstallNamespace: () => namespace,
    readLegacyFirstPartyEligible: () => true,
    isPendingLegacyNamespace: () => pending,
    lookupOrganizationPrefix: () => prefix ? { kind: 'known', pluginPrefix: prefix } : { kind: 'absent' },
  });
}

describe('first-party install authorization and old organization tokens', () => {
  it('authorizes a first official Cindy public broker install only from exact inspected server bytes', () => {
    const pending = {
      scope: 'public' as const, source: 'market' as const, installed: true,
      organizationId: null, sha256: PACKAGE_SHA256,
    };
    for (const inspectedPackageSha256 of [PACKAGE_SHA256, 'b'.repeat(64)]) {
      const loaded = loader().load('cindy-web-search', 'install', PERSONAL, {
        marketRecord: bindPendingMarketRecordToInspectedPackage(pending, inspectedPackageSha256),
      });
      expect(authorizeGhostTokenBroker('cindy-web-search', loaded)).toBe(inspectedPackageSha256 === PACKAGE_SHA256);
    }
  });

  it('uses a Host legacy override only for same-source root updates, never an implicit install-time reader', () => {
    const marketRecord = bindPendingMarketRecordToInspectedPackage({
      scope: 'public', source: 'market', installed: true, organizationId: null, sha256: PACKAGE_SHA256,
    }, PACKAGE_SHA256);
    for (const legacyFirstPartyEligible of [undefined, false, true]) {
      const loaded = loader().load('filo-google', 'install', PERSONAL, {
        marketRecord, ...(legacyFirstPartyEligible !== undefined ? { legacyFirstPartyEligible } : {}),
      });
      expect(authorizeGhostTokenBroker('filo-google', loaded)).toBe(legacyFirstPartyEligible === true);
    }
    const freshXd = loader().load('xd-helper', 'install', PERSONAL, { marketRecord, legacyFirstPartyEligible: false });
    expect(authorizeGhostHostPrimitive('xd-helper', freshXd)).toBe(false);
  });

  it('allows approved XD namespace with an old token missing orgSlug, but rejects an explicit different slug', () => {
    const loaded = loader('xd').load('_ns/xd/helper', 'runtime', XD);
    expect(authorizeGhostHostPrimitive('helper', loaded)).toBe(true);
    const foreignSlug = loader('xd').load('_ns/xd/helper', 'runtime', { ...XD, orgSlug: 'other' });
    expect(authorizeGhostHostPrimitive('helper', foreignSlug)).toBe(false);
  });

  it('does not authorize a known root from a copied organization row with the same approved hash', () => {
    for (const ghostId of ['helper', 'xd-helper', 'cindy-helper']) {
      const loaded = loader(null, false, 'xd').load(ghostId, 'runtime', { ...XD, orgSlug: 'xd' });
      expect(authorizeGhostTokenBroker(ghostId, loaded)).toBe(false);
      expect(authorizeGhostHostPrimitive(ghostId, loaded)).toBe(false);
    }
  });

  it('allows only a real old pending XD instance with a known fixed prefix when orgSlug is missing', () => {
    expect(authorizeGhostHostPrimitive('helper', loader(undefined, true, 'xd').load('helper', 'runtime', XD))).toBe(true);
    expect(authorizeGhostHostPrimitive('helper', loader(undefined, false, 'xd').load('helper', 'runtime', XD))).toBe(false);
    expect(authorizeGhostHostPrimitive('helper', loader(null, true, 'xd').load('helper', 'runtime', XD))).toBe(false);
    expect(authorizeGhostHostPrimitive('helper', loader(undefined, true).load('helper', 'runtime', XD))).toBe(false);
    expect(authorizeGhostHostPrimitive('helper', loader(undefined, true, 'xd').load('helper', 'runtime', { ...XD, orgSlug: 'other' }))).toBe(false);
  });
});

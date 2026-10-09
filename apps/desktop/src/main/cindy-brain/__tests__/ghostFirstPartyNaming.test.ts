import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isUserInstallReservedGhostId, validateGhostManifest } from '../../../shared/ghost.js';
import { loadGhostFirstPartyFactsLoader } from '../ghostFirstPartyFacts.js';
import {
  captureLegacyFirstPartyEligibility,
  authorizeGhostHostPrimitive,
  resolveGhostFirstPartyPrivilege,
  type GhostFirstPartyFacts,
  type GhostFirstPartyMarketRecord,
} from '../ghostFirstPartyPrivilege.js';
import {
  createGhostInstallReceipt,
  GhostInstallReceiptStore,
  legacyFirstPartyEligibilityAfterUpdate,
} from '../ghostInstallReceipt.js';

const PACKAGE_SHA256 = 'a'.repeat(64);
const XD = { organizationId: 'org-xd', orgSlug: 'xd', pluginPrefix: 'xd' };
const PUBLIC_RECORD: GhostFirstPartyMarketRecord = {
  scope: 'public', organizationId: null, source: 'market', installed: true,
  sha256: PACKAGE_SHA256, approvedPackageSha256: PACKAGE_SHA256,
};

function facts(overrides: Partial<GhostFirstPartyFacts> = {}): GhostFirstPartyFacts {
  return {
    ghostId: 'helper', namespace: null, builtin: false, marketRecord: null,
    currentOrganization: null, installOrigin: 'manual', ...overrides,
  };
}

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('first-party naming and approved source eligibility', () => {
  it.each(['xd-helper', 'filo-helper', 'cindy-helper'])('does not grant new root %s by name or builtin roster', (ghostId) => {
    for (const builtin of [false, true]) {
      expect(resolveGhostFirstPartyPrivilege(facts({ ghostId, builtin, marketRecord: null }))).toMatchObject({
        brokerEligible: false, hostPrimitiveEligible: false,
      });
    }
    expect(isUserInstallReservedGhostId(ghostId)).toBe(ghostId === 'cindy-helper');
    expect(resolveGhostFirstPartyPrivilege(facts({ ghostId, marketRecord: PUBLIC_RECORD })).hostPrimitiveEligible)
      .toBe(ghostId === 'cindy-helper');
  });

  it.each(['helper', 'xd-helper', 'filo-helper'])('grants trusted XD organization %s without a naming or phase gate', (ghostId) => {
    const trusted = facts({
      ghostId, namespace: 'xd', currentOrganization: XD,
      marketRecord: { ...PUBLIC_RECORD, scope: 'organization', organizationId: XD.organizationId },
    });
    expect(resolveGhostFirstPartyPrivilege(trusted)).toEqual({
      brokerEligible: true, hostPrimitiveEligible: true, basis: 'market-organization-current',
    });
    for (const source of ['legacy-adopted', 'local-market', 'git-market'] as const) {
      expect(resolveGhostFirstPartyPrivilege({ ...trusted, marketRecord: { ...trusted.marketRecord!, source } }).hostPrimitiveEligible).toBe(false);
    }
    expect(resolveGhostFirstPartyPrivilege({ ...trusted, marketRecord: null }).hostPrimitiveEligible).toBe(false);
    expect(resolveGhostFirstPartyPrivilege({ ...trusted, namespace: null }).hostPrimitiveEligible).toBe(false);
    expect(resolveGhostFirstPartyPrivilege({ ...trusted, currentOrganization: { ...XD, organizationId: 'other' } }).hostPrimitiveEligible).toBe(false);
    expect(resolveGhostFirstPartyPrivilege({ ...trusted, marketRecord: { ...trusted.marketRecord!, approvedPackageSha256: 'b'.repeat(64) } }).hostPrimitiveEligible).toBe(false);
  });

  it.each(['helper', 'cindy-helper'])('binds official %s to exact approved identity and hash, not a prefix', (ghostId) => {
    const trusted = facts({
      ghostId, builtin: true, approvedPackageSha256: PACKAGE_SHA256,
      trustedSource: { kind: 'builtin-official', ghostId, namespace: null, packageSha256: PACKAGE_SHA256 },
    });
    expect(resolveGhostFirstPartyPrivilege(trusted).hostPrimitiveEligible).toBe(true);
    for (const changed of [
      { ...trusted, ghostId: 'different' },
      { ...trusted, namespace: 'xd' },
      { ...trusted, approvedPackageSha256: null },
      { ...trusted, approvedPackageSha256: 'b'.repeat(64) },
      { ...trusted, trustedSource: { ...trusted.trustedSource!, packageSha256: 'invalid' }, approvedPackageSha256: 'invalid' },
    ]) expect(resolveGhostFirstPartyPrivilege(changed).hostPrimitiveEligible).toBe(false);
    const publicInstall = { ...trusted, builtin: false, marketRecord: PUBLIC_RECORD, trustedSource: null };
    expect(resolveGhostFirstPartyPrivilege(publicInstall).hostPrimitiveEligible).toBe(ghostId === 'cindy-helper');
    expect(resolveGhostFirstPartyPrivilege({ ...publicInstall, marketRecord: null }).hostPrimitiveEligible).toBe(false);
    expect(resolveGhostFirstPartyPrivilege({ ...publicInstall, marketRecord: { ...PUBLIC_RECORD, sha256: 'b'.repeat(64) } }).hostPrimitiveEligible).toBe(false);
  });

  it('keeps an exact Cindy public resource usable without builtin facts or an organization prefix cache', () => {
    const loader = loadGhostFirstPartyFactsLoader({
      readInstalledBuiltin: () => false,
      readMarketInstallation: () => ({
        ...PUBLIC_RECORD, pluginId: 'plugin-cindy', ghostId: 'cindy-helper',
        releaseId: 'release-1', version: '1.0.0', updatedAt: '2026-09-30T00:00:00Z',
      }),
      readApprovedPackageSha256: () => PACKAGE_SHA256,
      readInstallOrigin: () => 'manual',
      readInstallNamespace: () => null,
      lookupOrganizationPrefix: () => { throw new Error('prefix lookup must not be required'); },
    });
    const loaded = loader.load('cindy-helper', 'runtime', { membershipKind: 'org', orgId: XD.organizationId, orgSlug: 'xd' });
    expect(loaded.kind).toBe('ready');
    if (loaded.kind !== 'ready') throw new Error('public resource facts unavailable');
    expect(loaded.facts.trustedSource).toBeUndefined();
    expect(resolveGhostFirstPartyPrivilege(loaded.facts).basis).toBe('market-public');
  });

  it('allows an exact official Cindy web-search market update before alias denial but never public XD Mivo', () => {
    const official = facts({ ghostId: 'cindy-web-search', marketRecord: PUBLIC_RECORD });
    expect(resolveGhostFirstPartyPrivilege(official)).toEqual({
      brokerEligible: true, hostPrimitiveEligible: true, basis: 'market-public',
    });
    for (const changed of [
      { ...official, namespace: 'xd' },
      { ...official, marketRecord: { ...PUBLIC_RECORD, approvedPackageSha256: 'b'.repeat(64) } },
      { ...official, marketRecord: { ...PUBLIC_RECORD, source: 'local-market' as const } },
      { ...official, ghostId: 'xd-mivo' },
    ]) expect(resolveGhostFirstPartyPrivilege(changed).basis).toBe('denied-alias');
  });

  it('captures only a real census installation with approved trusted public package evidence', () => {
    const candidate = {
      legacyExistingInstall: true, approved: true, ghostId: 'filo-google', namespace: null,
      approvedPackageSha256: PACKAGE_SHA256, marketRecord: { ...PUBLIC_RECORD, ghostId: 'filo-google' },
    };
    expect(captureLegacyFirstPartyEligibility(candidate)).toBe(true);
    for (const changed of [
      { ...candidate, legacyExistingInstall: false },
      { ...candidate, approved: false },
      { ...candidate, namespace: 'xd' },
      { ...candidate, approvedPackageSha256: 'b'.repeat(64) },
      { ...candidate, ghostId: 'helper' },
      { ...candidate, marketRecord: null },
      { ...candidate, marketRecord: { ...candidate.marketRecord, ghostId: 'other' } },
      { ...candidate, marketRecord: { ...candidate.marketRecord, namespace: 'xd' } },
      { ...candidate, marketRecord: { ...candidate.marketRecord, installed: false } },
      { ...candidate, marketRecord: { ...candidate.marketRecord, approvedPackageSha256: null } },
      { ...candidate, marketRecord: { ...candidate.marketRecord, approvedPackageSha256: 'b'.repeat(64) } },
      { ...candidate, marketRecord: { ...candidate.marketRecord, source: 'legacy-adopted' as const } },
      { ...candidate, marketRecord: { ...candidate.marketRecord, scope: 'organization' as const, organizationId: XD.organizationId } },
    ]) expect(captureLegacyFirstPartyEligibility(changed)).toBe(false);
  });

  it('does not let a legacy flag bypass alias, namespace, organization or changed-source gates', () => {
    for (const ghostId of ['xd-mivo', 'cindy-web-search']) {
      expect(resolveGhostFirstPartyPrivilege(facts({ ghostId, legacyFirstPartyEligible: true })).basis).toBe('denied-alias');
    }
    const legacy = facts({ ghostId: 'xd-helper', legacyFirstPartyEligible: true });
    expect(resolveGhostFirstPartyPrivilege(legacy).hostPrimitiveEligible).toBe(true);
    for (const changed of [
      { ...legacy, namespace: 'xd' },
      { ...legacy, installOrigin: 'agent-forge' as const },
      { ...legacy, marketRecord: { ...PUBLIC_RECORD, installed: false } },
      { ...legacy, marketRecord: { ...PUBLIC_RECORD, source: 'local-market' as const } },
      { ...legacy, marketRecord: { ...PUBLIC_RECORD, scope: 'organization' as const, organizationId: 'foreign' }, currentOrganization: XD },
    ]) expect(resolveGhostFirstPartyPrivilege(changed).hostPrimitiveEligible).toBe(false);
    expect(resolveGhostFirstPartyPrivilege({
      ...legacy, namespace: 'xd', currentOrganization: XD,
      marketRecord: { ...PUBLIC_RECORD, scope: 'organization', organizationId: 'foreign' },
    }).brokerEligible).toBe(false);
  });

  it.each(['absent', 'unavailable', 'throws'] as const)('authorizes natural XD names with %s prefix cache and keeps legacy Forge closed', (prefixState) => {
    let prefixReads = 0;
    const loader = loadGhostFirstPartyFactsLoader({
      readInstalledBuiltin: () => false,
      readMarketInstallation: () => ({
        ...PUBLIC_RECORD, scope: 'organization', organizationId: XD.organizationId,
        pluginId: 'plugin-helper', ghostId: 'helper', releaseId: 'release-1',
        version: '1.0.0', updatedAt: '2026-09-30T00:00:00Z',
      }),
      readApprovedPackageSha256: () => PACKAGE_SHA256,
      readInstallOrigin: () => 'manual',
      lookupOrganizationPrefix: () => {
        prefixReads += 1;
        if (prefixState === 'throws') throw new Error('prefix cache unavailable');
        return { kind: prefixState };
      },
    });
    const identity = { membershipKind: 'org' as const, orgId: XD.organizationId, orgSlug: 'xd' };
    const loaded = loader.load('_ns/xd/helper', 'runtime', identity);
    expect(loaded.kind).toBe('ready');
    if (loaded.kind === 'ready') {
      expect(loaded.facts.currentOrganization).toEqual({ organizationId: XD.organizationId, orgSlug: 'xd' });
      expect(resolveGhostFirstPartyPrivilege(loaded.facts).hostPrimitiveEligible).toBe(true);
    }
    expect(prefixReads).toBe(0);
    const legacyForge = loader.load('xd-helper', 'runtime', identity, { installOrigin: 'agent-forge' });
    expect(legacyForge.kind).toBe('unavailable');
    expect(prefixReads).toBe(1);
  });

  it('preserves offline pending XD enterprise privileges only for the censused unbound instance', () => {
    const createLoader = (recordedNamespace: string | null | undefined, pending: boolean) => loadGhostFirstPartyFactsLoader({
      readInstalledBuiltin: () => false,
      readMarketInstallation: () => ({
        ...PUBLIC_RECORD, scope: 'organization', organizationId: XD.organizationId,
        pluginId: 'plugin-old', ghostId: 'xd-helper', releaseId: 'release-1',
        version: '1.0.0', updatedAt: '2026-09-30T00:00:00Z',
      }),
      readApprovedPackageSha256: () => PACKAGE_SHA256,
      readInstallOrigin: () => 'manual',
      readInstallNamespace: () => recordedNamespace,
      isPendingLegacyNamespace: () => pending,
      isPendingLegacyForge: () => pending,
      lookupOrganizationPrefix: () => { throw new Error('offline prefix cache'); },
    });
    const identity = { membershipKind: 'org' as const, orgId: XD.organizationId, orgSlug: 'xd' };
    const oldPending = createLoader(undefined, true).load('xd-helper', 'runtime', identity);
    expect(oldPending.kind).toBe('ready');
    if (oldPending.kind !== 'ready') throw new Error('pending facts unavailable');
    expect(oldPending.facts.legacyPendingNamespace).toBe(true);
    expect(oldPending.facts.installOrigin).toBe('manual');
    expect(resolveGhostFirstPartyPrivilege(oldPending.facts).hostPrimitiveEligible).toBe(true);
    expect(resolveGhostFirstPartyPrivilege({ ...oldPending.facts, legacyPendingNamespace: false }).hostPrimitiveEligible).toBe(false);
    for (const denied of [
      createLoader(null, true).load('xd-helper', 'runtime', identity),
      createLoader(undefined, false).load('xd-helper', 'runtime', identity),
      createLoader(undefined, true).load('xd-helper', 'install', identity),
      createLoader(undefined, true).load('xd-helper', 'runtime', { ...identity, orgId: 'foreign' }),
      createLoader(undefined, true).load('xd-helper', 'runtime', identity, { installOrigin: 'agent-forge' }),
    ]) expect(authorizeGhostHostPrimitive('xd-helper', denied)).toBe(false);
    expect(resolveGhostFirstPartyPrivilege({
      ...oldPending.facts, marketRecord: { ...oldPending.facts.marketRecord!, approvedPackageSha256: null },
    }).hostPrimitiveEligible).toBe(false);
    const committed = createLoader('xd', true).load('xd-helper', 'runtime', identity);
    if (committed.kind !== 'ready') throw new Error('committed facts unavailable');
    expect(committed.facts.legacyPendingNamespace).toBeUndefined();
    expect(resolveGhostFirstPartyPrivilege(committed.facts).hostPrimitiveEligible).toBe(true);
  });

  it('loads captured receipt eligibility offline after census pending entries disappear, but never for a new install', () => {
    const loader = loadGhostFirstPartyFactsLoader({
      readInstalledBuiltin: () => false,
      readMarketInstallation: () => { throw new Error('offline ledger'); },
      readApprovedPackageSha256: () => null,
      readInstallOrigin: () => 'manual',
      lookupOrganizationPrefix: () => { throw new Error('offline organization cache'); },
      readLegacyFirstPartyEligible: () => true,
    });
    const identity = { membershipKind: 'org' as const, orgId: XD.organizationId, orgSlug: 'xd' };
    const runtime = loader.load('filo-google', 'runtime', identity);
    expect(runtime.kind).toBe('ready');
    if (runtime.kind === 'ready') expect(resolveGhostFirstPartyPrivilege(runtime.facts)).toEqual({
      brokerEligible: true, hostPrimitiveEligible: true, basis: 'legacy-existing-install',
    });
    expect(loader.load('filo-google', 'install', identity).kind).toBe('unavailable');
    expect(legacyFirstPartyEligibilityAfterUpdate({ legacyFirstPartyEligible: true }, false)).toBe(true);
    expect(legacyFirstPartyEligibilityAfterUpdate({ legacyFirstPartyEligible: true }, true)).toBe(false);
    expect(legacyFirstPartyEligibilityAfterUpdate({}, false)).toBe(false);
    expect(resolveGhostFirstPartyPrivilege(facts({ ghostId: 'filo-google', legacyFirstPartyEligible: false })).hostPrimitiveEligible).toBe(false);
  });

  it('persists the Host legacy qualification and rejects damaged receipt fields', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-first-party-naming-'));
    tempRoots.push(root);
    const store = new GhostInstallReceiptStore(() => root);
    const parsed = validateGhostManifest({
      schemaVersion: 2, id: 'filo-google', name: 'Google', version: '1.0.0', kind: 'chip', entry: 'main.js', slots: [],
    });
    if (!parsed.ok) throw new Error(parsed.reason);
    const input = {
      manifest: parsed.manifest, localeResources: {}, enabled: true, skillContentSha256: {},
      trust: { level: 'unverified' as const, publisherSigned: false, publisherVerified: false, reviewed: false },
    };
    expect(createGhostInstallReceipt(input).legacyFirstPartyEligible).toBeUndefined();
    const receipt = createGhostInstallReceipt({ ...input, legacyFirstPartyEligible: true });
    await store.write(receipt);
    expect(store.readForRecovery('filo-google')).toMatchObject({ state: 'approved', receipt: { legacyFirstPartyEligible: true } });
    const loader = loadGhostFirstPartyFactsLoader({
      readInstalledBuiltin: () => false, readMarketInstallation: () => null,
      readApprovedPackageSha256: () => null, readInstallOrigin: () => 'manual',
      lookupOrganizationPrefix: () => ({ kind: 'absent' }),
      readLegacyFirstPartyEligible: (relId) => {
        const read = store.readForRecovery(relId);
        return read.state === 'approved' && read.receipt.legacyFirstPartyEligible === true;
      },
    });
    const identity = { membershipKind: 'personal' as const, orgId: null };
    const approved = loader.load('filo-google', 'runtime', identity);
    if (approved.kind !== 'ready') throw new Error('approved facts unavailable');
    expect(resolveGhostFirstPartyPrivilege(approved.facts).hostPrimitiveEligible).toBe(true);
    for (const legacyFirstPartyEligible of ['true', 1, {}, null]) {
      fs.writeFileSync(path.join(root, 'filo-google.json'), JSON.stringify({ ...receipt, legacyFirstPartyEligible }));
      expect(store.readForRecovery('filo-google').state).not.toBe('approved');
      const damaged = loader.load('filo-google', 'runtime', identity);
      if (damaged.kind !== 'ready') throw new Error('damaged facts unavailable');
      expect(resolveGhostFirstPartyPrivilege(damaged.facts).hostPrimitiveEligible).toBe(false);
    }
    fs.writeFileSync(path.join(root, 'filo-google.json'), JSON.stringify({ ...receipt, revision: 'damaged' }));
    expect(store.readForRecovery('filo-google').state).not.toBe('approved');
  });
});

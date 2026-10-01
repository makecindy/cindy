import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { PluginMarketInstallationRecord } from '../../plugin-market/ledger.js';
import { createOrganizationPrefixStore } from '../../plugin-market/organizationPrefixStore.js';
import {
  bindPendingMarketRecordToInspectedPackage,
  loadGhostFirstPartyFactsLoader,
  type GhostFirstPartyFactsIdentity,
  type LoadGhostFirstPartyFactsLoaderOptions,
} from '../ghostFirstPartyFacts.js';
import {
  authorizeGhostTokenBroker,
  resolveGhostFirstPartyPrivilege,
} from '../ghostFirstPartyPrivilege.js';

const PERSONAL: GhostFirstPartyFactsIdentity = {
  membershipKind: 'personal',
  orgId: null,
};

const ORG_A: GhostFirstPartyFactsIdentity = {
  membershipKind: 'org',
  orgId: 'org-a',
  orgSlug: 'slug-a',
};

const ORG_B: GhostFirstPartyFactsIdentity = {
  membershipKind: 'org',
  orgId: 'org-b',
  orgSlug: 'slug-b',
};

const MARKET_ROW: PluginMarketInstallationRecord = {
  pluginId: 'plugin-1',
  ghostId: 'acme-tool',
  releaseId: 'release-1',
  version: '1.0.0',
  sha256: 'a'.repeat(64),
  scope: 'organization',
  organizationId: 'org-a',
  source: 'market',
  installed: true,
  updatedAt: '2026-08-21T00:00:00.000Z',
  manifestDigest: 'c'.repeat(64),
};

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function loader(overrides: Partial<LoadGhostFirstPartyFactsLoaderOptions> = {}) {
  return loadGhostFirstPartyFactsLoader({
    readInstalledBuiltin: () => false,
    readMarketInstallation: () => null,
    readApprovedPackageSha256: (ghostId) => ['xd-feishu', 'xd-atlassian'].includes(ghostId) ? 'a'.repeat(64) : null,
    readTrustedSource: (ghostId) => ['xd-feishu', 'xd-atlassian'].includes(ghostId) ? {
      kind: 'builtin-official', ghostId, namespace: null, packageSha256: 'a'.repeat(64),
    } : null,
    lookupOrganizationPrefix: () => ({ kind: 'absent' }),
    readInstallOrigin: () => 'manual',
    ...overrides,
  });
}

describe('loadGhostFirstPartyFactsLoader', () => {
  it('reads a new root receipt without inheriting the same-name legacy organization receipt', () => {
    const reads: string[] = [];
    const loaded = loader({
      readInstallNamespace: (id) => { reads.push(id); return id === 'xd-feishu' ? 'xd' : null; },
      lookupOrganizationPrefix: () => ({ kind: 'known', pluginPrefix: 'xd' }),
    }).load('_root__xd-feishu', 'runtime', ORG_A);
    expect(reads).toEqual(['_root/xd-feishu']);
    expect(loaded).toMatchObject({ kind: 'ready', facts: { namespace: null } });
    if (loaded.kind === 'ready') expect(resolveGhostFirstPartyPrivilege(loaded.facts).brokerEligible).toBe(false);
  });
  it('gives builtin official plugins broker on a personal identity with no prefix cache', () => {
    const factsLoader = loader({
      readInstalledBuiltin: (ghostId) => ghostId === 'xd-feishu' || ghostId === 'xd-atlassian',
      lookupOrganizationPrefix: () => {
        throw new Error('prefix cache must not be required for builtin official plugins');
      },
    });

    for (const ghostId of ['xd-feishu', 'xd-atlassian']) {
      const loaded = factsLoader.load(ghostId, 'runtime', PERSONAL);
      expect(loaded.kind, ghostId).toBe('ready');
      if (loaded.kind !== 'ready') continue;
      expect(loaded.facts).toEqual({
        ghostId,
        namespace: null,
        builtin: true,
        marketRecord: null,
        currentOrganization: null,
        installOrigin: 'manual',
        trustedSource: { kind: 'builtin-official', ghostId, namespace: null, packageSha256: 'a'.repeat(64) },
        approvedPackageSha256: 'a'.repeat(64),
      });
      expect(resolveGhostFirstPartyPrivilege(loaded.facts)).toEqual({
        brokerEligible: true,
        hostPrimitiveEligible: true,
        basis: 'builtin-official',
      });
    }
  });

  it('keeps logical ghostId for privilege matching and looks up the market row by instance id', () => {
    const seen = {
      builtin: [] as string[],
      origin: [] as string[],
      approved: [] as string[],
      market: [] as string[],
    };
    const factsLoader = loader({
      readInstalledBuiltin: (id) => {
        seen.builtin.push(id);
        return false;
      },
      readInstallOrigin: (id) => {
        seen.origin.push(id);
        return 'manual';
      },
      readApprovedPackageSha256: (id) => {
        seen.approved.push(id);
        return 'a'.repeat(64);
      },
      readMarketInstallation: (id) => {
        seen.market.push(id);
        return MARKET_ROW;
      },
      lookupOrganizationPrefix: () => ({ kind: 'known', pluginPrefix: 'acme' }),
    });

    const loaded = factsLoader.load('_ns__acme__acme-tool', 'runtime', ORG_A);
    expect(loaded.kind).toBe('ready');
    if (loaded.kind !== 'ready') return;
    expect(loaded.facts.ghostId).toBe('acme-tool');
    expect(seen.builtin).toEqual(['_ns__acme__acme-tool']);
    expect(seen.origin).toEqual(['_ns/acme/acme-tool']);
    expect(seen.approved).toEqual(['_ns/acme/acme-tool']);
    expect(seen.market).toEqual(['_ns__acme__acme-tool']);
    expect(resolveGhostFirstPartyPrivilege(loaded.facts)).toEqual({
      brokerEligible: true,
      hostPrimitiveEligible: false,
      basis: 'market-organization-current',
    });

    seen.builtin.length = 0;
    seen.origin.length = 0;
    seen.approved.length = 0;
    seen.market.length = 0;
    const fromRel = factsLoader.load('_ns/acme/acme-tool', 'runtime', ORG_A);
    expect(fromRel.kind).toBe('ready');
    if (fromRel.kind !== 'ready') return;
    expect(fromRel.facts.ghostId).toBe('acme-tool');
    expect(seen.origin).toEqual(['_ns/acme/acme-tool']);
    expect(seen.approved).toEqual(['_ns/acme/acme-tool']);
  });

  it('re-evaluates the current organization prefix after an org switch and keeps the previous key', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-first-party-facts-'));
    const store = createOrganizationPrefixStore(path.join(tempDir, 'organization.v1.json'));
    store.remember('org-a', 'aaa');
    store.remember('org-b', 'bbb');
    const factsLoader = loader({
      lookupOrganizationPrefix: (orgId) => store.lookup(orgId),
    });

    const orgA = factsLoader.load('aaa-tool', 'runtime', ORG_A);
    expect(orgA).toMatchObject({
      kind: 'ready',
      facts: {
        currentOrganization: { organizationId: 'org-a', pluginPrefix: 'aaa' },
      },
    });

    const orgB = factsLoader.load('bbb-tool', 'runtime', ORG_B);
    expect(orgB).toMatchObject({
      kind: 'ready',
      facts: {
        currentOrganization: { organizationId: 'org-b', pluginPrefix: 'bbb' },
      },
    });

    const orgAAgain = factsLoader.load('aaa-tool', 'runtime', ORG_A);
    expect(orgAAgain).toMatchObject({
      kind: 'ready',
      facts: {
        currentOrganization: { organizationId: 'org-a', pluginPrefix: 'aaa' },
      },
    });
    expect(store.lookup('org-a')).toEqual({ kind: 'known', pluginPrefix: 'aaa' });
    expect(store.lookup('org-b')).toEqual({ kind: 'known', pluginPrefix: 'bbb' });
  });

  it('does not synthesize pluginPrefix null when the cache is absent or unavailable', () => {
    const absent = loader({
      lookupOrganizationPrefix: () => ({ kind: 'absent' }),
    }).load('acme-tool', 'runtime', ORG_A);
    expect(absent).toEqual({
      kind: 'unavailable',
      reason: 'organization-prefix-absent',
      purpose: 'runtime',
      action: 'load-without-privilege',
    });

    const unavailable = loader({
      lookupOrganizationPrefix: () => ({ kind: 'unavailable' }),
    }).load('acme-tool', 'install', ORG_A);
    expect(unavailable).toEqual({
      kind: 'unavailable',
      reason: 'organization-prefix-unavailable',
      purpose: 'install',
      action: 'refuse-install',
    });
  });

  it('treats personal identity currentOrganization null as a determined fact', () => {
    const loaded = loader({
      lookupOrganizationPrefix: () => {
        throw new Error('personal identity must not look up an organization prefix');
      },
    }).load('local-tool', 'runtime', PERSONAL);

    expect(loaded).toEqual({
      kind: 'ready',
      facts: {
        ghostId: 'local-tool',
        namespace: null,
        builtin: false,
        marketRecord: null,
        currentOrganization: null,
        installOrigin: 'manual',
      },
    });
  });

  it('keeps refuse-install vs load-without-privilege as the two fail-closed intensities', () => {
    const factsLoader = loader({
      lookupOrganizationPrefix: () => ({ kind: 'absent' }),
    });
    expect(factsLoader.load('acme-tool', 'install', ORG_A)).toMatchObject({
      kind: 'unavailable',
      action: 'refuse-install',
    });
    expect(factsLoader.load('acme-tool', 'runtime', ORG_A)).toMatchObject({
      kind: 'unavailable',
      action: 'load-without-privilege',
    });
  });

  it('treats a ledger read failure as unavailable, not marketRecord null', () => {
    const loaded = loader({
      readMarketInstallation: () => {
        throw new Error('EACCES');
      },
      lookupOrganizationPrefix: () => ({ kind: 'known', pluginPrefix: 'acme' }),
    }).load('acme-tool', 'install', ORG_A);

    expect(loaded).toEqual({
      kind: 'unavailable',
      reason: 'market-installation-read-failed',
      purpose: 'install',
      action: 'refuse-install',
    });
  });

  it('keeps explicit Forge facts usable when the rebuildable market ledger cannot be read', () => {
    const loaded = loader({
      readInstallOrigin: () => 'agent-forge',
      readMarketInstallation: () => {
        throw new Error('EACCES');
      },
      lookupOrganizationPrefix: () => ({ kind: 'known', pluginPrefix: 'acme' }),
    }).load('acme-tool', 'runtime', ORG_A);

    expect(loaded).toMatchObject({
      kind: 'ready',
      facts: {
        marketRecord: null,
        installOrigin: 'agent-forge',
        currentOrganization: { organizationId: 'org-a', pluginPrefix: 'acme', orgSlug: 'slug-a' },
      },
    });
  });

  it('applies an install-time Forge origin before consulting a broken market ledger', () => {
    const loaded = loader({
      readInstallOrigin: () => 'manual',
      readMarketInstallation: () => {
        throw new Error('EACCES');
      },
      lookupOrganizationPrefix: () => ({ kind: 'known', pluginPrefix: 'acme' }),
    }).load('acme-tool', 'install', ORG_A, { installOrigin: 'agent-forge' });

    expect(loaded).toMatchObject({
      kind: 'ready',
      facts: { installOrigin: 'agent-forge', marketRecord: null },
    });
  });

  it('copies a confirmed ledger miss as marketRecord null when facts are otherwise ready', () => {
    const loaded = loader({
      readMarketInstallation: () => null,
      lookupOrganizationPrefix: () => ({ kind: 'known', pluginPrefix: 'acme' }),
    }).load('acme-tool', 'runtime', ORG_A);

    expect(loaded).toEqual({
      kind: 'ready',
      facts: {
        ghostId: 'acme-tool',
        namespace: null,
        builtin: false,
        marketRecord: null,
        currentOrganization: { organizationId: 'org-a', pluginPrefix: 'acme', orgSlug: 'slug-a' },
        installOrigin: 'manual',
      },
    });
  });

  it('copies a known null pluginPrefix instead of treating it as absent', () => {
    const loaded = loader({
      readMarketInstallation: () => MARKET_ROW,
      readApprovedPackageSha256: () => MARKET_ROW.sha256,
      lookupOrganizationPrefix: () => ({ kind: 'known', pluginPrefix: null }),
    }).load('acme-tool', 'runtime', ORG_A);

    expect(loaded).toEqual({
      kind: 'ready',
      facts: {
        ghostId: 'acme-tool',
        namespace: null,
        builtin: false,
        marketRecord: {
          scope: 'organization',
          organizationId: 'org-a',
          source: 'market',
          installed: true,
          sha256: MARKET_ROW.sha256,
          approvedPackageSha256: MARKET_ROW.sha256,
        },
        currentOrganization: { organizationId: 'org-a', pluginPrefix: null, orgSlug: 'slug-a' },
        installOrigin: 'manual',
      },
    });
  });

  it('denies the same manifest digest when Release and approved package bytes differ', () => {
    const loaded = loader({
      readMarketInstallation: () => MARKET_ROW,
      readApprovedPackageSha256: () => 'b'.repeat(64),
      lookupOrganizationPrefix: () => ({ kind: 'known', pluginPrefix: 'acme' }),
    }).load('acme-tool', 'runtime', ORG_A);

    expect(loaded).toMatchObject({
      kind: 'ready',
      facts: {
        marketRecord: {
          scope: 'organization',
          organizationId: 'org-a',
          source: 'market',
          installed: true,
          sha256: 'a'.repeat(64),
          approvedPackageSha256: 'b'.repeat(64),
        },
        currentOrganization: { organizationId: 'org-a', pluginPrefix: 'acme', orgSlug: 'slug-a' },
      },
    });
    expect(MARKET_ROW.manifestDigest).toBe('c'.repeat(64));
    if (loaded.kind !== 'ready') return;
    // This assertion kills an implementation that drops package SHA and falls
    // back to the unchanged manifestDigest for Broker authorization.
    expect(resolveGhostFirstPartyPrivilege(loaded.facts).brokerEligible).toBe(false);
  });

  it('reads install namespace from a storage-part ghost id', () => {
    const loaded = loader({
      lookupOrganizationPrefix: () => ({ kind: 'known', pluginPrefix: null }),
    }).load('_ns__slug-a__helper', 'runtime', ORG_A);
    expect(loaded).toMatchObject({
      kind: 'ready',
      facts: { ghostId: 'helper', namespace: 'slug-a' },
    });
  });

  it('reads trusted receipt namespace for an in-place physical id', () => {
    const factsLoader = loader({
      lookupOrganizationPrefix: () => ({ kind: 'known', pluginPrefix: null }),
      readInstallOrigin: () => 'agent-forge',
      readInstallNamespace: (id) => (id === 'acme-tool' ? 'slug-a' : undefined),
    });
    const loaded = factsLoader.load('acme-tool', 'runtime', ORG_A);
    expect(loaded).toMatchObject({
      kind: 'ready',
      facts: { ghostId: 'acme-tool', namespace: 'slug-a', installOrigin: 'agent-forge' },
    });
    if (loaded.kind === 'ready') {
      expect(authorizeGhostTokenBroker('acme-tool', loaded)).toBe(true);
    }
  });

  it('distinguishes a censused legacy Forge from a new missing-namespace install', () => {
    const factsLoader = loader({
      lookupOrganizationPrefix: () => ({ kind: 'known', pluginPrefix: 'acme' }),
      readInstallOrigin: () => 'agent-forge',
      isPendingLegacyForge: (id) => id === 'acme-old',
    });
    const legacy = factsLoader.load('acme-old', 'runtime', ORG_A);
    expect(legacy).toMatchObject({ kind: 'ready', facts: { legacyPendingForge: true } });
    if (legacy.kind === 'ready') expect(authorizeGhostTokenBroker('acme-old', legacy)).toBe(true);
    const fresh = factsLoader.load('acme-new', 'install', ORG_A, { installOrigin: 'agent-forge' });
    if (fresh.kind === 'ready') expect(authorizeGhostTokenBroker('acme-new', fresh)).toBe(false);
  });

  it('lets install-time namespace override win over a free-name ghost id', () => {
    const factsLoader = loader({
      lookupOrganizationPrefix: () => ({ kind: 'known', pluginPrefix: null }),
    });
    const denied = factsLoader.load('helper', 'install', ORG_A, {
      installOrigin: 'agent-forge',
    });
    expect(denied).toMatchObject({
      kind: 'ready',
      facts: { ghostId: 'helper', namespace: null, installOrigin: 'agent-forge' },
    });
    if (denied.kind === 'ready') {
      expect(authorizeGhostTokenBroker('helper', denied)).toBe(false);
      expect(resolveGhostFirstPartyPrivilege(denied.facts).basis).toBe('denied-foreign-org');
    }

    const granted = factsLoader.load('helper', 'install', ORG_A, {
      installOrigin: 'agent-forge',
      namespace: 'slug-a',
    });
    expect(granted).toMatchObject({
      kind: 'ready',
      facts: { ghostId: 'helper', namespace: 'slug-a', installOrigin: 'agent-forge' },
    });
    if (granted.kind === 'ready') {
      expect(authorizeGhostTokenBroker('helper', granted)).toBe(true);
      expect(resolveGhostFirstPartyPrivilege(granted.facts)).toEqual({
        brokerEligible: true,
        hostPrimitiveEligible: false,
        basis: 'forge-current-org',
      });
    }

    const explicitRoot = factsLoader.load('_ns__slug-a__helper', 'install', ORG_A, {
      installOrigin: 'agent-forge',
      namespace: null,
    });
    expect(explicitRoot).toMatchObject({
      kind: 'ready',
      facts: { ghostId: 'helper', namespace: null },
    });
  });

  it('binds pending organization-market authorization to the inspected package bytes', () => {
    const pending = {
      scope: 'organization' as const,
      organizationId: 'org-a',
      source: 'market' as const,
      installed: true,
      sha256: 'a'.repeat(64),
    };
    const installLoad = (inspectedPackageSha256: string) => ({
      kind: 'ready' as const,
      facts: {
        ghostId: 'acme-tool',
        namespace: 'slug-a',
        builtin: false,
        marketRecord: bindPendingMarketRecordToInspectedPackage(
          pending,
          inspectedPackageSha256,
        ),
        currentOrganization: { organizationId: 'org-a', pluginPrefix: 'acme', orgSlug: 'slug-a' },
        installOrigin: 'manual' as const,
      },
    });

    // Equal bytes preserve the receipt-less first-install path. Different
    // bytes deny before installation, killing a caller-supplied/self-reported
    // pending ticket that never compares with inspect(packageSha256).
    expect(authorizeGhostTokenBroker('acme-tool', installLoad('a'.repeat(64)))).toBe(true);
    expect(authorizeGhostTokenBroker('acme-tool', installLoad('b'.repeat(64)))).toBe(false);
  });

  it('keeps builtin official plugins unchanged without receipt-origin facts', () => {
    const loaded = loader({
      readInstalledBuiltin: (ghostId) => ghostId === 'xd-feishu',
    }).load('xd-feishu', 'runtime', PERSONAL);
    expect(loaded.kind).toBe('ready');
    if (loaded.kind !== 'ready') return;
    expect(resolveGhostFirstPartyPrivilege(loaded.facts)).toEqual({
      brokerEligible: true,
      hostPrimitiveEligible: true,
      basis: 'builtin-official',
    });
  });

  it('copies only the explicit Forge origin and fails closed when it cannot be read', () => {
    const forged = loader({
      readInstallOrigin: () => 'agent-forge',
      lookupOrganizationPrefix: () => ({ kind: 'known', pluginPrefix: 'acme' }),
    }).load('acme-tool', 'runtime', ORG_A);
    expect(forged).toMatchObject({
      kind: 'ready',
      facts: { installOrigin: 'agent-forge' },
    });

    const unreadable = loader({
      readInstallOrigin: () => {
        throw new Error('EACCES');
      },
      lookupOrganizationPrefix: () => ({ kind: 'known', pluginPrefix: 'acme' }),
    }).load('acme-tool', 'runtime', ORG_A);
    expect(unreadable).toMatchObject({
      kind: 'ready',
      facts: { installOrigin: 'manual' },
    });
  });
});

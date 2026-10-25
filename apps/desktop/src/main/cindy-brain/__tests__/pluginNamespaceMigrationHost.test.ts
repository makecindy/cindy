import { describe, expect, it, vi } from 'vitest';

import { createNamespaceMigrationHost, type NamespaceMigrationHostDeps } from '../pluginNamespaceMigrationHost.js';
import { parseInstalledGhostManifest } from '../../installedGhostManifest.js';
import { confirmUnconfirmedInstance, type PluginInstanceRecord } from '../pluginInstanceRegistry.js';

function deps(overrides: Partial<NamespaceMigrationHostDeps> = {}): NamespaceMigrationHostDeps {
  return {
    activeOwnerScopeKey: () => 'owner-a',
    isAppSessionBoundaryPending: () => false,
    getGhostManager: () => ({
      list: () => [],
      approvedInstallEvidence: () => null,
      readApprovedInstallOriginStrict: () => 'manual',
      reconcilePendingRootNamespaces: async () => {},
    }),
    getPluginMarketLedger: () => ({
      lookupInstallationsForNamespaceMigration: () => ({ kind: 'missing' }),
    }),
    getAuthState: () => ({ isAuthenticated: false, user: null }),
    createOrganizationPrefixStore: () => ({ lookup: () => ({ kind: 'missing' }) }),
    ownerScopedUserDataPath: (...parts) => parts.join('/'),
    brainRootDir: () => '/brain',
    readInstalledGhostManifestSnapshot: () => ({ ok: false }),
    oauthLockExists: () => false,
    hasPendingWork: () => false,
    runtimeState: () => null,
    nodeRuntimeRunning: () => false,
    stopRuntime: () => {},
    stopNodeRuntime: async () => {},
    captureGhostMutationOwner: () => ({}),
    beginGhostMutation: () => () => {},
    log: { warn: () => {} },
    ...overrides,
  };
}

describe('pending resident migration host', () => {
  it('stops a resident that is already running after the client comes online', async () => {
    const stopRuntime = vi.fn();
    const stopNodeRuntime = vi.fn(async () => {});
    const host = createNamespaceMigrationHost(deps({
      getGhostManager: () => ({
        list: () => [{
          manifest: { id: 'ns-resident-probe', launch: 'resident' as const },
          namespaceState: 'pending',
          dir: '/ghosts/ns-resident-probe',
        }],
        approvedInstallEvidence: () => null,
        readApprovedInstallOriginStrict: () => 'manual',
        reconcilePendingRootNamespaces: async () => {},
      }),
      runtimeState: (instanceKey) => instanceKey === 'ns-resident-probe' ? 'running' : null,
      stopRuntime,
      stopNodeRuntime,
    }));

    await expect(host.preparePendingResidentForMigration('ns-resident-probe')).resolves.toBe(true);
    expect(stopRuntime).toHaveBeenCalledWith('ns-resident-probe');
    expect(stopNodeRuntime).toHaveBeenCalledWith('ns-resident-probe');
  });

  it('does not stop a running panel plugin', async () => {
    const stopRuntime = vi.fn();
    const host = createNamespaceMigrationHost(deps({
      getGhostManager: () => ({
        list: () => [{
          manifest: { id: 'panel-probe' },
          namespaceState: 'pending',
          dir: '/ghosts/panel-probe',
        }],
        approvedInstallEvidence: () => null,
        readApprovedInstallOriginStrict: () => 'manual',
        reconcilePendingRootNamespaces: async () => {},
      }),
      runtimeState: () => 'running',
      stopRuntime,
    }));
    await expect(host.preparePendingResidentForMigration('panel-probe')).resolves.toBe(false);
    expect(stopRuntime).not.toHaveBeenCalled();
  });

  it('restarts a resident when the commit does not land', async () => {
    const spawn = vi.fn();
    const host = createNamespaceMigrationHost(deps({
      getGhostManager: () => ({
        list: () => [{
          manifest: { id: 'ns-resident-probe', node: { lifecycle: 'resident' } },
          namespaceState: 'pending',
          dir: '/ghosts/ns-resident-probe',
        }],
        approvedInstallEvidence: () => null,
        readApprovedInstallOriginStrict: () => 'manual',
        reconcilePendingRootNamespaces: async () => {},
      }),
      runtimeState: () => 'running',
      spawnIfResident: spawn,
    }));
    await expect(host.preparePendingResidentForMigration('ns-resident-probe')).resolves.toBe(true);
    host.onPendingResidentMigrationSettled('ns-resident-probe', false);
    expect(spawn).toHaveBeenCalledWith('ns-resident-probe');
    host.onPendingResidentMigrationSettled('ns-resident-probe', false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('leaves an idle online resident alone', async () => {
    const stopRuntime = vi.fn();
    const host = createNamespaceMigrationHost(deps({ stopRuntime }));
    await expect(host.preparePendingResidentForMigration('ns-resident-probe')).resolves.toBe(true);
    expect(stopRuntime).not.toHaveBeenCalled();
  });

  it('retries a pending resident that is not in the offline set', async () => {
    const reconcile = vi.fn(async () => {});
    const scheduled: Array<() => void> = [];
    const host = createNamespaceMigrationHost(deps({
      getGhostManager: () => ({
        list: () => [],
        approvedInstallEvidence: () => null,
        readApprovedInstallOriginStrict: () => 'manual',
        reconcilePendingRootNamespaces: reconcile,
      }),
      setTimeout: (handler) => {
        scheduled.push(handler);
        return { unref() {} };
      },
    }));

    host.schedulePendingResidentMigrationRetry('ns-resident-probe');
    expect(reconcile).not.toHaveBeenCalled();
    scheduled[0]?.();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith(true));
  });
});

describe('legacy bare instance reclaim', () => {
  const removed = {
    pluginId: 'plugin-a', ghostId: 'hello', releaseId: 'release-a', version: '1.0.0', sha256: 'a'.repeat(64),
    scope: 'organization' as const, organizationId: 'org-acme', source: 'market' as const,
    installed: false, updatedAt: '2026-10-01T00:00:00.000Z',
  };
  const signedIn = {
    isAuthenticated: true,
    user: { membershipKind: 'org', orgId: 'org-acme', orgSlug: 'acme' },
  };

  it('reads the ledger and the signed-in organization', () => {
    const lookup = vi.fn(() => ({ kind: 'found', records: [removed] }));
    const host = createNamespaceMigrationHost(deps({
      getPluginMarketLedger: () => ({ lookupInstallationsForNamespaceMigration: lookup }),
      getAuthState: () => signedIn,
    }));
    expect(host.canReclaimLegacyBareInstance({ ghostId: 'hello', namespace: 'acme', pluginId: 'plugin-a' })).toBe(true);
    expect(lookup).toHaveBeenCalledWith('hello');
  });

  it('refuses an unreadable ledger', () => {
    const host = createNamespaceMigrationHost(deps({
      getPluginMarketLedger: () => ({ lookupInstallationsForNamespaceMigration: () => ({ kind: 'invalid' }) }),
      getAuthState: () => signedIn,
    }));
    expect(host.canReclaimLegacyBareInstance({ ghostId: 'hello', namespace: 'acme', pluginId: 'plugin-a' })).toBe(false);
  });
});

// Unit regression: confirmation must keep market identity as well as package
// identity. Legacy receipts also require approved/stored manifest identities.
describe('namespace confirmation evidence', () => {
  it.each([
    'matching', 'no-digest', 'changed-content', 'changed-approval', 'not-migrated', 'duplicate', 'other-org',
    'other-plugin', 'modern-matching', 'modern-other-plugin', 'unbound-legacy',
  ])(
    'confirms only independently matched installation facts (%s)', (condition) => {
      const modern = condition.startsWith('modern-');
      const parsed = parseInstalledGhostManifest({
        schemaVersion: 2, id: 'hello', name: 'Hello', version: '1.0.0',
        kind: 'chip', entry: 'main.js', slots: ['tool'], tools: [{ name: 'hello', description: 'Hello' }],
      });
      if (!parsed.ok) throw new Error(parsed.reason);
      const manifest = parsed.manifest;
      const record: PluginInstanceRecord = {
        instanceKey: 'hello', contentRelId: 'hello', ghostId: 'hello', namespace: 'acme',
        namespaceState: 'unconfirmed', pluginId: condition === 'unbound-legacy' ? null : 'plugin-a', source: 'market',
        receiptRevision: 'rev-1', packageSha256: modern ? 'a'.repeat(64) : null, active: true,
      };
      const market = {
        pluginId: condition.endsWith('other-plugin') ? 'plugin-b' : 'plugin-a',
        ghostId: 'hello', namespace: 'acme', releaseId: 'release-a', version: '1.0.0',
        sha256: 'a'.repeat(64), scope: 'organization' as const, organizationId: 'org-acme',
        source: 'market' as const, installed: true, updatedAt: '2026-10-01T00:00:00.000Z',
        ...(condition !== 'no-digest' ? { rawManifestSha256: 'b'.repeat(64) } : {}),
      };
      const defaults = deps();
      const readManifest = vi.fn(() => ({ ok: true, snapshot: {
        manifest, legacyManualIgnored: false,
        rawManifestSha256: (condition === 'changed-content' ? 'c' : 'b').repeat(64),
        releasedLegacyDigestFormat: manifest, legacyDigestFormats: [manifest],
      } }));
      const host = createNamespaceMigrationHost(deps({
        getAuthState: () => ({ isAuthenticated: true, user: {
          membershipKind: 'org', orgId: condition === 'other-org' ? 'org-other' : 'org-acme', orgSlug: 'acme',
        } }),
        getGhostManager: () => ({ ...defaults.getGhostManager(), approvedInstallEvidence: () => ({
          packageSha256: modern ? 'a'.repeat(64) : null,
          legacyMigrated: !modern && condition !== 'not-migrated',
          approvedManifest: condition === 'changed-approval' ? { ...manifest, version: '0.9.0' } : manifest,
        }) }),
        getPluginMarketLedger: () => ({ lookupInstallationsForNamespaceMigration: () => ({
          kind: 'found', records: condition === 'duplicate' ? [market, market] : [market],
        }) }),
        readInstalledGhostManifestSnapshot: readManifest,
      }));
      const decision = confirmUnconfirmedInstance(record, host.readUnconfirmedConfirmationEvidence(record)!);
      const confirms = ['matching', 'modern-matching', 'unbound-legacy'].includes(condition);
      expect(decision).toEqual(confirms ? { namespace: 'acme' } : null);
      if (modern) expect(readManifest).not.toHaveBeenCalled();
    },
  );
});

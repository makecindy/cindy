import { describe, expect, it, vi } from 'vitest';

import { createNamespaceMigrationHost, type NamespaceMigrationHostDeps } from '../pluginNamespaceMigrationHost.js';

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
          manifest: { id: 'ns-resident-probe' },
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

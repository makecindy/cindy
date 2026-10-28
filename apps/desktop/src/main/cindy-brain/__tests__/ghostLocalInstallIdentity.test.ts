import { describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost.js';
import type { GhostInstallConsentRequest } from '../../../shared/ghostInstallConsent.js';
import { findInstalledGhostForDeliveryTarget, installedGhostStoragePart } from '../../../shared/pluginIdentity.js';
import { assertGhostInstallConsent, confirmedTaskCapability, obtainGhostInstallConsent } from '../ghostInstallConsent.js';
import { ghostInstallApprovalToken } from '../../../shared/ghost.js';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';

const createCallbacks = createGhostProductionCallbacks<{
  install: (event: unknown, file: string, options: unknown) => Promise<{ ghost: InstalledGhost }>;
}>({
  functions: ['installAndDock', 'installAndDockLocked'],
  callbacks: { install: ['ipcMain.handle', 'ghosts:install'] },
});

describe('local root installation consent identity', () => {
  it.each([true, false])('confirms an independent root beside an approved organization (allow=%s)', async (allow) => {
    const manifest: InstalledGhost['manifest'] = {
      schemaVersion: 3, minCindyVersion: '0.0.0', id: 'helper', name: 'Helper',
      version: '1.0.0', kind: 'chip', entry: 'main.js',
      node: { entry: 'node/worker.cjs', protocol: 'json-rpc-stdio', lifecycle: 'resident' },
    };
    const organization: InstalledGhost = {
      manifest, namespace: 'acme', dir: '/plugins/_ns/acme/helper', enabled: true,
      approval: { state: 'approved', revision: '11111111-1111-4111-8111-111111111111' },
    };
    const root: InstalledGhost = { ...organization, namespace: null, dir: '/plugins/_ns/_root/helper' };
    const packageSha256 = 'a'.repeat(64);
    const prompt = vi.fn<(request: Omit<GhostInstallConsentRequest, 'requestId'>) => Promise<boolean>>(async () => allow);
    const release = vi.fn();
    const manager = {
      list: () => [organization],
      inspect: vi.fn(async () => ({ manifest, packageSha256 })),
      install: vi.fn(async () => ({ ghost: root })),
    };
    const callbacks = createCallbacks({
      manager, assertTrustedAppRendererEvent: vi.fn(), captureGhostMutationOwner: () => 'owner',
      beginGhostMutation: () => release, rejectReservedGhostId: vi.fn(),
      rejectBrokerWithoutDeclaredRedirectPort: vi.fn(), rejectUnauthorizedTokenBroker: vi.fn(),
      throwIpcError: (code: string) => { throw new Error(code); },
      throwInstallError: () => { throw new Error('install rejected'); },
      obtainGhostInstallConsent, assertGhostInstallConsent, confirmedTaskCapability,
      createWindowGhostInstallConsentPrompt: () => prompt,
      findInstalledGhostForDeliveryTarget, installedGhostStoragePart,
      withGhostInstallLock: async (_id: string, operation: () => unknown) => operation(),
      getLayoutStore: () => ({ getLayout: () => ({}) }), layoutWithGhostPanel: () => null,
      spawnIfResident: vi.fn(), bindPluginUsage: vi.fn(async () => {}),
      markGhostRecommendationInstalled: vi.fn(), log: { warn: vi.fn() },
    });
    const installing = callbacks.install({ sender: {} }, '/tmp/helper.cindy', { enable: true, expectedPackageSha256: packageSha256 });
    if (allow) {
      await expect(installing).resolves.toMatchObject({ ghost: root });
      expect(manager.install).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    } else {
      await expect(installing).rejects.toThrow();
      expect(manager.install).not.toHaveBeenCalled();
    }
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({ facts: { kind: 'install' } });
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({ target: { namespace: null, sourceChanged: false, otherCopies: 1 } });
  });
});

const forgeCallbacks = createGhostProductionCallbacks<{
  installOrUpdateLocalGhostPackageFromForge: (file: string, options: Record<string, unknown>) => Promise<{ action: string; ghost: InstalledGhost }>;
}>({ functions: ['installOrUpdateLocalGhostPackageFromForge'] });

// Production entry regression: current-org authoring must not silently create
// a duplicate, cross the selected namespace, or proceed after consent expires.
it.each(['choose', 'update', 'copy', 'cancel', 'changed'] as const)('Forge installation target: %s', async mode => {
  const manifest: InstalledGhost['manifest'] = { schemaVersion: 3, minCindyVersion: '0.0.0', id: 'helper', name: 'Helper', version: '1.0.0', kind: 'chip', entry: 'main.js' };
  const root: InstalledGhost = { manifest, namespace: null, instanceKey: '_root__helper', dir: '/plugins/_root/helper', enabled: true,
    approval: { state: 'approved', revision: '11111111-1111-4111-8111-111111111111' } };
  const digest = 'a'.repeat(64), install = vi.fn<(...args: unknown[]) => Promise<InstalledGhost>>(async () => ({ ...root, namespace: 'acme' })), update = vi.fn<(...args: unknown[]) => Promise<InstalledGhost>>(async () => root);
  const prompt = vi.fn<(request: Omit<GhostInstallConsentRequest, 'requestId'>) => Promise<boolean>>(async () => {
    if (mode === 'changed') root.approval = { state: 'approved', revision: '22222222-2222-4222-8222-222222222222' };
    return mode !== 'cancel';
  });
  const entry = forgeCallbacks({
    getGhostManager: () => ({ list: () => [root], inspect: async () => ({ manifest, canonicalManifest: manifest, packageSha256: digest }) }),
    rejectReservedGhostId() {}, rejectBrokerWithoutDeclaredRedirectPort() {}, rejectUnauthorizedTokenBroker() {},
    getAuthState: () => ({ isAuthenticated: true, user: { membershipKind: 'org', orgSlug: 'acme' } }),
    forgeInstallOriginForMembership: () => 'agent-forge', isValidPluginNamespace: () => true, isValidNewGhostId: () => true,
    readLocalGhostUpdateSource: () => ({ sourceChanged: true, authorizationOverrides: {} }),
    ghostInstallApprovalToken, obtainGhostInstallConsent, findInstalledGhostForDeliveryTarget,
    forgeOidcInstallConfirmFacts: () => null, beginGhostMutation: () => () => {},
    withGhostInstallLock: async (_id: string, fn: () => unknown) => fn(), installAndDockLocked: install,
    updateLocalGhostPackageLocked: update, markGhostRecommendationInstalled() {},
    throwIpcError: (code: string) => { throw new Error(code); }, log: { warn() {} },
  }).installOrUpdateLocalGhostPackageFromForge;
  const pending = entry('/tmp/helper.cindy', { ghostId: 'helper', packageSha256: digest, mutationOwner: {}, consentPrompt: prompt,
    ...(mode === 'copy' ? { installCopy: true, namespace: 'acme' } : mode === 'choose' ? {} : { targetInstanceId: root.instanceKey }) });
  if (['cancel', 'changed'].includes(mode)) {
    await expect(pending).rejects.toThrow();
    expect(install).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  } else if (mode === 'copy') {
    expect((await pending).action).toBe('installed');
    expect(install.mock.calls[0]?.[2]).toMatchObject({ namespace: 'acme', enable: true });
    expect(update).not.toHaveBeenCalled();
  } else {
    expect((await pending).action).toBe('updated');
    expect(update.mock.calls[0]?.[5]).toBe('_root__helper');
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({ target: { namespace: null, sourceChanged: true } });
    expect(install).not.toHaveBeenCalled();
  }
});

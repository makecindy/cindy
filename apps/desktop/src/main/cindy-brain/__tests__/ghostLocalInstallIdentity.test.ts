import { describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost.js';
import type { GhostInstallConsentRequest } from '../../../shared/ghostInstallConsent.js';
import { findInstalledGhostForDeliveryTarget, installedGhostStoragePart } from '../../../shared/pluginIdentity.js';
import { assertGhostInstallConsent, confirmedTaskCapability, obtainGhostInstallConsent } from '../ghostInstallConsent.js';
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
    const prompt = vi.fn(async (_request: Omit<GhostInstallConsentRequest, 'requestId'>) => allow);
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
      spawnIfResident: vi.fn(), markGhostRecommendationInstalled: vi.fn(), log: { warn: vi.fn() },
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
  });
});

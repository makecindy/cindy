import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  ghosts: [] as Array<{
    manifest: Record<string, unknown>;
    dir: string;
    enabled: boolean;
  }>,
  install: vi.fn(),
  uninstall: vi.fn(),
  builtinRemoved: new Set<string>(),
  session: {
    mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
    dataOwnerId: 'user-1' as string | null,
    generation: 1,
  },
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()) },
}));
vi.mock('../../authManager.js', () => ({
  getAuthState: vi.fn(() => ({
    user: { id: 'user-1', membershipKind: 'personal' },
    mode: runtime.session.mode,
    dataOwnerId: runtime.session.dataOwnerId,
  })),
  getCurrentUserId: vi.fn(() => 'user-1'),
}));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: vi.fn(() => ({ ...runtime.session })),
  isAppSessionBoundaryPending: vi.fn(() => false),
  ownerScopedUserDataPath: vi.fn((...parts: string[]) =>
    path.join(os.tmpdir(), 'owners', runtime.session.dataOwnerId ?? 'local', ...parts),
  ),
}));
vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpoint: vi.fn(() => 'https://plugin.test.invalid'),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../cindy-brain/index.js', () => ({
  getGhostManager: () => ({ list: () => runtime.ghosts }),
  installOrUpdateMarketGhostPackage: runtime.install,
  isBuiltinGhostRemovedByUser: (id: string) => runtime.builtinRemoved.has(id),
  uninstallGhostAndCleanup: runtime.uninstall,
}));
vi.mock('../download.js', () => ({
  downloadVerifiedPlugin: vi.fn(async () => undefined),
}));

import type { VisiblePluginDetail, VisiblePluginSummary } from '@cindy/plugin-protocol';

import { PluginMarketLedger } from '../ledger';
import { PluginMarketService } from '../service';
import type { PluginMarketApi } from '../api';

const roots: string[] = [];
const PLUGIN_ID = `c${'a'.repeat(24)}`;

afterEach(() => {
  runtime.ghosts = [];
  runtime.install.mockReset();
  runtime.uninstall.mockReset();
  runtime.builtinRemoved.clear();
  runtime.session = {
    mode: 'cloud',
    dataOwnerId: 'user-1',
    generation: 1,
  };
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function manifest(
  id = 'cindy-test',
  version = '1.0.0',
  slots: ['notify'] | ['notify', 'fs'] = ['notify'],
) {
  return {
    schemaVersion: 2 as const,
    id,
    name: 'Test Plugin',
    description: 'Test description',
    author: 'Cindy',
    version,
    kind: 'chip' as const,
    entry: 'main.js',
    slots,
  };
}

function summary(
  overrides: Partial<VisiblePluginSummary> = {},
): VisiblePluginSummary {
  return {
    id: PLUGIN_ID,
    ghostId: 'cindy-test',
    name: 'Test Plugin',
    description: 'Test description',
    author: 'Cindy',
    scope: 'public',
    organizationId: null,
    defaultInstall: false,
    currentRelease: {
      id: 'release-1',
      version: '1.0.0',
      sha256: 'a'.repeat(64),
      sizeBytes: 42,
      publishedAt: '2026-07-23T00:00:00.000Z',
      icon: null,
    },
    ...overrides,
  };
}

function detail(item = summary(), slots: ['notify'] | ['notify', 'fs'] = ['notify']): VisiblePluginDetail {
  return {
    ...item,
    currentRelease: {
      ...item.currentRelease,
      manifest: manifest(item.ghostId, item.currentRelease.version, slots),
    },
  };
}

function harness(items: VisiblePluginSummary[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-plugin-service-'));
  roots.push(root);
  const ledger = new PluginMarketLedger(path.join(root, 'ledger.json'));
  const api = {
    listAll: vi.fn(async () => items),
    detail: vi.fn(async (pluginId: string) => {
      const item = items.find((candidate) => candidate.id === pluginId);
      if (!item) throw new Error('not found');
      return detail(item);
    }),
    download: vi.fn(async () => ({
      url: 'https://downloads.test.invalid/plugin.cindy',
      expiresAt: '2099-01-01T00:00:00.000Z',
      sha256: 'a'.repeat(64),
      sizeBytes: 42,
    })),
  };
  return {
    api,
    ledger,
    service: new PluginMarketService(api as unknown as PluginMarketApi, ledger),
  };
}

describe('PluginMarketService migration and defaultInstall', () => {
  it('passes the optional release icon metadata to renderer-safe market items', async () => {
    const icon = {
      mimeType: 'image/png',
      sha256: 'b'.repeat(64),
      sizeBytes: 128,
      url: 'https://oss.example.invalid/icons/test.png',
      expiresAt: '2026-07-23T00:05:00.000Z',
    };
    const h = harness([summary({
      currentRelease: {
        ...summary().currentRelease,
        icon,
      },
    })]);

    await expect(h.service.snapshot()).resolves.toMatchObject({
      items: [{ icon }],
      unavailableReason: null,
    });
  });

  it('takes bounded local snapshots instead of reading the ledger per market item', async () => {
    const items = Array.from({ length: 50 }, (_, index) => summary({
      id: `c${index.toString(36).padStart(24, '0')}`,
      ghostId: `cindy-test-${index}`,
    }));
    const h = harness(items);
    const read = vi.spyOn(h.ledger, 'read');

    await h.service.snapshot();

    expect(read.mock.calls.length).toBeLessThan(10);
  });

  it('does not query the authenticated market in account-free local mode', async () => {
    runtime.session = {
      mode: 'local',
      dataOwnerId: 'local-v1',
      generation: 2,
    };
    const h = harness([summary()]);

    await expect(h.service.snapshot()).resolves.toEqual({
      items: [],
      unavailableReason: 'authentication-required',
    });
    expect(h.api.listAll).not.toHaveBeenCalled();
  });

  it('adopts one exact official legacy install without downloading or changing enable state', async () => {
    runtime.ghosts = [
      {
        manifest: manifest(),
        dir: '/userData/cindy-brain/cindy-test',
        enabled: true,
      },
    ];
    const h = harness([summary()]);

    const snapshot = await h.service.snapshot();

    expect(snapshot.items[0]).toMatchObject({
      installState: 'installed',
      enabled: true,
    });
    expect(h.ledger.installationForGhost('cindy-test')).toMatchObject({
      source: 'legacy-adopted',
      pluginId: PLUGIN_ID,
    });
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('adopts an older official legacy install as update-available without rendering a duplicate', async () => {
    runtime.ghosts = [
      {
        manifest: manifest('cindy-test', '0.9.0'),
        dir: '/userData/cindy-brain/cindy-test',
        enabled: false,
      },
    ];
    const h = harness([summary()]);

    const snapshot = await h.service.snapshot();

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({
      ghostId: 'cindy-test',
      installState: 'update-available',
      enabled: false,
    });
    expect(h.ledger.installationForGhost('cindy-test')).toMatchObject({
      source: 'legacy-adopted',
      pluginId: PLUGIN_ID,
      releaseId: 'legacy-unresolved:0.9.0',
      version: '0.9.0',
      sha256: 'legacy-unverified',
    });
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('installs and enables a unique defaultInstall package and records its release', async () => {
    const item = summary({ defaultInstall: true });
    runtime.install.mockImplementation(async () => {
      const ghost = {
        manifest: manifest(),
        dir: '/userData/cindy-brain/cindy-test',
        enabled: true,
      };
      runtime.ghosts = [ghost];
      return ghost;
    });
    const h = harness([item]);

    const snapshot = await h.service.snapshot();

    expect(runtime.install).toHaveBeenCalledWith(
      expect.stringMatching(/\.cindy$/),
      {
        ghostId: 'cindy-test',
        version: '1.0.0',
        initiallyEnabled: true,
      },
    );
    expect(snapshot.items[0]).toMatchObject({
      installState: 'installed',
      enabled: true,
    });
    expect(h.ledger.installationForGhost('cindy-test')).toMatchObject({
      source: 'market',
      releaseId: 'release-1',
    });
  });

  it('keeps a manual market install disabled by default', async () => {
    const item = summary();
    runtime.install.mockResolvedValue({
      manifest: manifest(),
      dir: '/userData/cindy-brain/cindy-test',
      enabled: false,
    });
    const h = harness([item]);

    await h.service.install(item.id);

    expect(runtime.install).toHaveBeenCalledWith(
      expect.stringMatching(/\.cindy$/),
      {
        ghostId: 'cindy-test',
        version: '1.0.0',
        initiallyEnabled: false,
      },
    );
  });

  it('does not re-enable an installed defaultInstall package disabled by the user', async () => {
    const item = summary({ defaultInstall: true });
    runtime.ghosts = [
      {
        manifest: manifest(),
        dir: '/userData/cindy-brain/cindy-test',
        enabled: false,
      },
    ];
    const h = harness([item]);
    h.ledger.upsertInstallation(recordForTest(item));

    const snapshot = await h.service.snapshot();

    expect(runtime.install).not.toHaveBeenCalled();
    expect(snapshot.items[0]).toMatchObject({
      installState: 'installed',
      enabled: false,
    });
  });

  it('treats a missing previously-managed directory as an opt-out and does not reinstall', async () => {
    const item = summary({ defaultInstall: true });
    const h = harness([item]);
    h.ledger.upsertInstallation({
      pluginId: item.id,
      ghostId: item.ghostId,
      releaseId: item.currentRelease.id,
      version: item.currentRelease.version,
      sha256: item.currentRelease.sha256,
      scope: item.scope,
      organizationId: item.organizationId,
      source: 'market',
      installed: true,
      updatedAt: '2026-07-23T00:00:00.000Z',
    });

    const snapshot = await h.service.snapshot();

    expect(runtime.install).not.toHaveBeenCalled();
    expect(snapshot.items[0]?.installState).toBe('not-installed');
    expect(h.ledger.isDefaultInstallSuppressed('user-1', item.id)).toBe(true);
  });

  it('records an opt-out only after a tracked local uninstall succeeds', async () => {
    const item = summary({ defaultInstall: true });
    const h = harness([item]);
    h.ledger.upsertInstallation(recordForTest(item));

    const complete = h.service.prepareLocalUninstallTracking(item.ghostId);

    expect(complete).not.toBeNull();
    expect(h.ledger.installationForGhost(item.ghostId)?.installed).toBe(true);
    await complete?.();
    expect(h.ledger.installationForGhost(item.ghostId)?.installed).toBe(false);
    expect(h.ledger.isDefaultInstallSuppressed('user-1', item.id)).toBe(true);
  });

  it('does not attach local uninstall tracking outside a cloud session', () => {
    runtime.session = {
      mode: 'local',
      dataOwnerId: 'local-v1',
      generation: 2,
    };
    const h = harness([summary()]);

    expect(h.service.prepareLocalUninstallTracking('cindy-test')).toBeNull();
  });

  it('does not restore a bundled default after the user removed it', async () => {
    const item = summary({ defaultInstall: true });
    runtime.builtinRemoved.add(item.ghostId);
    const h = harness([item]);

    const snapshot = await h.service.snapshot();

    expect(snapshot.items[0]?.installState).toBe('not-installed');
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('does not auto-adopt or overwrite an untracked non-official id collision', async () => {
    const item = summary({
      ghostId: 'third-party',
      defaultInstall: true,
    });
    runtime.ghosts = [
      {
        manifest: manifest('third-party'),
        dir: '/userData/cindy-brain/third-party',
        enabled: true,
      },
    ];
    const h = harness([item]);

    const snapshot = await h.service.snapshot();

    expect(snapshot.items[0]?.installState).toBe('conflict');
    expect(runtime.install).not.toHaveBeenCalled();
    expect(h.ledger.installationForGhost('third-party')).toBeNull();
  });

  it('requires an explicit reviewed flag before an update can add permissions', async () => {
    const item = summary({
      currentRelease: {
        ...summary().currentRelease,
        id: 'release-2',
        version: '2.0.0',
      },
    });
    runtime.ghosts = [
      {
        manifest: manifest(),
        dir: '/userData/cindy-brain/cindy-test',
        enabled: true,
      },
    ];
    runtime.install.mockResolvedValue({
      manifest: manifest('cindy-test', '2.0.0', ['notify', 'fs']),
      dir: '/userData/cindy-brain/cindy-test',
      enabled: true,
    });
    const h = harness([item]);
    h.ledger.upsertInstallation({
      ...recordForTest(item),
      releaseId: 'release-1',
      version: '1.0.0',
    });
    h.api.detail.mockResolvedValue(detail(item, ['notify', 'fs']));

    await expect(h.service.install(item.id)).rejects.toThrow('增加了权限');
    expect(runtime.install).not.toHaveBeenCalled();

    await expect(
      h.service.install(item.id, { allowPermissionExpansion: true }),
    ).resolves.toMatchObject({
      ghost: { manifest: { version: '2.0.0' } },
    });
    expect(runtime.install).toHaveBeenCalledTimes(1);
  });

  it('rejects a download credential with an invalid expiry timestamp', async () => {
    const item = summary();
    const h = harness([item]);
    h.api.download.mockResolvedValue({
      url: 'https://downloads.test.invalid/plugin.cindy',
      expiresAt: 'not-a-timestamp',
      sha256: item.currentRelease.sha256,
      sizeBytes: item.currentRelease.sizeBytes,
    });

    await expect(h.service.install(item.id)).rejects.toThrow('下载凭证已过期');
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('cancels an install if the active data owner changes during the request', async () => {
    const item = summary();
    const h = harness([item]);
    h.api.listAll.mockImplementationOnce(async () => {
      runtime.session = {
        mode: 'cloud',
        dataOwnerId: 'user-2',
        generation: 2,
      };
      return [item];
    });

    await expect(h.service.install(item.id)).rejects.toThrow('账号已切换');
    expect(runtime.install).not.toHaveBeenCalled();
    expect(h.ledger.installationForGhost(item.ghostId)).toBeNull();
  });
});

function recordForTest(item: VisiblePluginSummary) {
  return {
    pluginId: item.id,
    ghostId: item.ghostId,
    releaseId: item.currentRelease.id,
    version: item.currentRelease.version,
    sha256: item.currentRelease.sha256,
    scope: item.scope,
    organizationId: item.organizationId,
    source: 'market' as const,
    installed: true,
    updatedAt: '2026-07-23T00:00:00.000Z',
  };
}

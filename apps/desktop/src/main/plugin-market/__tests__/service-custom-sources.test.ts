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
  accountGhostAvailable: true,
  boundaryPending: false,
  pluginApiBaseUrl: 'https://plugin.test.invalid' as string | null,
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
  getCurrentUserId: vi.fn(() =>
    runtime.session.mode === 'cloud' ? runtime.session.dataOwnerId : null,
  ),
}));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: vi.fn(() => ({ ...runtime.session })),
  isAppSessionBoundaryPending: vi.fn(() => runtime.boundaryPending),
  ownerScopedUserDataPath: vi.fn((...parts: string[]) =>
    path.join(os.tmpdir(), 'owners', runtime.session.dataOwnerId ?? 'local', ...parts),
  ),
}));
vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpoint: vi.fn(() => runtime.pluginApiBaseUrl),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../cindy-brain/index.js', () => ({
  getGhostManager: () => ({ list: () => runtime.ghosts }),
  isGhostAvailableForActiveSession: vi.fn(() => runtime.accountGhostAvailable),
  installOrUpdateMarketGhostPackage: runtime.install,
  rejectReservedGhostIdForCustomMarket: vi.fn(),
  isBuiltinGhostRemovedByUser: (id: string) => runtime.builtinRemoved.has(id),
  uninstallGhostAndCleanup: runtime.uninstall,
}));
vi.mock('../download.js', () => ({
  downloadVerifiedPlugin: vi.fn(async () => undefined),
}));

import type { VisiblePluginSummary } from '@cindy/plugin-protocol';

import { customMarketPluginId, customMarketReleaseId } from '../../../shared/pluginMarket';
import { PluginMarketLedger } from '../ledger';
import { PluginMarketService } from '../service';
import { MarketSourceStore } from '../sources/store';
import type { PluginMarketApi } from '../api';

const roots: string[] = [];
const PLUGIN_ID = `c${'a'.repeat(24)}`;

afterEach(() => {
  runtime.ghosts = [];
  runtime.install.mockReset();
  runtime.uninstall.mockReset();
  runtime.builtinRemoved.clear();
  runtime.accountGhostAvailable = true;
  runtime.boundaryPending = false;
  runtime.pluginApiBaseUrl = 'https://plugin.test.invalid';
  runtime.session = { mode: 'cloud', dataOwnerId: 'user-1', generation: 1 };
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function ghostManifest(id: string, version = '1.0.0') {
  return {
    schemaVersion: 2 as const,
    id,
    name: `Plugin ${id}`,
    description: 'Custom market plugin',
    author: 'Community',
    version,
    kind: 'chip' as const,
    entry: 'main.js',
    slots: ['notify'],
  };
}

function serverSummary(overrides: Partial<VisiblePluginSummary> = {}): VisiblePluginSummary {
  return {
    id: PLUGIN_ID,
    ghostId: 'server-plugin',
    name: 'Server Plugin',
    description: 'Server description',
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

/** 在临时目录造一个本地市场夹具（marketplace.json + 插件目录）。 */
function writeLocalMarket(
  root: string,
  marketName: string,
  plugins: Array<{ rel: string; id: string; version?: string }>,
): string {
  const dir = path.join(root, marketName);
  for (const plugin of plugins) {
    const pluginDir = path.join(dir, ...plugin.rel.split('/'));
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'ghost.json'),
      JSON.stringify(ghostManifest(plugin.id, plugin.version ?? '1.0.0')),
    );
    fs.writeFileSync(path.join(pluginDir, 'main.js'), '// entry');
  }
  fs.mkdirSync(path.join(dir, '.agents', 'plugins'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({
      name: marketName,
      plugins: plugins.map((plugin) => ({ name: plugin.id, source: plugin.rel })),
    }),
  );
  return dir;
}

function harness(items: VisiblePluginSummary[], marketDirs: Array<{ name: string; dir: string }>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-plugin-custom-'));
  roots.push(root);
  const ledger = new PluginMarketLedger(path.join(root, 'ledger.json'));
  const sourceStore = new MarketSourceStore(path.join(root, 'sources.v1.json'));
  for (const market of marketDirs) {
    sourceStore.add({
      name: market.name,
      addedAt: '2026-07-30T00:00:00.000Z',
      lastSyncedAt: '2026-07-30T01:00:00.000Z',
      lastRevision: null,
      source: { type: 'local', path: market.dir },
    });
  }
  const api = {
    listAll: vi.fn(async () => items),
    detail: vi.fn(),
    download: vi.fn(),
  };
  return {
    api,
    ledger,
    sourceStore,
    service: new PluginMarketService(
      api as unknown as PluginMarketApi,
      ledger,
      sourceStore,
    ),
  };
}

describe('PluginMarketService 自定义市场聚合', () => {
  it('appends custom market items after server items with source identity', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([serverSummary()], [{ name: 'team-lib', dir }]);

    const snapshot = await h.service.snapshot();
    expect(snapshot.unavailableReason).toBeNull();
    expect(snapshot.customSourceNames).toEqual(['team-lib']);
    expect(snapshot.items).toHaveLength(2);
    const [server, custom] = snapshot.items;
    expect(server?.sourceType).toBe('server');
    expect(server?.sourceMarketName).toBeNull();
    expect(custom).toMatchObject({
      pluginId: customMarketPluginId('team-lib', 'alpha'),
      ghostId: 'alpha',
      releaseId: customMarketReleaseId('team-lib', 'alpha', '1.0.0'),
      installState: 'not-installed',
      sourceType: 'local-market',
      sourceMarketName: 'team-lib',
    });
  });

  it('keeps custom items available when the server market is not configured', async () => {
    runtime.pluginApiBaseUrl = null;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);

    const snapshot = await h.service.snapshot();
    expect(snapshot.unavailableReason).toBeNull();
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]?.sourceType).toBe('local-market');
  });

  it('keeps the not-configured reason when neither source has anything', async () => {
    runtime.pluginApiBaseUrl = null;
    const h = harness([], []);
    const snapshot = await h.service.snapshot();
    expect(snapshot).toEqual({
      items: [],
      unavailableReason: 'not-configured',
      customSourceNames: [],
    });
  });

  it('marks cross-source ghostId duplicates as conflict on both sides', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/x', id: 'server-plugin' }]);
    const h = harness([serverSummary()], [{ name: 'team-lib', dir }]);

    const snapshot = await h.service.snapshot();
    expect(snapshot.items.find((item) => item.sourceType === 'server')?.installState).toBe(
      'conflict',
    );
    expect(snapshot.items.find((item) => item.sourceType === 'local-market')?.installState).toBe(
      'conflict',
    );
  });

  it('reports update-available when the marketplace version moved past the install', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [
      { rel: 'plugins/alpha', id: 'alpha', version: '2.0.0' },
    ]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    runtime.ghosts = [
      { manifest: ghostManifest('alpha', '1.0.0'), dir: '/ghosts/alpha', enabled: true },
    ];
    h.ledger.upsertInstallation({
      pluginId: customMarketPluginId('team-lib', 'alpha'),
      ghostId: 'alpha',
      releaseId: customMarketReleaseId('team-lib', 'alpha', '1.0.0'),
      version: '1.0.0',
      sha256: 'custom-unverified',
      scope: 'public',
      organizationId: null,
      source: 'local-market',
      installed: true,
      updatedAt: '2026-07-30T02:00:00.000Z',
    });

    const snapshot = await h.service.snapshot();
    expect(snapshot.items[0]).toMatchObject({
      installState: 'update-available',
      version: '2.0.0',
      enabled: true,
    });
  });
});

describe('PluginMarketService 自定义市场 detail/install', () => {
  it('returns the validated manifest for custom plugin detail', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);

    const detail = await h.service.detail(customMarketPluginId('team-lib', 'alpha'));
    expect(detail.manifest.id).toBe('alpha');
    expect(detail.sourceType).toBe('local-market');
    await expect(h.service.detail(customMarketPluginId('team-lib', 'missing'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(h.service.detail(customMarketPluginId('no-such-market', 'alpha'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('installs a custom market plugin and records local-market provenance', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    runtime.install.mockResolvedValue({
      manifest: ghostManifest('alpha'),
      dir: '/ghosts/alpha',
      enabled: true,
    });

    const pluginId = customMarketPluginId('team-lib', 'alpha');
    // 以 detail 下发的归一化 manifest 作为“用户审阅内容”，与安装侧重读结果逐字比对。
    const reviewed = await h.service.detail(pluginId);
    const result = await h.service.install(pluginId, {
      expectedReleaseId: customMarketReleaseId('team-lib', 'alpha', '1.0.0'),
      expectedManifest: reviewed.manifest,
    });
    expect(result.ghost.manifest.id).toBe('alpha');
    expect(runtime.install).toHaveBeenCalledTimes(1);
    // 打包产物是临时文件，装完即删
    expect(runtime.install.mock.calls[0]?.[0]).toMatch(/cindy-custom-market-alpha-.*\.cindy$/);
    expect(fs.existsSync(runtime.install.mock.calls[0]?.[0] as string)).toBe(false);

    const record = h.ledger.installationForGhost('alpha');
    expect(record).toMatchObject({
      pluginId,
      source: 'local-market',
      installed: true,
      version: '1.0.0',
    });
  });

  it('rejects install when the reviewed release no longer matches', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    const reviewed = await h.service.detail(customMarketPluginId('team-lib', 'alpha'));

    await expect(
      h.service.install(customMarketPluginId('team-lib', 'alpha'), {
        expectedReleaseId: 'custom:stale',
        expectedManifest: reviewed.manifest,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('rejects install when the manifest changed after permission review', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);

    const detail = await h.service.detail(customMarketPluginId('team-lib', 'alpha'));
    // 用户审阅之后，本地 ghost.json 保持 id/version 不变但新增权限声明。
    const ghostFile = path.join(dir, 'plugins', 'alpha', 'ghost.json');
    const tampered = { ...ghostManifest('alpha'), description: 'tampered after review' };
    fs.writeFileSync(ghostFile, JSON.stringify(tampered));

    await expect(
      h.service.install(customMarketPluginId('team-lib', 'alpha'), {
        expectedReleaseId: detail.releaseId,
        expectedManifest: detail.manifest,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('rejects install when another source already owns the ghostId', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    runtime.ghosts = [
      { manifest: ghostManifest('alpha'), dir: '/ghosts/alpha', enabled: true },
    ];
    // 服务端市场装过同 id 插件
    h.ledger.upsertInstallation({
      pluginId: PLUGIN_ID,
      ghostId: 'alpha',
      releaseId: 'release-1',
      version: '1.0.0',
      sha256: 'a'.repeat(64),
      scope: 'public',
      organizationId: null,
      source: 'market',
      installed: true,
      updatedAt: '2026-07-30T02:00:00.000Z',
    });

    const reviewed = await h.service.detail(customMarketPluginId('team-lib', 'alpha'));
    await expect(
      h.service.install(customMarketPluginId('team-lib', 'alpha'), {
        expectedReleaseId: customMarketReleaseId('team-lib', 'alpha', '1.0.0'),
        expectedManifest: reviewed.manifest,
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('uninstalls a custom market plugin through the shared uninstall path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    const pluginId = customMarketPluginId('team-lib', 'alpha');
    h.ledger.upsertInstallation({
      pluginId,
      ghostId: 'alpha',
      releaseId: customMarketReleaseId('team-lib', 'alpha', '1.0.0'),
      version: '1.0.0',
      sha256: 'custom-unverified',
      scope: 'public',
      organizationId: null,
      source: 'local-market',
      installed: true,
      updatedAt: '2026-07-30T02:00:00.000Z',
    });

    await expect(h.service.uninstall(pluginId)).resolves.toEqual({ ok: true });
    expect(runtime.uninstall).toHaveBeenCalledWith('alpha', { skipMarketLedger: true });
    expect(h.ledger.installationForGhost('alpha')?.installed).toBe(false);
  });
});

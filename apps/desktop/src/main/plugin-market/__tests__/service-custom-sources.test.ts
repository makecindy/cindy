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

import type { MarketSourceConfig } from '../../../shared/pluginMarket';
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

/** 服务端详情夹具：summary + 该 release 的完整 manifest。 */
function serverDetail() {
  const summary = serverSummary();
  return {
    ...summary,
    currentRelease: {
      ...summary.currentRelease,
      manifest: ghostManifest(summary.ghostId),
    },
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

describe('PluginMarketService 自定义市场 snapshot 账户作用域', () => {
  it('rejects the snapshot when the account switches during custom discovery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);

    // 以 user-1 捕获 owner、按 user-1 完成自定义发现;在随后的服务端目录
    // await 间隙把会话漂移到 user-2,此后 requireSameMarketOwner 必须检测到并拒绝,
    // 而不是把 user-1 的自定义插件聚合进 user-2 的快照。
    h.api.listAll.mockImplementation(async () => {
      runtime.session = { mode: 'cloud', dataOwnerId: 'user-2', generation: 2 };
      return [];
    });
    await expect(h.service.snapshot()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    runtime.session = { mode: 'cloud', dataOwnerId: 'user-1', generation: 1 };
  });

  it('returns empty custom items instead of reading the previous account store when session is switching', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);

    // 切换中:不得按调用时 owner 现查 store/目录,直接降级为空并标记原因。
    runtime.boundaryPending = true;
    const snap = await h.service.snapshot();
    expect(snap.items).toEqual([]);
    expect(snap.customSourceNames).toEqual([]);
    expect(snap.unavailableReason).toBe('session-switching');
    runtime.boundaryPending = false;
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

  it('rejects install when the account switches during packaging', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    const detail = await h.service.detail(customMarketPluginId('team-lib', 'alpha'));

    // 打包(异步)完成后、装出前,会话已漂移到 user-2:beforeCommit 必须拒绝,
    // 不得把 user-1 审阅的插件装进 user-2 的运行时。
    h.api.listAll.mockImplementation(async () => {
      runtime.session = { mode: 'cloud', dataOwnerId: 'user-2', generation: 2 };
      return [];
    });
    // 打包前的 discover/校验按 user-1 完成;在 install 入口后切换会话。
    const installPromise = h.service.install(customMarketPluginId('team-lib', 'alpha'), {
      expectedReleaseId: detail.releaseId,
      expectedManifest: detail.manifest,
    });
    runtime.session = { mode: 'cloud', dataOwnerId: 'user-2', generation: 2 };
    await expect(installPromise).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(runtime.install).not.toHaveBeenCalled();
    runtime.session = { mode: 'cloud', dataOwnerId: 'user-1', generation: 1 };
  });

  it('rejects listSources when the account switches during discovery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);

    // listSources 异步发现 A 的目录;返回前会话漂移到 user-2 时必须拒绝,
    // 不得把 A 的私有 URL/本地路径摘要发给当前 Renderer。
    const listPromise = h.service.listSources();
    runtime.session = { mode: 'cloud', dataOwnerId: 'user-2', generation: 2 };
    await expect(listPromise).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    runtime.session = { mode: 'cloud', dataOwnerId: 'user-1', generation: 1 };
  });

  it('rejects the snapshot when listAll fails after an account switch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);

    // listAll 因切号失败:catch 分支不能把按 user-1 发现的自定义项返回当前会话。
    h.api.listAll.mockImplementation(async () => {
      runtime.session = { mode: 'cloud', dataOwnerId: 'user-2', generation: 2 };
      throw new Error('session changed');
    });
    await expect(h.service.snapshot()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    runtime.session = { mode: 'cloud', dataOwnerId: 'user-1', generation: 1 };
  });

  it('rejects refreshSource when the account switches during refresh', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);

    // 本地源刷新完成、返回 summary 前会话漂移:runForOwner 必须拒绝,
    // 不把含本地绝对路径的摘要发给当前 Renderer。
    const refreshPromise = h.service.refreshSource('team-lib');
    runtime.session = { mode: 'cloud', dataOwnerId: 'user-2', generation: 2 };
    await expect(refreshPromise).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    runtime.session = { mode: 'cloud', dataOwnerId: 'user-1', generation: 1 };
  });

  it('rejects custom detail when the account switches during discovery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);

    // discoverSource 之后、返回 manifest 前会话漂移:必须拒绝,不把 A 的
    // 名称/作者/权限声明发给当前 Renderer。
    const detailPromise = h.service.detail(customMarketPluginId('team-lib', 'alpha'));
    runtime.session = { mode: 'cloud', dataOwnerId: 'user-2', generation: 2 };
    await expect(detailPromise).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    runtime.session = { mode: 'cloud', dataOwnerId: 'user-1', generation: 1 };
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

  it('rejects install when another custom source declares the same ghostId', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const rival = writeLocalMarket(root, 'rival-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [
      { name: 'team-lib', dir },
      { name: 'rival-lib', dir: rival },
    ]);

    // 两个来源声明同一 ghostId、本地尚无安装:列表把双方都标成 conflict 并禁用,
    // 安装入口必须用同一口径重算并拒绝,不能因为"本地还没装"就放行。
    const snapshot = await h.service.snapshot();
    expect(snapshot.items.map((item) => item.installState)).toEqual(['conflict', 'conflict']);

    const reviewed = await h.service.detail(customMarketPluginId('team-lib', 'alpha'));
    await expect(
      h.service.install(customMarketPluginId('team-lib', 'alpha'), {
        expectedReleaseId: customMarketReleaseId('team-lib', 'alpha', '1.0.0'),
        expectedManifest: reviewed.manifest,
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('rejects install when the server catalog declares the same ghostId', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/x', id: 'server-plugin' }]);
    const h = harness([serverSummary()], [{ name: 'team-lib', dir }]);

    const reviewed = await h.service.detail(customMarketPluginId('team-lib', 'server-plugin'));
    await expect(
      h.service.install(customMarketPluginId('team-lib', 'server-plugin'), {
        expectedReleaseId: customMarketReleaseId('team-lib', 'server-plugin', '1.0.0'),
        expectedManifest: reviewed.manifest,
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('rejects installing a server plugin that a custom source also declares', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/x', id: 'server-plugin' }]);
    const h = harness([serverSummary()], [{ name: 'team-lib', dir }]);
    const item = serverSummary();
    h.api.detail.mockResolvedValue(serverDetail());

    // 列表把两边都标成 conflict 并禁用;服务端安装入口只查服务端目录内部重名,
    // 必须用同一口径重算,否则普通 UI 流程或直接 IPC 都能装进来并抢占 ghostId。
    const snapshot = await h.service.snapshot();
    expect(
      snapshot.items.find((entry) => entry.sourceType === 'server')?.installState,
    ).toBe('conflict');

    await expect(
      h.service.install(item.id, { expectedReleaseId: item.currentRelease.id }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    expect(h.api.download).not.toHaveBeenCalled();
  });

  it('keeps the conflict state on the server detail view', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/x', id: 'server-plugin' }]);
    const h = harness([serverSummary()], [{ name: 'team-lib', dir }]);
    h.api.detail.mockResolvedValue(serverDetail());

    // 详情传空重复集合会把 conflict 项恢复成可安装,给出绕过冲突闸的入口。
    const detail = await h.service.detail(serverSummary().id);
    expect(detail.installState).toBe('conflict');
  });

  it('skips defaultInstall when a custom source declares the same ghostId', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/x', id: 'server-plugin' }]);
    const h = harness([serverSummary({ defaultInstall: true })], [{ name: 'team-lib', dir }]);
    h.api.detail.mockResolvedValue(serverDetail());

    // 默认安装会真的下载并启用插件。若只按服务端目录判重,与自定义来源同 ghostId
    // 的默认项会被静默抢占所有权,而列表随后又把它标成 conflict —— 既定事实已经
    // 发生。冲突集合必须先于默认安装算出来。
    const snapshot = await h.service.snapshot();
    expect(h.api.download).not.toHaveBeenCalled();
    expect(runtime.install).not.toHaveBeenCalled();
    expect(
      snapshot.items.find((entry) => entry.sourceType === 'server')?.installState,
    ).toBe('conflict');
  });

  it('rechecks cross-source ownership right before committing the install', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const rivalDir = writeLocalMarket(root, 'rival-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    runtime.install.mockResolvedValue({
      manifest: ghostManifest('alpha'),
      dir: '/ghosts/alpha',
      enabled: true,
    });
    const pluginId = customMarketPluginId('team-lib', 'alpha');
    const reviewed = await h.service.detail(pluginId);

    // 竞争来源必须在**入口检查之后**才出现,否则被入口那次判定拦住,根本触不到
    // 提交点复核。打包是异步的、可以持续很久,期间另一窗口经独立的 market-sources
    // 互斥键添加了声明同一 ghostId 的来源 —— 用"第一次读取来源表之后才加进去"
    // 精确模拟这个时序。
    const rival: MarketSourceConfig = {
      name: 'rival-lib',
      addedAt: '2026-08-01T00:00:00.000Z',
      lastSyncedAt: '2026-08-01T00:00:00.000Z',
      lastRevision: null,
      source: { type: 'local', path: rivalDir },
    };
    const realList = MarketSourceStore.prototype.list;
    let reads = 0;
    const listSpy = vi
      .spyOn(MarketSourceStore.prototype, 'list')
      .mockImplementation(function (this: MarketSourceStore) {
        const configs = realList.call(this);
        reads += 1;
        return reads <= 1 ? configs : [...configs, rival];
      });

    try {
      await expect(
        h.service.install(pluginId, {
          expectedReleaseId: customMarketReleaseId('team-lib', 'alpha', '1.0.0'),
          expectedManifest: reviewed.manifest,
        }),
      ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      // 关键:不能只是报错,而是必须在**改动 Ghost 运行时之前**就拒绝。
      expect(runtime.install).not.toHaveBeenCalled();
      expect(reads).toBeGreaterThan(1);
    } finally {
      listSpy.mockRestore();
    }
  });

  it('holds the source lock across the install commit so sources cannot interleave', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const rivalDir = writeLocalMarket(root, 'rival-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    const pluginId = customMarketPluginId('team-lib', 'alpha');
    const reviewed = await h.service.detail(pluginId);

    // 落位期间(installOrUpdateMarketGhostPackage 还在 await 包检查)另一窗口尝试
    // 添加声明同一 ghostId 的来源。提交段持有来源锁,这次 addSource 必须排在落位
    // 之后 —— 否则复核结论在真正落位前就过期了。
    let addSourceStarted = false;
    let installFinished = false;
    runtime.install.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      installFinished = true;
      return { manifest: ghostManifest('alpha'), dir: '/ghosts/alpha', enabled: true };
    });

    const installing = h.service.install(pluginId, {
      expectedReleaseId: customMarketReleaseId('team-lib', 'alpha', '1.0.0'),
      expectedManifest: reviewed.manifest,
    });
    // 等安装真正进入落位段再发起来源添加。
    await new Promise((resolve) => setTimeout(resolve, 20));
    const adding = h.service
      .addSource({ source: rivalDir })
      .then(() => {
        addSourceStarted = true;
      })
      .catch(() => {
        addSourceStarted = true;
      });

    await installing;
    // 落位完成时,来源添加还没被放行(它在锁后面排队)。
    expect(installFinished).toBe(true);
    expect(addSourceStarted).toBe(false);
    await adding;
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

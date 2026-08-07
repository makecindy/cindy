import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  ghosts: [] as Array<{
    manifest: Record<string, unknown>;
    dir: string;
    enabled: boolean;
    approval?:
      | { state: 'approved'; revision: string }
      | { state: 'legacy-unapproved' }
      | { state: 'invalid' };
  }>,
  /** 测试可注入:每次 list() 调用返回不同快照(模拟打包窗口内运行时变动)。 */
  listSequence: null as null | (() => Array<{
    manifest: Record<string, unknown>;
    dir: string;
    enabled: boolean;
    approval?:
      | { state: 'approved'; revision: string }
      | { state: 'legacy-unapproved' }
      | { state: 'invalid' };
  }>),
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

const pickerDialog = vi.hoisted(() => ({
  showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
}));
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()) },
  dialog: pickerDialog,
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
  getGhostManager: () => ({
    list: () =>
      (runtime.listSequence ? runtime.listSequence() : runtime.ghosts).map((ghost) => ({
        ...ghost,
        approval: ghost.approval ?? {
          state: 'approved',
          revision: '00000000-0000-4000-8000-000000000001',
        },
      })),
  }),
  isGhostAvailableForActiveSession: vi.fn(() => runtime.accountGhostAvailable),
  installOrUpdateMarketGhostPackage: runtime.install,
  rejectReservedGhostIdForCustomMarket: vi.fn(),
  isBuiltinGhostRemovedByUser: (id: string) => runtime.builtinRemoved.has(id),
  uninstallGhostAndCleanup: runtime.uninstall,
}));
vi.mock('../download.js', () => ({
  downloadVerifiedPlugin: vi.fn(async () => undefined),
}));

import type { VisiblePluginDetail, VisiblePluginSummary } from '@cindy/plugin-protocol';

import { ghostPermissionBaselineKey, type GhostManifest } from '../../../shared/ghost';
import type { MarketSourceConfig } from '../../../shared/pluginMarket';
import { customMarketPluginId, customMarketReleaseId, marketSourceKey } from '../../../shared/pluginMarket';
import { PluginMarketLedger, ghostManifestDigest } from '../ledger';
import { PluginMarketService } from '../service';
import { MarketSourceStore } from '../sources/store';
import type { PluginMarketApi } from '../api';

const roots: string[] = [];
const PLUGIN_ID = `c${'a'.repeat(24)}`;
const APPROVED_INSTALL_TOKEN = 'approved:00000000-0000-4000-8000-000000000001';

afterEach(() => {
  runtime.ghosts = [];
  runtime.listSequence = null;
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
    slots: ['notify' as const],
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
    listAll: vi.fn(async () => ({ plugins: items, removals: [] })),
    detail: vi.fn(async (pluginId: string) => {
      const item = items.find((candidate) => candidate.id === pluginId);
      if (!item) throw new Error('not found');
      return {
        ...item,
        currentRelease: {
          ...item.currentRelease,
          manifest: ghostManifest(item.ghostId, item.currentRelease.version),
        },
      } satisfies VisiblePluginDetail;
    }),
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

  it('strips bidi/control chars from custom plugin name/description/author in snapshot', async () => {
    // ghost.json 来自不受信市场仓库,双向控制符会在卡片上伪造署名/说明。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = path.join(root, 'team-lib');
    const pluginDir = path.join(dir, 'plugins', 'alpha');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'ghost.json'),
      JSON.stringify({
        ...ghostManifest('alpha'),
        name: 'Alpha‮EVIL',
        description: 'line1‏‭trick',
        author: 'me⁦x⁩',
      }),
    );
    fs.writeFileSync(path.join(pluginDir, 'main.js'), '// entry');
    fs.mkdirSync(path.join(dir, '.agents', 'plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({ name: 'team-lib', plugins: [{ name: 'alpha', source: 'plugins/alpha' }] }),
    );
    const h = harness([], [{ name: 'team-lib', dir }]);

    const snapshot = await h.service.snapshot();
    const custom = snapshot.items.find((item) => item.ghostId === 'alpha');
    expect(custom?.name).toBe('AlphaEVIL');
    expect(custom?.description).toBe('line1trick');
    expect(custom?.author).toBe('mex');
    for (const field of [custom?.name, custom?.description, custom?.author]) {
      expect(field).not.toMatch(/[‎‏‪-‮⁦-⁩]/);
    }
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

  it('keeps uninstalled cross-source ghostId duplicates available', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/x', id: 'server-plugin' }]);
    const h = harness([serverSummary()], [{ name: 'team-lib', dir }]);

    const snapshot = await h.service.snapshot();
    expect(snapshot.items.find((item) => item.sourceType === 'server')?.installState).toBe(
      'not-installed',
    );
    expect(snapshot.items.find((item) => item.sourceType === 'local-market')?.installState).toBe(
      'not-installed',
    );
  });

  it('reports update-available when the marketplace version moved past the install', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [
      { rel: 'plugins/alpha', id: 'alpha', version: '2.0.0' },
    ]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    // 已装插件目录里放**原始** ghost.json;运行时 manifest 用"本地化后"的变体
    // (name 被翻译)——摘要比对必须 locale 无关,切语言不得把自装插件判成 conflict。
    const installedDir = path.join(root, 'installed-alpha');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, 'ghost.json'),
      JSON.stringify(ghostManifest('alpha', '1.0.0')),
    );
    runtime.ghosts = [
      {
        manifest: { ...ghostManifest('alpha', '1.0.0'), name: 'アルファ(localized)' },
        dir: installedDir,
        enabled: true,
      },
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
      // 所有权 = pluginId + 来源指纹 + 安装时 manifest 摘要,三者齐全才认领。
      sourceKey: marketSourceKey({ type: 'local', path: dir }),
      manifestDigest: ghostManifestDigest(ghostManifest('alpha', '1.0.0')),
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
      return { plugins: [], removals: [] };
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
    expect(detail.manifest?.id).toBe('alpha');
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
    expect(result.ghost?.manifest.id).toBe('alpha');
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

  it('requires full review for an unapproved custom update and carries its receipt token to commit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [
      { rel: 'plugins/alpha', id: 'alpha', version: '2.0.0' },
    ]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    const installedManifest = ghostManifest('alpha', '1.0.0');
    const installedDir = path.join(root, 'installed-alpha');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(path.join(installedDir, 'ghost.json'), JSON.stringify(installedManifest));
    runtime.ghosts = [
      {
        manifest: installedManifest,
        dir: installedDir,
        enabled: true,
        approval: { state: 'legacy-unapproved' },
      },
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
      updatedAt: '2026-08-01T00:00:00.000Z',
      sourceKey: marketSourceKey({ type: 'local', path: dir }),
      manifestDigest: ghostManifestDigest(installedManifest),
    });
    runtime.install.mockResolvedValue({
      manifest: ghostManifest('alpha', '2.0.0'),
      dir: installedDir,
      enabled: true,
    });
    const pluginId = customMarketPluginId('team-lib', 'alpha');
    const reviewed = await h.service.detail(pluginId);

    await expect(
      h.service.install(pluginId, {
        expectedReleaseId: reviewed.releaseId,
        expectedManifest: reviewed.manifest,
        expectedInstalledApproval: 'legacy-unapproved',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(runtime.install).not.toHaveBeenCalled();

    await h.service.install(pluginId, {
      expectedReleaseId: reviewed.releaseId,
      expectedManifest: reviewed.manifest,
      expectedInstalledApproval: 'legacy-unapproved',
      allowPermissionExpansion: true,
      reviewedBaseline: ghostPermissionBaselineKey(installedManifest as GhostManifest),
    });
    expect(runtime.install).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ expectedInstalledApproval: 'legacy-unapproved' }),
    );
  });

  it('rejects a custom update when the receipt changes during packaging', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    const installedManifest = ghostManifest('alpha');
    const installedDir = path.join(root, 'installed-alpha');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(path.join(installedDir, 'ghost.json'), JSON.stringify(installedManifest));
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
      updatedAt: '2026-08-01T00:00:00.000Z',
      sourceKey: marketSourceKey({ type: 'local', path: dir }),
      manifestDigest: ghostManifestDigest(installedManifest),
    });
    const calls = { n: 0 };
    runtime.listSequence = () => {
      calls.n += 1;
      return [
        {
          manifest: installedManifest,
          dir: installedDir,
          enabled: true,
          approval:
            calls.n >= 2
              ? { state: 'invalid' as const }
              : {
                  state: 'approved' as const,
                  revision: '00000000-0000-4000-8000-000000000001',
                },
        },
      ];
    };
    const pluginId = customMarketPluginId('team-lib', 'alpha');
    const reviewed = await h.service.detail(pluginId);

    await expect(
      h.service.install(pluginId, {
        expectedReleaseId: reviewed.releaseId,
        expectedManifest: reviewed.manifest,
        expectedInstalledApproval: APPROVED_INSTALL_TOKEN,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(runtime.install).not.toHaveBeenCalled();
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
      return { plugins: [], removals: [] };
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

  it('rejects install when the plugin is uninstalled during packaging (runtime 复核)', async () => {
    // F1:审阅时 alpha 已装(existing 存在),打包窗口内本地页把它卸载。
    // beforeCommit 的 runtime 复核必须发现 existing→缺失并拒,避免"更新"被
    // 静默降级成"首装 + 带电启用"。用 listSequence 让最后一次 list()(即
    // beforeCommit 内的复核)看到空,前面的 list() 都看到已装。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    const pluginId = customMarketPluginId('team-lib', 'alpha');
    const reviewed = await h.service.detail(pluginId);
    const installedGhost = [
      { manifest: ghostManifest('alpha'), dir: path.join(dir, 'plugins', 'alpha'), enabled: true },
    ];
    // detail 之后开始计数:审阅路径的 list() 都看到已装,beforeCommit(最后一次)
    // 看到空——alpha 在打包窗口内被卸载。
    // 该路径共两次 list():#1 审阅算 existing(看到已装),#2 beforeCommit
    // 的 runtime 复核(看到空=打包窗口内被卸载)。
    const calls = { n: 0 };
    runtime.listSequence = () => {
      calls.n += 1;
      return calls.n >= 2 ? [] : installedGhost;
    };
    await expect(
      h.service.install(pluginId, {
        expectedReleaseId: reviewed.releaseId,
        expectedManifest: reviewed.manifest,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(runtime.install).not.toHaveBeenCalled();
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

  it('lets the user choose between uninstalled custom sources with the same ghostId', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const rival = writeLocalMarket(root, 'rival-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [
      { name: 'team-lib', dir },
      { name: 'rival-lib', dir: rival },
    ]);

    runtime.install.mockResolvedValue({
      manifest: ghostManifest('alpha'),
      dir: '/ghosts/alpha',
      enabled: true,
    });

    // 市场目录只负责发现。没有真实安装时，两个条目都可选；用户选择哪个来源，
    // 安装完成后才由运行时插件和账本建立所有权。
    const snapshot = await h.service.snapshot();
    expect(snapshot.items.map((item) => item.installState)).toEqual([
      'not-installed',
      'not-installed',
    ]);

    const reviewed = await h.service.detail(customMarketPluginId('team-lib', 'alpha'));
    await expect(
      h.service.install(customMarketPluginId('team-lib', 'alpha'), {
        expectedReleaseId: customMarketReleaseId('team-lib', 'alpha', '1.0.0'),
        expectedManifest: reviewed.manifest,
      }),
    ).resolves.toMatchObject({ ghost: { manifest: { id: 'alpha' } } });
    expect(runtime.install).toHaveBeenCalledTimes(1);
  });

  it('lets a selected custom source install when the server catalog declares the same ghostId', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/x', id: 'server-plugin' }]);
    const h = harness([serverSummary()], [{ name: 'team-lib', dir }]);
    runtime.install.mockResolvedValue({
      manifest: ghostManifest('server-plugin'),
      dir: '/ghosts/server-plugin',
      enabled: true,
    });

    const reviewed = await h.service.detail(customMarketPluginId('team-lib', 'server-plugin'));
    await expect(
      h.service.install(customMarketPluginId('team-lib', 'server-plugin'), {
        expectedReleaseId: customMarketReleaseId('team-lib', 'server-plugin', '1.0.0'),
        expectedManifest: reviewed.manifest,
      }),
    ).resolves.toMatchObject({ ghost: { manifest: { id: 'server-plugin' } } });
    expect(runtime.install).toHaveBeenCalledTimes(1);
  });

  it('lets a selected server plugin install when a custom source declares the same ghostId', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/x', id: 'server-plugin' }]);
    const h = harness([serverSummary()], [{ name: 'team-lib', dir }]);
    const item = serverSummary();
    h.api.download.mockResolvedValue({
      url: 'https://downloads.test.invalid/plugin.cindy',
      expiresAt: '2099-01-01T00:00:00.000Z',
      sha256: 'a'.repeat(64),
      sizeBytes: 42,
    });
    runtime.install.mockResolvedValue({
      manifest: ghostManifest('server-plugin'),
      dir: '/ghosts/server-plugin',
      enabled: true,
    });

    const snapshot = await h.service.snapshot();
    expect(
      snapshot.items.find((entry) => entry.sourceType === 'server')?.installState,
    ).toBe('not-installed');

    await expect(
      h.service.install(item.id, {
        expectedReleaseId: item.currentRelease.id,
        expectedManifest: ghostManifest(item.ghostId, item.currentRelease.version),
      }),
    ).resolves.toMatchObject({ ghost: { manifest: { id: 'server-plugin' } } });
    expect(h.api.download).toHaveBeenCalledTimes(1);
  });

  it('keeps an uninstalled duplicate available on the server detail view', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/x', id: 'server-plugin' }]);
    const h = harness([serverSummary()], [{ name: 'team-lib', dir }]);

    const detail = await h.service.detail(serverSummary().id);
    expect(detail.installState).toBe('not-installed');
  });

  it('does not let an uninstalled custom catalog entry block an official default install', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/x', id: 'server-plugin' }]);
    const h = harness([serverSummary({ defaultInstall: true })], [{ name: 'team-lib', dir }]);
    h.api.download.mockResolvedValue({
      url: 'https://downloads.test.invalid/plugin.cindy',
      expiresAt: '2099-01-01T00:00:00.000Z',
      sha256: 'a'.repeat(64),
      sizeBytes: 42,
    });
    runtime.install.mockResolvedValue({
      manifest: ghostManifest('server-plugin'),
      dir: '/ghosts/server-plugin',
      enabled: true,
    });

    await h.service.snapshot();
    expect(h.api.download).toHaveBeenCalledTimes(1);
    expect(runtime.install).toHaveBeenCalledTimes(1);
  });

  it('does not rescan unrelated catalogs while committing a selected install', async () => {
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
    const reviewed = await h.service.detail(pluginId);

    const realList = MarketSourceStore.prototype.list;
    let reads = 0;
    const listSpy = vi
      .spyOn(MarketSourceStore.prototype, 'list')
      .mockImplementation(function (this: MarketSourceStore) {
        reads += 1;
        return realList.call(this);
      });

    try {
      await expect(
        h.service.install(pluginId, {
          expectedReleaseId: customMarketReleaseId('team-lib', 'alpha', '1.0.0'),
          expectedManifest: reviewed.manifest,
        }),
      ).resolves.toMatchObject({ ghost: { manifest: { id: 'alpha' } } });
      expect(runtime.install).toHaveBeenCalledTimes(1);
      expect(reads).toBe(0);
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
    // 变更来源配置。自定义安装提交段持有来源锁，这次 addSource 必须排在落位后，
    // 保证所选来源从提交前复核到落位完成之间保持稳定。
    const order: string[] = [];
    let markInstallEntered!: () => void;
    const installEntered = new Promise<void>((resolve) => {
      markInstallEntered = resolve;
    });
    let releaseInstall!: () => void;
    const installMayFinish = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    runtime.install.mockImplementation(async () => {
      order.push('install-entered');
      markInstallEntered();
      await installMayFinish;
      order.push('install-finished');
      return { manifest: ghostManifest('alpha'), dir: '/ghosts/alpha', enabled: true };
    });

    const installing = h.service.install(pluginId, {
      expectedReleaseId: customMarketReleaseId('team-lib', 'alpha', '1.0.0'),
      expectedManifest: reviewed.manifest,
    });
    // runtime.install 只会在 beforeCommit 复核之后、SOURCE_MUTATION_KEY 仍被持有时调用。
    // 用显式 barrier 等到这个时刻，不能靠固定毫秒数猜测打包是否已经完成：CI 负载下
    // 打包超过等待时间时，rival 会先拿锁，测试反而正确地收到 ALREADY_EXISTS。
    await installEntered;
    let addSourceSettled = false;
    const adding = h.service
      .addSource({ source: rivalDir })
      .then(() => {
        addSourceSettled = true;
        order.push('source-settled');
      })
      .catch(() => {
        addSourceSettled = true;
        order.push('source-settled');
      });

    // 给 addSource 一次真实调度机会；持锁期间它必须仍未 settle。记录结果后先释放
    // barrier 并等待两个 promise，保证断言失败也不会把后台操作泄漏到下一条测试。
    await new Promise((resolve) => setTimeout(resolve, 0));
    const settledWhileInstallHeld = addSourceSettled;
    releaseInstall();
    await Promise.all([installing, adding]);

    expect(settledWhileInstallHeld).toBe(false);
    expect(order).toEqual(['install-entered', 'install-finished', 'source-settled']);
  });

  it('denies a re-added same-name source with a different origin from owning the install', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    // 来源 B 与当初安装用的来源 A 市场名相同(marketplace.json 自报、可复用),
    // 但指向完全不同的目录。pluginId 因此完全相同,所有权必须由来源指纹裁决。
    const dirB = writeLocalMarket(root, 'team-lib', [
      { rel: 'plugins/alpha', id: 'alpha', version: '2.0.0' },
    ]);
    const h = harness([], [{ name: 'team-lib', dir: dirB }]);
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
      // 当初的安装来自另一个目录(来源 A)。
      sourceKey: marketSourceKey({ type: 'local', path: path.join(root, 'origin-a') }),
    });

    // 列表:同 pluginId 但指纹不符 → 不是所有者,如实标 conflict 而不是把
    // "无关仓库的 2.0.0"呈现成本插件的可用更新。
    const snapshot = await h.service.snapshot();
    expect(snapshot.items[0]?.installState).toBe('conflict');

    // 安装:同样被拒,恶意/无关仓库不能借同名市场"更新"别人装出来的插件。
    const reviewed = await h.service.detail(customMarketPluginId('team-lib', 'alpha'));
    await expect(
      h.service.install(customMarketPluginId('team-lib', 'alpha'), {
        expectedReleaseId: customMarketReleaseId('team-lib', 'alpha', '2.0.0'),
        expectedManifest: reviewed.manifest,
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('rejects the install when the source vanishes before the commit point', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    const pluginId = customMarketPluginId('team-lib', 'alpha');
    const reviewed = await h.service.detail(pluginId);

    // 打包期间另一窗口移除了该来源(移除先拿 SOURCE_MUTATION_KEY 删配置,租约只
    // 保住目录字节)。用"入口发现之后 store.get 开始返回 null"精确模拟这个时序:
    // 提交点必须确认来源仍在,否则会装出一个没有对应来源的包并写孤儿账本记录。
    const realGet = MarketSourceStore.prototype.get;
    let gets = 0;
    const spy = vi
      .spyOn(MarketSourceStore.prototype, 'get')
      .mockImplementation(function (this: MarketSourceStore, name: string) {
        gets += 1;
        if (gets > 1) return null;
        return realGet.call(this, name);
      });
    try {
      await expect(
        h.service.install(pluginId, {
          expectedReleaseId: customMarketReleaseId('team-lib', 'alpha', '1.0.0'),
          expectedManifest: reviewed.manifest,
        }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(runtime.install).not.toHaveBeenCalled();
      expect(gets).toBeGreaterThan(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not let a stale custom record claim a locally replaced package', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [
      { rel: 'plugins/alpha', id: 'alpha', version: '2.0.0' },
    ]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    // 降级窗口:旧版卸载了本来源装的 A,又从本地 .cindy 装了同 ghostId 的 B。
    // 旧版不认识 custom 账本,记录原样留存(installed:true、指纹全对),唯一能
    // 分辨的是"运行时的 manifest 已不是安装时那份"。
    const replacedManifest = {
      ...ghostManifest('alpha', '1.0.0'),
      description: 'locally installed replacement',
      slots: ['notify', 'network'],
    };
    runtime.ghosts = [{ manifest: replacedManifest, dir: '/ghosts/alpha', enabled: true }];
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
      sourceKey: marketSourceKey({ type: 'local', path: dir }),
      // 摘要是**安装时那份 A** 的,不是替换后的 B 的。
      manifestDigest: ghostManifestDigest(ghostManifest('alpha', '1.0.0')),
    });

    // 列表:B 不归本来源所有,如实标 conflict,而不是把来源的 2.0.0 呈现成
    // "B 的可用更新"。
    const snapshot = await h.service.snapshot();
    expect(snapshot.items[0]?.installState).toBe('conflict');

    // 安装:同样被拒,来源的更新不能覆盖用户降级期间自己装的包。
    const reviewed = await h.service.detail(customMarketPluginId('team-lib', 'alpha'));
    await expect(
      h.service.install(customMarketPluginId('team-lib', 'alpha'), {
        expectedReleaseId: customMarketReleaseId('team-lib', 'alpha', '2.0.0'),
        expectedManifest: reviewed.manifest,
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('masks failure details with a generation error when the account switches mid-operation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    // 让操作在"开始之后"失败:来源目录消失 → refreshSource 在 operation 内抛
    // MARKET_SOURCE_INVALID。切号发生在 operation 已启动、错误尚未抛出之间——
    // 用 store.get 作时序钩子(refreshSource 第一步就是读配置)。
    const realGet = MarketSourceStore.prototype.get;
    const spy = vi
      .spyOn(MarketSourceStore.prototype, 'get')
      .mockImplementation(function (this: MarketSourceStore, name: string) {
        const config = realGet.call(this, name);
        fs.rmSync(dir, { recursive: true, force: true });
        runtime.session = { ...runtime.session, generation: runtime.session.generation + 1 };
        return config;
      });
    try {
      // 失败出口若不校验代际,git/discover 类错误的 detail(刻意保留仓库地址等
      // 上一账号私有信息)会被交给切号后的 Renderer。必须统一换成代际错误。
      await expect(h.service.refreshSource('team-lib')).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps official default installs available while a custom source is unreadable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/x', id: 'other-plugin' }]);
    const h = harness([serverSummary({ defaultInstall: true })], [{ name: 'team-lib', dir }]);
    h.api.download.mockResolvedValue({
      url: 'https://downloads.test.invalid/plugin.cindy',
      expiresAt: '2099-01-01T00:00:00.000Z',
      sha256: 'a'.repeat(64),
      sizeBytes: 42,
    });
    runtime.install.mockResolvedValue({
      manifest: ghostManifest('server-plugin'),
      dir: '/ghosts/server-plugin',
      enabled: true,
    });
    // 来源暂时不可读只影响该来源，未安装的目录条目不能阻塞官方默认安装。
    fs.rmSync(dir, { recursive: true, force: true });

    await h.service.snapshot();
    expect(h.api.download).toHaveBeenCalled();
    expect(runtime.install).toHaveBeenCalled();
  });

  it('keeps official default installs available while one custom entry is unreadable', async () => {
    // 粒度到条目:来源本身可读、清单也在,只是**某个插件的 ghost.json** 因文件锁/
    // 权限/网络盘抖动暂时读不到。此前这类失败与"内容非法"共用静默跳过分支,目录
    // 仍被判 complete,同 ghostId 的默认安装会在这个窗口里抢占所有权,恢复后该
    // 插件永久 conflict。现在读取事实不明必须让目录判为不完整。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    // 插件 id **刻意不与服务端 ghostId 相同**:否则"同 ghostId 重复"规则本身就会
    // 拦下默认安装,用例即使没有完整性闸也照样通过(咬不住)。
    const dir = writeLocalMarket(root, 'team-lib', [
      { rel: 'plugins/srv', id: 'unrelated-plugin' },
    ]);
    const h = harness([serverSummary({ defaultInstall: true })], [{ name: 'team-lib', dir }]);
    h.api.download.mockResolvedValue({
      url: 'https://downloads.test.invalid/plugin.cindy',
      expiresAt: '2099-01-01T00:00:00.000Z',
      sha256: 'a'.repeat(64),
      sizeBytes: 42,
    });
    runtime.install.mockResolvedValue({
      manifest: ghostManifest('server-plugin'),
      dir: '/ghosts/server-plugin',
      enabled: true,
    });
    // EACCES 是可重试类错误(事实不明);注意不能用 ENOENT —— 那是"清单指向不存在
    // 的目录"这种永久错误,按内容非法跳过才对(否则这类市场永久阻塞默认安装)。
    // 路径必须按 realpath 拼:发现层用的是 realpath(macOS 上 /var → /private/var),
    // 用 mkdtemp 原样路径做匹配会让 mock 永不命中。
    const target = path.join(await fs.promises.realpath(dir), 'plugins', 'srv', 'ghost.json');
    const realOpen = fs.promises.open;
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation((async (
      ...args: Parameters<typeof fs.promises.open>
    ) => {
      if (String(args[0]) === target) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      return realOpen(...args);
    }) as typeof fs.promises.open);
    try {
      await h.service.snapshot();
      expect(h.api.download).toHaveBeenCalled();
      expect(runtime.install).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('still treats a missing plugin directory as invalid content (不阻塞默认安装)', async () => {
    // 对照组:marketplace.json 列了一个已被删掉的插件目录(ENOENT)是常见的**永久**
    // 错误。若把它也当"读取事实不明",这类市场会永久阻塞默认安装 —— 必须按内容
    // 非法跳过,默认安装照常进行。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/gone', id: 'stale-entry' }]);
    fs.rmSync(path.join(dir, 'plugins', 'gone'), { recursive: true, force: true });
    const h = harness([serverSummary({ defaultInstall: true })], [{ name: 'team-lib', dir }]);

    await h.service.snapshot();
    // 与"不可读"组对称的信号:目录判为完整 → 默认安装照常进入下载阶段。
    expect(h.api.download).toHaveBeenCalled();
  });

  it('keeps manual official installs available while a custom source is unreadable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/x', id: 'other-plugin' }]);
    const h = harness([serverSummary()], [{ name: 'team-lib', dir }]);
    h.api.download.mockResolvedValue({
      url: 'https://downloads.test.invalid/plugin.cindy',
      expiresAt: '2099-01-01T00:00:00.000Z',
      sha256: 'a'.repeat(64),
      sizeBytes: 42,
    });
    runtime.install.mockResolvedValue({
      manifest: ghostManifest('server-plugin'),
      dir: '/ghosts/server-plugin',
      enabled: true,
    });
    fs.rmSync(dir, { recursive: true, force: true });

    const item = serverSummary();
    await expect(
      h.service.install(item.id, {
        expectedReleaseId: item.currentRelease.id,
        expectedManifest: ghostManifest(item.ghostId, item.currentRelease.version),
      }),
    ).resolves.toMatchObject({ ghost: { manifest: { id: 'server-plugin' } } });
    expect(h.api.download).toHaveBeenCalled();
  });

  it('does not let official market take over an installed custom plugin when its source is unreadable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [
      { rel: 'plugins/x', id: 'server-plugin' },
    ]);
    const h = harness([serverSummary()], [{ name: 'team-lib', dir }]);
    runtime.ghosts = [
      { manifest: ghostManifest('server-plugin'), dir: '/ghosts/server-plugin', enabled: true },
    ];
    h.ledger.upsertInstallation({
      pluginId: customMarketPluginId('team-lib', 'server-plugin'),
      ghostId: 'server-plugin',
      releaseId: customMarketReleaseId('team-lib', 'server-plugin', '1.0.0'),
      version: '1.0.0',
      sha256: 'custom-unverified',
      scope: 'public',
      organizationId: null,
      source: 'local-market',
      installed: true,
      updatedAt: '2026-08-06T00:00:00.000Z',
      sourceKey: marketSourceKey({ type: 'local', path: dir }),
      manifestDigest: ghostManifestDigest(ghostManifest('server-plugin')),
    });
    fs.rmSync(dir, { recursive: true, force: true });

    const item = serverSummary();
    await expect(
      h.service.install(item.id, {
        expectedReleaseId: item.currentRelease.id,
        expectedManifest: ghostManifest(item.ghostId, item.currentRelease.version),
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    expect(h.api.download).not.toHaveBeenCalled();
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('adopts a matching install after a lost ledger write instead of dead-ending in conflict', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    // 场景:包已落位,但溯源账本因文件锁/磁盘错没写成——账本里没有记录。
    // 运行时内容与来源候选**完全一致**(同一份原始 ghost.json)。
    const installedDir = path.join(root, 'installed-alpha');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(path.join(installedDir, 'ghost.json'), JSON.stringify(ghostManifest('alpha')));
    runtime.ghosts = [{ manifest: ghostManifest('alpha'), dir: installedDir, enabled: true }];

    // 列表:不能标 conflict(UI 会禁用安装,用户连修复入口都没有);投影成可安装。
    const snapshot = await h.service.snapshot();
    expect(snapshot.items[0]?.installState).toBe('not-installed');

    // 安装 = 收养:完整重装 + 补写溯源,自愈完成。
    runtime.install.mockResolvedValue({
      manifest: ghostManifest('alpha'),
      dir: installedDir,
      enabled: true,
    });
    const reviewed = await h.service.detail(customMarketPluginId('team-lib', 'alpha'));
    await h.service.install(customMarketPluginId('team-lib', 'alpha'), {
      expectedReleaseId: customMarketReleaseId('team-lib', 'alpha', '1.0.0'),
      expectedManifest: reviewed.manifest,
      expectedInstalledApproval: APPROVED_INSTALL_TOKEN,
    });
    expect(h.ledger.installationForGhost('alpha')).toMatchObject({
      installed: true,
      source: 'local-market',
    });
  });

  it('adds a local source only through the native directory picker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], []);

    // 用户取消:什么都不添加。
    pickerDialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(h.service.addLocalSourceFromPicker(dir)).resolves.toEqual({ canceled: true });
    expect(h.sourceStore.list()).toEqual([]);

    // 用户在原生框选中目录:授权即选择结果,defaultPath 只是初始定位提示。
    pickerDialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [dir] });
    const added = await h.service.addLocalSourceFromPicker('/somewhere/else');
    expect(added).toMatchObject({ canceled: false, summary: { name: 'team-lib' } });
    expect(h.sourceStore.list().map((config) => config.name)).toEqual(['team-lib']);
  });

  it('rejects the picker result when the account switched while it was open', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], []);
    // 原生选择器可以开着很久:打开期间切号,选完落盘会写进新账户的 store。
    pickerDialog.showOpenDialog.mockImplementationOnce(async () => {
      runtime.session = { ...runtime.session, generation: runtime.session.generation + 1 };
      return { canceled: false, filePaths: [dir] };
    });
    await expect(h.service.addLocalSourceFromPicker()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(h.sourceStore.list()).toEqual([]);
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

  it('结构守卫:service.ts 不允许出现按路径的 readFile/readFileSync', async () => {
    // 已安装目录同样可能被外部进程/同步盘改动,且摘要读取在每次市场快照都会
    // 执行;所有此类读取必须走 readBoundedFileNoFollow 系列(单句柄限量闸)。
    const source = await fs.promises.readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'service.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/fs\.promises\.readFile\(/);
    expect(source).not.toMatch(/readFileSync\(/);
    expect(source).toMatch(/readBoundedFileNoFollowSync/);
  });
});

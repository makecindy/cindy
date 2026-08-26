import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

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
  inspect: vi.fn(),
  uninstall: vi.fn(),
  builtinRemoved: new Set<string>(),
  accountGhostAvailable: true,
  pendingCalls: false,
  runningErrand: false,
  cindyWork: false,
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
  app: {
    getPath: vi.fn(() => os.tmpdir()),
    getVersion: vi.fn(() => '1.0.0'),
  },
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
    inspect: runtime.inspect,
  }),
  isGhostAvailableForActiveSession: vi.fn(() => runtime.accountGhostAvailable),
  installOrUpdateMarketGhostPackage: async (
    filePath: string,
    options: {
      afterCommitInLock?: (installed: unknown) => void | Promise<void>;
    },
  ) => {
    const installed = await runtime.install(filePath, options);
    await options.afterCommitInLock?.(installed);
    return installed;
  },
  hasPendingGhostCalls: vi.fn(() => runtime.pendingCalls),
  hasRunningGhostErrand: vi.fn(() => runtime.runningErrand),
  hasRunningGhostCindyWork: vi.fn(() => runtime.cindyWork),
  rejectReservedGhostIdForCustomMarket: vi.fn(),
  isBuiltinGhostRemovedByUser: (id: string) => runtime.builtinRemoved.has(id),
  uninstallGhostAndCleanup: runtime.uninstall,
}));
vi.mock('../download.js', () => ({
  downloadVerifiedPlugin: vi.fn(async () => undefined),
}));

import { downloadVerifiedPlugin } from '../download.js';
import type { VisiblePluginDetail, VisiblePluginSummary } from '@cindy/plugin-protocol';

import { GHOST_ICON_MAX_BYTES, type GhostManifest } from '../../../shared/ghost';
import {
  customMarketPluginId,
  customMarketReleaseId,
  marketSourceKey,
  pluginMarketCustomIconProjectionToken,
  pluginMarketCustomIconSourceToken,
} from '../../../shared/pluginMarket';
import {
  PluginMarketLedger,
  ghostManifestDigest,
  type PluginMarketInstallationRecord,
} from '../ledger';
import { PluginMarketService } from '../service';
import { MarketSourceManager } from '../sources';
import { MarketSourceStore } from '../sources/store';
import type { PluginMarketApi } from '../api';

const roots: string[] = [];
const PLUGIN_ID = `c${'a'.repeat(24)}`;
const APPROVED_INSTALL_TOKEN = 'approved:00000000-0000-4000-8000-000000000001';

afterEach(() => {
  runtime.ghosts = [];
  runtime.listSequence = null;
  runtime.install.mockReset();
  runtime.inspect.mockReset();
  runtime.uninstall.mockReset();
  runtime.builtinRemoved.clear();
  runtime.accountGhostAvailable = true;
  runtime.pendingCalls = false;
  runtime.runningErrand = false;
  runtime.cindyWork = false;
  runtime.boundaryPending = false;
  runtime.pluginApiBaseUrl = 'https://plugin.test.invalid';
  runtime.session = { mode: 'cloud', dataOwnerId: 'user-1', generation: 1 };
  vi.mocked(downloadVerifiedPlugin).mockReset();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function ghostManifest(id: string, version = '1.0.0', overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 3 as const,
    minCindyVersion: '0.1.61',
    id,
    name: `Plugin ${id}`,
    description: 'Custom market plugin',
    author: 'Community',
    version,
    kind: 'chip' as const,
    entry: 'main.js',
    notify: true as const,
    ...overrides,
  };
}

/** runtime 安装返回的目录必须包含真实 ghost.json，和生产契约一致。 */
function installedGhost(root: string, id: string, version = '1.0.0') {
  const dir = path.join(root, 'installed', id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = ghostManifest(id, version);
  fs.writeFileSync(path.join(dir, 'ghost.json'), JSON.stringify(manifest));
  return { manifest, dir, enabled: true };
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
  plugins: Array<{
    rel: string;
    id: string;
    version?: string;
    minCindyVersion?: string;
    icon?: string;
    iconBytes?: string | Buffer;
  }>,
): string {
  const dir = path.join(root, marketName);
  for (const plugin of plugins) {
    const pluginDir = path.join(dir, ...plugin.rel.split('/'));
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'ghost.json'),
      JSON.stringify({
        ...ghostManifest(
          plugin.id,
          plugin.version ?? '1.0.0',
          plugin.icon ? { icon: plugin.icon } : {},
        ),
        ...(plugin.minCindyVersion ? { minCindyVersion: plugin.minCindyVersion } : {}),
      }),
    );
    fs.writeFileSync(path.join(pluginDir, 'main.js'), '// entry');
    if (plugin.icon) {
      const iconPath = path.join(pluginDir, ...plugin.icon.split('/'));
      fs.mkdirSync(path.dirname(iconPath), { recursive: true });
      fs.writeFileSync(iconPath, plugin.iconBytes ?? 'icon-bytes');
    }
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
  vi.mocked(downloadVerifiedPlugin).mockImplementation(async (_url, _expected, targetPath) => {
    const item = items[0];
    if (!item) throw new Error('missing server Plugin fixture');
    const zip = new JSZip();
    zip.file('ghost.json', JSON.stringify(ghostManifest(item.ghostId, item.currentRelease.version)));
    zip.file('main.js', '// server package fixture');
    await fs.promises.writeFile(targetPath, await zip.generateAsync({ type: 'nodebuffer' }), {
      flag: 'wx',
      mode: 0o600,
    });
  });
  runtime.inspect.mockImplementation(async (filePath: string) => {
    const zip = await JSZip.loadAsync(await fs.promises.readFile(filePath));
    const manifestEntry = zip.file('ghost.json');
    if (!manifestEntry) throw new Error('missing ghost.json in test package');
    const inspectedManifest = JSON.parse(await manifestEntry.async('text')) as GhostManifest;
    return {
      manifest: inspectedManifest,
      canonicalManifest: inspectedManifest,
      unsupportedLegacySlots: [],
      trust: {
        level: 'unverified',
        publisherSigned: false,
        publisherVerified: false,
        reviewed: false,
      },
      packageSha256: 'a'.repeat(64),
    };
  });
  return {
    api,
    ledger,
    sourceStore,
    service: new PluginMarketService(api as unknown as PluginMarketApi, ledger, sourceStore),
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

  it('keeps official items visible and reports only the unavailable custom source', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-missing-'));
    roots.push(root);
    const h = harness(
      [serverSummary()],
      [{ name: 'offline-market', dir: path.join(root, 'does-not-exist') }],
    );

    const snapshot = await h.service.snapshot();

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]?.sourceType).toBe('server');
    expect(snapshot.unavailableReason).toBeNull();
    expect(snapshot.unavailableCustomSourceNames).toEqual(['offline-market']);
  });

  it('preserves completed custom sources when a later source exceeds the snapshot timeout', async () => {
    vi.useFakeTimers();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-timeout-'));
    roots.push(root);
    const readyDir = writeLocalMarket(root, 'ready-market', [
      { rel: 'plugins/ready', id: 'ready' },
    ]);
    const slowDir = writeLocalMarket(root, 'slow-market', [{ rel: 'plugins/slow', id: 'slow' }]);
    const h = harness(
      [],
      [
        { name: 'ready-market', dir: readyDir },
        { name: 'slow-market', dir: slowDir },
      ],
    );
    const original = MarketSourceManager.prototype.forEachDiscoveredSource;
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const discover = vi
      .spyOn(MarketSourceManager.prototype, 'forEachDiscoveredSource')
      .mockImplementation(async function (this: MarketSourceManager, fn) {
        await original.call(this, async (entry) => {
          if (entry.config.name === 'slow-market') {
            await new Promise<void>(() => undefined);
            return;
          }
          await fn(entry);
          resolveReady();
        });
      });

    try {
      const snapshotPromise = h.service.snapshot();
      await ready;
      await vi.advanceTimersByTimeAsync(3_100);
      const snapshot = await snapshotPromise;

      expect(snapshot.items.map((item) => item.ghostId)).toEqual(['ready']);
      expect(snapshot.unavailableCustomSourceNames).toEqual(['slow-market']);
    } finally {
      discover.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not mark a custom market installation removed when discovery is temporarily empty', async () => {
    const h = harness([], []);
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

    await expect(h.service.snapshot()).resolves.toMatchObject({ items: [] });

    expect(h.ledger.installationForGhost('alpha')?.installed).toBe(true);
    expect(h.ledger.isDefaultInstallSuppressed('user-1', pluginId)).toBe(false);
  });

  it('keeps custom releases visible without a client min-version filter', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [
      { rel: 'plugins/compatible', id: 'compatible' },
      {
        rel: 'plugins/requires-newer',
        id: 'requires-newer',
        minCindyVersion: '2.0.0',
      },
    ]);
    const h = harness([], [{ name: 'team-lib', dir }]);

    const snapshot = await h.service.snapshot();

    expect(snapshot.items.map((item) => item.ghostId)).toEqual(['compatible', 'requires-newer']);
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
      unavailableCustomSourceNames: [],
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

  it('silently updates a tracked custom plugin when the marketplace version advances', async () => {
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
      // 自动更新路由 = pluginId + 来源指纹 + 安装时 manifest 摘要。
      sourceKey: marketSourceKey({ type: 'local', path: dir }),
      manifestDigest: ghostManifestDigest(ghostManifest('alpha', '1.0.0')),
    });
    runtime.install.mockImplementationOnce(async () => {
      const upgraded = installedGhost(root, 'alpha', '2.0.0');
      runtime.ghosts = [upgraded];
      return upgraded;
    });

    const snapshot = await h.service.snapshot();
    expect(snapshot.items[0]).toMatchObject({
      installState: 'installed',
      version: '2.0.0',
      enabled: true,
    });
    expect(runtime.install).toHaveBeenCalledTimes(1);
  });
});

describe('PluginMarketService 自定义市场图标', () => {
  it('rejects an unsafe icon path before stat or byte read even if discovery validation is bypassed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const pluginDir = path.join(root, 'plugin');
    const outsideIcon = path.join(root, 'outside.png');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(outsideIcon, 'PRIVATE');
    const h = harness([], []);
    const config = {
      name: 'team-lib',
      addedAt: '2026-07-30T00:00:00.000Z',
      lastSyncedAt: '2026-07-30T01:00:00.000Z',
      lastRevision: null,
      source: { type: 'local' as const, path: root },
    };
    const discovered = {
      config,
      result: {
        ok: true as const,
        marketplace: {
          name: 'team-lib',
          displayName: null,
          skippedCount: 0,
          unreadableCount: 0,
          plugins: [
            {
              ghostId: 'alpha',
              version: '1.0.0',
              dir: pluginDir,
              manifest: ghostManifest('alpha', '1.0.0', {
                icon: '../outside.png',
              }) as GhostManifest,
            },
          ],
        },
      },
    };
    const forEachSpy = vi
      .spyOn(MarketSourceManager.prototype, 'forEachDiscoveredSource')
      .mockImplementation(async (visitor) => visitor(discovered));
    const withSourceSpy = vi
      .spyOn(MarketSourceManager.prototype, 'withDiscoveredSource')
      .mockImplementation(async (_name, visitor) => visitor(discovered));
    const lstatSpy = vi.spyOn(fs.promises, 'lstat');
    const openSpy = vi.spyOn(fs.promises, 'open');
    try {
      const item = (await h.service.snapshot()).items[0]!;
      expect(item.ghostId).toBe('alpha');
      expect(item.customIconKey).toBeUndefined();

      const request = {
        pluginId: item.pluginId,
        expectedIconKey: 'a'.repeat(64),
      };
      await expect(h.service.localIcons([request])).resolves.toEqual([
        { ...request, status: 'missing' },
      ]);
      expect(lstatSpy.mock.calls.some(([file]) => String(file) === outsideIcon)).toBe(false);
      expect(openSpy.mock.calls.some(([file]) => String(file) === outsideIcon)).toBe(false);
    } finally {
      openSpy.mockRestore();
      lstatSpy.mockRestore();
      withSourceSpy.mockRestore();
      forEachSpy.mockRestore();
    }
  });

  it('projects opaque icon keys and batches one discovery per marketplace', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [
      { rel: 'plugins/alpha', id: 'alpha', icon: 'assets/icon.png', iconBytes: 'ALPHA' },
      { rel: 'plugins/beta', id: 'beta', icon: 'assets/icon.webp', iconBytes: 'BETA' },
    ]);
    const h = harness([], [{ name: 'team-lib', dir }]);

    const snapshot = await h.service.snapshot();
    const alpha = snapshot.items.find((item) => item.ghostId === 'alpha');
    const beta = snapshot.items.find((item) => item.ghostId === 'beta');
    expect(alpha?.icon).toBeNull();
    expect(alpha?.customIconKey).toMatch(/^[a-f0-9]{64}$/);
    expect(beta?.customIconKey).toMatch(/^[a-f0-9]{64}$/);
    expect(pluginMarketCustomIconSourceToken(alpha!.customIconKey!)).toBe(
      pluginMarketCustomIconSourceToken(beta!.customIconKey!),
    );
    expect(pluginMarketCustomIconProjectionToken(alpha!.customIconKey!)).toBe(
      pluginMarketCustomIconProjectionToken(beta!.customIconKey!),
    );
    const detail = await h.service.detail(customMarketPluginId('team-lib', 'alpha'));
    expect(detail.customIconKey).toBe(alpha?.customIconKey);
    const repeatedDetail = await h.service.detail(customMarketPluginId('team-lib', 'alpha'));
    expect(repeatedDetail.customIconKey).toBe(detail.customIconKey);

    const discoverSpy = vi.spyOn(MarketSourceManager.prototype, 'withDiscoveredSource');
    try {
      const results = await h.service.localIcons([
        { pluginId: alpha!.pluginId, expectedIconKey: alpha!.customIconKey! },
        { pluginId: beta!.pluginId, expectedIconKey: beta!.customIconKey! },
      ]);
      expect(discoverSpy).toHaveBeenCalledTimes(1);
      expect(results).toEqual([
        {
          pluginId: alpha!.pluginId,
          expectedIconKey: alpha!.customIconKey,
          status: 'loaded',
          dataUrl: `data:image/png;base64,${Buffer.from('ALPHA').toString('base64')}`,
        },
        {
          pluginId: beta!.pluginId,
          expectedIconKey: beta!.customIconKey,
          status: 'loaded',
          dataUrl: `data:image/webp;base64,${Buffer.from('BETA').toString('base64')}`,
        },
      ]);
    } finally {
      discoverSpy.mockRestore();
    }
  });

  it('keeps the source token across refreshes and changes it for a new owner generation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [
      { rel: 'plugins/alpha', id: 'alpha', icon: 'assets/icon.png', iconBytes: 'AAAA' },
    ]);
    const h = harness([], [{ name: 'team-lib', dir }]);

    const first = (await h.service.snapshot()).items[0]!;
    const iconPath = path.join(dir, 'plugins', 'alpha', 'assets', 'icon.png');
    const before = fs.statSync(iconPath);
    await new Promise((resolve) => setTimeout(resolve, 5));
    fs.writeFileSync(iconPath, 'BBBB');
    fs.utimesSync(iconPath, before.atime, before.mtime);

    const second = (await h.service.snapshot()).items[0]!;
    expect(second.version).toBe(first.version);
    expect(second.customIconKey).not.toBe(first.customIconKey);
    expect(pluginMarketCustomIconSourceToken(second.customIconKey!)).toBe(
      pluginMarketCustomIconSourceToken(first.customIconKey!),
    );
    expect(pluginMarketCustomIconProjectionToken(second.customIconKey!)).not.toBe(
      pluginMarketCustomIconProjectionToken(first.customIconKey!),
    );
    await expect(
      h.service.localIcons([{ pluginId: first.pluginId, expectedIconKey: first.customIconKey! }]),
    ).resolves.toEqual([
      { pluginId: first.pluginId, expectedIconKey: first.customIconKey, status: 'missing' },
    ]);

    runtime.session = { ...runtime.session, generation: 2 };
    const nextOwner = (await h.service.snapshot()).items[0]!;
    expect(nextOwner.customIconKey).not.toBe(second.customIconKey);
    expect(pluginMarketCustomIconSourceToken(nextOwner.customIconKey!)).not.toBe(
      pluginMarketCustomIconSourceToken(second.customIconKey!),
    );
  });

  it('changes the projection key when same-length icon bytes change but stats collide', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [
      { rel: 'plugins/alpha', id: 'alpha', icon: 'assets/icon.png', iconBytes: 'AAAA' },
    ]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    const first = (await h.service.snapshot()).items[0]!;
    const iconPath = path.join(dir, 'plugins', 'alpha', 'assets', 'icon.png');
    const stableStat = await fs.promises.stat(iconPath, { bigint: true });
    await fs.promises.writeFile(iconPath, 'BBBB');

    const realLstat = fs.promises.lstat;
    const lstatSpy = vi.spyOn(fs.promises, 'lstat').mockImplementation((async (
      target: fs.PathLike,
      options?: fs.StatOptions,
    ) => {
      if (String(target).endsWith(path.join('plugins', 'alpha', 'assets', 'icon.png'))) {
        return stableStat;
      }
      return realLstat(target, options as never);
    }) as typeof fs.promises.lstat);
    const realOpen = fs.promises.open;
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation((async (
      ...args: Parameters<typeof fs.promises.open>
    ) => {
      const handle = await realOpen(...args);
      if (!String(args[0]).endsWith(path.join('plugins', 'alpha', 'assets', 'icon.png'))) {
        return handle;
      }
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'stat') return async () => stableStat;
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as typeof fs.promises.open);
    try {
      const second = (await h.service.snapshot()).items[0]!;
      expect(second.customIconKey).not.toBe(first.customIconKey);
      await expect(
        h.service.localIcons([
          { pluginId: second.pluginId, expectedIconKey: second.customIconKey! },
        ]),
      ).resolves.toEqual([
        {
          pluginId: second.pluginId,
          expectedIconKey: second.customIconKey,
          status: 'loaded',
          dataUrl: `data:image/png;base64,${Buffer.from('BBBB').toString('base64')}`,
        },
      ]);
    } finally {
      openSpy.mockRestore();
      lstatSpy.mockRestore();
    }
  });

  it('does not attach bytes from a raced file handle to an older icon key', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [
      { rel: 'plugins/alpha', id: 'alpha', icon: 'assets/icon.png', iconBytes: 'AAAA' },
    ]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    const item = (await h.service.snapshot()).items[0]!;
    const iconPath = await fs.promises.realpath(
      path.join(dir, 'plugins', 'alpha', 'assets', 'icon.png'),
    );
    const backupPath = `${iconPath}.old-generation`;
    const realOpen = fs.promises.open;
    let restoredOldGeneration = false;
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation((async (
      ...args: Parameters<typeof fs.promises.open>
    ) => {
      if (String(args[0]) !== iconPath) return realOpen(...args);
      fs.renameSync(iconPath, backupPath);
      fs.writeFileSync(iconPath, 'BBBB');
      const handle = await realOpen(...args);
      const realRead = handle.read.bind(handle);
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'read') {
            return async (buffer: Buffer, offset: number, length: number, position: number) => {
              const result = await realRead(buffer, offset, length, position);
              if (!restoredOldGeneration) {
                fs.rmSync(iconPath);
                fs.renameSync(backupPath, iconPath);
                restoredOldGeneration = true;
              }
              return result;
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as typeof fs.promises.open);
    try {
      const results = await h.service.localIcons([
        { pluginId: item.pluginId, expectedIconKey: item.customIconKey! },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        pluginId: item.pluginId,
        expectedIconKey: item.customIconKey,
      });
      expect(['missing', 'retryable']).toContain(results[0]?.status);
      expect(results[0]?.status).not.toBe('loaded');
      expect(restoredOldGeneration).toBe(true);
    } finally {
      openSpy.mockRestore();
      if (fs.existsSync(backupPath)) {
        fs.rmSync(iconPath, { force: true });
        fs.renameSync(backupPath, iconPath);
      }
    }
  });

  it('treats missing, oversized and invalid-extension icons as deterministic absence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [
      { rel: 'plugins/missing', id: 'missing', icon: 'assets/icon.png' },
      {
        rel: 'plugins/oversized',
        id: 'oversized',
        icon: 'assets/icon.png',
        iconBytes: Buffer.alloc(GHOST_ICON_MAX_BYTES + 1),
      },
      { rel: 'plugins/svg', id: 'svg', icon: 'assets/icon.svg', iconBytes: '<svg />' },
    ]);
    fs.rmSync(path.join(dir, 'plugins', 'missing', 'assets', 'icon.png'));
    const h = harness([], [{ name: 'team-lib', dir }]);

    const snapshot = await h.service.snapshot();
    expect(snapshot.items.some((item) => item.ghostId === 'svg')).toBe(false);
    const requests = snapshot.items.map((item) => ({
      pluginId: item.pluginId,
      expectedIconKey: item.customIconKey!,
    }));
    expect(requests).toHaveLength(2);
    await expect(h.service.localIcons(requests)).resolves.toEqual(
      requests.map((request) => ({ ...request, status: 'missing' })),
    );
  });

  it('returns retryable for uncertain icon I/O and failed marketplace rediscovery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [
      { rel: 'plugins/alpha', id: 'alpha', icon: 'assets/icon.png', iconBytes: 'ALPHA' },
    ]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    const item = (await h.service.snapshot()).items[0]!;
    const request = { pluginId: item.pluginId, expectedIconKey: item.customIconKey! };
    const iconPath = await fs.promises.realpath(
      path.join(dir, 'plugins', 'alpha', 'assets', 'icon.png'),
    );
    const realOpen = fs.promises.open;
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation((async (
      ...args: Parameters<typeof fs.promises.open>
    ) => {
      if (String(args[0]) === iconPath) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      return realOpen(...args);
    }) as typeof fs.promises.open);
    try {
      await expect(h.service.localIcons([request])).resolves.toEqual([
        { ...request, status: 'retryable' },
      ]);
    } finally {
      openSpy.mockRestore();
    }

    fs.rmSync(path.join(dir, '.agents', 'plugins', 'marketplace.json'));
    await expect(h.service.localIcons([request])).resolves.toEqual([
      { ...request, status: 'retryable' },
    ]);
  });

  it('returns retryable when the icon changes during the verified read', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [
      { rel: 'plugins/alpha', id: 'alpha', icon: 'assets/icon.png', iconBytes: 'ALPHA' },
    ]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    const item = (await h.service.snapshot()).items[0]!;
    const request = { pluginId: item.pluginId, expectedIconKey: item.customIconKey! };
    const iconPath = await fs.promises.realpath(
      path.join(dir, 'plugins', 'alpha', 'assets', 'icon.png'),
    );
    const realOpen = fs.promises.open;
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation((async (
      ...args: Parameters<typeof fs.promises.open>
    ) => {
      const handle = await realOpen(...args);
      if (String(args[0]) !== iconPath) return handle;
      const realStat = handle.stat.bind(handle);
      let statCalls = 0;
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'stat') {
            return async (options?: fs.StatOptions) => {
              const stat = (await realStat(options as never)) as unknown as fs.BigIntStats;
              statCalls += 1;
              if (statCalls !== 2) return stat;
              return new Proxy(stat, {
                get(statTarget, statKey) {
                  if (statKey === 'mtimeNs') return statTarget.mtimeNs + 1n;
                  const value = Reflect.get(statTarget, statKey);
                  return typeof value === 'function' ? value.bind(statTarget) : value;
                },
              }) as fs.BigIntStats;
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as typeof fs.promises.open);
    try {
      await expect(h.service.localIcons([request])).resolves.toEqual([
        { ...request, status: 'retryable' },
      ]);
    } finally {
      openSpy.mockRestore();
    }
  });

  it('keeps discovery and projection uncertainty retryable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [
      { rel: 'plugins/alpha', id: 'alpha', icon: 'assets/icon.png', iconBytes: 'ALPHA' },
    ]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    const item = (await h.service.snapshot()).items[0]!;
    const request = { pluginId: item.pluginId, expectedIconKey: item.customIconKey! };

    const discoverSpy = vi
      .spyOn(MarketSourceManager.prototype, 'withDiscoveredSource')
      .mockImplementationOnce(async (_name, consume) =>
        consume({
          config: {
            name: 'team-lib',
            source: { type: 'local', path: dir },
            addedAt: '2026-07-30T00:00:00.000Z',
            lastRevision: null,
            lastSyncedAt: null,
          },
          result: {
            ok: true,
            marketplace: {
              name: 'team-lib',
              displayName: null,
              plugins: [],
              skippedCount: 0,
              unreadableCount: 1,
            },
          },
        }),
      );
    await expect(h.service.localIcons([request])).resolves.toEqual([
      { ...request, status: 'retryable' },
    ]);
    discoverSpy.mockRestore();

    const realLstat = fs.promises.lstat;
    const currentProjectionSpy = vi.spyOn(fs.promises, 'lstat').mockImplementation((async (
      target: fs.PathLike,
      options?: fs.StatOptions,
    ) => {
      if (String(target).endsWith(path.join('plugins', 'alpha', 'assets', 'icon.png'))) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      return realLstat(target, options as never);
    }) as typeof fs.promises.lstat);
    try {
      await expect(h.service.localIcons([request])).resolves.toEqual([
        { ...request, status: 'retryable' },
      ]);
    } finally {
      currentProjectionSpy.mockRestore();
    }

    const lstatSpy = vi.spyOn(fs.promises, 'lstat').mockImplementation((async (
      target: fs.PathLike,
      options?: fs.StatOptions,
    ) => {
      if (String(target).endsWith(path.join('plugins', 'alpha', 'assets', 'icon.png'))) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      return realLstat(target, options as never);
    }) as typeof fs.promises.lstat);
    const uncertainItem = (await h.service.snapshot()).items[0]!;
    lstatSpy.mockRestore();
    await expect(
      h.service.localIcons([
        { pluginId: uncertainItem.pluginId, expectedIconKey: uncertainItem.customIconKey! },
      ]),
    ).resolves.toEqual([
      {
        pluginId: uncertainItem.pluginId,
        expectedIconKey: uncertainItem.customIconKey,
        status: 'retryable',
      },
    ]);
  });

  it.runIf(process.platform !== 'win32')(
    'does not stat an icon through a parent-directory symlink outside the plugin directory',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
      roots.push(root);
      const dir = writeLocalMarket(root, 'team-lib', [
        { rel: 'plugins/alpha', id: 'alpha', icon: 'assets/icon.png', iconBytes: 'ALPHA' },
      ]);
      const externalAssets = path.join(root, 'external-assets');
      fs.mkdirSync(externalAssets);
      fs.writeFileSync(path.join(externalAssets, 'icon.png'), 'PRIVATE');
      const assetsDir = path.join(dir, 'plugins', 'alpha', 'assets');
      fs.rmSync(assetsDir, { recursive: true });
      fs.symlinkSync(externalAssets, assetsDir, 'dir');
      const h = harness([], [{ name: 'team-lib', dir }]);
      const lstatSpy = vi.spyOn(fs.promises, 'lstat');
      try {
        const item = (await h.service.snapshot()).items[0]!;
        expect(item.customIconKey).toBeUndefined();
        expect(
          lstatSpy.mock.calls.some(([file]) => String(file) === path.join(assetsDir, 'icon.png')),
        ).toBe(false);
      } finally {
        lstatSpy.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'does not follow a marketplace icon symlink outside the plugin directory',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
      roots.push(root);
      const dir = writeLocalMarket(root, 'team-lib', [
        { rel: 'plugins/alpha', id: 'alpha', icon: 'assets/icon.png', iconBytes: 'ALPHA' },
      ]);
      const secret = path.join(root, 'secret.txt');
      fs.writeFileSync(secret, 'PRIVATE');
      const iconPath = path.join(dir, 'plugins', 'alpha', 'assets', 'icon.png');
      fs.rmSync(iconPath);
      fs.symlinkSync(secret, iconPath);
      const h = harness([], [{ name: 'team-lib', dir }]);
      const item = (await h.service.snapshot()).items[0]!;
      expect(item.customIconKey).toBeUndefined();
      const request = { pluginId: item.pluginId, expectedIconKey: 'a'.repeat(64) };

      const results = await h.service.localIcons([request]);
      expect(results).toEqual([{ ...request, status: 'missing' }]);
      expect(JSON.stringify(results)).not.toContain(Buffer.from('PRIVATE').toString('base64'));
    },
  );

  it('does not return bytes from a marketplace icon hard-linked to a file outside the plugin directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [
      { rel: 'plugins/alpha', id: 'alpha', icon: 'assets/icon.png', iconBytes: 'ALPHA' },
    ]);
    const secret = path.join(root, 'secret.txt');
    fs.writeFileSync(secret, 'PRIVATE');
    const iconPath = path.join(dir, 'plugins', 'alpha', 'assets', 'icon.png');
    fs.rmSync(iconPath);
    try {
      fs.linkSync(secret, iconPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') return;
      throw error;
    }
    const h = harness([], [{ name: 'team-lib', dir }]);
    const item = (await h.service.snapshot()).items[0]!;

    const results = await h.service.localIcons([
      { pluginId: item.pluginId, expectedIconKey: item.customIconKey! },
    ]);
    expect(results).toEqual([
      { pluginId: item.pluginId, expectedIconKey: item.customIconKey, status: 'missing' },
    ]);
    expect(JSON.stringify(results)).not.toContain(Buffer.from('PRIVATE').toString('base64'));
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
  it('installs a custom market package without a client version gate', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [
      {
        rel: 'plugins/requires-newer',
        id: 'requires-newer',
        minCindyVersion: '2.0.0',
      },
    ]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    const pluginId = customMarketPluginId('team-lib', 'requires-newer');

    const selected = await h.service.detail(pluginId);
    expect(selected).toMatchObject({
      pluginId,
      manifest: { id: 'requires-newer', minCindyVersion: '2.0.0' },
    });
    const releaseId = customMarketReleaseId('team-lib', 'requires-newer', '1.0.0');
    runtime.install.mockResolvedValue(installedGhost(root, 'requires-newer'));
    await expect(
      h.service.install(pluginId, {
        expectedReleaseId: releaseId,
        expectedManifest: selected.manifest,
      }),
    ).resolves.toMatchObject({ ghost: { manifest: { id: 'requires-newer' } } });
    expect(runtime.install.mock.calls[0]?.[1]).toMatchObject({
      ghostId: 'requires-newer',
    });
  });

  it('does not turn custom package min-version drift into a confirmation flow', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    const pluginId = customMarketPluginId('team-lib', 'alpha');
    const selected = await h.service.detail(pluginId);
    const actualManifest = ghostManifest('alpha', '1.0.0', { minCindyVersion: '2.0.0' });
    runtime.inspect.mockResolvedValueOnce({
      manifest: actualManifest,
      canonicalManifest: actualManifest,
      unsupportedLegacySlots: [],
      trust: {
        level: 'unverified',
        publisherSigned: false,
        publisherVerified: false,
        reviewed: false,
      },
      packageSha256: 'a'.repeat(64),
    });
    runtime.install.mockResolvedValue(installedGhost(root, 'alpha'));

    await expect(
      h.service.install(pluginId, {
        expectedReleaseId: customMarketReleaseId('team-lib', 'alpha', '1.0.0'),
        expectedManifest: selected.manifest,
      }),
    ).resolves.toMatchObject({ ghost: { manifest: { id: 'alpha' } } });
    expect(runtime.install).toHaveBeenCalledTimes(1);
  });

  it('returns the validated manifest for custom plugin detail', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);

    const detail = await h.service.detail(customMarketPluginId('team-lib', 'alpha'));
    expect(detail.manifest?.id).toBe('alpha');
    expect(detail.sourceType).toBe('local-market');
    await expect(
      h.service.detail(customMarketPluginId('team-lib', 'missing')),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      h.service.detail(customMarketPluginId('no-such-market', 'alpha')),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('installs a custom market plugin and records local-market provenance', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    runtime.install.mockResolvedValue(installedGhost(root, 'alpha'));

    const pluginId = customMarketPluginId('team-lib', 'alpha');
    // detail 的目录 manifest 只用于预览；安装权限由 Main 随后解析真实包。
    const detail = await h.service.detail(pluginId);
    const result = await h.service.install(pluginId, {
      expectedReleaseId: customMarketReleaseId("team-lib", "alpha", "1.0.0"),
      expectedManifest: detail.manifest,
    });
    expect(result.ghost?.manifest.id).toBe('alpha');
    expect(runtime.install).toHaveBeenCalledTimes(1);
    expect(runtime.install.mock.calls[0]?.[1]).not.toHaveProperty('pendingMarketRecord');
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

  it('custom market 即使自报 cindy-github 也不会获得 server-market 官方标记', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-github-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/github', id: 'cindy-github' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    runtime.install.mockResolvedValue({
      manifest: ghostManifest('cindy-github'),
      dir: '/ghosts/cindy-github',
      enabled: true,
    });
    const pluginId = customMarketPluginId('team-lib', 'cindy-github');
    const detail = await h.service.detail(pluginId);

    await h.service.install(pluginId, {
      expectedReleaseId: customMarketReleaseId("team-lib", "cindy-github", "1.0.0"),
      expectedManifest: detail.manifest,
    });

    expect(runtime.install.mock.calls[0]?.[1]).toMatchObject({
      ghostId: 'cindy-github',
      version: '1.0.0',
      manifestCap: ghostManifest('cindy-github'),
    });
    expect(runtime.install.mock.calls[0]?.[1]).not.toHaveProperty('officialCindyGithub');
  });

  it('rejects install when the selected release no longer matches', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    const detail = await h.service.detail(customMarketPluginId('team-lib', 'alpha'));

    await expect(
      h.service.install(customMarketPluginId('team-lib', 'alpha'), {
        expectedReleaseId: 'custom:stale',
        expectedManifest: detail.manifest,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('requires every custom install to bind the selected manifest', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);

    const detail = await h.service.detail(customMarketPluginId('team-lib', 'alpha'));

    await expect(
      h.service.install(customMarketPluginId('team-lib', 'alpha'), {
        expectedReleaseId: detail.releaseId,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('rejects install when the manifest changed after selection', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);

    const detail = await h.service.detail(customMarketPluginId('team-lib', 'alpha'));
    // 用户选择之后，本地 ghost.json 保持 id/version 不变但内容发生变化。
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
    // 不得把 user-1 选择的插件装进 user-2 的运行时。
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

  it('commits custom provenance to the captured ledger after a terminal switch timeout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    const pluginId = customMarketPluginId('team-lib', 'alpha');
    const detail = await h.service.detail(pluginId);
    runtime.install.mockImplementationOnce(async () => {
      const installed = installedGhost(root, 'alpha');
      // 真实路径中包已经落位且仍持原 owner lease；这里只模拟切号终止等待超时后
      // volatile session 已推进，但旧 owner 的溯源提交尚未执行。
      runtime.session = { mode: 'cloud', dataOwnerId: 'user-2', generation: 2 };
      return installed;
    });

    await expect(
      h.service.install(pluginId, {
        expectedReleaseId: detail.releaseId,
        expectedManifest: detail.manifest,
      }),
    ).resolves.toMatchObject({ ghost: { manifest: { id: 'alpha' } } });
    expect(h.ledger.installationForGhost('alpha')).toMatchObject({
      pluginId,
      releaseId: detail.releaseId,
      source: 'local-market',
      installed: true,
    });
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
    h.ledger.upsertInstallation({
      pluginId,
      ghostId: 'alpha',
      releaseId: reviewed.releaseId,
      version: '1.0.0',
      sha256: 'custom-unverified',
      scope: 'public',
      organizationId: null,
      source: 'local-market',
      installed: true,
      updatedAt: '2026-07-30T02:00:00.000Z',
      sourceKey: marketSourceKey({ type: 'local', path: dir }),
      manifestDigest: ghostManifestDigest(ghostManifest('alpha')),
    });
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

  it('allows an explicit custom install to replace the same ghostId from another source', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    const current = installedGhost(root, 'alpha');
    runtime.ghosts = [current];
    // 服务端市场装过同 id 插件
    const previousRecord = {
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
    } satisfies PluginMarketInstallationRecord;
    h.ledger.upsertInstallation(previousRecord);

    const detail = await h.service.detail(customMarketPluginId('team-lib', 'alpha'));
    await expect(
      h.service.install(customMarketPluginId('team-lib', 'alpha'), {
        expectedReleaseId: customMarketReleaseId("team-lib", "alpha", "1.0.0"),
        expectedManifest: detail.manifest,
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    runtime.install.mockImplementationOnce(async (_file, options) => {
      options.beforeCommitInLock?.();
      expect(h.ledger.installationForGhost('alpha')).toMatchObject({ installed: false });
      throw new Error('placement failed');
    });
    await expect(
      h.service.install(customMarketPluginId('team-lib', 'alpha'), {
        expectedReleaseId: customMarketReleaseId("team-lib", "alpha", "1.0.0"),
        expectedManifest: detail.manifest,
        expectedInstalledApproval: APPROVED_INSTALL_TOKEN,
        allowSourceReplacement: true,
      }),
    ).rejects.toThrow('placement failed');
    expect(h.ledger.installationForGhost('alpha')).toEqual(previousRecord);
    expect(h.ledger.isDefaultInstallSuppressed('user-1', PLUGIN_ID)).toBe(false);
    runtime.install.mockImplementationOnce(async (_file, options) => {
      options.beforeCommitInLock?.();
      options.onPackagePlacedInLock?.();
      throw new Error('notification failed after placement');
    });
    await expect(
      h.service.install(customMarketPluginId('team-lib', 'alpha'), {
        expectedReleaseId: customMarketReleaseId("team-lib", "alpha", "1.0.0"),
        expectedManifest: detail.manifest,
        expectedInstalledApproval: APPROVED_INSTALL_TOKEN,
        allowSourceReplacement: true,
      }),
    ).rejects.toThrow('notification failed after placement');
    expect(h.ledger.installationForGhost('alpha')).toMatchObject({ installed: false });
    expect(h.ledger.isDefaultInstallSuppressed('user-1', PLUGIN_ID)).toBe(true);
    runtime.install.mockImplementationOnce(async (_file, options) => {
      options.beforeCommitInLock?.();
      expect(h.ledger.installationForGhost('alpha')).toMatchObject({ installed: false });
      return {
        manifest: ghostManifest('alpha'),
        dir: '/ghosts/replaced-alpha',
        enabled: true,
      };
    });
    await expect(
      h.service.install(customMarketPluginId('team-lib', 'alpha'), {
        expectedReleaseId: customMarketReleaseId("team-lib", "alpha", "1.0.0"),
        expectedManifest: detail.manifest,
        expectedInstalledApproval: APPROVED_INSTALL_TOKEN,
        allowSourceReplacement: true,
      }),
    ).resolves.toMatchObject({ ghost: { manifest: { id: 'alpha' } } });
    expect(runtime.install.mock.calls[0]?.[1]).toMatchObject({
      manifestCap: ghostManifest('alpha'),
    });
    expect(h.ledger.installationForGhost('alpha')).toMatchObject({
      pluginId: customMarketPluginId('team-lib', 'alpha'),
      source: 'local-market',
      installed: true,
    });
  });

  it('lets the user choose between uninstalled custom sources with the same ghostId', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const rival = writeLocalMarket(root, 'rival-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness(
      [],
      [
        { name: 'team-lib', dir },
        { name: 'rival-lib', dir: rival },
      ],
    );

    runtime.install.mockResolvedValue(installedGhost(root, 'alpha'));

    // 市场目录只负责发现。没有真实安装时，两个条目都可选；用户选择哪个来源，
    // 安装完成后才由运行时插件和账本建立更新路由。
    const snapshot = await h.service.snapshot();
    expect(snapshot.items.map((item) => item.installState)).toEqual([
      'not-installed',
      'not-installed',
    ]);

    const detail = await h.service.detail(customMarketPluginId('team-lib', 'alpha'));
    await expect(
      h.service.install(customMarketPluginId('team-lib', 'alpha'), {
        expectedReleaseId: customMarketReleaseId("team-lib", "alpha", "1.0.0"),
        expectedManifest: detail.manifest,
      }),
    ).resolves.toMatchObject({ ghost: { manifest: { id: 'alpha' } } });
    expect(runtime.install).toHaveBeenCalledTimes(1);
  });

  it('lets a selected custom source install when the server catalog declares the same ghostId', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/x', id: 'server-plugin' }]);
    const h = harness([serverSummary()], [{ name: 'team-lib', dir }]);
    runtime.install.mockResolvedValue(installedGhost(root, 'server-plugin'));

    const detail = await h.service.detail(customMarketPluginId('team-lib', 'server-plugin'));
    await expect(
      h.service.install(customMarketPluginId('team-lib', 'server-plugin'), {
        expectedReleaseId: customMarketReleaseId("team-lib", "server-plugin", "1.0.0"),
        expectedManifest: detail.manifest,
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
    expect(snapshot.items.find((entry) => entry.sourceType === 'server')?.installState).toBe(
      'not-installed',
    );

    await expect(
      h.service.install(item.id, {
        expectedReleaseId: item.currentRelease.id,
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
    runtime.install.mockResolvedValue(installedGhost(root, 'alpha'));
    const pluginId = customMarketPluginId('team-lib', 'alpha');
    const detail = await h.service.detail(pluginId);

    const realList = MarketSourceStore.prototype.list;
    let reads = 0;
    const listSpy = vi.spyOn(MarketSourceStore.prototype, 'list').mockImplementation(function (
      this: MarketSourceStore,
    ) {
      reads += 1;
      return realList.call(this);
    });

    try {
      await expect(
        h.service.install(pluginId, {
          expectedReleaseId: customMarketReleaseId("team-lib", "alpha", "1.0.0"),
          expectedManifest: detail.manifest,
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
    const detail = await h.service.detail(pluginId);

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
    const installed = installedGhost(root, 'alpha');
    runtime.install.mockImplementation(async () => {
      order.push('install-entered');
      markInstallEntered();
      await installMayFinish;
      order.push('install-finished');
      return installed;
    });

    const installing = h.service.install(pluginId, {
      expectedReleaseId: customMarketReleaseId("team-lib", "alpha", "1.0.0"),
      expectedManifest: detail.manifest,
    });
    // runtime.install 只会在 beforeCommit 复核之后、SOURCE_MUTATION_KEY 仍被持有时调用。
    // 用显式 barrier 等到这个时刻，不能靠固定毫秒数猜测打包是否已经完成。
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

  it('keeps a re-added same-name source out of automatic updates but allows explicit replacement', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    // 来源 B 与当初安装用的来源 A 市场名相同(marketplace.json 自报、可复用),
    // 但指向完全不同的目录。pluginId 因此完全相同，自动更新路由必须由来源指纹区分。
    const dirB = writeLocalMarket(root, 'team-lib', [
      { rel: 'plugins/alpha', id: 'alpha', version: '2.0.0' },
    ]);
    const h = harness([], [{ name: 'team-lib', dir: dirB }]);
    const current = installedGhost(root, 'alpha', '1.0.0');
    runtime.ghosts = [current];
    runtime.install.mockResolvedValue({
      manifest: ghostManifest('alpha', '2.0.0'),
      dir: '/ghosts/replaced-alpha',
      enabled: true,
    });
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

    // 用户明确点击该条目后可以替换；成功落位后才切换后续更新路由。
    const detail = await h.service.detail(customMarketPluginId('team-lib', 'alpha'));
    await expect(
      h.service.install(customMarketPluginId('team-lib', 'alpha'), {
        expectedReleaseId: customMarketReleaseId("team-lib", "alpha", "2.0.0"),
        expectedManifest: detail.manifest,
        expectedInstalledApproval: APPROVED_INSTALL_TOKEN,
        allowSourceReplacement: true,
      }),
    ).resolves.toMatchObject({ ghost: { manifest: { version: '2.0.0' } } });
    expect(runtime.install.mock.calls[0]?.[1]).toMatchObject({
      manifestCap: ghostManifest('alpha', '2.0.0'),
    });
    expect(h.ledger.installationForGhost('alpha')).toMatchObject({
      sourceKey: marketSourceKey({ type: 'local', path: dirB }),
      version: '2.0.0',
      installed: true,
    });
  });

  it('rejects the install when the source vanishes before the commit point', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    const pluginId = customMarketPluginId('team-lib', 'alpha');
    const detail = await h.service.detail(pluginId);

    // 打包期间另一窗口移除了该来源(移除先拿 SOURCE_MUTATION_KEY 删配置,租约只
    // 保住目录字节)。用"入口发现之后 store.get 开始返回 null"精确模拟这个时序:
    // 提交点必须确认来源仍在,否则会装出一个没有对应来源的包并写孤儿账本记录。
    const realGet = MarketSourceStore.prototype.get;
    let gets = 0;
    const spy = vi.spyOn(MarketSourceStore.prototype, 'get').mockImplementation(function (
      this: MarketSourceStore,
      name: string,
    ) {
      gets += 1;
      if (gets > 1) return null;
      return realGet.call(this, name);
    });
    try {
      await expect(
        h.service.install(pluginId, {
          expectedReleaseId: customMarketReleaseId("team-lib", "alpha", "1.0.0"),
          expectedManifest: detail.manifest,
        }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(runtime.install).not.toHaveBeenCalled();
      expect(gets).toBeGreaterThan(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps a stale custom record out of automatic updates but allows explicit replacement', async () => {
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
    const installedDir = path.join(root, 'installed-replacement');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(path.join(installedDir, 'ghost.json'), JSON.stringify(replacedManifest));
    runtime.ghosts = [{ manifest: replacedManifest, dir: installedDir, enabled: true }];
    runtime.install.mockResolvedValue({
      manifest: ghostManifest('alpha', '2.0.0'),
      dir: '/ghosts/market-alpha',
      enabled: true,
    });
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

    // 列表不把它当自动更新，但用户显式选择后可以替换。
    const detail = await h.service.detail(customMarketPluginId('team-lib', 'alpha'));
    await expect(
      h.service.install(customMarketPluginId('team-lib', 'alpha'), {
        expectedReleaseId: customMarketReleaseId("team-lib", "alpha", "2.0.0"),
        expectedManifest: detail.manifest,
        expectedInstalledApproval: APPROVED_INSTALL_TOKEN,
        allowSourceReplacement: true,
      }),
    ).resolves.toMatchObject({ ghost: { manifest: { version: '2.0.0' } } });
    expect(runtime.install.mock.calls[0]?.[1]).toMatchObject({
      manifestCap: ghostManifest('alpha', '2.0.0'),
    });
    expect(h.ledger.installationForGhost('alpha')).toMatchObject({
      sourceKey: marketSourceKey({ type: 'local', path: dir }),
      version: '2.0.0',
      installed: true,
    });
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
    const spy = vi.spyOn(MarketSourceStore.prototype, 'get').mockImplementation(function (
      this: MarketSourceStore,
      name: string,
    ) {
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
    // 仍被判 complete,同 ghostId 的默认安装会在这个窗口里落位,恢复后该
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
        allowSourceReplacement: true,
      }),
    ).resolves.toMatchObject({ ghost: { manifest: { id: 'server-plugin' } } });
    expect(h.api.download).toHaveBeenCalled();
  });

  it('allows explicit official replacement when the previous custom source is unreadable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/x', id: 'server-plugin' }]);
    const h = harness([serverSummary()], [{ name: 'team-lib', dir }]);
    const current = installedGhost(root, 'server-plugin');
    runtime.ghosts = [current];
    runtime.install.mockResolvedValue({
      manifest: ghostManifest('server-plugin'),
      dir: '/ghosts/official-server-plugin',
      enabled: true,
    });
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
    h.api.download.mockResolvedValue({
      url: 'https://downloads.test.invalid/plugin.cindy',
      expiresAt: '2099-01-01T00:00:00.000Z',
      sha256: 'a'.repeat(64),
      sizeBytes: 42,
    });
    await expect(
      h.service.install(item.id, {
        expectedReleaseId: item.currentRelease.id,
        expectedInstalledApproval: APPROVED_INSTALL_TOKEN,
        allowSourceReplacement: true,
      }),
    ).resolves.toMatchObject({ ghost: { manifest: { id: 'server-plugin' } } });
    expect(runtime.install.mock.calls[0]?.[1]).toMatchObject({
      manifestCap: ghostManifest('server-plugin'),
    });
    expect(h.ledger.installationForGhost('server-plugin')).toMatchObject({
      pluginId: item.id,
      source: 'market',
      installed: true,
    });
  });

  it('recovers a lost ledger write through an explicit install without automatic adoption', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-fixture-'));
    roots.push(root);
    const dir = writeLocalMarket(root, 'team-lib', [{ rel: 'plugins/alpha', id: 'alpha' }]);
    const h = harness([], [{ name: 'team-lib', dir }]);
    // 场景:包已落位,但溯源账本里没有记录。即使运行时内容与来源候选
    // 完全一致，也不能据此自动推断后续更新来源。
    const installedDir = path.join(root, 'installed-alpha');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(path.join(installedDir, 'ghost.json'), JSON.stringify(ghostManifest('alpha')));
    runtime.ghosts = [{ manifest: ghostManifest('alpha'), dir: installedDir, enabled: true }];
    runtime.install.mockResolvedValue({
      manifest: ghostManifest('alpha'),
      dir: '/ghosts/recovered-alpha',
      enabled: true,
    });
    // 列表不根据内容相同自动推断来源；用户显式点击后可以原位恢复路由。
    const snapshot = await h.service.snapshot();
    expect(snapshot.items[0]?.installState).toBe('conflict');

    const detail = await h.service.detail(customMarketPluginId('team-lib', 'alpha'));
    await expect(
      h.service.install(customMarketPluginId('team-lib', 'alpha'), {
        expectedReleaseId: customMarketReleaseId("team-lib", "alpha", "1.0.0"),
        expectedManifest: detail.manifest,
        expectedInstalledApproval: APPROVED_INSTALL_TOKEN,
        allowSourceReplacement: true,
      }),
    ).resolves.toMatchObject({ ghost: { manifest: { id: 'alpha' } } });
    expect(runtime.install.mock.calls[0]?.[1]).toMatchObject({
      manifestCap: ghostManifest('alpha'),
    });
    expect(h.ledger.installationForGhost('alpha')).toMatchObject({
      pluginId: customMarketPluginId('team-lib', 'alpha'),
      source: 'local-market',
      installed: true,
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
    expect(source).toMatch(/readInstalledGhostManifest/);
  });
});

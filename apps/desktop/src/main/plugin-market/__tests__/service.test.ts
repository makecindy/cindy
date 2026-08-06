import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  diffGhostPermissionItems,
  ghostPermissionBaselineKey,
} from '../../../shared/ghost.js';

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
  isBuiltinGhostRemovedByUser: (id: string) => runtime.builtinRemoved.has(id),
  uninstallGhostAndCleanup: runtime.uninstall,
}));
vi.mock('../download.js', () => ({
  downloadVerifiedPlugin: vi.fn(async () => undefined),
}));

import type {
  PluginRemovalNotice,
  VisiblePluginDetail,
  VisiblePluginSummary,
} from '@cindy/plugin-protocol';

import { withGhostInstallLock } from '../../cindy-brain/ghostInstallLock';
import { GhostPackagePermissionReviewRequiredError } from '../../cindy-brain/packagePermissionReview';
import {
  PluginMarketLedger,
  ghostManifestDigest,
  type PluginMarketInstallationRecord,
} from '../ledger';
import { PluginMarketService } from '../service';
import type { PluginMarketApi } from '../api';

const roots: string[] = [];
const PLUGIN_ID = `c${'a'.repeat(24)}`;

/** 手动可控 deferred,用于精确编排"安装在飞行中"的交错。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  runtime.ghosts = [];
  runtime.install.mockReset();
  runtime.uninstall.mockReset();
  runtime.builtinRemoved.clear();
  runtime.accountGhostAvailable = true;
  runtime.boundaryPending = false;
  runtime.pluginApiBaseUrl = 'https://plugin.test.invalid';
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

function reviewedInstallOptions(item: VisiblePluginSummary) {
  return {
    expectedReleaseId: item.currentRelease.id,
    expectedManifest: manifest(item.ghostId, item.currentRelease.version),
  };
}

function removal(
  overrides: Partial<PluginRemovalNotice> = {},
): PluginRemovalNotice {
  return {
    pluginId: PLUGIN_ID,
    ghostId: 'cindy-test',
    scope: 'organization',
    organizationId: 'org-1',
    action: 'purge',
    removedAt: '2026-08-03T08:00:00.000Z',
    ...overrides,
  };
}

function harness(
  items: VisiblePluginSummary[],
  removals: PluginRemovalNotice[] = [],
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-plugin-service-'));
  roots.push(root);
  const ledger = new PluginMarketLedger(path.join(root, 'ledger.json'));
  const api = {
    listAll: vi.fn(async () => ({ plugins: items, removals })),
    detail: vi.fn(async (pluginId: string) => {
      const item = items.find((candidate) => candidate.id === pluginId);
      if (!item) throw new Error('not found');
      return {
        ...item,
        currentRelease: {
          ...item.currentRelease,
          manifest: manifest(item.ghostId, item.currentRelease.version),
        },
      } satisfies VisiblePluginDetail;
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

/** 清理通告测试的组织安装记录（统一账本 factory 的 organization 视图）。 */
function removalRecord(
  overrides: Partial<PluginMarketInstallationRecord> = {},
): PluginMarketInstallationRecord {
  return recordForTest(
    summary({ scope: 'organization', organizationId: 'org-1' }),
    overrides,
  );
}

/** 清理通告测试的运行时 Ghost 目录项。 */
function ghostEntry(id: string, name?: string) {
  return {
    manifest: name === undefined ? manifest(id) : { ...manifest(id), name },
    dir: `/userData/cindy-brain/${id}`,
    enabled: true,
  };
}

/** uninstall mock 真的把 Ghost 从运行时目录拿走；failFor 指定的那条抛错。 */
function mockUninstallDropsGhost(failFor?: string): void {
  runtime.uninstall.mockImplementation(async (ghostId: string) => {
    if (ghostId === failFor) throw new Error('cleanup failed');
    runtime.ghosts = runtime.ghosts.filter((ghost) => ghost.manifest.id !== ghostId);
  });
}

describe('PluginMarketService migration and defaultInstall', () => {
  it('projects same-release display metadata without reinstalling the package', async () => {
    runtime.ghosts = [
      {
        manifest: manifest(),
        dir: '/userData/cindy-brain/cindy-test',
        enabled: false,
      },
    ];
    const item = summary({
      name: 'Renamed Plugin',
      description: 'Updated market description',
      author: 'Updated Publisher',
    });
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
      updatedAt: '2026-07-27T00:00:00.000Z',
    });

    await expect(h.service.snapshot()).resolves.toMatchObject({
      items: [
        {
          name: 'Renamed Plugin',
          description: 'Updated market description',
          author: 'Updated Publisher',
          releaseId: 'release-1',
          version: '1.0.0',
          installState: 'installed',
          enabled: false,
        },
      ],
      unavailableReason: null,
    });
    expect(runtime.install).not.toHaveBeenCalled();
  });

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

  it('shows only public market plugins in account-free local mode', async () => {
    runtime.session = {
      mode: 'local',
      dataOwnerId: 'local-v1',
      generation: 2,
    };
    const publicPlugin = summary();
    const organizationPlugin = summary({
      id: `c${'b'.repeat(24)}`,
      ghostId: 'cindy-team-only',
      scope: 'organization',
      organizationId: 'org-1',
    });
    const h = harness([publicPlugin, organizationPlugin]);

    await expect(h.service.snapshot()).resolves.toMatchObject({
      items: [{ pluginId: publicPlugin.id, scope: 'public' }],
      unavailableReason: null,
    });
    expect(h.api.listAll).toHaveBeenCalledTimes(1);
  });

  it('keeps signed-out sessions out of the market until an owner is selected', async () => {
    runtime.session = {
      mode: 'signed-out',
      dataOwnerId: null,
      generation: 2,
    };
    const h = harness([summary()]);

    await expect(h.service.snapshot()).resolves.toEqual({
      items: [],
      unavailableReason: 'authentication-required',
      customSourceNames: [],
    });
    expect(h.api.listAll).not.toHaveBeenCalled();
  });

  it('reports missing market configuration before requiring authentication', async () => {
    runtime.pluginApiBaseUrl = null;
    runtime.session = {
      mode: 'signed-out',
      dataOwnerId: null,
      generation: 2,
    };
    const h = harness([summary()]);

    await expect(h.service.snapshot()).resolves.toEqual({
      items: [],
      unavailableReason: 'not-configured',
      customSourceNames: [],
    });
    expect(h.api.listAll).not.toHaveBeenCalled();
  });

  it('uses a switching reason while the account boundary is pending', async () => {
    runtime.boundaryPending = true;
    const h = harness([summary()]);

    await expect(h.service.snapshot()).resolves.toEqual({
      items: [],
      unavailableReason: 'session-switching',
      customSourceNames: [],
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
      installState: 'update-available',
      enabled: true,
    });
    expect(h.ledger.installationForGhost('cindy-test')).toMatchObject({
      source: 'legacy-adopted',
      pluginId: PLUGIN_ID,
      releaseId: 'legacy-unresolved:1.0.0',
      sha256: 'legacy-unverified',
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
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-market-installed-'));
    roots.push(installDir);
    fs.writeFileSync(path.join(installDir, 'ghost.json'), JSON.stringify(manifest()));
    runtime.install.mockImplementation(async () => {
      const ghost = {
        manifest: manifest(),
        dir: installDir,
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
        reviewedManifest: manifest(),
      },
    );
    expect(snapshot.items[0]).toMatchObject({
      installState: 'installed',
      enabled: true,
    });
    expect(h.ledger.installationForGhost('cindy-test')).toMatchObject({
      source: 'market',
      releaseId: 'release-1',
      manifestDigest: ghostManifestDigest(manifest()),
    });
  });

  it('does not auto-install a default package with permissions absent from its catalog manifest', async () => {
    const item = summary({ defaultInstall: true });
    runtime.install.mockRejectedValueOnce(
      new GhostPackagePermissionReviewRequiredError({
        manifest: manifest(item.ghostId, item.currentRelease.version, ['notify', 'fs']),
        permissionDiff: null,
        packageSha256: item.currentRelease.sha256,
        installedBaseline: null,
      }),
    );
    const h = harness([item]);

    const snapshot = await h.service.snapshot();

    expect(runtime.install).toHaveBeenCalledWith(
      expect.stringMatching(/\.cindy$/),
      expect.objectContaining({ reviewedManifest: manifest() }),
    );
    expect(snapshot.items[0]?.installState).toBe('not-installed');
    expect(h.ledger.installationForGhost(item.ghostId)).toBeNull();
  });

  it('does not infer historical provenance from the server manifest', async () => {
    const item = summary({ scope: 'organization', organizationId: 'org-1' });
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-market-installed-'));
    roots.push(installDir);
    fs.writeFileSync(path.join(installDir, 'ghost.json'), JSON.stringify(manifest()));
    runtime.ghosts = [{ manifest: manifest(), dir: installDir, enabled: true }];
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
      updatedAt: '2026-07-27T00:00:00.000Z',
    });

    await h.service.snapshot();

    expect(h.ledger.installationForGhost(item.ghostId)?.manifestDigest).toBeUndefined();
  });

  // 2026-07-26 定案:市场首装一律装完即开,手动安装与 defaultInstall 归一,
  // 不再向装入入口透传 initiallyEnabled(启用语义收敛在市场装入入口本身)。
  it('manual market install goes through the auto-enable install entry', async () => {
    const item = summary();
    runtime.install.mockResolvedValue({
      manifest: manifest(),
      dir: '/userData/cindy-brain/cindy-test',
      enabled: true,
    });
    const h = harness([item]);

    const { ghost } = await h.service.install(item.id, reviewedInstallOptions(item));

    expect(runtime.install).toHaveBeenCalledWith(
      expect.stringMatching(/\.cindy$/),
      {
        ghostId: 'cindy-test',
        version: '1.0.0',
        reviewedManifest: manifest(),
      },
    );
    // 锁定装完即开的最终结果:装入入口返回的 ghost 必须是启用态。
    expect(ghost?.enabled).toBe(true);
  });

  it('passes the reviewed server manifest to the package verification boundary', async () => {
    const item = summary();
    runtime.install.mockResolvedValue({
      manifest: manifest(),
      dir: '/userData/cindy-brain/cindy-test',
      enabled: true,
    });
    const h = harness([item]);

    await h.service.install(item.id, reviewedInstallOptions(item));

    expect(runtime.install.mock.calls[0]?.[1]).toMatchObject({
      reviewedManifest: manifest(),
    });
  });

  it('pauses one install transaction for package review and reuses the download', async () => {
    const item = summary();
    const review = {
      manifest: manifest('cindy-test', '1.0.0', ['notify', 'fs']),
      permissionDiff: null,
      packageSha256: 'a'.repeat(64),
      installedBaseline: null,
    };
    runtime.install
      .mockRejectedValueOnce(new GhostPackagePermissionReviewRequiredError(review))
      .mockResolvedValueOnce({
        manifest: manifest(),
        dir: '/userData/cindy-brain/cindy-test',
        enabled: true,
      });
    const h = harness([item]);
    const confirmReview = vi.fn(async () => true);

    await expect(
      h.service.install(item.id, reviewedInstallOptions(item), confirmReview),
    ).resolves.toMatchObject({ ghost: { manifest: { id: item.ghostId } } });
    expect(confirmReview).toHaveBeenCalledWith(review);
    expect(h.api.download).toHaveBeenCalledTimes(1);
    expect(runtime.install).toHaveBeenLastCalledWith(
      expect.stringMatching(/\.cindy$/),
      expect.objectContaining({
        reviewedManifest: manifest(),
        approvedPackageSha256: review.packageSha256,
      }),
    );
  });

  it('does not return package review details after the active owner changes', async () => {
    const item = summary();
    const review = {
      manifest: manifest('cindy-test', '1.0.0', ['notify', 'fs']),
      permissionDiff: null,
      packageSha256: 'a'.repeat(64),
      installedBaseline: null,
    };
    runtime.install.mockImplementationOnce(async () => {
      runtime.session = {
        mode: 'cloud',
        dataOwnerId: 'user-2',
        generation: 2,
      };
      throw new GhostPackagePermissionReviewRequiredError(review);
    });
    const h = harness([item]);

    await expect(
      h.service.install(item.id, reviewedInstallOptions(item)),
    ).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(h.ledger.installationForGhost(item.ghostId)).toBeNull();
  });

  it('uses the installed raw manifest as the package permission baseline', async () => {
    const item = summary({
      currentRelease: { ...summary().currentRelease, id: 'release-2', version: '2.0.0' },
    });
    const installed = manifest(item.ghostId, '1.0.0', ['notify', 'fs']);
    const installedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-installed-ghost-'));
    roots.push(installedDir);
    fs.writeFileSync(path.join(installedDir, 'ghost.json'), JSON.stringify(installed));
    runtime.ghosts = [
      {
        manifest: { ...installed, name: 'Localized Test Plugin' },
        dir: installedDir,
        enabled: true,
      },
    ];
    runtime.install.mockResolvedValue({
      manifest: manifest(item.ghostId, '2.0.0', ['notify', 'fs']),
      dir: '/userData/cindy-brain/cindy-test',
      enabled: true,
    });
    const h = harness([item]);
    h.ledger.upsertInstallation({
      ...recordForTest(item),
      releaseId: 'release-1',
      version: '1.0.0',
      manifestDigest: ghostManifestDigest(installed),
    });

    await h.service.install(item.id, reviewedInstallOptions(item));

    expect(runtime.install.mock.calls[0]?.[1]).toMatchObject({
      permissionBaselineManifest: installed,
    });
  });

  it('does not let a stale official record claim a locally changed package', async () => {
    const item = summary({
      currentRelease: { ...summary().currentRelease, id: 'release-2', version: '2.0.0' },
    });
    const installed = manifest(item.ghostId, '1.0.0', ['notify', 'fs']);
    const installedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-installed-ghost-'));
    roots.push(installedDir);
    fs.writeFileSync(path.join(installedDir, 'ghost.json'), JSON.stringify(installed));
    runtime.ghosts = [{ manifest: installed, dir: installedDir, enabled: true }];
    const h = harness([item]);
    h.ledger.upsertInstallation({
      ...recordForTest(item),
      releaseId: 'release-1',
      version: '1.0.0',
      manifestDigest: ghostManifestDigest({ ...installed, slots: ['notify'] }),
    });

    expect((await h.service.snapshot()).items[0]?.installState).toBe('conflict');
    await expect(
      h.service.install(item.id, reviewedInstallOptions(item)),
    ).rejects.toThrow('[ALREADY_EXISTS]');
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('does not trust an installed manifest as the permission baseline without a digest', async () => {
    const item = summary({
      currentRelease: { ...summary().currentRelease, id: 'release-2', version: '2.0.0' },
    });
    const installed = manifest(item.ghostId, '1.0.0', ['notify', 'fs']);
    const installedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-installed-ghost-'));
    roots.push(installedDir);
    fs.writeFileSync(path.join(installedDir, 'ghost.json'), JSON.stringify(installed));
    runtime.ghosts = [{ manifest: installed, dir: installedDir, enabled: true }];
    runtime.install.mockResolvedValue({
      manifest: manifest(item.ghostId, '2.0.0', ['notify']),
      dir: '/userData/cindy-brain/cindy-test',
      enabled: true,
    });
    const h = harness([item]);
    h.ledger.upsertInstallation({
      ...recordForTest(item),
      source: 'legacy-adopted',
      releaseId: 'legacy-unresolved:1.0.0',
      version: '1.0.0',
    });

    await h.service.install(item.id, reviewedInstallOptions(item));

    expect(runtime.install.mock.calls[0]?.[1]).not.toHaveProperty('permissionBaselineManifest');
  });

  it('installs and enables a public defaultInstall package in local mode', async () => {
    runtime.session = {
      mode: 'local',
      dataOwnerId: 'local-v1',
      generation: 2,
    };
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
        ghostId: item.ghostId,
        version: item.currentRelease.version,
        reviewedManifest: manifest(),
      },
    );
    expect(snapshot.items[0]).toMatchObject({
      installState: 'installed',
      enabled: true,
    });
  });

  it('installs a public market plugin in account-free local mode', async () => {
    runtime.session = {
      mode: 'local',
      dataOwnerId: 'local-v1',
      generation: 2,
    };
    const item = summary();
    runtime.install.mockResolvedValue({
      manifest: manifest(),
      dir: '/userData/cindy-brain/cindy-test',
      enabled: false,
    });
    const h = harness([item]);

    await expect(h.service.install(item.id, reviewedInstallOptions(item))).resolves.toMatchObject({
      ghost: { manifest: { id: 'cindy-test' }, enabled: false },
    });
    expect(h.api.download).toHaveBeenCalledWith(item.id, item.currentRelease.id);
    expect(h.ledger.installationForGhost(item.ghostId)).toMatchObject({
      pluginId: item.id,
      installed: true,
    });
  });

  it('服务端安装持 ghostId 锁,覆盖落位到溯源写入整段', async () => {
    // 少了这把锁,本地 .cindy 装入能在包检查窗口里落入同 id 的包,随后被本次安装
    // 当作更新目标覆盖;账本写入若在锁外,本地装入还能插在"落位"与"写溯源"之间,
    // 让账本认领一个已被替换的包(账本摘要若未对上当前安装内容,投影不会认领)。
    // 这里用真实的 withGhostInstallLock(service 直接 import,未被 mock)观察:
    // 安装在飞行中时,外部同 id 请求必须进不来;账本已写入后才放行。
    const item = summary();
    const h = harness([item]);
    const installGate = deferred();
    runtime.install.mockImplementation(async () => {
      await installGate.promise;
      return { manifest: manifest(), dir: '/userData/cindy-brain/cindy-test', enabled: true };
    });

    const order: string[] = [];
    const installing = h.service.install(item.id, reviewedInstallOptions(item));
    // 等安装推进到持锁并阻塞在 runtime.install 上。
    await vi.waitFor(() => expect(runtime.install).toHaveBeenCalled());
    const outsider = withGhostInstallLock(item.ghostId, async () => {
      // 进入临界区的那一刻,账本必须已经写完(写入在锁内)。
      order.push(
        h.ledger.installationForGhost(item.ghostId)?.installed === true
          ? 'outsider:ledger-written'
          : 'outsider:ledger-missing',
      );
    });
    await Promise.resolve();
    // 安装仍持锁(阻塞在落位上):外部同 id 请求不得进入。
    expect(order).toEqual([]);
    installGate.resolve();
    await Promise.all([installing, outsider]);
    // 进入时看到的是"账本已写",而不是"包已落位但溯源还没写"的中间态。
    expect(order).toEqual(['outsider:ledger-written']);
  });

  it('rejects a non-public plugin returned to account-free local mode', async () => {
    runtime.session = {
      mode: 'local',
      dataOwnerId: 'local-v1',
      generation: 2,
    };
    const item = summary({
      scope: 'organization',
      organizationId: 'org-1',
    });
    const h = harness([item]);

    await expect(h.service.install(item.id, reviewedInstallOptions(item))).rejects.toThrow('[NOT_FOUND]');
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('hides account-managed public plugins from account-free local mode', async () => {
    runtime.session = {
      mode: 'local',
      dataOwnerId: 'local-v1',
      generation: 2,
    };
    const item = summary({ ghostId: 'cindy-github' });
    runtime.accountGhostAvailable = false;
    const h = harness([item]);

    await expect(h.service.snapshot()).resolves.toEqual({
      items: [],
      unavailableReason: null,
      customSourceNames: [],
    });
    expect(h.api.listAll).toHaveBeenCalledOnce();
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

  it('records local-mode defaultInstall opt-out under the local owner', async () => {
    runtime.session = {
      mode: 'local',
      dataOwnerId: 'local-v1',
      generation: 2,
    };
    const item = summary({ defaultInstall: true });
    const h = harness([item]);
    h.ledger.upsertInstallation(recordForTest(item));

    const complete = h.service.prepareLocalUninstallTracking(item.ghostId);

    expect(complete).not.toBeNull();
    await complete?.();
    expect(h.ledger.installationForGhost(item.ghostId)?.installed).toBe(false);
    expect(h.ledger.isDefaultInstallSuppressed('local-v1', item.id)).toBe(true);
  });

  it('records a local uninstall opt-out for the captured owner after an account switch', async () => {
    const item = summary({ defaultInstall: true });
    const h = harness([item]);
    h.ledger.upsertInstallation(recordForTest(item));
    const complete = h.service.prepareLocalUninstallTracking(item.ghostId);

    runtime.session = {
      mode: 'cloud',
      dataOwnerId: 'user-2',
      generation: 2,
    };

    await expect(complete?.()).resolves.toBeUndefined();
    expect(h.ledger.installationForGhost(item.ghostId)?.installed).toBe(false);
    expect(h.ledger.isDefaultInstallSuppressed('user-1', item.id)).toBe(true);
    expect(h.ledger.isDefaultInstallSuppressed('user-2', item.id)).toBe(false);
  });

  it('does not attach local uninstall tracking without a stable owner', () => {
    runtime.session = {
      mode: 'signed-out',
      dataOwnerId: null,
      generation: 2,
    };
    const h = harness([summary()]);

    expect(h.service.prepareLocalUninstallTracking('cindy-test')).toBeNull();
  });

  it.each(['market', 'legacy-adopted'] as const)(
    'purges an installed organization plugin owned by the %s source without opting out',
    async (source) => {
      const notice = removal();
      const h = harness([], [notice]);
      runtime.ghosts = [ghostEntry(notice.ghostId)];
      mockUninstallDropsGhost();
      h.ledger.upsertInstallation(removalRecord({ source }));

      await expect(h.service.snapshot()).resolves.toMatchObject({
        unavailableReason: null,
      });

      expect(runtime.uninstall).toHaveBeenCalledWith(notice.ghostId, {
        skipMarketLedger: true,
      });
      expect(h.ledger.installationForGhost(notice.ghostId)?.installed).toBe(false);
      expect(h.ledger.isDefaultInstallSuppressed('user-1', notice.pluginId)).toBe(false);
      expect(h.service.consumeRemovalNotice()).toEqual({
        count: 1,
        name: 'Test Plugin',
      });
    },
  );

  it('purges when the ledger provenance digest matches the installed package', async () => {
    const notice = removal();
    const h = harness([], [notice]);
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-market-installed-'));
    roots.push(installDir);
    fs.writeFileSync(path.join(installDir, 'ghost.json'), JSON.stringify(manifest()));
    runtime.ghosts = [{ ...ghostEntry(notice.ghostId), dir: installDir }];
    mockUninstallDropsGhost();
    h.ledger.upsertInstallation(
      removalRecord({ manifestDigest: ghostManifestDigest(manifest()) }),
    );

    await expect(h.service.snapshot()).resolves.toMatchObject({
      unavailableReason: null,
    });

    expect(runtime.uninstall).toHaveBeenCalledWith(notice.ghostId, {
      skipMarketLedger: true,
    });
    expect(h.ledger.installationForGhost(notice.ghostId)?.installed).toBe(false);
    expect(h.service.consumeRemovalNotice()).toEqual({
      count: 1,
      name: 'Test Plugin',
    });
  });

  it.each([
    ['missing ledger record', null],
    ['different pluginId', removalRecord({ pluginId: `c${'b'.repeat(24)}` })],
    [
      'git marketplace source',
      removalRecord({ source: 'git-market', sourceKey: '["git","repo"]' }),
    ],
    [
      'local marketplace source',
      removalRecord({ source: 'local-market', sourceKey: '["local","dir"]' }),
    ],
    ['already removed record', removalRecord({ installed: false })],
    ['public scope record', removalRecord({ scope: 'public', organizationId: null })],
    // 记录带溯源摘要但运行时包对不上(此处 ghost.json 不可读=摘要 null):占位的
    // 已不是市场装的那份包,按 fail-closed 口径不删。
    ['stale manifest digest', removalRecord({ manifestDigest: 'f'.repeat(64) })],
  ] as const)(
    'skips a server removal with %s without touching the ledger',
    async (_label, record) => {
      const notice = removal();
      const h = harness([], [notice]);
      runtime.ghosts = [ghostEntry(notice.ghostId)];
      if (record) h.ledger.upsertInstallation(record);
      const before = h.ledger.read();

      await expect(h.service.snapshot()).resolves.toMatchObject({
        unavailableReason: null,
      });

      expect(runtime.uninstall).not.toHaveBeenCalled();
      expect(h.ledger.read()).toEqual(before);
      expect(h.service.consumeRemovalNotice()).toBeNull();
    },
  );

  it('skips a removal whose action is not purge without touching the ledger', async () => {
    // 协议层已滤掉未知 action;这里锁的是 service 兜底(验收点 6):万一有
    // 非 purge 通告穿透,零卸载、零账本写入、零通知。
    const notice = removal({
      action: 'quarantine' as unknown as PluginRemovalNotice['action'],
    });
    const h = harness([], [notice]);
    runtime.ghosts = [ghostEntry(notice.ghostId)];
    h.ledger.upsertInstallation(removalRecord());
    const before = h.ledger.read();

    await expect(h.service.snapshot()).resolves.toMatchObject({
      unavailableReason: null,
    });

    expect(runtime.uninstall).not.toHaveBeenCalled();
    expect(h.ledger.read()).toEqual(before);
    expect(h.service.consumeRemovalNotice()).toBeNull();
  });

  it('keeps an existing default-install opt-out when a repeated purge is skipped', async () => {
    const notice = removal();
    const h = harness([], [notice]);
    h.ledger.upsertInstallation(removalRecord());
    h.ledger.markRemoved(notice.ghostId, 'user-1');

    await h.service.snapshot();

    expect(runtime.uninstall).not.toHaveBeenCalled();
    expect(h.ledger.isDefaultInstallSuppressed('user-1', notice.pluginId)).toBe(true);
    expect(h.service.consumeRemovalNotice()).toBeNull();
  });

  it('keeps a pre-existing opt-out intact after a successful purge', async () => {
    // 退订只读的另一半(不清):早先手动卸载写过退订、之后又重新安装的用户,
    // purge 成功后退订必须原样保留,穿越重新上架周期继续生效。
    const notice = removal();
    const h = harness([], [notice]);
    runtime.ghosts = [ghostEntry(notice.ghostId)];
    mockUninstallDropsGhost();
    h.ledger.upsertInstallation(removalRecord());
    h.ledger.markRemoved(notice.ghostId, 'user-1');
    h.ledger.upsertInstallation(removalRecord());

    await h.service.snapshot();

    expect(runtime.uninstall).toHaveBeenCalledTimes(1);
    expect(h.ledger.installationForGhost(notice.ghostId)?.installed).toBe(false);
    expect(h.ledger.isDefaultInstallSuppressed('user-1', notice.pluginId)).toBe(true);
    expect(h.service.consumeRemovalNotice()).toEqual({ count: 1, name: 'Test Plugin' });
  });

  it('applies a repeated removal only once across snapshots', async () => {
    const notice = removal();
    const h = harness([], [notice]);
    runtime.ghosts = [ghostEntry(notice.ghostId)];
    mockUninstallDropsGhost();
    h.ledger.upsertInstallation(removalRecord());

    await h.service.snapshot();
    expect(h.service.consumeRemovalNotice()).toEqual({ count: 1, name: 'Test Plugin' });
    await h.service.snapshot();

    expect(runtime.uninstall).toHaveBeenCalledTimes(1);
    expect(h.service.consumeRemovalNotice()).toBeNull();
  });

  it('purges a batch and exposes one combined user notice', async () => {
    const secondPluginId = `c${'b'.repeat(24)}`;
    const notices = [
      removal(),
      removal({ pluginId: secondPluginId, ghostId: 'cindy-second' }),
    ];
    const h = harness([], notices);
    runtime.ghosts = [
      ghostEntry('cindy-test'),
      ghostEntry('cindy-second', 'Second Plugin'),
    ];
    mockUninstallDropsGhost();
    h.ledger.upsertInstallation(removalRecord());
    h.ledger.upsertInstallation(
      removalRecord({ pluginId: secondPluginId, ghostId: 'cindy-second' }),
    );

    await h.service.snapshot();

    expect(runtime.uninstall).toHaveBeenCalledTimes(2);
    expect(h.service.consumeRemovalNotice()).toEqual({ count: 2, name: null });
  });

  it('keeps a pending removal notice isolated to the owner that was cleaned', async () => {
    const notice = removal();
    const h = harness([], [notice]);
    runtime.ghosts = [ghostEntry(notice.ghostId)];
    mockUninstallDropsGhost();
    h.ledger.upsertInstallation(removalRecord());

    await h.service.snapshot();
    runtime.session = {
      mode: 'cloud',
      dataOwnerId: 'user-2',
      generation: 2,
    };
    expect(h.service.consumeRemovalNotice()).toBeNull();
    runtime.session = {
      mode: 'cloud',
      dataOwnerId: 'user-1',
      generation: 3,
    };
    expect(h.service.consumeRemovalNotice()).toEqual({
      count: 1,
      name: 'Test Plugin',
    });
    // 一次即清:同 owner 紧接着再取必须为空,不会重复弹窗。
    expect(h.service.consumeRemovalNotice()).toBeNull();
  });

  it('still counts a successful removal when the safe display name becomes empty', async () => {
    const notice = removal();
    const h = harness([], [notice]);
    runtime.ghosts = [ghostEntry(notice.ghostId, '\u202e')];
    mockUninstallDropsGhost();
    h.ledger.upsertInstallation(removalRecord());

    await h.service.snapshot();

    expect(h.service.consumeRemovalNotice()).toEqual({ count: 1, name: null });
  });

  it('continues the snapshot and later removals when one purge fails', async () => {
    const secondPluginId = `c${'b'.repeat(24)}`;
    const notices = [
      removal(),
      removal({ pluginId: secondPluginId, ghostId: 'cindy-second' }),
    ];
    const h = harness([], notices);
    runtime.ghosts = [
      ghostEntry('cindy-test'),
      ghostEntry('cindy-second', 'Second Plugin'),
    ];
    mockUninstallDropsGhost('cindy-test');
    h.ledger.upsertInstallation(removalRecord());
    h.ledger.upsertInstallation(
      removalRecord({ pluginId: secondPluginId, ghostId: 'cindy-second' }),
    );

    await expect(h.service.snapshot()).resolves.toMatchObject({
      unavailableReason: null,
    });

    expect(runtime.uninstall).toHaveBeenCalledTimes(2);
    expect(h.ledger.installationForGhost('cindy-test')?.installed).toBe(true);
    expect(h.ledger.installationForGhost('cindy-second')?.installed).toBe(false);
    expect(h.service.consumeRemovalNotice()).toEqual({
      count: 1,
      name: 'Second Plugin',
    });
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

  it('treats a removed market record plus an existing directory as an id conflict', async () => {
    const item = summary();
    runtime.ghosts = [
      {
        manifest: manifest(),
        dir: '/userData/cindy-brain/cindy-test',
        enabled: true,
      },
    ];
    const h = harness([item]);
    h.ledger.upsertInstallation({
      ...recordForTest(item),
      installed: false,
    });

    await expect(h.service.install(item.id, reviewedInstallOptions(item))).rejects.toThrow('[ALREADY_EXISTS]');
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('does not overwrite a local plugin that appears while an official package downloads', async () => {
    const item = summary();
    const h = harness([item]);
    h.api.download.mockImplementationOnce(async () => {
      runtime.ghosts = [
        {
          manifest: manifest(),
          dir: '/userData/cindy-brain/cindy-test',
          enabled: true,
        },
      ];
      return {
        url: 'https://downloads.test.invalid/plugin.cindy',
        expiresAt: '2099-01-01T00:00:00.000Z',
        sha256: 'a'.repeat(64),
        sizeBytes: 42,
      };
    });

    await expect(
      h.service.install(item.id, reviewedInstallOptions(item)),
    ).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(runtime.install).not.toHaveBeenCalled();
    expect(h.ledger.installationForGhost(item.ghostId)).toBeNull();
  });

  it('continues the same update transaction after real-package approval', async () => {
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
    const targetManifest = manifest('cindy-test', '2.0.0', ['notify', 'fs']);
    const review = {
      manifest: targetManifest,
      permissionDiff: diffGhostPermissionItems(manifest(), targetManifest),
      packageSha256: 'a'.repeat(64),
      installedBaseline: ghostPermissionBaselineKey(manifest()),
    };
    runtime.install
      .mockRejectedValueOnce(new GhostPackagePermissionReviewRequiredError(review))
      .mockResolvedValueOnce({
        manifest: review.manifest,
        dir: '/userData/cindy-brain/cindy-test',
        enabled: true,
      });
    const h = harness([item]);
    h.ledger.upsertInstallation({
      ...recordForTest(item),
      releaseId: 'release-1',
      version: '1.0.0',
    });

    const confirmReview = vi.fn(async () => true);
    await expect(
      h.service.install(item.id, reviewedInstallOptions(item), confirmReview),
    ).resolves.toMatchObject({
      ghost: { manifest: { version: '2.0.0' } },
    });
    expect(confirmReview).toHaveBeenCalledWith(review);
    expect(h.api.download).toHaveBeenCalledTimes(1);
    expect(runtime.install).toHaveBeenCalledTimes(2);
  });

  it('cancels the current transaction when real-package approval is declined', async () => {
    const item = summary({
      currentRelease: { ...summary().currentRelease, id: 'release-2', version: '2.0.0' },
    });
    runtime.ghosts = [
      {
        manifest: manifest(),
        dir: '/userData/cindy-brain/cindy-test',
        enabled: true,
      },
    ];
    const review = {
      manifest: manifest('cindy-test', '2.0.0', ['notify', 'fs']),
      permissionDiff: diffGhostPermissionItems(
        manifest(),
        manifest('cindy-test', '2.0.0', ['notify', 'fs']),
      ),
      packageSha256: 'a'.repeat(64),
      installedBaseline: ghostPermissionBaselineKey(manifest()),
    };
    runtime.install.mockRejectedValueOnce(
      new GhostPackagePermissionReviewRequiredError(review),
    );
    const h = harness([item]);
    h.ledger.upsertInstallation({ ...recordForTest(item), releaseId: 'release-1', version: '1.0.0' });

    await expect(
      h.service.install(item.id, reviewedInstallOptions(item), async () => false),
    ).resolves.toEqual({ cancelled: true });
    expect(h.api.download).toHaveBeenCalledTimes(1);
    expect(runtime.install).toHaveBeenCalledTimes(1);
  });

  it('does not trust the current installed package without a digest after download', async () => {
    const item = summary({
      currentRelease: { ...summary().currentRelease, id: 'release-2', version: '2.0.0' },
    });
    const reviewedInstalled = manifest('cindy-test', '1.0.0', ['notify', 'fs']);
    const currentInstalled = manifest('cindy-test', '1.0.0', ['notify']);
    const installedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-installed-ghost-'));
    roots.push(installedDir);
    fs.writeFileSync(path.join(installedDir, 'ghost.json'), JSON.stringify(currentInstalled));
    runtime.ghosts = [
      { manifest: reviewedInstalled, dir: '/userData/cindy-brain/cindy-test', enabled: true },
    ];
    runtime.install.mockResolvedValue({
      manifest: manifest('cindy-test', '2.0.0', ['notify', 'fs']),
      dir: '/userData/cindy-brain/cindy-test',
      enabled: true,
    });
    const downloadMock = vi.mocked(
      (await import('../download.js')).downloadVerifiedPlugin,
    );
    downloadMock.mockImplementationOnce(async () => {
      runtime.ghosts = [
        { manifest: currentInstalled, dir: installedDir, enabled: true },
      ];
    });
    const h = harness([item]);
    h.ledger.upsertInstallation({ ...recordForTest(item), releaseId: 'release-1', version: '1.0.0' });
    await expect(
      h.service.install(item.id, reviewedInstallOptions(item)),
    ).resolves.toMatchObject({ ghost: { manifest: { version: '2.0.0' } } });
    expect(runtime.install.mock.calls[0]?.[1]).not.toHaveProperty('permissionBaselineManifest');
  });

  it('rejects an update when the installed target disappears during download', async () => {
    const item = summary({ currentRelease: { ...summary().currentRelease, version: '2.0.0' } });
    const h = harness([item]);
    h.ledger.upsertInstallation({
      ...recordForTest(item),
      releaseId: 'release-0',
      version: '1.0.0',
    });
    runtime.ghosts = [
      {
        manifest: manifest('cindy-test', '1.0.0'),
        dir: '/userData/cindy-brain/cindy-test',
        enabled: false,
      },
    ];
    h.api.download.mockImplementationOnce(async () => {
      // 模拟另一窗口在下载期间完成本地卸载。
      runtime.ghosts = [];
      return {
        url: 'https://downloads.test.invalid/plugin.cindy',
        expiresAt: '2099-01-01T00:00:00.000Z',
        sha256: item.currentRelease.sha256,
        sizeBytes: item.currentRelease.sizeBytes,
      };
    });

    await expect(
      h.service.install(item.id, reviewedInstallOptions(item)),
    ).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('rejects when the market release changes after renderer review', async () => {
    const reviewed = summary();
    const replacement = summary({
      currentRelease: {
        ...reviewed.currentRelease,
        id: 'release-2',
        version: '1.1.0',
        sha256: 'b'.repeat(64),
      },
    });
    const h = harness([reviewed]);
    h.api.listAll.mockResolvedValueOnce({ plugins: [replacement], removals: [] });

    await expect(
      h.service.install(reviewed.id, reviewedInstallOptions(reviewed)),
    ).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(h.api.download).not.toHaveBeenCalled();
    expect(runtime.install).not.toHaveBeenCalled();
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

    await expect(h.service.install(item.id, reviewedInstallOptions(item))).rejects.toThrow('[PRECONDITION_FAILED]');
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
      return { plugins: [item], removals: [] };
    });

    await expect(h.service.install(item.id, reviewedInstallOptions(item))).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(runtime.install).not.toHaveBeenCalled();
    expect(h.ledger.installationForGhost(item.ghostId)).toBeNull();
  });

  it('records provenance for the captured owner when the owner changes after install', async () => {
    const item = summary();
    const installedGhost = {
      manifest: manifest(),
      dir: '/userData/cindy-brain/cindy-test',
      enabled: false,
    };
    const h = harness([item]);
    runtime.install.mockImplementationOnce(async () => {
      runtime.session = {
        mode: 'cloud',
        dataOwnerId: 'user-2',
        generation: 2,
      };
      runtime.ghosts = [installedGhost];
      return installedGhost;
    });

    await expect(h.service.install(item.id, reviewedInstallOptions(item))).resolves.toEqual({
      ghost: installedGhost,
    });
    expect(h.ledger.installationForGhost(item.ghostId)).toMatchObject({
      pluginId: item.id,
      releaseId: item.currentRelease.id,
      installed: true,
    });
  });

  it('reports a successful market uninstall when the owner changes during cleanup', async () => {
    const item = summary({ defaultInstall: true });
    const h = harness([item]);
    h.ledger.upsertInstallation(recordForTest(item));
    runtime.ghosts = [
      {
        manifest: manifest(),
        dir: '/userData/cindy-brain/cindy-test',
        enabled: true,
      },
    ];
    runtime.uninstall.mockImplementationOnce(async () => {
      runtime.session = {
        mode: 'cloud',
        dataOwnerId: 'user-2',
        generation: 2,
      };
      runtime.ghosts = [];
    });

    await expect(h.service.uninstall(item.id)).resolves.toEqual({ ok: true });
    expect(runtime.uninstall).toHaveBeenCalledWith(item.ghostId, {
      skipMarketLedger: true,
    });
    expect(h.ledger.installationForGhost(item.ghostId)?.installed).toBe(false);
    expect(h.ledger.isDefaultInstallSuppressed('user-1', item.id)).toBe(true);
  });
});

function recordForTest(
  item: VisiblePluginSummary,
  overrides: Partial<PluginMarketInstallationRecord> = {},
): PluginMarketInstallationRecord {
  return {
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
    ...overrides,
  };
}

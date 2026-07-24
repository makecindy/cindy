import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  isValidPluginResourceId,
  type VisiblePluginDetail,
  type VisiblePluginSummary,
} from '@cindy/plugin-protocol';
import { app } from 'electron';

import {
  diffGhostPermissionItems,
  isOfficialGhostId,
  validateGhostManifest,
  type InstalledGhost,
} from '../../shared/ghost.js';
import type {
  PluginMarketDetail,
  PluginMarketItem,
  PluginMarketSnapshot,
} from '../../shared/pluginMarket.js';
import { getAuthState, getCurrentUserId } from '../authManager.js';
import {
  getGhostManager,
  installOrUpdateMarketGhostPackage,
  isBuiltinGhostRemovedByUser,
  uninstallGhostAndCleanup,
} from '../cindy-brain/index.js';
import {
  getActiveAppSession,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
  type ActiveAppSession,
} from '../appSessionState.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { createLogger } from '../logger.js';
import { PluginMarketApi } from './api.js';
import { downloadVerifiedPlugin } from './download.js';
import {
  PluginMarketLedger,
  type PluginMarketInstallationRecord,
} from './ledger.js';

const log = createLogger('plugin-market');

function captureCloudOwner(): ActiveAppSession {
  const session = getActiveAppSession();
  if (
    session.mode !== 'cloud' ||
    !session.dataOwnerId ||
    isAppSessionBoundaryPending()
  ) {
    throw new Error('Plugin 市场需要已登录的云端会话');
  }
  return session;
}

function requireSameCloudOwner(expected: ActiveAppSession): void {
  const current = getActiveAppSession();
  if (
    isAppSessionBoundaryPending() ||
    current.mode !== 'cloud' ||
    current.dataOwnerId !== expected.dataOwnerId ||
    current.generation !== expected.generation
  ) {
    throw new Error('账号已切换，已取消本次 Plugin 操作');
  }
}

function sameLegacyFacts(plugin: VisiblePluginSummary, ghost: InstalledGhost): boolean {
  return (
    plugin.ghostId === ghost.manifest.id &&
    plugin.currentRelease.version === ghost.manifest.version &&
    plugin.name === ghost.manifest.name &&
    plugin.description === (ghost.manifest.description ?? null) &&
    plugin.author === (ghost.manifest.author ?? null)
  );
}

function recordFrom(
  plugin: VisiblePluginSummary | VisiblePluginDetail,
  source: PluginMarketInstallationRecord['source'],
): PluginMarketInstallationRecord {
  return {
    pluginId: plugin.id,
    ghostId: plugin.ghostId,
    releaseId: plugin.currentRelease.id,
    version: plugin.currentRelease.version,
    sha256: plugin.currentRelease.sha256,
    scope: plugin.scope,
    organizationId: plugin.organizationId,
    source,
    installed: true,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Claims a trusted legacy install without pretending its bytes came from the
 * current market release. A synthetic release id keeps the local version
 * visible as update-available until the user explicitly installs the market
 * release; the normal update path then replaces this with verified provenance.
 */
function legacyRecordFrom(
  plugin: VisiblePluginSummary,
  ghost: InstalledGhost,
): PluginMarketInstallationRecord {
  if (sameLegacyFacts(plugin, ghost)) {
    return recordFrom(plugin, 'legacy-adopted');
  }
  return {
    pluginId: plugin.id,
    ghostId: plugin.ghostId,
    releaseId: `legacy-unresolved:${ghost.manifest.version}`,
    version: ghost.manifest.version,
    sha256: 'legacy-unverified',
    scope: plugin.scope,
    organizationId: plugin.organizationId,
    source: 'legacy-adopted',
    installed: true,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Plugin 市场的 main 端协调器。远程不可用时不碰本地目录；安装写路径必须依次
 * 通过 protocol parser、下载大小/SHA 校验、Ghost runtime validator 和原子换目录。
 */
export class PluginMarketService {
  private readonly mutations = new Map<string, Promise<unknown>>();

  constructor(
    private readonly api = new PluginMarketApi(),
    private readonly ledger = new PluginMarketLedger(() =>
      ownerScopedUserDataPath('plugin-market', 'ledger.v1.json'),
    ),
  ) {}

  async snapshot(): Promise<PluginMarketSnapshot> {
    let owner: ActiveAppSession;
    try {
      owner = captureCloudOwner();
    } catch {
      return { items: [], unavailableReason: 'authentication-required' };
    }
    if (!getClientEndpoint('pluginApiBaseUrl')) {
      return { items: [], unavailableReason: 'not-configured' };
    }
    let plugins: VisiblePluginSummary[];
    try {
      plugins = await this.api.listAll();
    } catch (error) {
      log.warn('market list unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        items: [],
        unavailableReason: error instanceof Error ? error.message : String(error),
      };
    }

    requireSameCloudOwner(owner);
    this.adoptLegacyInstallations(plugins);
    this.reconcileRemovedInstallations();
    await this.applyDefaultInstalls(plugins, owner);
    requireSameCloudOwner(owner);
    return { items: this.toItems(plugins), unavailableReason: null };
  }

  async detail(pluginId: string): Promise<PluginMarketDetail> {
    if (!isValidPluginResourceId(pluginId)) throw new Error('Plugin ID 不合法');
    this.requireConfigured();
    const owner = captureCloudOwner();
    const plugin = await this.api.detail(pluginId);
    requireSameCloudOwner(owner);
    const compatible = validateGhostManifest(plugin.currentRelease.manifest);
    if (!compatible.ok) {
      throw new Error(`当前 Cindy 不支持此 Plugin 清单: ${compatible.reason}`);
    }
    return {
      ...this.toItem(plugin),
      manifest: compatible.manifest,
    };
  }

  async install(
    pluginId: string,
    options?: { allowPermissionExpansion?: boolean },
  ): Promise<{ ghost: InstalledGhost }> {
    if (!isValidPluginResourceId(pluginId)) throw new Error('Plugin ID 不合法');
    this.requireConfigured();
    const owner = captureCloudOwner();
    return this.withMutation(pluginId, async () => {
      requireSameCloudOwner(owner);
      const catalog = await this.api.listAll();
      requireSameCloudOwner(owner);
      const selected = catalog.find((plugin) => plugin.id === pluginId);
      if (!selected) throw new Error('Plugin 不存在或当前身份不可见');
      if (
        catalog.filter((plugin) => plugin.ghostId === selected.ghostId).length !== 1
      ) {
        throw new Error(`存在同 id Plugin，当前客户端无法安全共存: ${selected.ghostId}`);
      }
      const plugin = await this.api.detail(pluginId);
      return {
        ghost: await this.installDetail(
          plugin,
          options?.allowPermissionExpansion === true,
          owner,
        ),
      };
    });
  }

  async uninstall(pluginId: string): Promise<{ ok: true }> {
    if (!isValidPluginResourceId(pluginId)) throw new Error('Plugin ID 不合法');
    const owner = captureCloudOwner();
    return this.withMutation(pluginId, async () => {
      requireSameCloudOwner(owner);
      const data = this.ledger.read();
      const record = Object.values(data.installations).find(
        (candidate) => candidate.pluginId === pluginId && candidate.installed,
      );
      if (!record) throw new Error('该市场 Plugin 未安装');
      requireSameCloudOwner(owner);
      await uninstallGhostAndCleanup(record.ghostId);
      requireSameCloudOwner(owner);
      this.ledger.markRemoved(record.ghostId, getCurrentUserId());
      return { ok: true };
    });
  }

  private async installDetail(
    plugin: VisiblePluginDetail,
    allowPermissionExpansion = false,
    owner = captureCloudOwner(),
  ): Promise<InstalledGhost> {
    requireSameCloudOwner(owner);
    const existing = getGhostManager()
      .list()
      .find((ghost) => ghost.manifest.id === plugin.ghostId);
    const currentRecord = this.ledger.installationForGhost(plugin.ghostId);
    if (
      existing &&
      (!currentRecord || currentRecord.pluginId !== plugin.id)
    ) {
      throw new Error(`本地已存在同 id Plugin: ${plugin.ghostId}`);
    }

    const compatible = validateGhostManifest(plugin.currentRelease.manifest);
    if (!compatible.ok) {
      throw new Error(`当前 Cindy 不支持此 Plugin 清单: ${compatible.reason}`);
    }
    if (
      existing &&
      diffGhostPermissionItems(existing.manifest, compatible.manifest).added.length > 0 &&
      !allowPermissionExpansion
    ) {
      throw new Error('Plugin 更新增加了权限，需要用户确认');
    }
    const download = await this.api.download(plugin.id, plugin.currentRelease.id);
    requireSameCloudOwner(owner);
    if (
      download.sha256 !== plugin.currentRelease.sha256 ||
      download.sizeBytes !== plugin.currentRelease.sizeBytes
    ) {
      throw new Error('下载凭证与当前 Release 不一致');
    }
    const expiresAt = Date.parse(download.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error('Plugin 下载凭证已过期');
    }

    const tempPath = path.join(
      app.getPath('temp'),
      `cindy-plugin-${plugin.id}-${crypto.randomUUID()}.cindy`,
    );
    try {
      await downloadVerifiedPlugin(download.url, download, tempPath);
      requireSameCloudOwner(owner);
      const ghost = await installOrUpdateMarketGhostPackage(tempPath, {
        ghostId: plugin.ghostId,
        version: plugin.currentRelease.version,
      });
      requireSameCloudOwner(owner);
      this.ledger.upsertInstallation(recordFrom(plugin, 'market'));
      return ghost;
    } finally {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private requireConfigured(): void {
    if (!getClientEndpoint('pluginApiBaseUrl')) {
      throw new Error('Plugin 市场未配置');
    }
  }

  private toItems(plugins: readonly VisiblePluginSummary[]): PluginMarketItem[] {
    const duplicateGhostIds = new Set(
      plugins
        .map((plugin) => plugin.ghostId)
        .filter((ghostId, index, all) => all.indexOf(ghostId) !== index),
    );
    return plugins.map((plugin) => this.toItem(plugin, duplicateGhostIds));
  }

  private toItem(
    plugin: VisiblePluginSummary | VisiblePluginDetail,
    duplicateGhostIds: ReadonlySet<string> = new Set(),
  ): PluginMarketItem {
    const ghost = getGhostManager()
      .list()
      .find((candidate) => candidate.manifest.id === plugin.ghostId);
    const record = this.ledger.installationForGhost(plugin.ghostId);
    const ownsInstall = Boolean(
      ghost && record?.installed && record.pluginId === plugin.id,
    );
    const conflict = Boolean(
      duplicateGhostIds.has(plugin.ghostId) ||
        (ghost && (!record || record.pluginId !== plugin.id)),
    );
    const installState: PluginMarketItem['installState'] = conflict
      ? 'conflict'
      : !ownsInstall
        ? 'not-installed'
        : record?.releaseId === plugin.currentRelease.id
          ? 'installed'
          : 'update-available';
    return {
      pluginId: plugin.id,
      ghostId: plugin.ghostId,
      name: plugin.name,
      description: plugin.description,
      author: plugin.author,
      scope: plugin.scope,
      organizationId: plugin.organizationId,
      defaultInstall: plugin.defaultInstall,
      releaseId: plugin.currentRelease.id,
      version: plugin.currentRelease.version,
      publishedAt: plugin.currentRelease.publishedAt,
      installState,
      enabled: ownsInstall ? (ghost?.enabled ?? null) : null,
    };
  }

  private adoptLegacyInstallations(plugins: readonly VisiblePluginSummary[]): void {
    const counts = new Map<string, number>();
    for (const plugin of plugins) {
      counts.set(plugin.ghostId, (counts.get(plugin.ghostId) ?? 0) + 1);
    }
    for (const ghost of getGhostManager().list()) {
      if (this.ledger.installationForGhost(ghost.manifest.id)) continue;
      if (!isOfficialGhostId(ghost.manifest.id)) continue;
      const matches = plugins.filter(
        (plugin) =>
          counts.get(plugin.ghostId) === 1 &&
          plugin.scope !== 'personal' &&
          plugin.ghostId === ghost.manifest.id,
      );
      if (matches.length !== 1) continue;
      const record = legacyRecordFrom(matches[0], ghost);
      this.ledger.upsertInstallation(record);
      log.info('legacy plugin adopted into market ledger', {
        ghostId: ghost.manifest.id,
        pluginId: matches[0].id,
        exactCurrentRelease: record.releaseId === matches[0].currentRelease.id,
      });
    }
  }

  private reconcileRemovedInstallations(): void {
    const installedIds = new Set(
      getGhostManager().list().map((ghost) => ghost.manifest.id),
    );
    const userId = getCurrentUserId();
    for (const record of Object.values(this.ledger.read().installations)) {
      if (record.installed && !installedIds.has(record.ghostId)) {
        this.ledger.markRemoved(record.ghostId, userId);
      }
    }
  }

  private async applyDefaultInstalls(
    plugins: readonly VisiblePluginSummary[],
    owner: ActiveAppSession,
  ): Promise<void> {
    const user = getAuthState().user;
    if (!user) return;
    const uniqueGhostIds = new Set(
      plugins
        .map((plugin) => plugin.ghostId)
        .filter(
          (ghostId, index, all) =>
            all.indexOf(ghostId) === index && all.lastIndexOf(ghostId) === index,
        ),
    );
    for (const summary of plugins) {
      if (!summary.defaultInstall || !uniqueGhostIds.has(summary.ghostId)) continue;
      if (this.ledger.isDefaultInstallSuppressed(user.id, summary.id)) continue;
      if (isBuiltinGhostRemovedByUser(summary.ghostId)) continue;
      const state = this.toItem(summary).installState;
      if (state !== 'not-installed') continue;
      try {
        await this.withMutation(summary.id, async () => {
          requireSameCloudOwner(owner);
          const detail = await this.api.detail(summary.id);
          await this.installDetail(detail, false, owner);
        });
      } catch (error) {
        // 单个默认插件失败不拖垮整个市场；下次同步可重试。
        log.warn('default plugin install failed', {
          pluginId: summary.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private withMutation<T>(pluginId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(pluginId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(operation);
    this.mutations.set(pluginId, current);
    const cleanup = () => {
      if (this.mutations.get(pluginId) === current) this.mutations.delete(pluginId);
    };
    void current.then(cleanup, cleanup);
    return current;
  }
}

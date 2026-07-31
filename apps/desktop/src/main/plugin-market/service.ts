import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  isValidPluginResourceId,
  type VisiblePluginDetail,
  type VisiblePluginSummary,
} from '@cindy/plugin-protocol';
import { app, type WebContents } from 'electron';

import {
  diffGhostPermissionItems,
  isOfficialGhostId,
  validateGhostManifest,
  type GhostManifest,
  type InstalledGhost,
} from '../../shared/ghost.js';
import type {
  MarketSourceConfig,
  MarketSourceSummary,
  PluginMarketDetail,
  PluginMarketItem,
  PluginMarketSnapshot,
} from '../../shared/pluginMarket.js';
import {
  customMarketPluginId,
  customMarketReleaseId,
  parseCustomMarketPluginId,
} from '../../shared/pluginMarket.js';
import { getCurrentUserId } from '../authManager.js';
import {
  getGhostManager,
  installOrUpdateMarketGhostPackage,
  isGhostAvailableForActiveSession,
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
import { throwIpcError } from '../utils/ipcValidate.js';
import { PluginMarketApi } from './api.js';
import { downloadVerifiedPlugin } from './download.js';
import { installCustomMarketPlugin } from './install.js';
import {
  PluginMarketLedger,
  type PluginMarketInstallationRecord,
} from './ledger.js';
import type { DiscoveredMarketPlugin } from './sources/discover.js';
import { checkGitPreflight, type GitPreflightResult } from './sources/preflight.js';
import { MarketSourceManager } from './sources/index.js';
import { MarketSourceStore } from './sources/store.js';

const log = createLogger('plugin-market');
const NO_DUPLICATE_GHOST_IDS: ReadonlySet<string> = new Set();

function captureMarketOwner(): ActiveAppSession {
  const session = getActiveAppSession();
  if (
    (session.mode !== 'cloud' && session.mode !== 'local') ||
    !session.dataOwnerId ||
    isAppSessionBoundaryPending()
  ) {
    throwIpcError('PRECONDITION_FAILED', 'Plugin market requires a stable app session');
  }
  return session;
}

function requireSameMarketOwner(expected: ActiveAppSession): void {
  const current = getActiveAppSession();
  if (
    isAppSessionBoundaryPending() ||
    current.mode !== expected.mode ||
    current.dataOwnerId !== expected.dataOwnerId ||
    current.generation !== expected.generation
  ) {
    throwIpcError('PRECONDITION_FAILED', 'The active account changed during the Plugin operation');
  }
}

function visiblePluginsForOwner(
  owner: ActiveAppSession,
  plugins: readonly VisiblePluginSummary[],
): VisiblePluginSummary[] {
  return owner.mode === 'local'
    ? plugins.filter(
        (plugin) =>
          plugin.scope === 'public' && isGhostAvailableForActiveSession(plugin.ghostId),
      )
    : [...plugins];
}

function defaultInstallSubject(owner: ActiveAppSession): string {
  const subject = getCurrentUserId() ?? owner.dataOwnerId;
  if (!subject) {
    throwIpcError('PRECONDITION_FAILED', 'Plugin market data owner is unavailable');
  }
  return subject;
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

function ghostIdCounts(
  plugins: readonly VisiblePluginSummary[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const plugin of plugins) {
    counts.set(plugin.ghostId, (counts.get(plugin.ghostId) ?? 0) + 1);
  }
  return counts;
}

/** 自定义市场发现到的单个插件条目（快照投影的原料）。 */
interface CustomMarketEntry {
  config: MarketSourceConfig;
  plugin: DiscoveredMarketPlugin;
}

/** 服务端目录 + 自定义市场合并后的重复 ghostId 集合。 */
function combinedDuplicateGhostIds(
  plugins: readonly VisiblePluginSummary[],
  customEntries: readonly CustomMarketEntry[],
): ReadonlySet<string> {
  const counts = ghostIdCounts(plugins);
  for (const entry of customEntries) {
    counts.set(entry.plugin.ghostId, (counts.get(entry.plugin.ghostId) ?? 0) + 1);
  }
  return new Set(
    [...counts.entries()].filter(([, count]) => count > 1).map(([ghostId]) => ghostId),
  );
}

/** Stable local facts reused while projecting one market catalog response. */
interface LocalInstallSnapshot {
  /** Installed Ghost runtime facts indexed once for one market operation. */
  ghostsById: ReadonlyMap<string, InstalledGhost>;
  /** Parsed provenance records from one ledger read. */
  installations: Readonly<Record<string, PluginMarketInstallationRecord>>;
}

/**
 * Plugin 市场的 main 端协调器。远程不可用时不碰本地目录；安装写路径必须依次
 * 通过 protocol parser、下载大小/SHA 校验、Ghost runtime validator 和原子换目录。
 */
export class PluginMarketService {
  private readonly mutations = new Map<string, Promise<unknown>>();
  private ledgerMutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly api = new PluginMarketApi(),
    private readonly ledger = new PluginMarketLedger(() =>
      ownerScopedUserDataPath('plugin-market', 'ledger.v1.json'),
    ),
    private readonly sourceStore = new MarketSourceStore(() =>
      ownerScopedUserDataPath('plugin-market', 'sources.v1.json'),
    ),
  ) {}

  async snapshot(): Promise<PluginMarketSnapshot> {
    // 自定义市场项完全来自本地数据，不依赖服务端与登录态；服务端不可用时
    // 仍然返回，unavailableReason 只表达服务端部分的不可用。
    //
    // 自定义发现与服务端目录/账本必须在同一 owner 作用域内：先捕获 owner,
    // store/cloneRoot 绑定到它,跨 await 后用 generation 校验会话未切换,
    // 避免账号 A 的插件数据在切换窗口期被返回给账号 B 的 Renderer。
    let owner: ActiveAppSession;
    try {
      owner = captureMarketOwner();
    } catch {
      // 无稳定会话(未登录/切换中):无法可靠确定自定义数据该按哪个账号
      // 现查,返回空自定义项并标记原因,避免在切换窗口期把上一账号的
      // 插件数据返回给当前 Renderer。
      return {
        items: [],
        unavailableReason: isAppSessionBoundaryPending()
          ? 'session-switching'
          : getClientEndpoint('pluginApiBaseUrl')
            ? 'authentication-required'
            : 'not-configured',
        customSourceNames: [],
      };
    }
    const customEntries = await this.discoverCustomEntriesSafe(owner);
    const customSourceNames = this.customSourceNamesSafe(owner);
    requireSameMarketOwner(owner);
    if (!getClientEndpoint('pluginApiBaseUrl')) {
      return {
        items: this.projectCustomItems(customEntries),
        unavailableReason: customEntries.length > 0 ? null : 'not-configured',
        customSourceNames,
      };
    }
    let plugins: VisiblePluginSummary[];
    try {
      plugins = visiblePluginsForOwner(owner, await this.api.listAll());
    } catch (error) {
      log.warn('market list unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        items: this.projectCustomItems(customEntries),
        unavailableReason: error instanceof Error ? error.message : String(error),
        customSourceNames,
      };
    }

    requireSameMarketOwner(owner);
    const ledger = this.ledgerForOwner(owner);
    await this.adoptLegacyInstallations(plugins, ledger, owner);
    await this.reconcileRemovedInstallations(ledger, owner);
    await this.applyDefaultInstalls(plugins, owner, ledger);
    requireSameMarketOwner(owner);
    // ghostId 冲突判定跨服务端与自定义市场合并计算（全局唯一、先装先得）。
    const duplicateGhostIds = combinedDuplicateGhostIds(plugins, customEntries);
    const local = this.localInstallSnapshot(ledger);
    const serverItems = plugins.map((plugin) =>
      this.toItem(plugin, duplicateGhostIds, local),
    );
    const items = [...serverItems, ...this.projectCustomItems(customEntries, duplicateGhostIds, local)];
    // 聚合完成、返回 Renderer 前最后校验:账号在任一 await 间隙漂移则拒绝,
    // 不把按旧账号解析的自定义项/账本状态发给当前会话。
    requireSameMarketOwner(owner);
    return {
      items,
      unavailableReason: null,
      customSourceNames,
    };
  }

  async detail(pluginId: string): Promise<PluginMarketDetail> {
    // 自定义市场插件走本地发现，不要求服务端可用，也不受 CUID 形状约束。
    const customRef = parseCustomMarketPluginId(pluginId);
    if (customRef) return this.customDetail(customRef);
    if (!isValidPluginResourceId(pluginId)) {
      throwIpcError('INVALID_PARAMS', 'Invalid Plugin ID');
    }
    this.requireConfigured();
    return this.runForOwner(async (owner) => {
      const plugin = await this.api.detail(pluginId);
      requireSameMarketOwner(owner);
      if (owner.mode === 'local' && plugin.scope !== 'public') {
        throwIpcError('PERMISSION_DENIED', 'Local mode can only access public Plugins');
      }
      const compatible = validateGhostManifest(plugin.currentRelease.manifest);
      if (!compatible.ok) {
        throwIpcError('GHOST_FILE_INVALID', 'This Plugin manifest is not supported');
      }
      return {
        ...this.toItem(
          plugin,
          NO_DUPLICATE_GHOST_IDS,
          this.localInstallSnapshot(this.ledgerForOwner(owner)),
        ),
        manifest: compatible.manifest,
      };
    });
  }

  async install(
    pluginId: string,
    options: {
      /** Renderer 确认框实际展示过的 release。Main 重拉详情后必须仍一致,
       *  否则用户审阅 A、实际安装/启用 B(review P1)。 */
      expectedReleaseId: string;
      /** 自定义市场插件：Renderer 确认框实际审阅过的完整 manifest。 */
      expectedManifest?: GhostManifest;
      allowPermissionExpansion?: boolean;
    },
  ): Promise<{ ghost: InstalledGhost }> {
    const customRef = parseCustomMarketPluginId(pluginId);
    if (customRef) {
      if (!options.expectedManifest) {
        throwIpcError('INVALID_PARAMS', 'The reviewed Plugin manifest is required');
      }
      return this.customInstall(customRef, options as typeof options & { expectedManifest: GhostManifest });
    }
    if (!isValidPluginResourceId(pluginId)) {
      throwIpcError('INVALID_PARAMS', 'Invalid Plugin ID');
    }
    this.requireConfigured();
    const owner = captureMarketOwner();
    const ledger = this.ledgerForOwner(owner);
    return this.withMutation(pluginId, async () => {
      requireSameMarketOwner(owner);
      const catalog = visiblePluginsForOwner(owner, await this.api.listAll());
      requireSameMarketOwner(owner);
      const selected = catalog.find((plugin) => plugin.id === pluginId);
      if (!selected) {
        throwIpcError('NOT_FOUND', 'Plugin is unavailable to the active account');
      }
      if (
        catalog.filter((plugin) => plugin.ghostId === selected.ghostId).length !== 1
      ) {
        throwIpcError('ALREADY_EXISTS', 'Multiple market Plugins use the same Plugin ID');
      }
      const plugin = await this.api.detail(pluginId);
      requireSameMarketOwner(owner);
      if (plugin.currentRelease.id !== options.expectedReleaseId) {
        throwIpcError(
          'PRECONDITION_FAILED',
          'Plugin release changed after permission review',
        );
      }
      const existing = getGhostManager()
        .list()
        .some((ghost) => ghost.manifest.id === plugin.ghostId);
      return {
        ghost: await this.installDetail(
          plugin,
          {
            expectedInstalled: existing,
            allowPermissionExpansion: options.allowPermissionExpansion === true,
          },
          owner,
          ledger,
        ),
      };
    });
  }

  async uninstall(pluginId: string): Promise<{ ok: true }> {
    // 自定义市场插件的卸载走同一账本路径，仅跳过服务端 CUID 形状校验。
    if (
      !parseCustomMarketPluginId(pluginId) &&
      !isValidPluginResourceId(pluginId)
    ) {
      throwIpcError('INVALID_PARAMS', 'Invalid Plugin ID');
    }
    const owner = captureMarketOwner();
    const ledger = this.ledgerForOwner(owner);
    return this.withMutation(pluginId, async () => {
      requireSameMarketOwner(owner);
      const data = ledger.read();
      const record = Object.values(data.installations).find(
        (candidate) => candidate.pluginId === pluginId && candidate.installed,
      );
      if (!record) {
        throwIpcError('NOT_FOUND', 'The market Plugin is not installed');
      }
      const installSubject = defaultInstallSubject(owner);
      requireSameMarketOwner(owner);
      await uninstallGhostAndCleanup(record.ghostId, { skipMarketLedger: true });
      // The package removal is already complete at this point. The session may
      // have changed while the runtime was stopping, so ledger reconciliation
      // must not turn a successful uninstall into an IPC failure. The ledger
      // instance is bound to the original owner's path, and the write is
      // serialized separately from the active-session check.
      try {
        await this.withCapturedLedgerMutation(ledger, () => {
          ledger.markRemoved(record.ghostId, installSubject);
        });
      } catch (error) {
        log.warn('market uninstall ledger reconciliation deferred', {
          ghostId: record.ghostId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return { ok: true };
    });
  }

  /**
   * Captures the active owner and ledger before a local-page uninstall starts.
   * The returned completion records opt-out only after the package was removed.
   */
  prepareLocalUninstallTracking(ghostId: string): (() => Promise<void>) | null {
    let owner: ActiveAppSession;
    try {
      owner = captureMarketOwner();
    } catch {
      return null;
    }
    const ledger = this.ledgerForOwner(owner);
    const record = ledger.installationForGhost(ghostId);
    if (!record?.installed) return null;
    const installSubject = defaultInstallSubject(owner);
    return async () => {
      await this.withCapturedLedgerMutation(ledger, () => {
        ledger.markRemoved(ghostId, installSubject);
      });
    };
  }

  /* ---------------------------------------------------------------------- */
  /* 自定义市场源（Git / 本地文件夹）                                         */
  /* ---------------------------------------------------------------------- */

  async listSources(): Promise<MarketSourceSummary[]> {
    return this.runForOwner((owner) => this.sourceManagerForOwner(owner).listSources());
  }

  async addSource(input: {
    source: string;
    ref?: string;
    sparsePaths?: string[];
  }): Promise<MarketSourceSummary> {
    // 源管理操作全局串行：添加期间发现的市场名必须唯一，并行添加会互相覆盖。
    return this.runForOwner((owner) =>
      this.withMutation('market-sources', async () => {
        requireSameMarketOwner(owner);
        return this.sourceManagerForOwner(owner).addSource(input);
      }),
    );
  }

  async removeSource(name: string): Promise<{ ok: true }> {
    return this.runForOwner((owner) =>
      this.withMutation('market-sources', async () => {
        requireSameMarketOwner(owner);
        return this.sourceManagerForOwner(owner).removeSource(name);
      }),
    );
  }

  async refreshSource(name: string): Promise<MarketSourceSummary> {
    return this.runForOwner((owner) =>
      this.withMutation('market-sources', async () => {
        requireSameMarketOwner(owner);
        return this.sourceManagerForOwner(owner).refreshSource(name);
      }),
    );
  }

  async gitPreflight(): Promise<GitPreflightResult> {
    return checkGitPreflight();
  }

  /** 自定义市场插件详情：本地发现现查，不要求服务端市场可用。 */
  private async customDetail(ref: {
    marketName: string;
    ghostId: string;
  }): Promise<PluginMarketDetail> {
    return this.runForOwner(async (owner) => {
      const manager = this.sourceManagerForOwner(owner);
      const discovered = await manager.discoverSource(ref.marketName);
      if (!discovered.result.ok) {
        throwIpcError(discovered.result.code, discovered.result.detail ?? discovered.result.code);
      }
      const plugin = discovered.result.marketplace.plugins.find(
        (candidate) => candidate.ghostId === ref.ghostId,
      );
      if (!plugin) {
        throwIpcError('NOT_FOUND', 'The Plugin is no longer listed by this marketplace');
      }
      return {
        ...this.customToItem(
          { config: discovered.config, plugin },
          NO_DUPLICATE_GHOST_IDS,
          this.localInstallSnapshot(this.ledgerForOwner(owner)),
        ),
        manifest: plugin.manifest,
      };
    });
  }

  /**
   * 自定义市场插件安装/更新。与服务端 installDetail 同一组防线：
   * release 一致性（重发现后比对 expectedReleaseId）、冲突先装先得、
   * 权限扩张显式确认；打包与装入复用 installOrUpdateMarketGhostPackage。
   */
  private async customInstall(
    ref: { marketName: string; ghostId: string },
    options: { expectedReleaseId: string; expectedManifest: GhostManifest; allowPermissionExpansion?: boolean },
  ): Promise<{ ghost: InstalledGhost }> {
    const owner = captureMarketOwner();
    const ledger = this.ledgerForOwner(owner);
    const manager = this.sourceManagerForOwner(owner);
    // 互斥键与 uninstall 一致使用规范化 pluginId，保证同插件的安装/更新/卸载串行。
    return this.withMutation(customMarketPluginId(ref.marketName, ref.ghostId), async () => {
      requireSameMarketOwner(owner);
      const discovered = await manager.discoverSource(ref.marketName);
      if (!discovered.result.ok) {
        throwIpcError(discovered.result.code, discovered.result.detail ?? discovered.result.code);
      }
      const plugin = discovered.result.marketplace.plugins.find(
        (candidate) => candidate.ghostId === ref.ghostId,
      );
      if (!plugin) {
        throwIpcError('NOT_FOUND', 'The Plugin is no longer listed by this marketplace');
      }
      const pluginId = customMarketPluginId(ref.marketName, plugin.ghostId);
      const releaseId = customMarketReleaseId(ref.marketName, plugin.ghostId, plugin.version);
      if (releaseId !== options.expectedReleaseId) {
        throwIpcError(
          'PRECONDITION_FAILED',
          'Plugin release changed after permission review',
        );
      }
      const existing = getGhostManager()
        .list()
        .find((ghost) => ghost.manifest.id === plugin.ghostId);
      const currentRecord = ledger.installationForGhost(plugin.ghostId);
      if (existing && (!currentRecord?.installed || currentRecord.pluginId !== pluginId)) {
        throwIpcError('ALREADY_EXISTS', 'A local Plugin already uses this Plugin ID');
      }
      if (
        existing &&
        diffGhostPermissionItems(existing.manifest, plugin.manifest).added.length > 0 &&
        options.allowPermissionExpansion !== true
      ) {
        throwIpcError('PRECONDITION_FAILED', 'Plugin permissions changed and require review');
      }
      requireSameMarketOwner(owner);
      const ghost = await installCustomMarketPlugin({
        pluginDir: plugin.dir,
        expected: options.expectedManifest,
        beforeCommit: () => requireSameMarketOwner(owner),
      });
      // 包目录落位后,溯源写入操作开始时捕获的 owner 账本(与服务端安装同款)。
      await this.withCapturedLedgerMutation(ledger, () => {
        ledger.upsertInstallation({
          pluginId,
          ghostId: plugin.ghostId,
          releaseId,
          version: plugin.version,
          // 自定义源没有服务端内容哈希;占位值如实表达"未经内容校验"。
          sha256: 'custom-unverified',
          scope: 'public',
          organizationId: null,
          source: discovered.config.source.type === 'git' ? 'git-market' : 'local-market',
          installed: true,
          updatedAt: new Date().toISOString(),
        });
      });
      return { ghost };
    });
  }

  /** 已配置来源名（按添加顺序）；存储读取失败时降级为空数组。 */
  private customSourceNamesSafe(owner?: ActiveAppSession): string[] {
    try {
      const store = owner
        ? this.sourceStore.bind(ownerScopedUserDataPath('plugin-market', 'sources.v1.json'))
        : this.sourceStore;
      return store.list().map((source) => source.name);
    } catch {
      return [];
    }
  }

  /** 快照聚合用：发现全部自定义市场条目。任何失败都降级为空，不拖垮快照。 */
  private async discoverCustomEntriesSafe(
    owner?: ActiveAppSession,
  ): Promise<CustomMarketEntry[]> {
    try {
      const manager = owner
        ? this.sourceManagerForOwner(owner)
        : new MarketSourceManager({
            store: this.sourceStore,
            cloneRoot: ownerScopedUserDataPath('plugin-market', 'sources'),
          });
      const discovered = await manager.discoverAll();
      const entries: CustomMarketEntry[] = [];
      for (const { config, result } of discovered) {
        if (!result.ok) {
          log.warn('custom marketplace discovery failed', {
            market: config.name,
            code: result.code,
          });
          continue;
        }
        for (const plugin of result.marketplace.plugins) {
          entries.push({ config, plugin });
        }
      }
      return entries;
    } catch (error) {
      log.warn('custom marketplace enumeration failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private projectCustomItems(
    entries: readonly CustomMarketEntry[],
    duplicateGhostIds?: ReadonlySet<string>,
    local?: LocalInstallSnapshot,
  ): PluginMarketItem[] {
    const duplicates =
      duplicateGhostIds ?? combinedDuplicateGhostIds([], entries);
    const snapshot = local ?? this.localInstallSnapshot();
    return entries.map((entry) => this.customToItem(entry, duplicates, snapshot));
  }

  /** 自定义市场项的状态机与服务端 toItem 完全一致（冲突 / 首装 / 更新 / 已装）。 */
  private customToItem(
    entry: CustomMarketEntry,
    duplicateGhostIds: ReadonlySet<string>,
    local: LocalInstallSnapshot,
  ): PluginMarketItem {
    const { config, plugin } = entry;
    const pluginId = customMarketPluginId(config.name, plugin.ghostId);
    const releaseId = customMarketReleaseId(config.name, plugin.ghostId, plugin.version);
    const ghost = local.ghostsById.get(plugin.ghostId);
    const record = local.installations[plugin.ghostId];
    const ownsInstall = Boolean(
      ghost && record?.installed && record.pluginId === pluginId,
    );
    // 已拥有当前安装记录的来源保留所有权（installed / update-available）；
    // duplicate 只把未拥有安装的竞争来源标为冲突，避免“先安装者优先”被降格。
    const conflict = Boolean(
      (duplicateGhostIds.has(plugin.ghostId) && !ownsInstall) || (ghost && !ownsInstall),
    );
    const installState: PluginMarketItem['installState'] = conflict
      ? 'conflict'
      : !ownsInstall
        ? 'not-installed'
        : record?.releaseId === releaseId
          ? 'installed'
          : 'update-available';
    return {
      pluginId,
      ghostId: plugin.ghostId,
      name: plugin.manifest.name,
      description: plugin.manifest.description ?? null,
      author: plugin.manifest.author ?? null,
      // scope 是服务端授权概念，自定义市场项无服务端身份;展示层按 sourceType 分流。
      scope: 'public',
      organizationId: null,
      defaultInstall: false,
      releaseId,
      version: plugin.version,
      publishedAt: config.lastSyncedAt ?? config.addedAt,
      icon: null,
      installState,
      enabled: ownsInstall ? (ghost?.enabled ?? null) : null,
      sourceType: config.source.type === 'git' ? 'git-market' : 'local-market',
      sourceMarketName: config.name,
    };
  }

  /**
   * owner 绑定执行 + 返回前漂移校验。所有把市场数据返回 Renderer 或改动
   * 运行时的 owner-bound 导出方法统一走此闸:账号在 await 间隙切换则拒绝,
   * 不把上一账号的 URL/路径/manifest/summary 发给当前 Renderer,也不让
   * 写操作落在错误账户。新增 owner-bound 方法只允许经此入口,从结构上
   * 杜绝逐路径漏加 generation 校验。
   */
  private async runForOwner<T>(
    operation: (owner: ActiveAppSession) => Promise<T>,
  ): Promise<T> {
    const owner = captureMarketOwner();
    const result = await operation(owner);
    requireSameMarketOwner(owner);
    return result;
  }

  private sourceManagerForOwner(owner: ActiveAppSession): MarketSourceManager {
    requireSameMarketOwner(owner);
    return new MarketSourceManager({
      store: this.sourceStore.bind(
        ownerScopedUserDataPath('plugin-market', 'sources.v1.json'),
      ),
      cloneRoot: ownerScopedUserDataPath('plugin-market', 'sources'),
    });
  }

  private async installDetail(
    plugin: VisiblePluginDetail,
    options: {
      allowPermissionExpansion?: boolean;
      /** 确认操作时的安装意图;下载窗口期目标被另一窗口卸载时拒绝滑入首装。 */
      expectedInstalled: boolean;
    } = { expectedInstalled: false },
    owner = captureMarketOwner(),
    ledger = this.ledgerForOwner(owner),
  ): Promise<InstalledGhost> {
    requireSameMarketOwner(owner);
    if (owner.mode === 'local' && plugin.scope !== 'public') {
      throwIpcError('PERMISSION_DENIED', 'Local mode can only access public Plugins');
    }
    const existing = getGhostManager()
      .list()
      .find((ghost) => ghost.manifest.id === plugin.ghostId);
    const currentRecord = ledger.installationForGhost(plugin.ghostId);
    if (existing && (!currentRecord?.installed || currentRecord.pluginId !== plugin.id)) {
      throwIpcError('ALREADY_EXISTS', 'A local Plugin already uses this Plugin ID');
    }

    const compatible = validateGhostManifest(plugin.currentRelease.manifest);
    if (!compatible.ok) {
      throwIpcError('GHOST_FILE_INVALID', 'This Plugin manifest is not supported');
    }
    if (
      existing &&
      diffGhostPermissionItems(existing.manifest, compatible.manifest).added.length > 0 &&
      options.allowPermissionExpansion !== true
    ) {
      throwIpcError('PRECONDITION_FAILED', 'Plugin permissions changed and require review');
    }
    const download = await this.api.download(plugin.id, plugin.currentRelease.id);
    requireSameMarketOwner(owner);
    if (
      download.sha256 !== plugin.currentRelease.sha256 ||
      download.sizeBytes !== plugin.currentRelease.sizeBytes
    ) {
      throwIpcError('PRECONDITION_FAILED', 'Plugin release metadata changed');
    }
    const expiresAt = Date.parse(download.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throwIpcError('PRECONDITION_FAILED', 'Plugin download authorization expired');
    }

    const tempPath = path.join(
      app.getPath('temp'),
      `cindy-plugin-${plugin.id}-${crypto.randomUUID()}.cindy`,
    );
    try {
      await downloadVerifiedPlugin(download.url, download, tempPath);
      requireSameMarketOwner(owner);
      if (options.expectedInstalled) {
        const stillInstalled = getGhostManager()
          .list()
          .some((ghost) => ghost.manifest.id === plugin.ghostId);
        if (!stillInstalled) {
          // 用户确认的是更新；下载期间若另一窗口已卸载目标,不能把操作
          // 降级成首装并自动启用。按状态变化拒绝,由 renderer 刷新重试。
          throwIpcError(
            'PRECONDITION_FAILED',
            'Plugin was uninstalled while the update was downloading',
          );
        }
      }
      // 市场首装一律装完即开(2026-07-26 定案,见 installOrUpdateMarketGhostPackage);
      // 已装过则走原位更新,唤醒/沉睡状态延续当前值。
      const ghost = await installOrUpdateMarketGhostPackage(tempPath, {
        ghostId: plugin.ghostId,
        version: plugin.currentRelease.version,
      });
      // Once the package directory is committed, finish provenance against the
      // owner captured at operation start even if the active session changes.
      // The bound ledger prevents this write from leaking into the new owner.
      await this.withCapturedLedgerMutation(ledger, () => {
        ledger.upsertInstallation(recordFrom(plugin, 'market'));
      });
      return ghost;
    } finally {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private requireConfigured(): void {
    if (!getClientEndpoint('pluginApiBaseUrl')) {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'Plugin market is not configured');
    }
  }

  private toItem(
    plugin: VisiblePluginSummary | VisiblePluginDetail,
    duplicateGhostIds: ReadonlySet<string> = NO_DUPLICATE_GHOST_IDS,
    local = this.localInstallSnapshot(),
  ): PluginMarketItem {
    const ghost = local.ghostsById.get(plugin.ghostId);
    const record = local.installations[plugin.ghostId];
    const ownsInstall = Boolean(
      ghost && record?.installed && record.pluginId === plugin.id,
    );
    // 与自定义侧 customToItem 对齐:已拥有当前安装记录的来源保留所有权
    // (installed / update-available),duplicate 只标未拥有安装的竞争来源,
    // 避免先安装者被重复 ghostId 降格、失去更新入口。
    const conflict = Boolean(
      (duplicateGhostIds.has(plugin.ghostId) && !ownsInstall) ||
        (ghost && (!record?.installed || record.pluginId !== plugin.id)),
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
      icon: plugin.currentRelease.icon,
      installState,
      enabled: ownsInstall ? (ghost?.enabled ?? null) : null,
      sourceType: 'server',
      sourceMarketName: null,
    };
  }

  private async adoptLegacyInstallations(
    plugins: readonly VisiblePluginSummary[],
    ledger: PluginMarketLedger,
    owner: ActiveAppSession,
  ): Promise<void> {
    const counts = ghostIdCounts(plugins);
    const installations = ledger.read().installations;
    for (const ghost of getGhostManager().list()) {
      if (installations[ghost.manifest.id]) continue;
      if (!isOfficialGhostId(ghost.manifest.id)) continue;
      const matches = plugins.filter(
        (plugin) =>
          counts.get(plugin.ghostId) === 1 &&
          plugin.scope !== 'personal' &&
          plugin.ghostId === ghost.manifest.id,
      );
      if (matches.length !== 1) continue;
      const record = legacyRecordFrom(matches[0], ghost);
      await this.withLedgerMutation(owner, () => {
        ledger.upsertInstallation(record);
      });
      installations[record.ghostId] = record;
      log.info('legacy plugin adopted into market ledger', {
        ghostId: ghost.manifest.id,
        pluginId: matches[0].id,
        exactCurrentRelease: record.releaseId === matches[0].currentRelease.id,
      });
    }
  }

  private async reconcileRemovedInstallations(
    ledger: PluginMarketLedger,
    owner: ActiveAppSession,
  ): Promise<void> {
    const installedIds = new Set(
      getGhostManager().list().map((ghost) => ghost.manifest.id),
    );
    const installSubject = defaultInstallSubject(owner);
    for (const record of Object.values(ledger.read().installations)) {
      if (record.installed && !installedIds.has(record.ghostId)) {
        await this.withLedgerMutation(owner, () => {
          ledger.markRemoved(record.ghostId, installSubject);
        });
      }
    }
  }

  private async applyDefaultInstalls(
    plugins: readonly VisiblePluginSummary[],
    owner: ActiveAppSession,
    ledger: PluginMarketLedger,
  ): Promise<void> {
    const installSubject = defaultInstallSubject(owner);
    const counts = ghostIdCounts(plugins);
    const uniqueGhostIds = new Set(
      plugins
        .filter((plugin) => counts.get(plugin.ghostId) === 1)
        .map((plugin) => plugin.ghostId),
    );
    const ledgerData = ledger.read();
    const local = this.localInstallSnapshot(ledger, ledgerData.installations);
    for (const summary of plugins) {
      if (!summary.defaultInstall || !uniqueGhostIds.has(summary.ghostId)) continue;
      if (ledgerData.defaultInstallOptOuts[installSubject]?.includes(summary.id)) continue;
      if (isBuiltinGhostRemovedByUser(summary.ghostId)) continue;
      const state = this.toItem(summary, NO_DUPLICATE_GHOST_IDS, local).installState;
      if (state !== 'not-installed') continue;
      try {
        await this.withMutation(summary.id, async () => {
          requireSameMarketOwner(owner);
          const detail = await this.api.detail(summary.id);
          // 装完即开语义已收敛进市场安装入口本身,这里无需再显式声明。
          await this.installDetail(
            detail,
            { expectedInstalled: false },
            owner,
            ledger,
          );
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

  private localInstallSnapshot(
    ledger = this.ledger,
    installations = ledger.read().installations,
  ): LocalInstallSnapshot {
    return {
      ghostsById: new Map(
        getGhostManager().list().map((ghost) => [ghost.manifest.id, ghost]),
      ),
      installations,
    };
  }

  private ledgerForOwner(owner: ActiveAppSession): PluginMarketLedger {
    requireSameMarketOwner(owner);
    return this.ledger.bind(
      ownerScopedUserDataPath('plugin-market', 'ledger.v1.json'),
    );
  }

  private withLedgerMutation<T>(
    owner: ActiveAppSession,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const current = this.ledgerMutation.then(() => {
      requireSameMarketOwner(owner);
      return operation();
    });
    this.ledgerMutation = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  /**
   * Serializes a ledger mutation against other operations without resolving
   * the ledger path from the current session. Callers that use this directly
   * must pass a ledger already bound to the operation's original owner.
   */
  private withCapturedLedgerMutation<T>(
    _ledger: PluginMarketLedger,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const current = this.ledgerMutation.then(() => {
      return operation();
    });
    this.ledgerMutation = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
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

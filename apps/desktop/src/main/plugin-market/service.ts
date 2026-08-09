import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  isValidPluginResourceId,
  supportsCindyVersion,
  type PluginRemovalNotice,
  type VisiblePluginDetail,
  type VisiblePluginSummary,
} from '@cindy/plugin-protocol';
import { app, dialog } from 'electron';

import {
  diffGhostPermissionItems,
  ghostPermissionBaselineKey,
  isOfficialGhostId,
  validateGhostManifest,
  type GhostManifest,
  type InstalledGhost,
} from '../../shared/ghost.js';
import type {
  MarketSourceConfig,
  MarketSourceSummary,
  PluginMarketDetail,
  PluginMarketInstallOptions,
  PluginMarketInstallResult,
  PluginMarketItem,
  PluginMarketPackageReviewFacts,
  PluginMarketSnapshot,
  PluginRemovalUserNotice,
  PluginUpgradePermissionNotice,
  PluginUpgradeUserNotice,
} from '../../shared/pluginMarket.js';
import {
  customMarketPluginId,
  customMarketReleaseId,
  marketSourceKey,
  parseCustomMarketPluginId,
} from '../../shared/pluginMarket.js';
import { getCurrentUserId } from '../authManager.js';
import {
  getGhostManager,
  hasPendingGhostCalls,
  hasRunningGhostCindyWork,
  hasRunningGhostErrand,
  installOrUpdateMarketGhostPackage,
  isGhostAvailableForActiveSession,
  isBuiltinGhostRemovedByUser,
  uninstallGhostAndCleanup,
} from '../cindy-brain/index.js';
import { hasCindyOfficialTrustMetadata } from '../cindy-brain/GhostManager.js';
import {
  getActiveAppSession,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
  type ActiveAppSession,
} from '../appSessionState.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { createLogger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  GHOST_MANIFEST_MAX_BYTES,
  readBoundedFileNoFollowSync,
} from '../utils/readBoundedFile.js';
import { withGhostInstallLock } from '../cindy-brain/ghostInstallLock.js';
import { GhostPackagePermissionReviewRequiredError } from '../cindy-brain/packagePermissionReview.js';
import { PluginMarketApi } from './api.js';
import { downloadVerifiedPlugin } from './download.js';
import { installCustomMarketPlugin } from './install.js';
import {
  PluginMarketLedger,
  ghostManifestDigest,
  type PluginMarketInstallationRecord,
} from './ledger.js';
import type { DiscoveredMarketPlugin } from './sources/discover.js';
import { checkGitPreflight, type GitPreflightResult } from './sources/preflight.js';
import { MarketSourceManager } from './sources/index.js';
import { MarketSourceStore } from './sources/store.js';

const log = createLogger('plugin-market');

type PackagePermissionReviewer = (
  facts: PluginMarketPackageReviewFacts,
) => Promise<boolean>;

class SilentUpgradeBusyError extends Error {}
class SilentUpgradeStaleBaselineError extends Error {}
class SilentDefaultInstallCancelledError extends Error {}

/**
 * 来源增删改的互斥键。自定义市场安装的提交段也要拿这把锁，保证所选来源从
 * 复核到包落位之间不会被移除或替换。官方市场安装不依赖自定义市场目录，不能
 * 拿这把锁，否则一次慢刷新就会无关地拖住官方插件安装。
 *
 * **锁次序(不变量,违反即死锁)**:允许 `withMutation(pluginId)` 内再取本键
 * (安装路径就是这么做的),**禁止**持本键时再取任何 pluginId 键。来源操作
 * (add/remove/refresh)只拿本键,永不反向,因此锁图无环。
 *
 * **已知权衡**:refreshSource 全程持本键,大仓库 clone 期间(可达分钟级)自定义
 * 市场安装的提交段与其它来源操作会排队。只读路径和官方市场安装不受影响；
 * 把刷新的网络段移出锁会重新打开“所选来源在提交前被替换”的窗口；吞吐不构成
 * 放宽正确性的理由。
 */
const SOURCE_MUTATION_KEY = 'market-sources';

/**
 * 扩权批准的原子复核:Renderer 的 allowPermissionExpansion 只代表「用户对
 * **某一份**已装 manifest 与目标包之间的差异点过同意」。它到达这里之前有一段
 * 往返窗口,期间「从文件更新」等路径可能整体替换已装 manifest(ghosts.update()
 * 没有版本单调性检查),那份同意就不再对应现实——继续放行等于让旧批准覆盖
 * 相对新 manifest 的全部新增权限。
 *
 * 所以带审阅基线来的批准,必须在安装锁内、真正放行扩权之前,拿**当前**已装
 * manifest 重算指纹比对;不一致就拒绝这次批准,由 Renderer 回到重新审阅。
 * 基线缺席时保持既有行为(旧版本 Renderer / 首装无基线可比),不新增拒绝面。
 */
function assertReviewedBaselineFresh(
  installed: GhostManifest,
  reviewedBaseline: string | undefined,
): void {
  if (reviewedBaseline === undefined) return;
  if (ghostPermissionBaselineKey(installed) !== reviewedBaseline) {
    throwIpcError(
      'PRECONDITION_FAILED',
      'Installed Plugin permissions changed after review; re-review required',
    );
  }
}

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
  installed: InstalledGhost,
): PluginMarketInstallationRecord {
  const rawManifest = installedGhostRawManifest(installed.dir);
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
    ...(rawManifest ? { manifestDigest: ghostManifestDigest(rawManifest) } : {}),
  };
}

/** 列表与详情是两次请求；安装前必须确认两次看到的是同一份发布。 */
function assertDetailMatchesSummary(
  summary: VisiblePluginSummary,
  detail: VisiblePluginDetail,
): void {
  if (
    detail.id !== summary.id ||
    detail.ghostId !== summary.ghostId ||
    detail.scope !== summary.scope ||
    detail.organizationId !== summary.organizationId ||
    detail.currentRelease.id !== summary.currentRelease.id ||
    detail.currentRelease.version !== summary.currentRelease.version ||
    detail.currentRelease.sha256 !== summary.currentRelease.sha256 ||
    detail.currentRelease.sizeBytes !== summary.currentRelease.sizeBytes
  ) {
    throwIpcError('PRECONDITION_FAILED', 'Plugin release changed while loading details');
  }
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
  const rawManifest = installedGhostRawManifest(ghost.dir);
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
    ...(rawManifest ? { manifestDigest: ghostManifestDigest(rawManifest) } : {}),
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

function manifestSupportsCurrentCindy(manifest: GhostManifest): boolean {
  return supportsCindyVersion(app.getVersion(), manifest.minCindyVersion);
}

/** 自定义市场发现到的单个插件条目（快照投影的原料）。 */
interface CustomMarketEntry {
  config: MarketSourceConfig;
  plugin: DiscoveredMarketPlugin;
}

/**
 * 已安装插件的 locale 无关 manifest 摘要。运行时 `InstalledGhost.manifest` 是
 * **按当前界面语言本地化后的**(GhostManager.readInstalledLocalizedManifest),
 * 拿它算摘要会让"切换应用语言"被误判成"包被替换"。所以摘要一律来自安装目录的
 * 原始 ghost.json,并过同一 validateGhostManifest 再规范化——与写入侧(发现层的
 * plugin.manifest,同为校验器输出)同口径。读不出/校验不过返回 null,视为不匹配
 * (fail 向 conflict,安全方向)。
 */
/**
 * 展示投影用:剥掉控制字符(保留换行/制表)与双向文本控制符。只作用于送往
 * Renderer 的市场条目字段,不改动 manifest 本体(校验/摘要仍以原文为准)。
 */
function stripDirectionalControls(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}

function installedGhostRawManifest(dir: string): GhostManifest | null {
  try {
    // 安装目录也可能被外部进程/同步盘改动,且本函数每次市场快照都会执行:
    // 与市场目录同一把单句柄限量闸,拒链接、超限即拒,不让无界字节进快照路径。
    const bytes = readBoundedFileNoFollowSync(
      path.join(dir, 'ghost.json'),
      GHOST_MANIFEST_MAX_BYTES,
    );
    if (bytes === null) return null;
    const raw = JSON.parse(bytes.toString('utf8')) as unknown;
    const validated = validateGhostManifest(raw);
    return validated.ok ? validated.manifest : null;
  } catch {
    return null;
  }
}

function installedGhostRawManifestDigest(dir: string): string | null {
  const manifest = installedGhostRawManifest(dir);
  return manifest ? ghostManifestDigest(manifest) : null;
}

/** 官方市场是否仍拥有当前落地包；带摘要的新记录必须与磁盘事实一致。 */
function serverMarketOwnsInstalledGhost(
  pluginId: string,
  ghost: InstalledGhost,
  record: PluginMarketInstallationRecord | null,
): boolean {
  if (
    !record?.installed ||
    (record.source !== 'market' && record.source !== 'legacy-adopted') ||
    record.pluginId !== pluginId
  ) {
    return false;
  }
  return (
    record.manifestDigest === undefined ||
    record.manifestDigest === installedGhostRawManifestDigest(ghost.dir)
  );
}

function canBackfillOfficialCindyGithubTrust(
  record: PluginMarketInstallationRecord,
  installed: InstalledGhost,
): boolean {
  return (
    record.installed &&
    record.source === 'market' &&
    record.manifestDigest !== undefined &&
    !hasCindyOfficialTrustMetadata(installed.dir) &&
    serverMarketOwnsInstalledGhost(record.pluginId, installed, record)
  );
}

function sameMarketInstallation(
  current: PluginMarketInstallationRecord,
  expected: PluginMarketInstallationRecord,
): boolean {
  return (
    current.pluginId === expected.pluginId &&
    current.releaseId === expected.releaseId &&
    current.version === expected.version &&
    current.sha256 === expected.sha256 &&
    current.manifestDigest === expected.manifestDigest
  );
}

/** Stable local facts reused while projecting one market catalog response. */
interface LocalInstallSnapshot {
  /** Installed Ghost runtime facts indexed once for one market operation. */
  ghostsById: ReadonlyMap<string, InstalledGhost>;
  /** Parsed provenance records from one ledger read. */
  installations: Readonly<Record<string, PluginMarketInstallationRecord>>;
  /** 每个已装插件的 locale 无关 manifest 摘要(一次快照只读一遍盘)。 */
  rawDigestByGhostId: ReadonlyMap<string, string | null>;
}

/**
 * 清理通告 pending 汇总的 owner 隔离键。**故意不含 generation**：同一 owner
 * 重新登录（换代）后，未消费的通知仍应展示，不随会话代际作废。
 */
function removalNoticeKey(owner: ActiveAppSession): string {
  return `${owner.mode}:${owner.dataOwnerId}`;
}

function upgradeNoticeKey(owner: ActiveAppSession): string {
  return `${owner.mode}:${owner.dataOwnerId}`;
}

/**
 * Plugin 市场的 main 端协调器。远程不可用时不碰本地目录；安装写路径必须依次
 * 通过 protocol parser、下载大小/SHA 校验、Ghost runtime validator 和原子换目录。
 */
export class PluginMarketService {
  private readonly mutations = new Map<string, Promise<unknown>>();
  private ledgerMutation: Promise<void> = Promise.resolve();
  private readonly pendingRemovalNotices = new Map<string, PluginRemovalUserNotice>();
  private readonly pendingUpgradeNotices = new Map<string, PluginUpgradeUserNotice>();

  constructor(
    private readonly api = new PluginMarketApi(undefined, () => app.getVersion()),
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
    let removals: PluginRemovalNotice[];
    try {
      const catalog = await this.api.listAll();
      plugins = visiblePluginsForOwner(owner, catalog.plugins);
      removals = catalog.removals;
    } catch (error) {
      log.warn('market list unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      // 本函数捕获 owner 后的每个 return 出口都必须先过 generation 校验:
      // listAll 失败(常因切号)时,不能把按旧账号发现的自定义项返回给当前会话。
      requireSameMarketOwner(owner);
      return {
        items: this.projectCustomItems(customEntries),
        unavailableReason: error instanceof Error ? error.message : String(error),
        customSourceNames,
      };
    }

    requireSameMarketOwner(owner);
    const ledger = this.ledgerForOwner(owner);
    await this.adoptLegacyInstallations(plugins, ledger, owner);
    await this.backfillOfficialCindyGithubTrust(ledger, owner);
    // A snapshot is passive discovery: an empty runtime list can be caused by
    // startup, an owner transition, or a transient filesystem view. Only an
    // explicit uninstall may turn that absence into installed=false/opt-out.
    await this.applyServerRemovals(removals, owner, ledger);
    // Explicit uninstall completion is allowed to finish its physical removal
    // before its ledger write. Wait for queued ledger mutations before deciding
    // whether a default plugin should be installed again.
    await this.ledgerMutation;
    // 自定义来源只影响自己的目录发现；暂时不可读的来源不能阻塞官方默认安装。
    // 已经落地的同 id 插件仍由 applyDefaultInstalls → installDetail 的本地事实检查保护。
    await this.applyDefaultInstalls(plugins, owner, ledger);
    await this.applyDefaultUpgrades(plugins, owner, ledger);
    requireSameMarketOwner(owner);
    const local = this.localInstallSnapshot(ledger);
    const serverItems = plugins.map((plugin) => this.toItem(plugin, local));
    const items = [...serverItems, ...this.projectCustomItems(customEntries, local)];
    // 聚合完成、返回 Renderer 前最后校验:账号在任一 await 间隙漂移则拒绝,
    // 不把按旧账号解析的自定义项/账本状态发给当前会话。
    requireSameMarketOwner(owner);
    return {
      items,
      unavailableReason: null,
      customSourceNames,
    };
  }

  /** 按当前 owner 消费一次清理汇总，避免组织插件名跨账号泄露。 */
  consumeRemovalNotice(): PluginRemovalUserNotice | null {
    const key = removalNoticeKey(captureMarketOwner());
    const notice = this.pendingRemovalNotices.get(key) ?? null;
    if (notice) this.pendingRemovalNotices.delete(key);
    return notice;
  }

  hasPendingRemovalNotice(): boolean {
    if (this.pendingRemovalNotices.size === 0) return false;
    try {
      return this.pendingRemovalNotices.has(removalNoticeKey(captureMarketOwner()));
    } catch {
      return false;
    }
  }

  consumeUpgradeNotice(): PluginUpgradeUserNotice | null {
    const key = upgradeNoticeKey(captureMarketOwner());
    const notice = this.pendingUpgradeNotices.get(key) ?? null;
    if (notice) this.pendingUpgradeNotices.delete(key);
    return notice;
  }

  hasPendingUpgradeNotice(): boolean {
    if (this.pendingUpgradeNotices.size === 0) return false;
    try {
      return this.pendingUpgradeNotices.has(upgradeNoticeKey(captureMarketOwner()));
    } catch {
      return false;
    }
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
      const catalog = visiblePluginsForOwner(owner, (await this.api.listAll()).plugins);
      requireSameMarketOwner(owner);
      const summary = catalog.find((candidate) => candidate.id === pluginId);
      if (!summary) {
        throwIpcError('NOT_FOUND', 'Plugin is unavailable to the active account');
      }
      const plugin = await this.api.detail(pluginId);
      requireSameMarketOwner(owner);
      assertDetailMatchesSummary(summary, plugin);
      if (owner.mode === 'local' && plugin.scope !== 'public') {
        throwIpcError('PERMISSION_DENIED', 'Local mode can only access public Plugins');
      }
      const compatible = validateGhostManifest(plugin.currentRelease.manifest);
      if (!compatible.ok) {
        throwIpcError('GHOST_FILE_INVALID', 'This Plugin manifest is not supported');
      }
      if (!manifestSupportsCurrentCindy(compatible.manifest)) {
        throwIpcError('NOT_FOUND', 'This Plugin is unavailable for this Cindy version');
      }
      return {
        ...this.toItem(plugin, this.localInstallSnapshot(this.ledgerForOwner(owner))),
        manifest: compatible.manifest,
      };
    });
  }

  async install(
    pluginId: string,
    options: PluginMarketInstallOptions,
    reviewPackagePermissions?: PackagePermissionReviewer,
  ): Promise<PluginMarketInstallResult> {
    const customRef = parseCustomMarketPluginId(pluginId);
    if (customRef) {
      return this.customInstall(customRef, options);
    }
    if (!isValidPluginResourceId(pluginId)) {
      throwIpcError('INVALID_PARAMS', 'Invalid Plugin ID');
    }
    this.requireConfigured();
    const owner = captureMarketOwner();
    const ledger = this.ledgerForOwner(owner);
    return this.withMutation(pluginId, async () => {
      requireSameMarketOwner(owner);
      const catalog = visiblePluginsForOwner(owner, (await this.api.listAll()).plugins);
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
      assertDetailMatchesSummary(selected, plugin);
      if (plugin.currentRelease.id !== options.expectedReleaseId) {
        throwIpcError(
          'PRECONDITION_FAILED',
          'Plugin release changed after permission review',
        );
      }
      const compatible = validateGhostManifest(plugin.currentRelease.manifest);
      const reviewed = validateGhostManifest(options.expectedManifest);
      if (
        !compatible.ok ||
        !reviewed.ok ||
        ghostManifestDigest(compatible.manifest) !== ghostManifestDigest(reviewed.manifest)
      ) {
        throwIpcError(
          'PRECONDITION_FAILED',
          'Plugin manifest changed after permission review',
        );
      }
      if (!manifestSupportsCurrentCindy(compatible.manifest)) {
        throwIpcError('NOT_FOUND', 'This Plugin is unavailable for this Cindy version');
      }
      const existing = getGhostManager()
        .list()
        .find((ghost) => ghost.manifest.id === plugin.ghostId);
      const ghost = await this.installDetail(
        plugin,
        {
          expectedInstalled: Boolean(existing),
          reviewedManifest: compatible.manifest,
          allowPermissionExpansion: options.allowPermissionExpansion === true,
          reviewPackagePermissions,
          ...(options.reviewedBaseline !== undefined
            ? { reviewedBaseline: options.reviewedBaseline }
            : {}),
        },
        owner,
        ledger,
      );
      return ghost ? { ghost } : { cancelled: true };
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
      this.withMutation(SOURCE_MUTATION_KEY, async () => {
        requireSameMarketOwner(owner);
        return this.sourceManagerForOwner(owner).addSource(input);
      }),
    );
  }

  /**
   * 经 Main 侧原生目录选择器添加本地市场来源。
   *
   * 本地目录的授权必须来自**用户在原生对话框里的选择**,而不是 Renderer 传来的
   * 绝对路径——Renderer 被 XSS 控制时,任何"它自己报的路径"都不构成用户授权
   * (electron-security 规则:不把 Renderer 路径当授权)。`defaultPath` 只是原生
   * 框的初始定位提示,不参与授权判定;用户在框里选中哪个目录,授权就是哪个。
   */
  async addLocalSourceFromPicker(
    defaultPath?: string,
  ): Promise<{ canceled: true } | { canceled: false; summary: MarketSourceSummary }> {
    // owner 在**打开选择器之前**捕获:原生框可以开着很久,期间切号的话,
    // 选完再捕获会把账户 A 发起的选择持久化进账户 B 的 store。返回后先校验
    // 同一代际,漂移即拒,再让 addSource 在同一 owner 下落盘。
    const owner = captureMarketOwner();
    const picked = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      ...(defaultPath ? { defaultPath } : {}),
    });
    const dir = picked.filePaths[0];
    if (picked.canceled || !dir) return { canceled: true };
    requireSameMarketOwner(owner);
    return { canceled: false, summary: await this.addSource({ source: dir }) };
  }

  async removeSource(name: string): Promise<{ ok: true }> {
    return this.runForOwner((owner) =>
      this.withMutation(SOURCE_MUTATION_KEY, async () => {
        requireSameMarketOwner(owner);
        return this.sourceManagerForOwner(owner).removeSource(name);
      }),
    );
  }

  async refreshSource(name: string): Promise<MarketSourceSummary> {
    return this.runForOwner((owner) =>
      this.withMutation(SOURCE_MUTATION_KEY, async () => {
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
      if (!manifestSupportsCurrentCindy(plugin.manifest)) {
        throwIpcError('NOT_FOUND', 'This Plugin is unavailable for this Cindy version');
      }
      return {
        ...this.customToItem(
          { config: discovered.config, plugin },
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
   *
   * 全程在 `withDiscoveredSource` 租约内执行:`plugin.dir` 指向 Git 源的缓存版本
   * 目录,打包要逐文件读它。租约必须一直持到打包结束,否则并发刷新的清理能在
   * 打包途中删掉该目录(安装随机失败或产物残缺)。
   */
  private async customInstall(
    ref: { marketName: string; ghostId: string },
    options: {
      expectedReleaseId: string;
      expectedManifest: GhostManifest;
      allowPermissionExpansion?: boolean;
      /** 扩权批准所依据的已装权限指纹;安装锁内复核,详见 install() 的说明。 */
      reviewedBaseline?: string;
    },
  ): Promise<{ ghost: InstalledGhost }> {
    const owner = captureMarketOwner();
    const ledger = this.ledgerForOwner(owner);
    const manager = this.sourceManagerForOwner(owner);
    // 互斥键与 uninstall 一致使用规范化 pluginId，保证同插件的安装/更新/卸载串行。
    return this.withMutation(customMarketPluginId(ref.marketName, ref.ghostId), async () => {
      requireSameMarketOwner(owner);
      return manager.withDiscoveredSource(ref.marketName, async (discovered) => {
        if (!discovered.result.ok) {
          throwIpcError(discovered.result.code, discovered.result.detail ?? discovered.result.code);
        }
        const plugin = discovered.result.marketplace.plugins.find(
          (candidate) => candidate.ghostId === ref.ghostId,
        );
        if (!plugin) {
          throwIpcError('NOT_FOUND', 'The Plugin is no longer listed by this marketplace');
        }
        if (!manifestSupportsCurrentCindy(plugin.manifest)) {
          throwIpcError('NOT_FOUND', 'This Plugin is unavailable for this Cindy version');
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
        // 所有权 = pluginId、来源指纹、安装时 manifest 摘要**同时**对上。市场名
        // 可复用(同名异源重加得到相同 pluginId);运行时的包在降级窗口可被旧版
        // 换成本地安装的任何东西(旧版不认识 custom 账本,不会更新它)——只凭
        // 记录存在就认领,会把别人的包错误归属给本来源并放行其更新覆盖。
        const sourceKey = marketSourceKey(discovered.config.source);
        // 审阅时刻的已装内容摘要:所有权/收养判定与提交段复核共用同一份快照。
        const reviewInstalledDigest = existing
          ? installedGhostRawManifestDigest(existing.dir)
          : null;
        const ownsInstall = Boolean(
          existing &&
            currentRecord?.installed &&
            currentRecord.pluginId === pluginId &&
            currentRecord.sourceKey === sourceKey &&
            currentRecord.manifestDigest != null &&
            currentRecord.manifestDigest === reviewInstalledDigest,
        );
        // 收养:运行时已装内容的声明与本来源候选**完全一致**(原始 manifest 摘要
        // 相等)时,允许在没有有效账本记录的情况下重装并补写溯源。这是"包已落位
        // 但账本写失败"(文件锁/磁盘错)后的唯一自愈入口——否则该插件永久 conflict、
        // 更新永被拒。安全性:收养走完整重装,落位字节来自本来源的包,且用户刚在
        // 确认框审阅过同一份 manifest;声明有任何差异都收养不了。
        const adoptable = Boolean(
          existing &&
            !ownsInstall &&
            reviewInstalledDigest === ghostManifestDigest(plugin.manifest),
        );
        if (existing && !ownsInstall && !adoptable) {
          throwIpcError('ALREADY_EXISTS', 'A local Plugin already uses this Plugin ID');
        }
        if (
          existing &&
          // 与服务端安装同口径:对比已装 manifest 与候选包,只有新增权限才要求
          // 显式确认(upstream 已回退批准 receipt 基线,这里跟随主干口径)。
          diffGhostPermissionItems(existing.manifest, plugin.manifest).added.length > 0
        ) {
          if (options.allowPermissionExpansion !== true) {
            throwIpcError('PRECONDITION_FAILED', 'Plugin permissions changed and require review');
          }
          assertReviewedBaselineFresh(existing.manifest, options.reviewedBaseline);
        }
        requireSameMarketOwner(owner);
        const ghost = await installCustomMarketPlugin({
          pluginDir: plugin.dir,
          expected: options.expectedManifest,
          beforeCommit: async () => {
            requireSameMarketOwner(owner);
            // 所选来源必须**仍然存在且仍是同一个来源**:移除来源会先拿
            // SOURCE_MUTATION_KEY 删掉配置,租约只保住了目录字节;没有这道核对,
            // 安装会把一个已经没有对应来源的包装进运行时并写下孤儿账本记录。
            // 同名异源的重加也在这里被指纹拦下。
            const live = manager.getConfig(ref.marketName);
            if (!live || marketSourceKey(live.source) !== sourceKey) {
              throwIpcError(
                'PRECONDITION_FAILED',
                'The marketplace source changed during the install',
              );
            }
            // runtime 所有权也要复核:打包窗口(秒到分钟级)内,
            // 本地插件页可以卸载同 id 插件(那条路径不持本服务的互斥锁)——不查
            // 会把"更新"降级成"首装+带电启用";反向地,窗口内新装入的同 id
            // 本地 .cindy 会被更新分支静默覆盖,还绕过了审阅时跳过的权限 diff。
            // 判据与审阅时刻同一份:在场状态一致 + 已装内容摘要未变。
            const current = getGhostManager()
              .list()
              .find((ghost) => ghost.manifest.id === plugin.ghostId);
            if (Boolean(current) !== Boolean(existing)) {
              throwIpcError(
                'PRECONDITION_FAILED',
                current
                  ? 'A local Plugin appeared with this Plugin ID during the install'
                  : 'Plugin was uninstalled while the install was packaging',
              );
            }
            if (current && installedGhostRawManifestDigest(current.dir) !== reviewInstalledDigest) {
              throwIpcError('PRECONDITION_FAILED', 'Installed Plugin changed during the install');
            }
          },
          // 复核与落位的双重互斥:
          // - SOURCE_MUTATION_KEY:beforeCommit 返回后包检查还要跑一段,期间不能
          //   让来源被增删,否则复核结论在落位前过期。
          // - withGhostInstallLock(ghostId):与本地 .cindy 装入/更新/卸载共用同一
          //   按 id 互斥,beforeCommit 的 runtime 复核到 installOrUpdate 落位之间,
          //   同 id 的本地装入/卸载插不进来(否则复核仍会在落位前过期)。
          withCommitLock: (fn) =>
            this.withMutation(SOURCE_MUTATION_KEY, () =>
              withGhostInstallLock(plugin.ghostId, fn),
            ),
          // 溯源写入仍在上面那把 ghost 锁内(afterCommit 由 commit 段调用):
          // 放到锁外时,本地装入能插在"包已落位"与"写下溯源"之间换掉同 id 的包。
          // 锁序:pluginId → SOURCE_MUTATION_KEY → ghostId → ledgerMutation。
          afterCommit: async () => {
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
                // 来源指纹与 pluginId 一起构成所有权:同名异源的重加对不上它。
                sourceKey,
                // 落位那一刻的 manifest 摘要:降级期间运行时被换成别的包后,认领
                // 对不上摘要即失效。摘要来自发现层的原始 manifest(校验器输出),
                // **不是**安装返回的 ghost.manifest——后者按当前界面语言本地化过,
                // 切语言会被误判成包被替换。
                manifestDigest: ghostManifestDigest(plugin.manifest),
              });
            });
          },
        });
        return { ghost };
      });
    });
  }

  /** 已配置来源名（按添加顺序）；存储读取失败时降级为空数组。 */
  private customSourceNamesSafe(owner?: ActiveAppSession): string[] {
    try {
      // 与 sourceManagerForOwner/ledgerForOwner 同一约定:先确认会话没漂移,
      // 再按 owner 解析路径——否则切号窗口里会读到新账号的 sources.v1.json。
      if (owner) requireSameMarketOwner(owner);
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
        if (result.marketplace.unreadableCount > 0) {
          log.warn('custom marketplace has unreadable plugin entries', {
            market: config.name,
            unreadableCount: result.marketplace.unreadableCount,
          });
        }
        for (const plugin of result.marketplace.plugins) {
          if (!manifestSupportsCurrentCindy(plugin.manifest)) continue;
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
    local?: LocalInstallSnapshot,
  ): PluginMarketItem[] {
    const snapshot = local ?? this.localInstallSnapshot();
    return entries.map((entry) => this.customToItem(entry, snapshot));
  }

  /** 自定义市场项的状态机与服务端 toItem 完全一致（冲突 / 首装 / 更新 / 已装）。 */
  private customToItem(
    entry: CustomMarketEntry,
    local: LocalInstallSnapshot,
  ): PluginMarketItem {
    const { config, plugin } = entry;
    const pluginId = customMarketPluginId(config.name, plugin.ghostId);
    const releaseId = customMarketReleaseId(config.name, plugin.ghostId, plugin.version);
    const ghost = local.ghostsById.get(plugin.ghostId);
    const record = local.installations[plugin.ghostId];
    // 所有权 = pluginId + 来源指纹 + 安装时 manifest 摘要都对上,与 customInstall
    // 同口径:同名异源的重加、降级期间被本地替换的包,都不是所有者,列表如实标
    // conflict 而不是 update-available。
    const ownsInstall = Boolean(
      ghost &&
        record?.installed &&
        record.pluginId === pluginId &&
        record.sourceKey === marketSourceKey(config.source) &&
        record.manifestDigest != null &&
        record.manifestDigest === local.rawDigestByGhostId.get(plugin.ghostId),
    );
    // 收养口径与 customInstall 一致:运行时内容声明与候选完全一致时不标 conflict,
    // 投影成可安装——这是账本写失败后的自愈入口(conflict 在 UI 被禁用,没有它
    // 用户连重试的按钮都没有)。
    const adoptable = Boolean(
      ghost &&
        !ownsInstall &&
        local.rawDigestByGhostId.get(plugin.ghostId) === ghostManifestDigest(plugin.manifest),
    );
    // 市场目录只用于发现，不声明未安装 ghostId 的所有权。只有运行时已经存在
    // 同 id 且不属于当前来源时才冲突，避免官方或其它市场接管用户已装插件。
    const conflict = Boolean(ghost && !ownsInstall && !adoptable);
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
      // ghost.json 来自不受信市场仓库:双向控制符可把市场卡片上的署名/说明
      // 显示成另一副样子(视觉欺骗),控制字符可撑破布局。展示投影一律剥掉
      // (保留换行);市场名闸在 discover,这里补齐插件侧同一口径。
      name: stripDirectionalControls(plugin.manifest.name),
      description: plugin.manifest.description != null
        ? stripDirectionalControls(plugin.manifest.description)
        : null,
      author: plugin.manifest.author != null
        ? stripDirectionalControls(plugin.manifest.author)
        : null,
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
    let result: T;
    try {
      result = await operation(owner);
    } catch (error) {
      // 异常出口同样要校验代际:git 类错误的 detail 刻意保留了仓库 URL 等
      // 上一账号的私有信息,操作期间切了号就不能把它交给当前 Renderer——
      // 统一替换成账号漂移错误,原始失败对当前会话本来就没有意义。
      requireSameMarketOwner(owner);
      throw error;
    }
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
    plugin: VisiblePluginSummary | VisiblePluginDetail,
    options: {
      /** 手动安装时已向用户展示；默认安装时作为自动授权的目录权限上限。 */
      reviewedManifest?: GhostManifest;
      allowPermissionExpansion?: boolean;
      /** 安装前权限确认所依据的已装权限指纹。 */
      reviewedBaseline?: string;
      /** 真实包比展示清单多权限时，在当前安装事务内立即询问发起窗口。 */
      reviewPackagePermissions?: PackagePermissionReviewer;
      beforeCommitInLock?: () => void;
      silentBaselineMismatch?: boolean;
      /** 确认操作时的安装意图;下载窗口期目标被另一窗口卸载时拒绝滑入首装。 */
      expectedInstalled: boolean;
    } = { expectedInstalled: false },
    owner = captureMarketOwner(),
    ledger = this.ledgerForOwner(owner),
  ): Promise<InstalledGhost | null> {
    requireSameMarketOwner(owner);
    if (owner.mode === 'local' && plugin.scope !== 'public') {
      throwIpcError('PERMISSION_DENIED', 'Local mode can only access public Plugins');
    }
    const existing = getGhostManager()
      .list()
      .find((ghost) => ghost.manifest.id === plugin.ghostId);
    const currentRecord = ledger.installationForGhost(plugin.ghostId);
    if (existing && !serverMarketOwnsInstalledGhost(plugin.id, existing, currentRecord)) {
      throwIpcError('ALREADY_EXISTS', 'A local Plugin already uses this Plugin ID');
    }

    const reviewedManifest = options.reviewedManifest
      ? validateGhostManifest(options.reviewedManifest)
      : null;
    if (reviewedManifest && !reviewedManifest.ok) {
      throwIpcError('GHOST_FILE_INVALID', 'This Plugin manifest is not supported');
    }
    this.assertServerPreviewExpansionApproved(
      existing?.manifest ?? null,
      reviewedManifest?.manifest,
      options.allowPermissionExpansion,
      options.reviewedBaseline,
      options.silentBaselineMismatch,
    );

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
      try {
        return await this.commitDownloadedPackage(
          tempPath,
          plugin,
          {
            expectedInstalled: options.expectedInstalled,
            ...(reviewedManifest?.ok
              ? { reviewedManifest: reviewedManifest.manifest }
              : {}),
            allowPermissionExpansion: options.allowPermissionExpansion,
            reviewedBaseline: options.reviewedBaseline,
            beforeCommitInLock: options.beforeCommitInLock,
            silentBaselineMismatch: options.silentBaselineMismatch,
          },
          owner,
          ledger,
        );
      } catch (error) {
        if (!(error instanceof GhostPackagePermissionReviewRequiredError)) throw error;
        requireSameMarketOwner(owner);
        const approved = await options.reviewPackagePermissions?.(error.review);
        requireSameMarketOwner(owner);
        if (approved !== true) return null;
        return this.commitDownloadedPackage(
          tempPath,
          plugin,
          {
            expectedInstalled: options.expectedInstalled,
            ...(reviewedManifest?.ok
              ? { reviewedManifest: reviewedManifest.manifest }
              : {}),
            allowPermissionExpansion: options.allowPermissionExpansion,
            reviewedBaseline: options.reviewedBaseline,
            approvedPackageSha256: error.review.packageSha256,
            approvedPackageBaseline: error.review.installedBaseline,
            beforeCommitInLock: options.beforeCommitInLock,
            silentBaselineMismatch: options.silentBaselineMismatch,
          },
          owner,
          ledger,
        );
      }
    } finally {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  /** 把已验证临时包提交到运行时；确认前后复用同一文件。 */
  private async commitDownloadedPackage(
    tempPath: string,
    plugin: VisiblePluginSummary | VisiblePluginDetail,
    options: {
      reviewedManifest?: GhostManifest;
      allowPermissionExpansion?: boolean;
      reviewedBaseline?: string;
      approvedPackageSha256?: string;
      approvedPackageBaseline?: string | null;
      beforeCommitInLock?: () => void;
      silentBaselineMismatch?: boolean;
      expectedInstalled: boolean;
    },
    owner: ActiveAppSession,
    ledger: PluginMarketLedger,
  ): Promise<InstalledGhost> {
    return withGhostInstallLock(plugin.ghostId, async () => {
      const installedNow = getGhostManager()
        .list()
        .find((ghost) => ghost.manifest.id === plugin.ghostId);
      const currentRecordNow = ledger.installationForGhost(plugin.ghostId);
      if (Boolean(installedNow) !== options.expectedInstalled) {
        throwIpcError(
          'PRECONDITION_FAILED',
          installedNow
            ? 'A local Plugin appeared with this Plugin ID during the install'
            : 'Plugin was uninstalled while the update was downloading',
        );
      }
      if (
        installedNow &&
        !serverMarketOwnsInstalledGhost(plugin.id, installedNow, currentRecordNow)
      ) {
        throwIpcError('ALREADY_EXISTS', 'A local Plugin already uses this Plugin ID');
      }
      requireSameMarketOwner(owner);
      this.assertServerPreviewExpansionApproved(
        installedNow?.manifest ?? null,
        options.reviewedManifest,
        options.allowPermissionExpansion,
        options.reviewedBaseline,
        options.silentBaselineMismatch,
      );
      const installedRawManifest = installedNow
        ? installedGhostRawManifest(installedNow.dir)
        : null;
      const permissionBaselineManifest =
        installedRawManifest &&
        currentRecordNow?.installed &&
        (currentRecordNow.source === 'market' ||
          currentRecordNow.source === 'legacy-adopted') &&
        currentRecordNow.manifestDigest === ghostManifestDigest(installedRawManifest)
          ? installedRawManifest
          : null;
      const installed = await installOrUpdateMarketGhostPackage(tempPath, {
        ghostId: plugin.ghostId,
        version: plugin.currentRelease.version,
        ...(plugin.ghostId === 'cindy-github' ? { officialCindyGithub: true } : {}),
        ...(options.reviewedManifest
          ? {
              reviewedManifest: options.reviewedManifest,
              ...(permissionBaselineManifest
                ? { permissionBaselineManifest }
                : {}),
            }
          : {}),
        ...(options.approvedPackageSha256 !== undefined
          ? {
              approvedPackageSha256: options.approvedPackageSha256,
              ...(options.approvedPackageBaseline !== null
                ? { reviewedBaseline: options.approvedPackageBaseline }
                : {}),
            }
          : {}),
        ...(options.beforeCommitInLock ? { beforeCommitInLock: options.beforeCommitInLock } : {}),
      });
      await this.withCapturedLedgerMutation(ledger, () => {
        ledger.upsertInstallation(recordFrom(plugin, 'market', installed));
      });
      return installed;
    });
  }

  private assertServerPreviewExpansionApproved(
    installed: GhostManifest | null,
    reviewedManifest: GhostManifest | undefined,
    allowPermissionExpansion: boolean | undefined,
    reviewedBaseline: string | undefined,
    silentBaselineMismatch = false,
  ): void {
    if (
      !installed ||
      !reviewedManifest ||
      diffGhostPermissionItems(installed, reviewedManifest).added.length === 0
    ) {
      return;
    }
    if (allowPermissionExpansion !== true) {
      throwIpcError('PRECONDITION_FAILED', 'Plugin permissions changed and require review');
    }
    if (
      silentBaselineMismatch &&
      reviewedBaseline !== undefined &&
      ghostPermissionBaselineKey(installed) !== reviewedBaseline
    ) {
      throw new SilentUpgradeStaleBaselineError('Installed Plugin permissions changed');
    }
    assertReviewedBaselineFresh(installed, reviewedBaseline);
  }

  private requireConfigured(): void {
    if (!getClientEndpoint('pluginApiBaseUrl')) {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'Plugin market is not configured');
    }
  }

  private toItem(
    plugin: VisiblePluginSummary,
    local = this.localInstallSnapshot(),
  ): PluginMarketItem {
    const ghost = local.ghostsById.get(plugin.ghostId);
    const record = local.installations[plugin.ghostId];
    const ownsInstall = Boolean(
      ghost && serverMarketOwnsInstalledGhost(plugin.id, ghost, record ?? null),
    );
    // 未安装的其它市场条目不拥有 ghostId；真实已安装插件才建立所有权边界。
    const conflict = Boolean(ghost && !ownsInstall);
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

  /**
   * 旧版 server-market 安装已经有 Host ledger + manifestDigest，但尚未写
   * cindy-official receipt。不能只按 manifestDigest 抬权：攻击者可保留清单、
   * 只替换 main.js。这里按 ledger 的 releaseId + sha256 重新下载原官方包，
   * 校验后原位恢复官方字节并由市场安装路径写 receipt。
   * legacy-adopted 只是“按 id 收养”的历史记录，绝不进入本路径。
   */
  private async backfillOfficialCindyGithubTrust(
    ledger: PluginMarketLedger,
    owner: ActiveAppSession,
  ): Promise<void> {
    const record = ledger.installationForGhost('cindy-github');
    requireSameMarketOwner(owner);
    const installed = getGhostManager().list().find((ghost) => ghost.manifest.id === 'cindy-github');
    if (!record || !installed || !canBackfillOfficialCindyGithubTrust(record, installed)) return;
    const tempPath = path.join(
      app.getPath('temp'),
      `cindy-plugin-trust-backfill-${crypto.randomUUID()}.cindy`,
    );
    try {
      const download = await this.api.download(record.pluginId, record.releaseId);
      requireSameMarketOwner(owner);
      if (download.sha256 !== record.sha256) {
        log.warn('cindy-github trust backfill release hash changed');
        return;
      }
      const expiresAt = Date.parse(download.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        log.warn('cindy-github trust backfill authorization expired');
        return;
      }
      await downloadVerifiedPlugin(download.url, download, tempPath);
      requireSameMarketOwner(owner);
      await withGhostInstallLock('cindy-github', async () => {
        requireSameMarketOwner(owner);
        const currentRecord = ledger.installationForGhost('cindy-github');
        const currentInstalled = getGhostManager()
          .list()
          .find((ghost) => ghost.manifest.id === 'cindy-github');
        if (
          !currentRecord?.installed ||
          currentRecord.source !== 'market' ||
          !currentInstalled ||
          !sameMarketInstallation(currentRecord, record) ||
          !canBackfillOfficialCindyGithubTrust(currentRecord, currentInstalled)
        ) {
          return;
        }
        await installOrUpdateMarketGhostPackage(tempPath, {
          ghostId: 'cindy-github',
          version: currentRecord.version,
          officialCindyGithub: true,
        });
      });
      requireSameMarketOwner(owner);
    } catch (error) {
      log.warn('cindy-github trust backfill deferred', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private async applyServerRemovals(
    removals: readonly PluginRemovalNotice[],
    owner: ActiveAppSession,
    ledger: PluginMarketLedger,
  ): Promise<void> {
    if (removals.length === 0) return;
    const skip = (removal: PluginRemovalNotice, reason: string): undefined => {
      log.info('server plugin removal skipped', {
        pluginId: removal.pluginId,
        ghostId: removal.ghostId,
        reason,
      });
      return undefined;
    };
    // 五道闸的账本侧判定。锁外先用一次性快照预筛(绝大多数通告在这里就被
    // 挡下,不必为它们各自重读账本/进互斥段);幸存候选进锁后**必须**用
    // installationForGhost 即时复检——快照在等锁期间可能过时,权威判定只认锁内。
    const ledgerGateReason = (
      record: PluginMarketInstallationRecord | null | undefined,
      removal: PluginRemovalNotice,
    ): string | null => {
      if (!record) return 'ledger-record-missing';
      if (record.pluginId !== removal.pluginId) return 'plugin-id-mismatch';
      if (record.source !== 'market' && record.source !== 'legacy-adopted') {
        return 'non-server-source';
      }
      if (!record.installed) return 'already-not-installed';
      if (record.scope !== 'organization') return 'non-organization-scope';
      return null;
    };
    const snapshot = ledger.read().installations;
    // runtime 在场判定与取名共用一次目录扫描(list 会读每个包的 manifest 与
    // 图标),首个幸存候选时才建;清理会改目录,但每条清理都在自己的互斥段里
    // 由账本复检把关,这张表只回答"清理前它在不在场、叫什么"。
    let ghostsById: Map<string, InstalledGhost> | null = null;
    const removedNames: Array<string | null> = [];
    for (const removal of removals) {
      if (removal.action !== 'purge') {
        skip(removal, 'unsupported-action');
        continue;
      }
      const prefilterReason = ledgerGateReason(snapshot[removal.ghostId], removal);
      if (prefilterReason) {
        skip(removal, prefilterReason);
        continue;
      }
      try {
        const removed = await this.withMutation(removal.pluginId, async () => {
          requireSameMarketOwner(owner);
          const record = ledger.installationForGhost(removal.ghostId);
          const reason = ledgerGateReason(record, removal);
          if (reason) return skip(removal, reason);

          ghostsById ??= new Map(
            getGhostManager().list().map((ghost) => [ghost.manifest.id, ghost]),
          );
          const installed = ghostsById.get(removal.ghostId);
          if (!installed) return skip(removal, 'runtime-not-installed');
          // 溯源摘要闸:账本记录只证明"市场装过这个 ghostId",不证明现在占位的
          // 还是那份包——本地 .cindy 可原位替换,替换不写市场账本。摘要对不上
          // (含 ghost.json 读不出)即视为非服务端安装,不删,与更新路径/连接授权
          // 的 fail-closed 判据同口径。缺摘要的存量记录放行:被下架的插件已不在
          // 目录里,digest 迁移永远补不上,fail-closed 会让老安装的合法清理永久失效。
          if (
            record?.manifestDigest != null &&
            installedGhostRawManifestDigest(installed.dir) !== record.manifestDigest
          ) {
            return skip(removal, 'manifest-digest-mismatch');
          }

          await uninstallGhostAndCleanup(removal.ghostId, { skipMarketLedger: true });
          await this.withCapturedLedgerMutation(ledger, () => {
            // userId=null 即不写退订(拍板:purge 对 defaultInstallOptOuts 只读,
            // 不写也不清;重新上架后按用户既有退订状态决定是否自动装回)。
            ledger.markRemoved(removal.ghostId, null);
          });
          log.info('server plugin removal applied', {
            pluginId: removal.pluginId,
            ghostId: removal.ghostId,
          });
          return {
            name: stripDirectionalControls(installed.manifest.name) || null,
          };
        });
        if (removed) removedNames.push(removed.name);
      } catch (error) {
        log.error('server plugin removal failed', {
          pluginId: removal.pluginId,
          ghostId: removal.ghostId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (removedNames.length === 0) return;
    const key = removalNoticeKey(owner);
    const count =
      (this.pendingRemovalNotices.get(key)?.count ?? 0) + removedNames.length;
    this.pendingRemovalNotices.set(key, {
      count,
      name: count === 1 ? (removedNames[0] ?? null) : null,
    });
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
      const state = this.toItem(summary, local).installState;
      if (state !== 'not-installed') continue;
      try {
        await this.withMutation(summary.id, async () => {
          requireSameMarketOwner(owner);
          const freshLedgerData = ledger.read();
          if (freshLedgerData.defaultInstallOptOuts[installSubject]?.includes(summary.id)) {
            return;
          }
          const freshLocal = this.localInstallSnapshot(ledger, freshLedgerData.installations);
          if (this.toItem(summary, freshLocal).installState !== 'not-installed') {
            return;
          }
          const detail = await this.api.detail(summary.id);
          requireSameMarketOwner(owner);
          assertDetailMatchesSummary(summary, detail);
          const reviewedManifest = validateGhostManifest(detail.currentRelease.manifest);
          if (!reviewedManifest.ok) {
            throwIpcError('GHOST_FILE_INVALID', 'This Plugin manifest is not supported');
          }
          // 装完即开语义已收敛进市场安装入口本身,这里无需再显式声明。
          await this.installDetail(
            detail,
            {
              expectedInstalled: false,
              // 默认安装没有用户发起窗口：目录 manifest 是自动安装可接受的权限
              // 上限；真实包若额外扩权，installDetail 会安全取消并等待用户之后
              // 从详情页手动安装、在原请求窗口完成确认。
              reviewedManifest: reviewedManifest.manifest,
              // 下载期间用户可能从本地插件页完成显式卸载。最终落位前在
              // ghostId 锁内重读卸载意图，不能让旧 snapshot 把插件装回来。
              beforeCommitInLock: () => {
                const commitLedgerData = ledger.read();
                if (
                  commitLedgerData.defaultInstallOptOuts[installSubject]?.includes(summary.id)
                ) {
                  throw new SilentDefaultInstallCancelledError(
                    'Default Plugin was explicitly uninstalled',
                  );
                }
                const commitLocal = this.localInstallSnapshot(
                  ledger,
                  commitLedgerData.installations,
                );
                if (this.toItem(summary, commitLocal).installState !== 'not-installed') {
                  throw new SilentDefaultInstallCancelledError(
                    'Default Plugin install state changed',
                  );
                }
              },
            },
            owner,
            ledger,
          );
        });
      } catch (error) {
        // 单个默认插件失败不拖垮整个市场；下次同步可重试。
        if (!(error instanceof SilentDefaultInstallCancelledError)) {
          log.warn('default plugin install failed', {
            pluginId: summary.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  private async applyDefaultUpgrades(
    plugins: readonly VisiblePluginSummary[],
    owner: ActiveAppSession,
    ledger: PluginMarketLedger,
  ): Promise<void> {
    const local = this.localInstallSnapshot(ledger);
    const completed: Array<{
      name: string | null;
      permissions: PluginUpgradePermissionNotice[];
    }> = [];
    for (const summary of plugins) {
      if (!summary.defaultInstall || summary.scope !== 'organization') continue;
      if (this.toItem(summary, local).installState !== 'update-available') continue;
      if (
        hasPendingGhostCalls(summary.ghostId) ||
        hasRunningGhostErrand(summary.ghostId) ||
        hasRunningGhostCindyWork(summary.ghostId)
      ) continue;
      try {
        await this.withMutation(summary.id, async () => {
          requireSameMarketOwner(owner);
          if (
            hasPendingGhostCalls(summary.ghostId) ||
            hasRunningGhostErrand(summary.ghostId) ||
            hasRunningGhostCindyWork(summary.ghostId)
          ) {
            throw new SilentUpgradeBusyError('Plugin is busy');
          }
          const freshLocal = this.localInstallSnapshot(ledger);
          if (this.toItem(summary, freshLocal).installState !== 'update-available') {
            log.debug?.('default plugin upgrade already reconciled', {
              pluginId: summary.id,
            });
            return;
          }
          const freshInstalled = freshLocal.ghostsById.get(summary.ghostId);
          const reviewedBaseline = freshInstalled
            ? ghostPermissionBaselineKey(freshInstalled.manifest)
            : undefined;
          const detail = await this.api.detail(summary.id);
          requireSameMarketOwner(owner);
          assertDetailMatchesSummary(summary, detail);
          const reviewedManifest = validateGhostManifest(detail.currentRelease.manifest);
          if (!reviewedManifest.ok) throwIpcError('GHOST_FILE_INVALID', 'This Plugin manifest is not supported');
          if (!manifestSupportsCurrentCindy(reviewedManifest.manifest)) {
            log.warn('default plugin upgrade skipped for Cindy version', {
              pluginId: summary.id,
              minCindyVersion: reviewedManifest.manifest.minCindyVersion,
            });
            return;
          }
          const installed = await this.installDetail(detail, {
            expectedInstalled: true,
            reviewedManifest: reviewedManifest.manifest,
            allowPermissionExpansion: true,
            reviewedBaseline,
            silentBaselineMismatch: true,
            beforeCommitInLock: () => {
              if (
                hasPendingGhostCalls(summary.ghostId) ||
                hasRunningGhostErrand(summary.ghostId) ||
                hasRunningGhostCindyWork(summary.ghostId)
              ) {
                throw new SilentUpgradeBusyError('Plugin is busy');
              }
            },
          }, owner, ledger);
          if (installed) {
            const addedPermissions = freshInstalled
              ? diffGhostPermissionItems(freshInstalled.manifest, reviewedManifest.manifest).added
                  .map(({ key, labelKey, labelArgs }) => ({
                    key,
                    labelKey,
                    ...(labelArgs ? { labelArgs } : {}),
                  }))
              : [];
            completed.push({
              name: stripDirectionalControls(installed.manifest.name) || null,
              permissions: addedPermissions,
            });
          }
        });
      } catch (error) {
        if (!(error instanceof SilentUpgradeBusyError || error instanceof SilentUpgradeStaleBaselineError)) {
          log.warn('default plugin upgrade failed', {
            pluginId: summary.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    if (completed.length > 0) {
      const key = upgradeNoticeKey(owner);
      const count = (this.pendingUpgradeNotices.get(key)?.count ?? 0) + completed.length;
      const hasPermissionExpansion =
        (this.pendingUpgradeNotices.get(key)?.hasPermissionExpansion ?? false) ||
        completed.some((entry) => entry.permissions.length > 0);
      this.pendingUpgradeNotices.set(key, {
        count,
        name: count === 1 ? (completed[0]?.name ?? null) : null,
        permissions:
          count === 1 && completed[0]?.permissions.length
            ? completed[0].permissions
            : null,
        hasPermissionExpansion,
      });
    }
  }

  private localInstallSnapshot(
    ledger = this.ledger,
    installations = ledger.read().installations,
  ): LocalInstallSnapshot {
    const ghosts = getGhostManager().list();
    return {
      ghostsById: new Map(ghosts.map((ghost) => [ghost.manifest.id, ghost])),
      installations,
      rawDigestByGhostId: new Map(
        ghosts.map((ghost) => [ghost.manifest.id, installedGhostRawManifestDigest(ghost.dir)]),
      ),
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

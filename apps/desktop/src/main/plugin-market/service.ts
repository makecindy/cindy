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
  diffInstalledGhostPermissionItems,
  GHOST_ICON_MAX_BYTES,
  ghostInstallApprovalToken,
  ghostPermissionBaselineKey,
  ghostIconMimeType,
  isSafeGhostRelativePath,
  isOfficialGhostId,
  validateGhostManifest,
  type GhostManifest,
  type InstalledGhost,
} from '../../shared/ghost.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import type {
  MarketSourceConfig,
  MarketSourceSummary,
  PluginMarketDetail,
  PluginMarketInstallOptions,
  PluginMarketInstallResult,
  PluginMarketItem,
  PluginMarketLocalIconRequest,
  PluginMarketLocalIconResult,
  PluginMarketPackageReviewFacts,
  PluginRecoveryCandidate,
  PluginRecoveryDecision,
  PluginRecoveryResolution,
  PluginRecoveryStatus,
  PluginRecoveryUserNotice,
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
  PLUGIN_MARKET_CUSTOM_ICON_PROJECTION_TOKEN_LENGTH,
  PLUGIN_MARKET_CUSTOM_ICON_SOURCE_TOKEN_LENGTH,
  pluginMarketCustomIconProjectionToken,
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
  readBoundedFileNoFollowWithStat,
} from '../utils/readBoundedFile.js';
import { readInstalledGhostManifest } from '../installedGhostManifest.js';
import { withGhostInstallLock } from '../cindy-brain/ghostInstallLock.js';
import { GhostPackagePermissionReviewRequiredError } from '../cindy-brain/packagePermissionReview.js';
import {
  installedGhostContentDigest,
  packableGhostSourceContentDigest,
} from '../cindy-brain/ghostPackageContentDigest.js';
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
import {
  PluginRecoveryStore,
  pluginInstallationKey,
  pluginRecoveryCandidateKey,
  type PluginRecoveryDecisionRecord,
  type PluginRemovalIntent,
} from './recoveryStore.js';

const log = createLogger('plugin-market');

type PackagePermissionReviewer = (facts: PluginMarketPackageReviewFacts) => Promise<boolean>;

class SilentUpgradeBusyError extends Error {}
class SilentDefaultInstallCancelledError extends Error {}
class SilentUpgradeStaleBaselineError extends Error {}

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
const CUSTOM_ICON_PROJECTION_TOKEN_RE = /^[a-f0-9]{16}$/;
const CUSTOM_MARKET_SNAPSHOT_TIMEOUT_MS = 3_000;

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
        (plugin) => plugin.scope === 'public' && isGhostAvailableForActiveSession(plugin.ghostId),
      )
    : [...plugins];
}

/** 单条详情由服务端完成账号授权；本地模式仍需执行客户端能力边界。 */
function requirePluginVisibleForOwner(
  owner: ActiveAppSession,
  plugin: VisiblePluginSummary | VisiblePluginDetail,
): void {
  if (
    owner.mode === 'local' &&
    (plugin.scope !== 'public' || !isGhostAvailableForActiveSession(plugin.ghostId))
  ) {
    throwIpcError('NOT_FOUND', 'Plugin is unavailable to the active account');
  }
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

/**
 * Builds a provisional market record for a ledgerless legacy install. The
 * caller must prove the complete installed directory matches this exact
 * release before persisting the record; identity and manifest alone are not
 * provenance.
 */
function provisionalLegacyPurgeRecord(
  plugin: VisiblePluginSummary,
  removal: PluginRemovalNotice,
  ghost: InstalledGhost,
): PluginMarketInstallationRecord | null {
  if (
    removal.action !== 'purge' ||
    plugin.id !== removal.pluginId ||
    plugin.ghostId !== removal.ghostId ||
    plugin.scope !== 'organization' ||
    plugin.organizationId !== removal.organizationId ||
    ghost.manifest.id !== plugin.ghostId ||
    ghost.manifest.version !== plugin.currentRelease.version
  ) {
    return null;
  }
  const rawManifest = installedGhostRawManifest(ghost.dir);
  if (
    !rawManifest ||
    rawManifest.id !== plugin.ghostId ||
    rawManifest.version !== plugin.currentRelease.version
  ) {
    return null;
  }
  return {
    pluginId: plugin.id,
    ghostId: plugin.ghostId,
    releaseId: plugin.currentRelease.id,
    version: plugin.currentRelease.version,
    sha256: plugin.currentRelease.sha256,
    scope: plugin.scope,
    organizationId: plugin.organizationId,
    source: 'market',
    // Persist fail-closed before physical cleanup: if the process exits after
    // this record is written, the next purge attempt must verify full content
    // again instead of treating provenance as committed.
    installed: false,
    updatedAt: new Date().toISOString(),
    manifestDigest: ghostManifestDigest(rawManifest),
  };
}

function ghostIdCounts(plugins: readonly VisiblePluginSummary[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const plugin of plugins) {
    counts.set(plugin.ghostId, (counts.get(plugin.ghostId) ?? 0) + 1);
  }
  return counts;
}

function activePurgeKeys(removals: readonly PluginRemovalNotice[]): Set<string> {
  return new Set(
    removals
      .filter((removal) => removal.action === 'purge')
      .map((removal) => `${removal.pluginId}\0${removal.ghostId}`),
  );
}

function withoutActivePurges(
  plugins: readonly VisiblePluginSummary[],
  removals: readonly PluginRemovalNotice[],
): VisiblePluginSummary[] {
  const purges = activePurgeKeys(removals);
  return plugins.filter((plugin) => !purges.has(`${plugin.id}\0${plugin.ghostId}`));
}

function manifestSupportsCurrentCindy(manifest: GhostManifest): boolean {
  return supportsCindyVersion(app.getVersion(), manifest.minCindyVersion);
}

/** 自定义市场发现到的单个插件条目（快照投影的原料）。 */
interface CustomMarketEntry {
  config: MarketSourceConfig;
  plugin: DiscoveredMarketPlugin;
  iconKey: string | null;
}

interface CustomMarketDiscovery {
  entries: CustomMarketEntry[];
  /** A failed/partially unreadable source cannot prove that a recorded item disappeared. */
  indeterminateSourceKeys: ReadonlySet<string>;
  /** False when even enumerating the configured sources failed. */
  complete: boolean;
  unavailableSourceNames: string[];
}

interface CustomMarketDiscoveryProgress {
  entries: CustomMarketEntry[];
  settledSourceNames: Set<string>;
  unavailableSourceNames: Set<string>;
  indeterminateSourceKeys: Set<string>;
}

export interface PluginMarketSnapshotOptions {
  /** Renderer 目录请求先返回；默认安装/升级在同一 owner 上后台补做。 */
  deferDefaultReconciliation?: boolean;
  /** 延后对账完成（成功或失败）后通知 IPC 层刷新一次性提示。 */
  onDeferredReconciliationSettled?: () => void;
}

/**
 * 展示投影用:剥掉控制字符(保留换行/制表)与双向文本控制符。只作用于送往
 * Renderer 的市场条目字段,不改动 manifest 本体(校验/摘要仍以原文为准)。
 */
/* eslint-disable no-control-regex */
function stripDirectionalControls(text: string): string {
  return text.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    '',
  );
}
/* eslint-enable no-control-regex */

function installedGhostRawManifest(dir: string): GhostManifest | null {
  const parsed = readInstalledGhostManifest(dir, GHOST_MANIFEST_MAX_BYTES);
  return parsed.ok ? parsed.manifest : null;
}

function installedGhostRawManifestDigest(dir: string): string | null {
  const manifest = installedGhostRawManifest(dir);
  return manifest ? ghostManifestDigest(manifest) : null;
}

/**
 * 自定义市场图标的不可逆投影键。Renderer 只拿摘要，不拿来源路径；每次新的
 * 市场快照都会换 projection token。它是快照级缓存代际，不是预读全部图标得出的
 * 内容 hash：localIcons 会重新核对当前投影事实并稳定读取；Renderer 可丢弃字节缓存
 * 后按同一代际重新物化，而刷新市场快照一定换 token 并触发新读取。
 */
function customMarketIconPath(plugin: DiscoveredMarketPlugin): string | null {
  const icon = plugin.manifest.icon;
  if (!isSafeGhostRelativePath(icon)) return null;
  return path.join(plugin.dir, ...icon.split('/'));
}

/**
 * 自定义市场的不透明传输身份。不包含 revision 或 projection，因此同一
 * 来源在当前会话内的刷新仍共享一个槽；来源命名空间、会话或重加的同名来源
 * 不会被旧来源的挂起 IPC 误阻塞。Renderer 只能看到摘要 token。
 */
function customMarketIconSourceToken(owner: ActiveAppSession, config: MarketSourceConfig): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        owner.mode,
        owner.dataOwnerId,
        owner.generation,
        config.name,
        marketSourceKey(config.source),
        config.addedAt,
      ]),
    )
    .digest('hex')
    .slice(0, PLUGIN_MARKET_CUSTOM_ICON_SOURCE_TOKEN_LENGTH);
}

async function customMarketIconKey(
  owner: ActiveAppSession,
  config: MarketSourceConfig,
  plugin: DiscoveredMarketPlugin,
  projectionToken: string,
  openedIconStat?: fs.BigIntStats,
): Promise<string | null> {
  const iconPath = customMarketIconPath(plugin);
  if (iconPath === null || !CUSTOM_ICON_PROJECTION_TOKEN_RE.test(projectionToken)) {
    return null;
  }
  let iconFingerprint: string;
  let projectionUncertain = false;
  try {
    // plugin.dir 是发现阶段得到的 realpath。先解析完整图标路径并确认仍在该根内，
    // 再做 lstat；否则父目录 symlink 会让投影阶段探测并摘要根外文件元数据。
    const realIconPath = await fs.promises.realpath(iconPath);
    const relativeToPlugin = path.relative(plugin.dir, realIconPath);
    if (
      relativeToPlugin === '..' ||
      relativeToPlugin.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToPlugin)
    ) {
      return null;
    }
    const stat = openedIconStat ?? (await fs.promises.lstat(iconPath, { bigint: true }));
    iconFingerprint = `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    projectionUncertain = !isDeterministicLocalIconReadFailure(error);
    iconFingerprint = `unreadable:${(error as NodeJS.ErrnoException)?.code ?? 'unknown'}`;
  }
  const digest = crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        owner.mode,
        owner.dataOwnerId,
        owner.generation,
        config.name,
        marketSourceKey(config.source),
        config.addedAt,
        config.lastRevision,
        plugin.ghostId,
        plugin.version,
        ghostManifestDigest(plugin.manifest),
        iconFingerprint,
        projectionToken,
      ]),
    )
    .digest('hex');
  const digestHead = digest[0] ?? '2';
  const stableHead = projectionUncertain
    ? '1'
    : digestHead === '0' || digestHead === '1'
      ? '2'
      : digestHead;
  return `${stableHead}${customMarketIconSourceToken(owner, config)}${projectionToken}${digest.slice(0, 31)}`;
}

function localIconMissing(request: PluginMarketLocalIconRequest): PluginMarketLocalIconResult {
  return { ...request, status: 'missing' };
}

function localIconRetryable(request: PluginMarketLocalIconRequest): PluginMarketLocalIconResult {
  return { ...request, status: 'retryable' };
}

/** 文件不存在/路径形状非法是确定性缺失；权限、锁和其它 I/O 留给 Renderer 重试。 */
function isDeterministicLocalIconReadFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR' || code === 'ELOOP';
}

/** 官方市场记录是否仍匹配当前落地包，可作为自动更新路由。 */
function serverRecordMatchesInstalledGhost(
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
    installed.approval.state === 'approved' &&
    !hasCindyOfficialTrustMetadata(installed.dir) &&
    serverRecordMatchesInstalledGhost(record.pluginId, installed, record)
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

interface RecoveryCandidateInternal {
  key: string;
  record: PluginMarketInstallationRecord;
  display: PluginRecoveryCandidate;
  decision: PluginRecoveryDecisionRecord | null;
  noticeMuted: boolean;
}

interface RecoveryProjection {
  status: PluginRecoveryStatus;
  candidates: readonly RecoveryCandidateInternal[];
}

interface RecoveryVerification {
  state: 'match' | 'mismatch' | 'deferred';
  installedDigest?: string;
  sourceDigest?: string;
}
type RecoveryCandidateResolution = 'restored' | 'review' | 'deferred';

const NO_PLUGIN_RECOVERY: PluginRecoveryStatus = {
  state: 'none',
  proposal: null,
};
const MAX_RECOVERY_CANDIDATES = 50;

function recoveryOwnerKey(owner: ActiveAppSession): string {
  return `${owner.mode}:${owner.dataOwnerId}`;
}

function recoverySourceType(
  source: PluginMarketInstallationRecord['source'],
): PluginRecoveryCandidate['sourceType'] {
  if (source === 'legacy-adopted') return 'legacy';
  if (source === 'git-market' || source === 'local-market') return source;
  return 'server';
}

function recoveryProposalId(
  owner: ActiveAppSession,
  state: 'pending' | 'review' | 'deferred',
  candidates: readonly RecoveryCandidateInternal[],
): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        owner.mode,
        owner.dataOwnerId,
        state,
        candidates
          .map((candidate) => [
            candidate.key,
            candidate.display.readiness,
            candidate.display.reason,
          ])
          .sort(),
      ]),
    )
    .digest('hex');
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
  private readonly recoveryProjections = new Map<string, RecoveryProjection>();
  private readonly pendingRecoveryNotices = new Map<string, PluginRecoveryUserNotice>();
  /**
   * Renderer 把 customIconKey 当不可变缓存 generation。每次重新投影市场都换代，
   * 使低精度文件系统上的同长度、同 stat 原地改写也会在刷新后重新按需读取。
   */
  private customIconProjectionGeneration = crypto
    .randomBytes(PLUGIN_MARKET_CUSTOM_ICON_PROJECTION_TOKEN_LENGTH / 2)
    .toString('hex');

  constructor(
    private readonly api = new PluginMarketApi(undefined, () => app.getVersion()),
    private readonly ledger = new PluginMarketLedger(() =>
      ownerScopedUserDataPath('plugin-market', 'ledger.v1.json'),
    ),
    private readonly sourceStore = new MarketSourceStore(() =>
      ownerScopedUserDataPath('plugin-market', 'sources.v1.json'),
    ),
    private readonly recoveryStore = new PluginRecoveryStore(() =>
      ownerScopedUserDataPath('plugin-market', 'ledger.v1.json'),
    ),
  ) {}

  async snapshot(options: PluginMarketSnapshotOptions = {}): Promise<PluginMarketSnapshot> {
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
        unavailableCustomSourceNames: [],
      };
    }
    const iconProjectionGeneration = this.nextCustomIconProjectionGeneration();
    const customSourceNames = this.customSourceNamesSafe(owner);
    const customDiscoveryPromise = this.discoverCustomEntriesBounded(
      owner,
      iconProjectionGeneration,
      customSourceNames,
    );
    if (!getClientEndpoint('pluginApiBaseUrl')) {
      const customDiscovery = await customDiscoveryPromise;
      requireSameMarketOwner(owner);
      const ledger = this.ledgerForOwner(owner);
      await this.refreshRecoveryProjection([], customDiscovery, owner, ledger, false);
      return {
        items: this.projectCustomItems(customDiscovery.entries),
        unavailableReason: customSourceNames.length > 0 ? null : 'not-configured',
        customSourceNames,
        unavailableCustomSourceNames: customDiscovery.unavailableSourceNames,
      };
    }
    let plugins: VisiblePluginSummary[];
    let removals: PluginRemovalNotice[];
    let customDiscovery: CustomMarketDiscovery;
    try {
      // 官方目录与自定义发现并行；单个本地/网络盘来源卡顿不会串行拖住官方请求。
      const [catalog, discovered] = await Promise.all([this.api.listAll(), customDiscoveryPromise]);
      plugins = visiblePluginsForOwner(owner, catalog.plugins);
      removals = catalog.removals;
      customDiscovery = discovered;
    } catch (error) {
      log.warn('market list unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      // 本函数捕获 owner 后的每个 return 出口都必须先过 generation 校验:
      // listAll 失败(常因切号)时,不能把按旧账号发现的自定义项返回给当前会话。
      customDiscovery = await customDiscoveryPromise;
      requireSameMarketOwner(owner);
      const ledger = this.ledgerForOwner(owner);
      await this.refreshRecoveryProjection([], customDiscovery, owner, ledger, false);
      return {
        items: this.projectCustomItems(customDiscovery.entries),
        unavailableReason: error instanceof Error ? error.message : String(error),
        customSourceNames,
        unavailableCustomSourceNames: customDiscovery.unavailableSourceNames,
      };
    }

    requireSameMarketOwner(owner);
    const ledger = this.ledgerForOwner(owner);
    const availablePlugins = withoutActivePurges(plugins, removals);
    // A purge is an explicit server decision and wins over recovery/default
    // installation even if a stale catalog response still lists the Plugin.
    await this.applyServerRemovals(removals, plugins, owner, ledger);
    await this.ledgerMutation;
    await this.adoptLegacyInstallations(availablePlugins, ledger, owner);
    await this.backfillOfficialCindyGithubTrust(ledger, owner);
    await this.refreshRecoveryProjection(availablePlugins, customDiscovery, owner, ledger, true);
    // A snapshot is passive discovery: an empty runtime list can be caused by
    // startup, an owner transition, or a transient filesystem view. Only an
    // explicit uninstall may turn that absence into installed=false/opt-out.
    // Explicit uninstall completion is allowed to finish its physical removal
    // before its ledger write. Wait for queued ledger mutations before deciding
    // whether a default plugin should be installed again.
    await this.ledgerMutation;
    const reconcileDefaults = async () => {
      // 自定义来源只影响自己的目录发现；暂时不可读的来源不能阻塞官方默认安装。
      // 已经落地的同 id 插件仍由 applyDefaultInstalls → installDetail 的本地事实检查保护。
      await this.applyDefaultInstalls(availablePlugins, owner, ledger);
      await this.applyDefaultUpgrades(availablePlugins, owner, ledger);
    };
    if (!options.deferDefaultReconciliation) await reconcileDefaults();
    requireSameMarketOwner(owner);
    const local = this.localInstallSnapshot(ledger);
    const serverItems = availablePlugins.map((plugin) => this.toItem(plugin, local));
    const items = [...serverItems, ...this.projectCustomItems(customDiscovery.entries, local)];
    // 聚合完成、返回 Renderer 前最后校验:账号在任一 await 间隙漂移则拒绝,
    // 不把按旧账号解析的自定义项/账本状态发给当前会话。
    requireSameMarketOwner(owner);
    const snapshot = {
      items,
      unavailableReason: null,
      customSourceNames,
      unavailableCustomSourceNames: customDiscovery.unavailableSourceNames,
    };
    if (options.deferDefaultReconciliation) {
      // 目录展示不等待默认插件下载；对账仍复用原有串行锁和 owner 校验。
      void Promise.resolve()
        .then(reconcileDefaults)
        .catch((error) => {
          log.warn('deferred default plugin reconciliation failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(options.onDeferredReconciliationSettled);
    }
    return snapshot;
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

  recoveryStatus(): PluginRecoveryStatus {
    const owner = captureMarketOwner();
    return this.recoveryProjections.get(recoveryOwnerKey(owner))?.status ?? NO_PLUGIN_RECOVERY;
  }

  hasPendingRecovery(): boolean {
    try {
      const projection = this.recoveryProjections.get(recoveryOwnerKey(captureMarketOwner()));
      return Boolean(projection?.status.proposal && !projection.status.proposal.notificationMuted);
    } catch {
      return false;
    }
  }

  consumeRecoveryNotice(): PluginRecoveryUserNotice | null {
    const key = recoveryOwnerKey(captureMarketOwner());
    const notice = this.pendingRecoveryNotices.get(key) ?? null;
    if (notice) this.pendingRecoveryNotices.delete(key);
    return notice;
  }

  hasPendingRecoveryNotice(): boolean {
    try {
      return this.pendingRecoveryNotices.has(recoveryOwnerKey(captureMarketOwner()));
    } catch {
      return false;
    }
  }

  async resolveRecovery(
    proposalId: string,
    decision: PluginRecoveryDecision,
    candidateIds?: readonly string[],
  ): Promise<PluginRecoveryResolution> {
    const owner = captureMarketOwner();
    const key = recoveryOwnerKey(owner);
    const projection = this.recoveryProjections.get(key);
    if (!projection?.status.proposal || projection.status.proposal.proposalId !== proposalId) {
      throwIpcError('PRECONDITION_FAILED', 'Plugin recovery proposal changed');
    }
    const ledger = this.ledgerForOwner(owner);
    const store = this.recoveryStoreForOwner(owner);
    const installSubject = defaultInstallSubject(owner);
    const visibleCandidateIds = new Set(
      projection.status.proposal.candidates.map((candidate) => candidate.candidateId),
    );
    const requestedIds =
      candidateIds ??
      (decision === 'restore'
        ? projection.candidates
            .filter((candidate) => candidate.display.readiness === 'ready')
            .map((candidate) => candidate.key)
        : projection.candidates.map((candidate) => candidate.key));
    const requested = new Set(requestedIds);
    const candidates = projection.candidates.filter((candidate) => requested.has(candidate.key));
    if (
      requested.size === 0 ||
      candidates.length !== requested.size ||
      (candidateIds !== undefined && candidateIds.some((id) => !visibleCandidateIds.has(id)))
    ) {
      throwIpcError('PRECONDITION_FAILED', 'Plugin recovery candidates changed');
    }

    if (decision === 'keep') {
      requireSameMarketOwner(owner);
      store.recordDecisions(
        candidates.map((candidate) => candidate.record),
        'keep',
      );
      await this.snapshot();
      return {
        status: this.recoveryProjections.get(key)?.status ?? NO_PLUGIN_RECOVERY,
        restoredCount: 0,
        reviewCount: 0,
      };
    }
    if (candidates.some((candidate) => candidate.display.readiness !== 'ready')) {
      throwIpcError('PRECONDITION_FAILED', 'Plugin recovery requires review');
    }

    let restoredCount = 0;
    let reviewCount = 0;
    let deferredCount = 0;
    const restoredNames: string[] = [];
    for (const candidate of candidates) {
      try {
        const outcome = await this.withMutation(candidate.record.pluginId, async () => {
          const verifyAndRestore = () =>
            withGhostInstallLock(
              candidate.record.ghostId,
              async (): Promise<RecoveryCandidateResolution> => {
                requireSameMarketOwner(owner);
                const current = ledger.installationForGhost(candidate.record.ghostId);
                if (
                  !current ||
                  pluginRecoveryCandidateKey(current) !== candidate.key ||
                  current.installed ||
                  !ledger.isDefaultInstallSuppressed(installSubject, current.pluginId)
                ) {
                  throwIpcError('PRECONDITION_FAILED', 'Plugin recovery candidate changed');
                }
                const installed = getGhostManager()
                  .list()
                  .find((ghost) => ghost.manifest.id === current.ghostId);
                if (!installed) return 'deferred';
                if (current.source === 'market') {
                  const sourceState = await this.verifyOfficialRecoverySource(current, owner);
                  if (sourceState === 'mismatch') {
                    store.recordDecision(current, 'review');
                    return 'review';
                  }
                }
                const verification = await this.verifyRecoveryContent(current, installed, owner);
                requireSameMarketOwner(owner);
                if (verification.state === 'deferred') return 'deferred';
                if (verification.state === 'mismatch') {
                  store.recordDecision(current, 'review');
                  return 'review';
                }
                return this.withCapturedLedgerMutation(ledger, async () => {
                  requireSameMarketOwner(owner);
                  const latest = ledger.installationForGhost(current.ghostId);
                  if (
                    !latest ||
                    pluginRecoveryCandidateKey(latest) !== candidate.key ||
                    latest.installed ||
                    !ledger.isDefaultInstallSuppressed(installSubject, latest.pluginId) ||
                    store.hasRemovalReceipt(latest)
                  ) {
                    throwIpcError('PRECONDITION_FAILED', 'Plugin recovery candidate changed');
                  }
                  const latestInstalled = getGhostManager()
                    .list()
                    .find((ghost) => ghost.manifest.id === latest.ghostId);
                  if (!latestInstalled || latestInstalled.dir !== installed.dir) return 'deferred';
                  const finalDigest = await installedGhostContentDigest(latestInstalled.dir);
                  requireSameMarketOwner(owner);
                  if (!finalDigest || finalDigest !== verification.installedDigest) {
                    store.recordDecision(latest, 'review');
                    return 'review';
                  }
                  const finalRecord = ledger.installationForGhost(latest.ghostId);
                  if (
                    !finalRecord ||
                    pluginRecoveryCandidateKey(finalRecord) !== candidate.key ||
                    finalRecord.installed ||
                    !ledger.isDefaultInstallSuppressed(installSubject, finalRecord.pluginId) ||
                    store.hasRemovalReceipt(finalRecord)
                  ) {
                    throwIpcError('PRECONDITION_FAILED', 'Plugin recovery candidate changed');
                  }
                  const changed = ledger.recoverInstallation(finalRecord, installSubject);
                  if (!changed) {
                    throwIpcError('PRECONDITION_FAILED', 'Plugin recovery candidate changed');
                  }
                  if (verification.sourceDigest) {
                    try {
                      store.recordSourceContentDigest(finalRecord, verification.sourceDigest);
                    } catch (error) {
                      log.warn('plugin recovery evidence cache write failed', {
                        pluginId: finalRecord.pluginId,
                        error: error instanceof Error ? error.message : String(error),
                      });
                    }
                  }
                  this.recordRecoveryDecisionBestEffort(store, finalRecord, 'restored');
                  return 'restored' as const;
                });
              },
            );
          return candidate.record.source === 'git-market' ||
            candidate.record.source === 'local-market'
            ? this.withMutation(SOURCE_MUTATION_KEY, verifyAndRestore)
            : verifyAndRestore();
        });
        if (outcome === 'restored') {
          restoredCount += 1;
          restoredNames.push(candidate.display.name);
        } else if (outcome === 'review') {
          reviewCount += 1;
        } else {
          deferredCount += 1;
        }
      } catch (error) {
        if (isIpcError(error) && error.code === 'PRECONDITION_FAILED') throw error;
        deferredCount += 1;
        log.warn('plugin recovery verification deferred', {
          pluginId: candidate.record.pluginId,
          ghostId: candidate.record.ghostId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (restoredCount > 0) {
      const existing = this.pendingRecoveryNotices.get(key);
      const count = (existing?.count ?? 0) + restoredCount;
      this.pendingRecoveryNotices.set(key, {
        count,
        name: count === 1 ? (restoredNames[0] ?? null) : null,
      });
    }
    await this.snapshot();
    if (deferredCount > 0) {
      const refreshed = this.recoveryProjections.get(key);
      if (refreshed?.status.proposal && refreshed.candidates.length > 0) {
        this.recoveryProjections.set(key, {
          status: { state: 'deferred', proposal: refreshed.status.proposal },
          candidates: refreshed.candidates,
        });
      }
    }
    return {
      status: this.recoveryProjections.get(key)?.status ?? NO_PLUGIN_RECOVERY,
      restoredCount,
      reviewCount,
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
      // 本地(免账号)模式只对 public 插件暴露详情;目录 summary 也是 detail 身份
      // 绑定的依据,服务端返回的 id/ghostId/scope 与请求不一致时必须拒,防止把
      // A 的详情内容(含权限清单)呈现给请求 B 的 Renderer。
      const catalog = visiblePluginsForOwner(owner, (await this.api.listAll()).plugins);
      requireSameMarketOwner(owner);
      const summary = catalog.find((candidate) => candidate.id === pluginId);
      if (!summary) {
        throwIpcError('NOT_FOUND', 'Plugin is unavailable to the active account');
      }
      const plugin = await this.api.detail(pluginId);
      requireSameMarketOwner(owner);
      assertDetailMatchesSummary(summary, plugin);
      requirePluginVisibleForOwner(owner, plugin);
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

  /**
   * 批量按需读取自定义市场图标。一次调用只捕获一个 owner，并按市场分组，保证
   * 同一来源至多发现一次；路径与字节始终留在 Main，Renderer 只得到 data URL。
   */
  async localIcons(
    requests: readonly PluginMarketLocalIconRequest[],
  ): Promise<PluginMarketLocalIconResult[]> {
    return this.runForOwner(async (owner) => {
      const manager = this.sourceManagerForOwner(owner);
      const results = new Array<PluginMarketLocalIconResult>(requests.length);
      const groups = new Map<
        string,
        Array<{
          index: number;
          request: PluginMarketLocalIconRequest;
          ref: { marketName: string; ghostId: string };
        }>
      >();

      requests.forEach((request, index) => {
        const ref = parseCustomMarketPluginId(request.pluginId);
        if (!ref) {
          results[index] = localIconMissing(request);
          return;
        }
        const group = groups.get(ref.marketName) ?? [];
        group.push({ index, request, ref });
        groups.set(ref.marketName, group);
      });

      for (const [marketName, group] of groups) {
        try {
          await manager.withDiscoveredSource(marketName, async (discovered) => {
            if (!discovered.result.ok) {
              for (const entry of group) {
                // 该 key 来自此前成功的快照；二次发现失败时无法可靠区分清单被删
                // 与 exists/stat 的暂时不可访问。只有来源配置已移除的 NOT_FOUND 才在
                // 外层 catch 固化为 missing，其余发现失败都交给 Renderer 重试。
                results[entry.index] = localIconRetryable(entry.request);
              }
              return;
            }
            const pluginsByGhostId = new Map(
              discovered.result.marketplace.plugins.map((plugin) => [plugin.ghostId, plugin]),
            );
            for (const entry of group) {
              const plugin = pluginsByGhostId.get(entry.ref.ghostId);
              if (!plugin) {
                results[entry.index] =
                  discovered.result.marketplace.unreadableCount > 0
                    ? localIconRetryable(entry.request)
                    : localIconMissing(entry.request);
                continue;
              }
              const expectedProjectionToken = pluginMarketCustomIconProjectionToken(
                entry.request.expectedIconKey,
              );
              if (expectedProjectionToken === null) {
                results[entry.index] = localIconMissing(entry.request);
                continue;
              }
              const currentIconKey = await customMarketIconKey(
                owner,
                discovered.config,
                plugin,
                expectedProjectionToken,
              );
              if (currentIconKey?.startsWith('1')) {
                results[entry.index] = localIconRetryable(entry.request);
                continue;
              }
              if (
                currentIconKey !== entry.request.expectedIconKey &&
                !entry.request.expectedIconKey.startsWith('1')
              ) {
                results[entry.index] = localIconMissing(entry.request);
                continue;
              }
              const icon = plugin.manifest.icon;
              const iconPath = customMarketIconPath(plugin);
              const mime = icon === undefined ? null : ghostIconMimeType(icon);
              if (iconPath === null || mime === null) {
                results[entry.index] = localIconMissing(entry.request);
                continue;
              }
              try {
                const read = await readBoundedFileNoFollowWithStat(iconPath, GHOST_ICON_MAX_BYTES, {
                  containWithin: plugin.dir,
                  nonBlocking: true,
                  rejectHardLinks: true,
                  verifyContentStability: true,
                });
                if (read === null) {
                  results[entry.index] =
                    discovered.result.marketplace.unreadableCount > 0
                      ? localIconRetryable(entry.request)
                      : localIconMissing(entry.request);
                } else if (
                  (await customMarketIconKey(
                    owner,
                    discovered.config,
                    plugin,
                    expectedProjectionToken,
                    read.stat,
                  )) !== entry.request.expectedIconKey
                ) {
                  results[entry.index] = entry.request.expectedIconKey.startsWith('1')
                    ? localIconRetryable(entry.request)
                    : localIconMissing(entry.request);
                } else {
                  results[entry.index] = {
                    ...entry.request,
                    status: 'loaded',
                    dataUrl: `data:${mime};base64,${read.bytes.toString('base64')}`,
                  };
                }
              } catch (error) {
                results[entry.index] = isDeterministicLocalIconReadFailure(error)
                  ? localIconMissing(entry.request)
                  : localIconRetryable(entry.request);
                if (!isDeterministicLocalIconReadFailure(error)) {
                  log.warn('custom marketplace icon read failed', {
                    market: marketName,
                    ghostId: entry.ref.ghostId,
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              }
            }
          });
        } catch (error) {
          if (isIpcError(error) && error.code === 'PRECONDITION_FAILED') throw error;
          const status = isIpcError(error) && error.code === 'NOT_FOUND' ? 'missing' : 'retryable';
          for (const entry of group) {
            results[entry.index] =
              status === 'missing'
                ? localIconMissing(entry.request)
                : localIconRetryable(entry.request);
          }
          if (status === 'retryable') {
            log.warn('custom marketplace icon source unavailable', {
              market: marketName,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      return results;
    });
  }

  async install(
    pluginId: string,
    options: PluginMarketInstallOptions,
    reviewPackagePermissions?: PackagePermissionReviewer,
  ): Promise<PluginMarketInstallResult> {
    const customRef = parseCustomMarketPluginId(pluginId);
    if (customRef) {
      return this.customInstall(customRef, options, reviewPackagePermissions);
    }
    if (!isValidPluginResourceId(pluginId)) {
      throwIpcError('INVALID_PARAMS', 'Invalid Plugin ID');
    }
    this.requireConfigured();
    const owner = captureMarketOwner();
    const ledger = this.ledgerForOwner(owner);
    return this.withMutation(pluginId, async () => {
      requireSameMarketOwner(owner);
      // 安装必须先经目录可见性闸:本地(免账号)模式只允许 public 插件,未通过
      // 可见性的条目在调用 detail 之前就要拒掉,不能把组织私有插件的详情拉下来。
      // 目录 summary 也是 detail 身份绑定的依据:detail 自报的 id/ghostId/scope/
      // 发布必须与用户确认时看到的那份 summary 一致,否则 A 的确认会被导向 B 的内容。
      const catalog = visiblePluginsForOwner(owner, (await this.api.listAll()).plugins);
      requireSameMarketOwner(owner);
      const selected = catalog.find((candidate) => candidate.id === pluginId);
      if (!selected) {
        throwIpcError('NOT_FOUND', 'Plugin is unavailable to the active account');
      }
      const plugin = await this.api.detail(pluginId);
      requireSameMarketOwner(owner);
      // 详情响应必须与请求的 pluginId 绑定:server 换身份会让用户审阅到别的插件。
      assertDetailMatchesSummary(selected, plugin);
      requirePluginVisibleForOwner(owner, plugin);
      if (plugin.currentRelease.id !== options.expectedReleaseId) {
        throwIpcError('PRECONDITION_FAILED', 'Plugin release changed after selection');
      }
      const compatible = validateGhostManifest(plugin.currentRelease.manifest);
      if (!compatible.ok) {
        throwIpcError('GHOST_FILE_INVALID', 'This Plugin manifest is not supported');
      }
      if (!manifestSupportsCurrentCindy(compatible.manifest)) {
        throwIpcError('NOT_FOUND', 'This Plugin is unavailable for this Cindy version');
      }
      // 用户审阅过的清单必须与市场当前返回的清单有相同的权限面：
      // 同 releaseId 下市场在审阅→安装之间换 manifest 时，新增的权限
      // 用户从没见过，不能当作"已审阅"递进安装。与自定义来源路径
      // install.ts:184-191 的打包前比对同向（但此处比对的是预览清单而非
      // 实际打包字节，名字/版本/作者差异不在此处检测）。
      if (options.expectedManifest !== undefined) {
        const reviewed = validateGhostManifest(options.expectedManifest);
        // 畸形 payload 会造成 ghostPermissionBaselineKey crash（slots.includes
        // 等字段解引用），先验证再比对。验证失败时直接拒——审阅过的清单连基本
        // 结构都不对，不能信任。
        if (!reviewed.ok) {
          throwIpcError('PRECONDITION_FAILED', reviewed.reason);
        }
        if (
          ghostPermissionBaselineKey(compatible.manifest) !==
          ghostPermissionBaselineKey(reviewed.manifest)
        ) {
          throwIpcError('PRECONDITION_FAILED', 'Plugin manifest changed after permission review');
        }
      }
      const existing = getGhostManager()
        .list()
        .find((ghost) => ghost.manifest.id === plugin.ghostId);
      const ghost = await this.installDetail(
        plugin,
        {
          expectedInstalled: Boolean(existing),
          reviewedManifest: compatible.manifest,
          ...(options.expectedInstalledApproval !== undefined
            ? { expectedInstalledApproval: options.expectedInstalledApproval }
            : {}),
          allowPermissionExpansion: options.allowPermissionExpansion === true,
          ...(options.reviewedBaseline !== undefined
            ? { reviewedBaseline: options.reviewedBaseline }
            : {}),
          permissionPolicy: { mode: 'manual', sourceType: 'server' },
          reviewPackagePermissions,
          allowSourceReplacement: options.allowSourceReplacement === true,
        },
        owner,
        ledger,
      );
      return ghost ? { ghost } : { cancelled: true };
    });
  }

  async uninstall(pluginId: string): Promise<{ ok: true }> {
    // 自定义市场插件的卸载走同一账本路径，仅跳过服务端 CUID 形状校验。
    if (!parseCustomMarketPluginId(pluginId) && !isValidPluginResourceId(pluginId)) {
      throwIpcError('INVALID_PARAMS', 'Invalid Plugin ID');
    }
    const owner = captureMarketOwner();
    const ledger = this.ledgerForOwner(owner);
    const recoveryStore = this.recoveryStoreForOwner(owner);
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
          const removed = ledger.installationForGhost(record.ghostId);
          if (removed) {
            this.recordRecoveryRemovalBestEffort(recoveryStore, removed, 'user-uninstall');
          }
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
    const recoveryStore = this.recoveryStoreForOwner(owner);
    const record = ledger.installationForGhost(ghostId);
    if (!record?.installed) return null;
    const installSubject = defaultInstallSubject(owner);
    return async () => {
      await this.withCapturedLedgerMutation(ledger, () => {
        ledger.markRemoved(ghostId, installSubject);
        const removed = ledger.installationForGhost(ghostId);
        if (removed) {
          this.recordRecoveryRemovalBestEffort(recoveryStore, removed, 'user-uninstall');
        }
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
      const iconProjectionGeneration = this.customIconProjectionGeneration;
      const manager = this.sourceManagerForOwner(owner);
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
        return {
          ...this.customToItem(
            {
              config: discovered.config,
              plugin,
              iconKey: await customMarketIconKey(
                owner,
                discovered.config,
                plugin,
                iconProjectionGeneration,
              ),
            },
            this.localInstallSnapshot(this.ledgerForOwner(owner)),
          ),
          manifest: plugin.manifest,
        };
      });
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
    options: PluginMarketInstallOptions,
    reviewPackagePermissions?: PackagePermissionReviewer,
  ): Promise<PluginMarketInstallResult> {
    const owner = captureMarketOwner();
    const ledger = this.ledgerForOwner(owner);
    const recoveryStore = this.recoveryStoreForOwner(owner);
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
          throwIpcError('PRECONDITION_FAILED', 'Plugin release changed after selection');
        }
        const existing = getGhostManager()
          .list()
          .find((ghost) => ghost.manifest.id === plugin.ghostId);
        const sourceKey = marketSourceKey(discovered.config.source);
        // 审阅时刻的已装内容摘要：确认等待和打包窗口内不能换掉当前包。
        const reviewInstalledDigest = existing
          ? installedGhostRawManifestDigest(existing.dir)
          : null;
        const currentRecord = ledger.installationForGhost(plugin.ghostId);
        const matchesSelectedRoute = Boolean(
          existing &&
          currentRecord?.installed &&
          currentRecord.pluginId === pluginId &&
          currentRecord.sourceKey === sourceKey &&
          currentRecord.manifestDigest != null &&
          currentRecord.manifestDigest === reviewInstalledDigest,
        );
        if (existing && !matchesSelectedRoute && options.allowSourceReplacement !== true) {
          throwIpcError('ALREADY_EXISTS', 'A local Plugin already uses this Plugin ID');
        }
        const assertCustomReviewApproved = (installedNow: InstalledGhost | null): void => {
          if (!installedNow) return;
          if (options.expectedInstalledApproval === undefined) {
            throwIpcError(
              'PRECONDITION_FAILED',
              'Plugin approval state was not bound to the market update',
            );
          }
          if (ghostInstallApprovalToken(installedNow.approval) !== options.expectedInstalledApproval) {
            throwIpcError(
              'PRECONDITION_FAILED',
              'Plugin approval state changed after permission review',
            );
          }
          const requiresFullReview =
            installedNow.approval.state !== 'approved' ||
            diffInstalledGhostPermissionItems(installedNow, plugin.manifest).added.length > 0;
          if (!requiresFullReview) return;
          if (options.allowPermissionExpansion !== true) {
            throwIpcError('PRECONDITION_FAILED', 'Plugin permissions changed and require review');
          }
          assertReviewedBaselineFresh(installedNow.manifest, options.reviewedBaseline);
        };
        // 无有效 receipt 时不信现场 manifest：目标包全部权限都必须重新确认。
        assertCustomReviewApproved(existing ?? null);
        // 来源只决定后台更新路由，不是 ghostId 的永久所有权。只有详情页明确
        // 选择“替换”才允许原地切换来源；普通更新和“全部更新”必须保持当前路由。
        // 权限基线始终取当前真实安装，避免换源绕过扩权确认。
        // 只在已批准安装时给出基线：非 approved 的安装无批准基线，
        // 目标包全部权限都必须重新确认，与官方市场路径 (commitDownloadedPackage) 一致。
        const permissionBaselineManifest =
          existing && existing.approval.state === 'approved'
            ? installedGhostRawManifest(existing.dir)
            : null;
        let replacedRoute: PluginMarketInstallationRecord | null = null;
        let replacedRouteWasSuppressed = false;
        let packageLanded = false;
        requireSameMarketOwner(owner);
        const ghost = await installCustomMarketPlugin({
          pluginDir: plugin.dir,
          expected: options.expectedManifest,
          expectedGhostId: plugin.ghostId,
          expectedVersion: plugin.version,
          sourceType: discovered.config.source.type === 'git' ? 'git-market' : 'local-market',
          reviewPackagePermissions: async (facts) => {
            requireSameMarketOwner(owner);
            const approved = await reviewPackagePermissions?.(facts);
            requireSameMarketOwner(owner);
            return approved === true;
          },
          ...(permissionBaselineManifest ? { permissionBaselineManifest } : {}),
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
            // 当前已装目标也要复核:打包窗口(秒到分钟级)内,
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
            // raw manifest 摘要不含 Host receipt；内容未变但批准态失效同样必须拒绝
            // 旧确认，并在下一轮按无批准基线展示全部权限。
            assertCustomReviewApproved(current ?? null);
          },
          expectedInstalledApproval: options.expectedInstalledApproval,
          beforePackagePlacement: () => {
            const record = ledger.installationForGhost(plugin.ghostId);
            const routeStillMatches = Boolean(
              existing &&
              record?.installed &&
              record.pluginId === pluginId &&
              record.sourceKey === sourceKey &&
              record.manifestDigest != null &&
              record.manifestDigest === reviewInstalledDigest,
            );
            if (existing && !routeStillMatches && options.allowSourceReplacement !== true) {
              throwIpcError('PRECONDITION_FAILED', 'Installed Plugin source changed');
            }
            if (existing && record?.installed && !routeStillMatches) {
              replacedRouteWasSuppressed = this.detachMarketRouteForReplacement(
                ledger,
                record,
                defaultInstallSubject(owner),
              );
              replacedRoute = record;
            }
          },
          onPackagePlaced: () => {
            packageLanded = true;
          },
          // 复核与落位的双重互斥:
          // - SOURCE_MUTATION_KEY:beforeCommit 返回后包检查还要跑一段,期间不能
          //   让来源被增删,否则复核结论在落位前过期。
          // - withGhostInstallLock(ghostId):与本地 .cindy 装入/更新/卸载共用同一
          //   按 id 互斥,beforeCommit 的 runtime 复核到 installOrUpdate 落位之间,
          //   同 id 的本地装入/卸载插不进来(否则复核仍会在落位前过期)。
          withCommitLock: (fn) =>
            this.withMutation(SOURCE_MUTATION_KEY, () => withGhostInstallLock(plugin.ghostId, fn)),
          // 溯源写入仍在上面那把 ghost 锁内(afterCommit 由 commit 段调用):
          // 放到锁外时,本地装入能插在"包已落位"与"写下溯源"之间换掉同 id 的包。
          // 锁序:pluginId → SOURCE_MUTATION_KEY → ghostId → ledgerMutation。
          afterCommit: async (_installed, packagedManifest) => {
            // packGhostDirToFile 返回的是写入真实临时包的 canonical manifest；
            // Main 随后复验并用包 SHA 钉死同一文件，因此无需在包已经落位后
            // 再读一次目录。后置 I/O 失败不应把成功安装误报成失败或漏写来源。
            const manifestDigest = ghostManifestDigest(packagedManifest);
            await this.withCapturedLedgerMutation(ledger, () => {
              const installation: PluginMarketInstallationRecord = {
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
                // 来源指纹与 pluginId 一起标识后续自动更新路由。
                sourceKey,
                // 摘要来自实际临时包的 canonical manifest,不是发现快照，也不是
                // 安装返回的本地化 ghost.manifest；包被替换后不会被当成同源更新。
                manifestDigest,
              };
              this.clearRecoveryRemovalBestEffort(recoveryStore, installation.ghostId);
              ledger.upsertInstallation(installation);
            });
            replacedRoute = null;
          },
        }).catch((error) => {
          if (!packageLanded && replacedRoute) {
            this.restoreMarketRouteAfterFailedReplacement(
              ledger,
              replacedRoute,
              defaultInstallSubject(owner),
              replacedRouteWasSuppressed,
            );
          }
          throw error;
        });
        return ghost ? { ghost } : { cancelled: true };
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

  /** 快照聚合用：发现全部自定义市场条目。失败来源单独标记，不拖垮其它来源。 */
  private nextCustomIconProjectionGeneration(): string {
    return (this.customIconProjectionGeneration = crypto
      .randomBytes(PLUGIN_MARKET_CUSTOM_ICON_PROJECTION_TOKEN_LENGTH / 2)
      .toString('hex'));
  }

  private async discoverCustomEntriesBounded(
    owner: ActiveAppSession,
    iconProjectionGeneration: string,
    configuredSourceNames: readonly string[],
  ): Promise<CustomMarketDiscovery> {
    const progress: CustomMarketDiscoveryProgress = {
      entries: [],
      settledSourceNames: new Set<string>(),
      unavailableSourceNames: new Set<string>(),
      indeterminateSourceKeys: new Set<string>(),
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const unavailable = new Promise<CustomMarketDiscovery>((resolve) => {
      timeout = setTimeout(() => {
        const unavailableSourceNames = new Set(progress.unavailableSourceNames);
        for (const name of configuredSourceNames) {
          if (!progress.settledSourceNames.has(name)) unavailableSourceNames.add(name);
        }
        log.warn('custom marketplace snapshot discovery timed out', {
          markets: configuredSourceNames.length,
        });
        resolve({
          entries: [...progress.entries],
          unavailableSourceNames: [...unavailableSourceNames],
          indeterminateSourceKeys: new Set(progress.indeterminateSourceKeys),
          complete: false,
        });
      }, CUSTOM_MARKET_SNAPSHOT_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        this.discoverCustomEntriesSafe(
          owner,
          iconProjectionGeneration,
          configuredSourceNames,
          progress,
        ),
        unavailable,
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private async discoverCustomEntriesSafe(
    owner: ActiveAppSession,
    iconProjectionGeneration: string,
    configuredSourceNames: readonly string[],
    progress: CustomMarketDiscoveryProgress,
  ): Promise<CustomMarketDiscovery> {
    try {
      const manager = this.sourceManagerForOwner(owner);
      await manager.forEachDiscoveredSource(async ({ config, result }) => {
        if (!result.ok) {
          progress.unavailableSourceNames.add(config.name);
          progress.settledSourceNames.add(config.name);
          progress.indeterminateSourceKeys.add(marketSourceKey(config.source));
          log.warn('custom marketplace discovery failed', {
            market: config.name,
            code: result.code,
          });
          return;
        }
        if (result.marketplace.unreadableCount > 0) {
          progress.indeterminateSourceKeys.add(marketSourceKey(config.source));
          log.warn('custom marketplace has unreadable plugin entries', {
            market: config.name,
            unreadableCount: result.marketplace.unreadableCount,
          });
        }
        const sourceEntries: CustomMarketEntry[] = [];
        for (const plugin of result.marketplace.plugins) {
          if (!manifestSupportsCurrentCindy(plugin.manifest)) continue;
          sourceEntries.push({
            config,
            plugin,
            iconKey: await customMarketIconKey(owner, config, plugin, iconProjectionGeneration),
          });
        }
        // 只在整个来源（含 icon 投影）完成后发布，超时快照不会暴露半个市场。
        progress.entries.push(...sourceEntries);
        progress.settledSourceNames.add(config.name);
      });
    } catch (error) {
      log.warn('custom marketplace enumeration failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      // 未走完的来源统一标记不可用；已经成功发现的来源仍保留，不因另一个
      // 来源抛出意外 I/O 错误而从列表消失。
      for (const name of configuredSourceNames) {
        if (!progress.settledSourceNames.has(name)) progress.unavailableSourceNames.add(name);
      }
      return {
        entries: [...progress.entries],
        unavailableSourceNames: [...progress.unavailableSourceNames],
        indeterminateSourceKeys: new Set(progress.indeterminateSourceKeys),
        complete: false,
      };
    }
    return {
      entries: [...progress.entries],
      unavailableSourceNames: [...progress.unavailableSourceNames],
      indeterminateSourceKeys: new Set(progress.indeterminateSourceKeys),
      complete: true,
    };
  }

  private projectCustomItems(
    entries: readonly CustomMarketEntry[],
    local?: LocalInstallSnapshot,
  ): PluginMarketItem[] {
    const snapshot = local ?? this.localInstallSnapshot();
    return entries.map((entry) => this.customToItem(entry, snapshot));
  }

  /** 自定义市场项的状态机与服务端 toItem 完全一致（冲突 / 首装 / 更新 / 已装）。 */
  private customToItem(entry: CustomMarketEntry, local: LocalInstallSnapshot): PluginMarketItem {
    const { config, plugin } = entry;
    const pluginId = customMarketPluginId(config.name, plugin.ghostId);
    const releaseId = customMarketReleaseId(config.name, plugin.ghostId, plugin.version);
    const ghost = local.ghostsById.get(plugin.ghostId);
    const record = local.installations[plugin.ghostId];
    // pluginId + 来源指纹 + 安装时 manifest 摘要全部对上时，
    // 该条目才是当前自动更新路由。其它同 id 条目仍可被用户显式选择替换。
    const matchesUpdateRoute = Boolean(
      ghost &&
      record?.installed &&
      record.pluginId === pluginId &&
      record.sourceKey === marketSourceKey(config.source) &&
      record.manifestDigest != null &&
      record.manifestDigest === local.rawDigestByGhostId.get(plugin.ghostId),
    );
    // conflict 是「不能作为自动更新」的内部投影，不是不可安装；
    // Renderer 会把它呈现为用户显式的「替换」操作。
    const conflict = Boolean(ghost && !matchesUpdateRoute);
    const installState: PluginMarketItem['installState'] = conflict
      ? 'conflict'
      : !matchesUpdateRoute
        ? 'not-installed'
        : record?.releaseId === releaseId
          ? 'installed'
          : 'update-available';
    const iconKey = entry.iconKey;
    return {
      pluginId,
      ghostId: plugin.ghostId,
      // ghost.json 来自不受信市场仓库:双向控制符可把市场卡片上的署名/说明
      // 显示成另一副样子(视觉欺骗),控制字符可撑破布局。展示投影一律剥掉
      // (保留换行);市场名闸在 discover,这里补齐插件侧同一口径。
      name: stripDirectionalControls(plugin.manifest.name),
      description:
        plugin.manifest.description != null
          ? stripDirectionalControls(plugin.manifest.description)
          : null,
      author:
        plugin.manifest.author != null ? stripDirectionalControls(plugin.manifest.author) : null,
      // scope 是服务端授权概念，自定义市场项无服务端身份;展示层按 sourceType 分流。
      scope: 'public',
      organizationId: null,
      defaultInstall: false,
      releaseId,
      version: plugin.version,
      publishedAt: config.lastSyncedAt ?? config.addedAt,
      icon: null,
      ...(iconKey !== null ? { customIconKey: iconKey } : {}),
      installState,
      enabled: matchesUpdateRoute ? (ghost?.enabled ?? null) : null,
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
  private async runForOwner<T>(operation: (owner: ActiveAppSession) => Promise<T>): Promise<T> {
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
      store: this.sourceStore.bind(ownerScopedUserDataPath('plugin-market', 'sources.v1.json')),
      cloneRoot: ownerScopedUserDataPath('plugin-market', 'sources'),
    });
  }

  private async installDetail(
    plugin: VisiblePluginSummary | VisiblePluginDetail,
    options: {
      /** 手动安装时已向用户展示；默认安装时作为自动授权的目录权限上限。 */
      reviewedManifest?: GhostManifest;
      allowPermissionExpansion?: boolean;
      /** receipt 模型的并发护栏:比对 receipt 派生 token,状态变更即拒(与 main 硬化叠加)。 */
      expectedInstalledApproval?: string;
      /** 安装前权限确认所依据的已装权限指纹。 */
      reviewedBaseline?: string;
      /** 手动安装确认真实包；默认安装只使用目录 manifest 作为 fail-closed 上限。 */
      permissionPolicy?:
        | { mode: 'manual'; sourceType: PluginMarketItem['sourceType'] }
        | {
            mode: 'cap';
            manifest: GhostManifest;
            sourceType: PluginMarketItem['sourceType'];
          };
      /** 真实包需要确认时，在当前安装事务内立即询问发起窗口。 */
      reviewPackagePermissions?: PackagePermissionReviewer;
      /** 用户明确点击安装时，允许所选市场包原地替换其它来源的同 id 插件。 */
      allowSourceReplacement?: boolean;
      /** 静默升级时基线不匹配是否按陈旧基线拒绝(不静默覆盖用户已审阅的基线)。 */
      silentBaselineMismatch?: boolean;
      beforeCommitInLock?: () => void;
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
    if (
      existing &&
      !options.allowSourceReplacement &&
      !serverRecordMatchesInstalledGhost(plugin.id, existing, currentRecord)
    ) {
      throwIpcError('ALREADY_EXISTS', 'A local Plugin already uses this Plugin ID');
    }
    // 受体并发护栏(TOCTOU):仅当调用方**显式**带来了确认时捕获的批准令牌才核对。
    // 令牌是更新/恢复入口在渲染确认框那一刻钉下的当前受体;它对不上 = 确认往返
    // 窗口里批准被换过,拒绝用旧同意批新包。自动播种/迁移/首装(不带令牌)不受此闸,
    // 各自的 expectedInstalled / 所有权 / reviewedBaseline 门负责它们的关切。
    if (existing) {
      if (options.expectedInstalledApproval === undefined) {
        throwIpcError(
          'PRECONDITION_FAILED',
          'Plugin approval state was not bound to the market update',
        );
      }
      if (ghostInstallApprovalToken(existing.approval) !== options.expectedInstalledApproval) {
        throwIpcError('PRECONDITION_FAILED', 'Plugin approval state changed after permission review');
      }
    }

    const reviewedManifest = options.reviewedManifest
      ? validateGhostManifest(options.reviewedManifest)
      : null;
    if (reviewedManifest && !reviewedManifest.ok) {
      throwIpcError('GHOST_FILE_INVALID', 'This Plugin manifest is not supported');
    }
    const permissionCap =
      options.permissionPolicy?.mode === 'cap'
        ? validateGhostManifest(options.permissionPolicy.manifest)
        : null;
    if (permissionCap && !permissionCap.ok) {
      throwIpcError('GHOST_FILE_INVALID', 'This Plugin manifest is not supported');
    }
    this.assertServerPreviewExpansionApproved(
      existing ?? null,
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
            ...(options.expectedInstalledApproval !== undefined
              ? { expectedInstalledApproval: options.expectedInstalledApproval }
              : {}),
            ...(reviewedManifest?.ok ? { reviewedManifest: reviewedManifest.manifest } : {}),
            allowPermissionExpansion: options.allowPermissionExpansion,
            reviewedBaseline: options.reviewedBaseline,
            silentBaselineMismatch: options.silentBaselineMismatch,
            ...(options.permissionPolicy
              ? {
                  permissionPolicy:
                    options.permissionPolicy.mode === 'cap' && permissionCap?.ok
                      ? {
                          ...options.permissionPolicy,
                          manifest: permissionCap.manifest,
                        }
                      : options.permissionPolicy,
                }
              : {}),
            allowSourceReplacement: options.allowSourceReplacement,
            beforeCommitInLock: options.beforeCommitInLock,
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
        return await this.commitDownloadedPackage(
          tempPath,
          plugin,
          {
            expectedInstalled: options.expectedInstalled,
            ...(options.expectedInstalledApproval !== undefined
              ? { expectedInstalledApproval: options.expectedInstalledApproval }
              : {}),
            ...(reviewedManifest?.ok ? { reviewedManifest: reviewedManifest.manifest } : {}),
            allowPermissionExpansion: options.allowPermissionExpansion,
            reviewedBaseline: options.reviewedBaseline,
            silentBaselineMismatch: options.silentBaselineMismatch,
            ...(options.permissionPolicy
              ? {
                  permissionPolicy:
                    options.permissionPolicy.mode === 'cap' && permissionCap?.ok
                      ? {
                          ...options.permissionPolicy,
                          manifest: permissionCap.manifest,
                        }
                      : options.permissionPolicy,
                }
              : {}),
            approvedPackageSha256: error.review.packageSha256,
            approvedPackageBaseline: error.review.installedBaseline,
            allowSourceReplacement: options.allowSourceReplacement,
            beforeCommitInLock: options.beforeCommitInLock,
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
      permissionPolicy?:
        | { mode: 'manual'; sourceType: PluginMarketItem['sourceType'] }
        | {
            mode: 'cap';
            manifest: GhostManifest;
            sourceType: PluginMarketItem['sourceType'];
          };
      approvedPackageSha256?: string;
      approvedPackageBaseline?: string | null;
      expectedInstalledApproval?: string;
      reviewedManifest?: GhostManifest;
      allowPermissionExpansion?: boolean;
      reviewedBaseline?: string;
      silentBaselineMismatch?: boolean;
      allowSourceReplacement?: boolean;
      beforeCommitInLock?: () => void;
      expectedInstalled: boolean;
    },
    owner: ActiveAppSession,
    ledger: PluginMarketLedger,
  ): Promise<InstalledGhost> {
    const recoveryStore = this.recoveryStoreForOwner(owner);
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
        !options.allowSourceReplacement &&
        !serverRecordMatchesInstalledGhost(plugin.id, installedNow, currentRecordNow)
      ) {
        throwIpcError('ALREADY_EXISTS', 'A local Plugin already uses this Plugin ID');
      }
      if (installedNow) {
        if (options.expectedInstalledApproval === undefined) {
          throwIpcError(
            'PRECONDITION_FAILED',
            'Plugin approval state was not bound to the market update',
          );
        }
        if (
          ghostInstallApprovalToken(installedNow.approval) !== options.expectedInstalledApproval
        ) {
          throwIpcError(
            'PRECONDITION_FAILED',
            'Plugin approval state changed while the update was downloading',
          );
        }
      }
      requireSameMarketOwner(owner);
      this.assertServerPreviewExpansionApproved(
        installedNow ?? null,
        options.reviewedManifest,
        options.allowPermissionExpansion,
        options.reviewedBaseline,
        options.silentBaselineMismatch,
      );
      const installedRawManifest = installedNow
        ? installedGhostRawManifest(installedNow.dir)
        : null;
      // 权限基线只在已批准安装时给出：非 approved (legacy-unapproved/invalid)
      // 无批准基线，目标包全部权限都必须重新确认，不能让旧确认带出的基线被
      // 当成"已审阅过"。approved 安装的基线取当前真实运行包（不是 ledger 摘要），
      // 更新路由由上方 serverRecordMatchesInstalledGhost 单独判断。
      // 经来源账本摘要认证的已装清单；缺失时不得回退到可变运行时清单。
      // currentRecordNow 是 provenance ledger 的记录（允许 source replacement 时不比对
      // pluginId，但不影响摘要链——来源可以不同，安装目录的字节身份仍需与已记录摘要一致）。
      const permissionBaselineManifest =
        installedNow?.approval.state === 'approved' &&
        installedRawManifest &&
        currentRecordNow?.installed &&
        (currentRecordNow.source === 'market' || currentRecordNow.source === 'legacy-adopted') &&
        currentRecordNow.manifestDigest === ghostManifestDigest(installedRawManifest)
          ? installedRawManifest
          : null;
      const replacingSource = Boolean(
        installedNow &&
        options.allowSourceReplacement &&
        currentRecordNow?.installed &&
        !serverRecordMatchesInstalledGhost(plugin.id, installedNow, currentRecordNow),
      );
      let routeDetached = false;
      let replacedRouteWasSuppressed = false;
      let packageLanded = false;
      const detachPreviousRoute = (): void => {
        options.beforeCommitInLock?.();
        if (!replacingSource || !currentRecordNow) return;
        replacedRouteWasSuppressed = this.detachMarketRouteForReplacement(
          ledger,
          currentRecordNow,
          defaultInstallSubject(owner),
        );
        routeDetached = true;
      };
      const installed = await installOrUpdateMarketGhostPackage(tempPath, {
        ghostId: plugin.ghostId,
        version: plugin.currentRelease.version,
        ...(plugin.ghostId === 'cindy-github' ? { officialCindyGithub: true } : {}),
        ...(options.permissionPolicy
          ? {
              permissionPolicy: options.permissionPolicy,
              ...(permissionBaselineManifest ? { permissionBaselineManifest } : {}),
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
        ...(options.expectedInstalledApproval !== undefined
          ? { expectedInstalledApproval: options.expectedInstalledApproval }
          : {}),
        ...(options.beforeCommitInLock || replacingSource
          ? { beforeCommitInLock: detachPreviousRoute }
          : {}),
        ...(replacingSource
          ? {
              onPackagePlacedInLock: () => {
                packageLanded = true;
              },
            }
          : {}),
      }).catch((error) => {
        if (routeDetached && !packageLanded && currentRecordNow) {
          this.restoreMarketRouteAfterFailedReplacement(
            ledger,
            currentRecordNow,
            defaultInstallSubject(owner),
            replacedRouteWasSuppressed,
          );
        }
        throw error;
      });
      await this.withCapturedLedgerMutation(ledger, () => {
        this.clearRecoveryRemovalBestEffort(recoveryStore, plugin.ghostId);
        ledger.upsertInstallation(recordFrom(plugin, 'market', installed));
      });
      return installed;
    });
  }

  private assertServerPreviewExpansionApproved(
    installed: InstalledGhost | null,
    reviewedManifest: GhostManifest | undefined,
    allowPermissionExpansion: boolean | undefined,
    reviewedBaseline: string | undefined,
    silentBaselineMismatch = false,
  ): void {
    if (!installed || !reviewedManifest) return;
    const requiresFullReview =
      installed.approval.state !== 'approved' ||
      diffInstalledGhostPermissionItems(installed, reviewedManifest).added.length > 0;
    if (!requiresFullReview) return;
    if (allowPermissionExpansion !== true) {
      throwIpcError('PRECONDITION_FAILED', 'Plugin permissions changed and require review');
    }
    if (
      silentBaselineMismatch &&
      reviewedBaseline !== undefined &&
      ghostPermissionBaselineKey(installed.manifest) !== reviewedBaseline
    ) {
      throw new SilentUpgradeStaleBaselineError('Installed Plugin permissions changed');
    }
    assertReviewedBaselineFresh(installed.manifest, reviewedBaseline);
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
    const matchesUpdateRoute = Boolean(
      ghost && serverRecordMatchesInstalledGhost(plugin.id, ghost, record ?? null),
    );
    // 其它同 id 条目不进入自动更新，但仍可由用户显式选择替换。
    const conflict = Boolean(ghost && !matchesUpdateRoute);
    const installState: PluginMarketItem['installState'] = conflict
      ? 'conflict'
      : !matchesUpdateRoute
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
      enabled: matchesUpdateRoute ? (ghost?.enabled ?? null) : null,
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
    const installed = getGhostManager()
      .list()
      .find((ghost) => ghost.manifest.id === 'cindy-github');
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
          expectedInstalledApproval: ghostInstallApprovalToken(currentInstalled.approval),
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

  private async refreshRecoveryProjection(
    plugins: readonly VisiblePluginSummary[],
    customDiscovery: CustomMarketDiscovery,
    owner: ActiveAppSession,
    ledger: PluginMarketLedger,
    serverCatalogAvailable: boolean,
  ): Promise<void> {
    const ownerKey = recoveryOwnerKey(owner);
    try {
      requireSameMarketOwner(owner);
      const store = this.recoveryStoreForOwner(owner);
      const installSubject = defaultInstallSubject(owner);
      const ledgerData = ledger.read();
      const local = this.localInstallSnapshot(ledger, ledgerData.installations);
      const serverCounts = ghostIdCounts(plugins);
      const pending: RecoveryCandidateInternal[] = [];
      const review: RecoveryCandidateInternal[] = [];
      const deferred: RecoveryCandidateInternal[] = [];

      for (const record of Object.values(ledgerData.installations)) {
        if (record.installed) continue;
        if (!ledgerData.defaultInstallOptOuts[installSubject]?.includes(record.pluginId)) continue;
        const ghost = local.ghostsById.get(record.ghostId);
        if (!ghost || store.hasRemovalReceipt(record)) continue;

        const decision = store.decisionFor(record);
        const noticeMuted = store.isNoticeMuted(record);
        if (decision === 'restored') continue;
        const key = pluginRecoveryCandidateKey(record);
        const name = stripDirectionalControls(ghost.manifest.name).trim() || record.ghostId;

        let sourceState: 'match' | 'mismatch' | 'deferred' = 'mismatch';
        if (record.source === 'market' || record.source === 'legacy-adopted') {
          if (!serverCatalogAvailable) {
            sourceState = 'deferred';
          } else {
            const plugin = plugins.find(
              (item) => item.ghostId === record.ghostId && serverCounts.get(item.ghostId) === 1,
            );
            sourceState =
              plugin &&
              plugin.id === record.pluginId &&
              plugin.scope === record.scope &&
              plugin.organizationId === record.organizationId
                ? 'match'
                : 'mismatch';
          }
        } else {
          const matches = customDiscovery.entries.filter((entry) => {
            const expectedSource =
              entry.config.source.type === 'git' ? 'git-market' : 'local-market';
            return (
              entry.plugin.ghostId === record.ghostId &&
              customMarketPluginId(entry.config.name, entry.plugin.ghostId) === record.pluginId &&
              expectedSource === record.source &&
              marketSourceKey(entry.config.source) === record.sourceKey &&
              (record.manifestDigest === undefined ||
                ghostManifestDigest(entry.plugin.manifest) === record.manifestDigest)
            );
          });
          if (matches.length === 1) {
            sourceState = 'match';
          } else if (
            !customDiscovery.complete ||
            (record.sourceKey !== undefined &&
              customDiscovery.indeterminateSourceKeys.has(record.sourceKey))
          ) {
            sourceState = 'deferred';
          }
        }

        const rawManifestDigest = local.rawDigestByGhostId.get(record.ghostId);
        const manifestState: 'match' | 'mismatch' | 'deferred' =
          rawManifestDigest == null
            ? 'deferred'
            : record.manifestDigest !== undefined && rawManifestDigest === record.manifestDigest
              ? 'match'
              : 'mismatch';
        let readiness: PluginRecoveryCandidate['readiness'];
        let reason: PluginRecoveryCandidate['reason'];
        if (decision === 'review') {
          readiness = 'review';
          reason = 'content-mismatch';
        } else if (sourceState === 'deferred') {
          readiness = 'deferred';
          reason = 'source-unavailable';
        } else if (manifestState === 'deferred') {
          readiness = 'deferred';
          reason = 'content-unavailable';
        } else if (
          sourceState === 'match' &&
          manifestState === 'match' &&
          record.source !== 'legacy-adopted'
        ) {
          readiness = 'ready';
          reason = 'exact-match';
        } else if (record.source === 'legacy-adopted') {
          readiness = 'review';
          reason = 'legacy-unverifiable';
        } else if (sourceState === 'mismatch') {
          readiness = 'review';
          reason = 'source-mismatch';
        } else {
          readiness = 'review';
          reason = 'manifest-mismatch';
        }
        const candidate: RecoveryCandidateInternal = {
          key,
          record,
          decision,
          noticeMuted,
          display: {
            candidateId: key,
            pluginId: record.pluginId,
            ghostId: record.ghostId,
            name,
            version: record.version,
            sourceType: recoverySourceType(record.source),
            readiness,
            reason,
          },
        };
        if (readiness === 'ready') pending.push(candidate);
        else if (readiness === 'review') review.push(candidate);
        else deferred.push(candidate);
      }

      const groups = [pending, review, deferred].map((group) =>
        group.sort(
          (a, b) => a.display.name.localeCompare(b.display.name) || a.key.localeCompare(b.key),
        ),
      );
      const selected: RecoveryCandidateInternal[] = [];
      for (const group of groups) {
        if (group[0]) selected.push(group[0]);
      }
      for (const group of groups) {
        for (const candidate of group.slice(1)) {
          if (selected.length >= MAX_RECOVERY_CANDIDATES) break;
          selected.push(candidate);
        }
      }
      if (selected.length === 0) {
        this.recoveryProjections.set(ownerKey, {
          status: NO_PLUGIN_RECOVERY,
          candidates: [],
        });
        return;
      }
      const state = pending.length > 0 ? 'pending' : review.length > 0 ? 'review' : 'deferred';
      const allCandidates = [...pending, ...review, ...deferred];
      const totalCount = allCandidates.length;
      const notificationMuted = allCandidates.every((candidate) => candidate.noticeMuted);
      this.recoveryProjections.set(ownerKey, {
        status: {
          state,
          proposal: {
            proposalId: recoveryProposalId(owner, state, allCandidates),
            candidates: selected.map((candidate) => candidate.display),
            counts: {
              ready: pending.length,
              review: review.length,
              deferred: deferred.length,
            },
            totalCount,
            truncated: selected.length < totalCount,
            notificationMuted,
          },
        },
        candidates: allCandidates,
      });
    } catch (error) {
      log.warn('plugin recovery analysis deferred', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.recoveryProjections.set(ownerKey, {
        status: { state: 'failed', proposal: null },
        candidates: [],
      });
    }
  }

  private async verifyRecoveryContent(
    record: PluginMarketInstallationRecord,
    installed: InstalledGhost,
    owner: ActiveAppSession,
  ): Promise<RecoveryVerification> {
    const installedDigest = await installedGhostContentDigest(installed.dir);
    requireSameMarketOwner(owner);
    if (!installedDigest) return { state: 'deferred' };

    if (record.source === 'market') {
      let sourceDigest: string;
      const tempPath = path.join(
        app.getPath('temp'),
        `cindy-plugin-recovery-${crypto.randomUUID()}.cindy`,
      );
      try {
        const download = await this.api.download(record.pluginId, record.releaseId);
        requireSameMarketOwner(owner);
        if (download.sha256 !== record.sha256) return { state: 'mismatch' };
        const expiresAt = Date.parse(download.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return { state: 'deferred' };
        await downloadVerifiedPlugin(download.url, download, tempPath);
        requireSameMarketOwner(owner);
        const inspected = await getGhostManager().inspect(tempPath, {
          includeContentDigest: true,
        });
        if ('rejection' in inspected) {
          return {
            state: inspected.rejection.code === 'file-invalid' ? 'mismatch' : 'deferred',
          };
        }
        if (
          inspected.packageSha256 !== record.sha256 ||
          inspected.canonicalManifest.id !== record.ghostId ||
          inspected.canonicalManifest.version !== record.version ||
          inspected.contentDigest === undefined ||
          (record.manifestDigest !== undefined &&
            ghostManifestDigest(inspected.canonicalManifest) !== record.manifestDigest)
        ) {
          return { state: 'mismatch' };
        }
        sourceDigest = inspected.contentDigest;
      } finally {
        await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
      }
      return sourceDigest === installedDigest
        ? { state: 'match', installedDigest, sourceDigest }
        : { state: 'mismatch' };
    }

    if (record.source === 'legacy-adopted') return { state: 'mismatch' };
    const ref = parseCustomMarketPluginId(record.pluginId);
    if (!ref) return { state: 'mismatch' };
    requireSameMarketOwner(owner);
    return this.sourceManagerForOwner(owner).withDiscoveredSource(
      ref.marketName,
      async (discovered) => {
        requireSameMarketOwner(owner);
        if (!discovered.result.ok) return { state: 'deferred' };
        if (
          marketSourceKey(discovered.config.source) !== record.sourceKey ||
          (discovered.config.source.type === 'git' ? 'git-market' : 'local-market') !==
            record.source
        ) {
          return { state: 'mismatch' };
        }
        const matches = discovered.result.marketplace.plugins.filter(
          (plugin) => plugin.ghostId === record.ghostId,
        );
        if (
          matches.length !== 1 ||
          (record.manifestDigest !== undefined &&
            ghostManifestDigest(matches[0]!.manifest) !== record.manifestDigest)
        ) {
          return { state: 'mismatch' };
        }
        const sourceDigest = await packableGhostSourceContentDigest(matches[0]!.dir);
        requireSameMarketOwner(owner);
        if (sourceDigest === null) return { state: 'deferred' };
        return sourceDigest === installedDigest
          ? { state: 'match', installedDigest, sourceDigest }
          : { state: 'mismatch' };
      },
    );
  }

  /** Re-read authoritative catalog state immediately before an official recovery. */
  private async verifyOfficialRecoverySource(
    record: PluginMarketInstallationRecord,
    owner: ActiveAppSession,
  ): Promise<'match' | 'mismatch'> {
    const catalog = await this.api.listAll();
    requireSameMarketOwner(owner);
    if (activePurgeKeys(catalog.removals).has(`${record.pluginId}\0${record.ghostId}`)) {
      throwIpcError('PRECONDITION_FAILED', 'Plugin recovery was superseded by a removal');
    }
    const visible = visiblePluginsForOwner(owner, catalog.plugins);
    const counts = ghostIdCounts(visible);
    const plugin = visible.find(
      (candidate) => candidate.ghostId === record.ghostId && counts.get(candidate.ghostId) === 1,
    );
    return plugin &&
      plugin.id === record.pluginId &&
      plugin.scope === record.scope &&
      plugin.organizationId === record.organizationId
      ? 'match'
      : 'mismatch';
  }

  /** Re-read both sides of a stale-catalog purge before adopting legacy bytes. */
  private async verifyOfficialLegacyPurgeSource(
    record: PluginMarketInstallationRecord,
    removal: PluginRemovalNotice,
    owner: ActiveAppSession,
  ): Promise<boolean> {
    const catalog = await this.api.listAll();
    requireSameMarketOwner(owner);
    const purgeStillActive = catalog.removals.some(
      (candidate) =>
        candidate.action === 'purge' &&
        candidate.pluginId === removal.pluginId &&
        candidate.ghostId === removal.ghostId &&
        candidate.scope === removal.scope &&
        candidate.organizationId === removal.organizationId,
    );
    if (!purgeStillActive) return false;
    const visible = visiblePluginsForOwner(owner, catalog.plugins);
    const matches = visible.filter(
      (candidate) =>
        candidate.id === record.pluginId &&
        candidate.ghostId === record.ghostId &&
        candidate.scope === record.scope &&
        candidate.organizationId === record.organizationId &&
        candidate.currentRelease.id === record.releaseId &&
        candidate.currentRelease.version === record.version &&
        candidate.currentRelease.sha256 === record.sha256,
    );
    return matches.length === 1;
  }

  private async applyServerRemovals(
    removals: readonly PluginRemovalNotice[],
    plugins: readonly VisiblePluginSummary[],
    owner: ActiveAppSession,
    ledger: PluginMarketLedger,
  ): Promise<void> {
    if (removals.length === 0) return;
    const recoveryStore = this.recoveryStoreForOwner(owner);
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
      if (record.scope !== 'organization' || removal.scope !== 'organization') {
        return 'non-organization-scope';
      }
      if (record.organizationId !== removal.organizationId) return 'organization-mismatch';
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
      const provisionalPlugins = plugins.filter(
        (plugin) =>
          plugin.id === removal.pluginId &&
          plugin.ghostId === removal.ghostId &&
          plugin.scope === 'organization' &&
          plugin.organizationId === removal.organizationId,
      );
      const mayVerifyLegacy =
        prefilterReason === 'ledger-record-missing' && provisionalPlugins.length === 1;
      if (prefilterReason && !mayVerifyLegacy) {
        skip(removal, prefilterReason);
        continue;
      }
      try {
        const removed = await this.withMutation(removal.pluginId, () =>
          withGhostInstallLock(removal.ghostId, async () => {
            requireSameMarketOwner(owner);
            let record = ledger.installationForGhost(removal.ghostId);
            let legacyContentVerified = false;
            ghostsById ??= new Map(
              getGhostManager()
                .list()
                .map((ghost) => [ghost.manifest.id, ghost]),
            );
            const installed = ghostsById.get(removal.ghostId);

            if (!record) {
              if (!installed) return skip(removal, 'ledger-record-missing');
              const provisional = provisionalLegacyPurgeRecord(
                provisionalPlugins[0]!,
                removal,
                installed,
              );
              if (!provisional) return skip(removal, 'legacy-provenance-unavailable');
              let verification: RecoveryVerification;
              try {
                verification = await this.verifyRecoveryContent(provisional, installed, owner);
              } catch (error) {
                if (isIpcError(error) && error.code === 'PRECONDITION_FAILED') throw error;
                verification = { state: 'deferred' };
                log.warn('legacy server purge content verification deferred', {
                  pluginId: removal.pluginId,
                  ghostId: removal.ghostId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
              if (verification.state !== 'match') {
                return skip(removal, `legacy-content-${verification.state}`);
              }
              if (!(await this.verifyOfficialLegacyPurgeSource(provisional, removal, owner))) {
                return skip(removal, 'legacy-source-changed');
              }
              await this.withCapturedLedgerMutation(ledger, () => {
                requireSameMarketOwner(owner);
                if (ledger.installationForGhost(removal.ghostId)) {
                  throwIpcError('PRECONDITION_FAILED', 'Plugin removal candidate changed');
                }
                ledger.upsertInstallation(provisional);
              });
              requireSameMarketOwner(owner);
              record = ledger.installationForGhost(removal.ghostId);
              legacyContentVerified = true;
            }
            const reason = ledgerGateReason(record, removal);
            if (reason) return skip(removal, reason);

            const finalizePurge = () =>
              this.withCapturedLedgerMutation(ledger, () => {
                const current = ledger.installationForGhost(removal.ghostId);
                if (
                  ledgerGateReason(current, removal) !== null ||
                  pluginInstallationKey(current!) !== pluginInstallationKey(record!)
                ) {
                  throwIpcError('PRECONDITION_FAILED', 'Plugin removal candidate changed');
                }
                // userId=null keeps any pre-existing default-install choice.
                if (current!.installed) ledger.markRemoved(removal.ghostId, null);
                const removedRecord = ledger.installationForGhost(removal.ghostId);
                if (removedRecord) {
                  this.recordRecoveryRemovalBestEffort(
                    recoveryStore,
                    removedRecord,
                    'server-purge',
                  );
                }
              });

            if (!installed) {
              await finalizePurge();
              return skip(removal, 'runtime-not-installed');
            }
            // 溯源摘要闸:账本记录只证明"市场装过这个 ghostId",不证明现在占位的
            // 还是那份包——本地 .cindy 可原位替换,替换不写市场账本。摘要对不上
            // (含 ghost.json 读不出)即视为非服务端安装,不删,与更新路径/连接授权
            // 的 fail-closed 判据同口径。缺摘要的存量记录放行:被下架的插件已不在
            // 目录里,digest 迁移永远补不上,fail-closed 会让老安装的合法清理永久失效。
            if (
              record?.manifestDigest != null &&
              installedGhostRawManifestDigest(installed.dir) !== record.manifestDigest
            ) {
              await finalizePurge();
              return skip(removal, 'manifest-digest-mismatch');
            }

            // Supporting a false ledger record is the new recovery compatibility
            // path. Unlike the historical installed=true purge, it must prove the
            // complete directory still equals the recorded release: the 0.1.38
            // failure window also allowed a local package with the same manifest
            // but different executable bytes to occupy this id.
            if (!record!.installed && !legacyContentVerified) {
              let verification: RecoveryVerification;
              try {
                verification = await this.verifyRecoveryContent(record!, installed, owner);
              } catch (error) {
                if (isIpcError(error) && error.code === 'PRECONDITION_FAILED') throw error;
                verification = { state: 'deferred' };
                log.warn('server plugin purge content verification deferred', {
                  pluginId: removal.pluginId,
                  ghostId: removal.ghostId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
              if (verification.state !== 'match') {
                await finalizePurge();
                return skip(removal, `runtime-content-${verification.state}`);
              }
            }

            requireSameMarketOwner(owner);
            try {
              await uninstallGhostAndCleanup(removal.ghostId, { skipMarketLedger: true });
              ghostsById.delete(removal.ghostId);
            } catch (error) {
              // The authoritative purge still owns the ledger decision. A later
              // snapshot can retry physical cleanup without making it recoverable.
              await finalizePurge();
              throw error;
            }
            await finalizePurge();
            log.info('server plugin removal applied', {
              pluginId: removal.pluginId,
              ghostId: removal.ghostId,
            });
            return {
              name: stripDirectionalControls(installed.manifest.name) || null,
            };
          }),
        );
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
    const count = (this.pendingRemovalNotices.get(key)?.count ?? 0) + removedNames.length;
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
      plugins.filter((plugin) => counts.get(plugin.ghostId) === 1).map((plugin) => plugin.ghostId),
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
          const permissionCap = validateGhostManifest(detail.currentRelease.manifest);
          if (!permissionCap.ok) {
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
              permissionPolicy: {
                mode: 'cap',
                manifest: permissionCap.manifest,
                sourceType: 'server',
              },
              // 下载期间用户可能从本地插件页完成显式卸载。最终落位前在
              // ghostId 锁内重读卸载意图，不能让旧 snapshot 把插件装回来。
              beforeCommitInLock: () => {
                const commitLedgerData = ledger.read();
                if (commitLedgerData.defaultInstallOptOuts[installSubject]?.includes(summary.id)) {
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
      )
        continue;
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
          if (!freshInstalled) {
            log.warn('default plugin upgrade skipped because the installed record disappeared', {
              pluginId: summary.id,
            });
            return;
          }
          // A legacy-unapproved or invalid install has no approved baseline: a
          // silent default upgrade would let Main mint a fresh approved receipt
          // without the full permission review the user must confirm. Skip the
          // silent upgrade and leave the plugin in its current state so it goes
          // through the reapproval/recovery flow instead.
          if (freshInstalled.approval.state !== 'approved') {
            log.warn('default plugin upgrade skipped for unapproved install', {
              pluginId: summary.id,
              ghostId: summary.ghostId,
              approvalState: freshInstalled.approval.state,
            });
            return;
          }
          const reviewedBaseline = ghostPermissionBaselineKey(freshInstalled.manifest);
          const detail = await this.api.detail(summary.id);
          requireSameMarketOwner(owner);
          assertDetailMatchesSummary(summary, detail);
          const reviewedManifest = validateGhostManifest(detail.currentRelease.manifest);
          if (!reviewedManifest.ok)
            throwIpcError('GHOST_FILE_INVALID', 'This Plugin manifest is not supported');
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
            expectedInstalledApproval: ghostInstallApprovalToken(freshInstalled.approval),
            silentBaselineMismatch: true,
            permissionPolicy: {
              mode: 'cap',
              manifest: reviewedManifest.manifest,
              sourceType: 'server',
            },
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
              ? diffGhostPermissionItems(freshInstalled.manifest, installed.manifest).added.map(
                  ({ key, labelKey, labelArgs }) => ({
                    key,
                    labelKey,
                    ...(labelArgs ? { labelArgs } : {}),
                  }),
                )
              : [];
            completed.push({
              name: stripDirectionalControls(installed.manifest.name) || null,
              permissions: addedPermissions,
            });
          }
        });
      } catch (error) {
        if (!(error instanceof SilentUpgradeBusyError)) {
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
          count === 1 && completed[0]?.permissions.length ? completed[0].permissions : null,
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
    return this.ledger.bind(ownerScopedUserDataPath('plugin-market', 'ledger.v1.json'));
  }

  private recoveryStoreForOwner(owner: ActiveAppSession): PluginRecoveryStore {
    requireSameMarketOwner(owner);
    return this.recoveryStore.bind(ownerScopedUserDataPath('plugin-market', 'ledger.v1.json'));
  }

  private recordRecoveryRemovalBestEffort(
    store: PluginRecoveryStore,
    record: PluginMarketInstallationRecord,
    reason: PluginRemovalIntent,
  ): void {
    try {
      if (store.hasRemovalReceipt(record)) return;
      store.recordRemoval(record, reason);
    } catch (error) {
      log.warn('plugin recovery removal receipt write failed', {
        pluginId: record.pluginId,
        ghostId: record.ghostId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private clearRecoveryRemovalBestEffort(store: PluginRecoveryStore, ghostId: string): void {
    try {
      store.clearRemoval(ghostId);
    } catch (error) {
      log.warn('plugin recovery removal receipt clear failed', {
        ghostId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private recordRecoveryDecisionBestEffort(
    store: PluginRecoveryStore,
    record: PluginMarketInstallationRecord,
    decision: PluginRecoveryDecisionRecord,
  ): void {
    try {
      store.recordDecision(record, decision);
    } catch (error) {
      log.warn('plugin recovery decision write failed after ledger commit', {
        pluginId: record.pluginId,
        ghostId: record.ghostId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

  private detachMarketRouteForReplacement(
    ledger: PluginMarketLedger,
    record: PluginMarketInstallationRecord,
    installSubject: string,
  ): boolean {
    const tracksDefaultInstall = record.source === 'market' || record.source === 'legacy-adopted';
    const wasSuppressed = tracksDefaultInstall
      ? ledger.isDefaultInstallSuppressed(installSubject, record.pluginId)
      : false;
    try {
      ledger.markRemoved(record.ghostId, tracksDefaultInstall ? installSubject : null);
    } catch (error) {
      this.restoreMarketRouteAfterFailedReplacement(ledger, record, installSubject, wasSuppressed);
      log.warn('failed to detach Plugin market route before replacement', {
        pluginId: record.pluginId,
        ghostId: record.ghostId,
        error: error instanceof Error ? error.message : String(error),
      });
      throwIpcError('INTERNAL', 'Unable to detach the installed Plugin source');
    }
    return wasSuppressed;
  }

  private restoreMarketRouteAfterFailedReplacement(
    ledger: PluginMarketLedger,
    record: PluginMarketInstallationRecord,
    installSubject: string,
    wasSuppressed: boolean,
  ): void {
    try {
      ledger.restoreInstallation(
        record,
        record.source === 'market' || record.source === 'legacy-adopted'
          ? { userId: installSubject, suppressed: wasSuppressed }
          : undefined,
      );
    } catch (error) {
      log.error('failed to restore Plugin market route after replacement failure', {
        pluginId: record.pluginId,
        ghostId: record.ghostId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private withMutation<T>(pluginId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(pluginId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.mutations.set(pluginId, current);
    const cleanup = () => {
      if (this.mutations.get(pluginId) === current) this.mutations.delete(pluginId);
    };
    void current.then(cleanup, cleanup);
    return current;
  }
}

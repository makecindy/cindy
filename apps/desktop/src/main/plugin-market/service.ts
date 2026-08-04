import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  isValidPluginResourceId,
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
  PluginMarketSnapshot,
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
const NO_DUPLICATE_GHOST_IDS: ReadonlySet<string> = new Set();

/**
 * 来源增删改的互斥键。**安装的提交段(所有权复核 + 包落位)也要拿这把锁**:
 * 否则复核通过后、真正改动 Ghost 运行时之前,另一窗口能添加声明同一 ghostId 的
 * 来源,让已冲突的插件照样装上。
 *
 * **锁次序(不变量,违反即死锁)**:允许 `withMutation(pluginId)` 内再取本键
 * (安装路径就是这么做的),**禁止**持本键时再取任何 pluginId 键。来源操作
 * (add/remove/refresh)只拿本键,永不反向,因此锁图无环。
 *
 * **已知权衡**:refreshSource 全程持本键,大仓库 clone 期间(可达分钟级)安装的
 * 提交段与其它来源操作会排队。这是有意选择——只读路径(快照/列表/详情)不受
 * 影响,而把刷新的网络段移出锁会重新打开"提交点复核过期"的窗口;吞吐不构成
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

function installedGhostRawManifestDigest(dir: string): string | null {
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
    return validated.ok ? ghostManifestDigest(validated.manifest) : null;
  } catch {
    return null;
  }
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
    const { entries: customEntries, complete: customComplete } =
      await this.discoverCustomEntriesSafe(owner);
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
    // ghostId 冲突判定跨服务端与自定义市场合并计算（全局唯一、先装先得）。
    // 必须**先于** applyDefaultInstalls 算出来:默认安装会真的下载并启用插件,
    // 若只按服务端目录判重,与自定义来源同 ghostId 的默认项会被静默抢占所有权,
    // 而列表随后又把它标成 conflict —— 既定事实已经发生。
    const duplicateGhostIds = combinedDuplicateGhostIds(plugins, customEntries);
    await this.adoptLegacyInstallations(plugins, ledger, owner);
    await this.reconcileRemovedInstallations(ledger, owner);
    // 自定义目录不完整(某来源暂时不可读)时跳过全部默认安装:此刻的合并冲突
    // 集合缺了坏来源声明的 ghostId,自动安装会在它恢复前抢占所有权。
    if (customComplete) {
      await this.applyDefaultInstalls(plugins, owner, ledger, duplicateGhostIds);
    } else {
      log.warn('skipping default installs: custom marketplace catalog is incomplete');
    }
    requireSameMarketOwner(owner);
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
      // 详情必须与列表同口径:传空重复集合会把列表标为 conflict 并禁用的项
      // 在详情页恢复成可安装,给出一条绕过冲突闸的入口。
      const { duplicates } = await this.crossSourceDuplicateGhostIds(owner);
      requireSameMarketOwner(owner);
      return {
        ...this.toItem(
          plugin,
          duplicates,
          this.localInstallSnapshot(this.ledgerForOwner(owner)),
        ),
        manifest: compatible.manifest,
      };
    });
  }

  async install(
    pluginId: string,
    options: PluginMarketInstallOptions,
  ): Promise<PluginMarketInstallResult> {
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
      // 上面只查了服务端目录内部重名。列表的 conflict 判定是"服务端 + 全部自定义
      // 来源"合并计数,这里必须用同一口径重算,否则被标为 conflict 并禁用的服务端
      // 项仍能经普通 UI 流程或直接 IPC 装进来并抢占 ghostId。
      const record = ledger.installationForGhost(plugin.ghostId);
      const ownsInstall = Boolean(
        existing && record?.installed && record.pluginId === plugin.id,
      );
      const assertOwnership = () =>
        this.assertSourceOwnsGhostId({
          owner,
          ghostId: plugin.ghostId,
          ownsInstall,
          // 复用已拉到的目录,复核不再多打一次网络请求。
          knownServerPlugins: catalog,
        });
      await assertOwnership();
      return {
        ghost: await this.installDetail(
          plugin,
          {
            expectedInstalled: existing,
            allowPermissionExpansion: options.allowPermissionExpansion === true,
            ...(options.reviewedBaseline !== undefined
              ? { reviewedBaseline: options.reviewedBaseline }
              : {}),
            ...(options.approvedPackageSha256 !== undefined
              ? { approvedPackageSha256: options.approvedPackageSha256 }
              : {}),
            // 下载可能持续数分钟,提交副作用前按当前事实再算一次。
            recheckOwnership: assertOwnership,
          },
          owner,
          ledger,
        ),
      };
    }).catch((error: unknown) => {
      if (error instanceof GhostPackagePermissionReviewRequiredError) {
        requireSameMarketOwner(owner);
        return { reviewRequired: error.review };
      }
      throw error;
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
      // 与服务端详情同理:详情必须沿用列表的 conflict 口径,不能传空重复集合。
      const { duplicates } = await this.crossSourceDuplicateGhostIds(owner);
      requireSameMarketOwner(owner);
      return {
        ...this.customToItem(
          { config: discovered.config, plugin },
          duplicates,
          this.localInstallSnapshot(this.ledgerForOwner(owner)),
        ),
        manifest: plugin.manifest,
      };
    });
  }

  /**
   * 按 snapshot 的同一口径重算跨来源重复 ghostId(服务端目录 + 全部自定义来源)。
   * 详情与安装都用它,保证"列表标成 conflict 并禁用"的判定不会在别处被放宽。
   *
   * 服务端目录可选:未配置或拉取失败时降级为仅自定义来源,并把 `serverKnown`
   * 置为 false 供调用方判断。自定义安装本就不要求服务端可用;未安装的服务端插件
   * 不构成本地运行期抢占,已安装的那种情况由安装侧的 `existing` 检查拦住。
   */
  private async crossSourceDuplicateGhostIds(
    owner: ActiveAppSession,
    knownServerPlugins?: readonly VisiblePluginSummary[],
  ): Promise<{ duplicates: ReadonlySet<string>; serverKnown: boolean; customComplete: boolean }> {
    const { entries: customEntries, complete: customComplete } =
      await this.discoverCustomEntriesSafe(owner);
    let serverPlugins: readonly VisiblePluginSummary[] = knownServerPlugins ?? [];
    let serverKnown = knownServerPlugins !== undefined;
    if (!serverKnown && getClientEndpoint('pluginApiBaseUrl')) {
      try {
        serverPlugins = visiblePluginsForOwner(owner, await this.api.listAll());
        serverKnown = true;
      } catch (error) {
        log.warn('market catalog unavailable while recomputing cross-source duplicates', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    requireSameMarketOwner(owner);
    return {
      duplicates: combinedDuplicateGhostIds(serverPlugins, customEntries),
      serverKnown,
      customComplete,
    };
  }

  /**
   * 安装入口重算 ghostId 所有权:列表把跨来源重名标成 `conflict` 并禁用,但那份
   * 判定是快照期算的。安装 IPC 可以被不可信 Renderer 直接调用,也可能在详情打开
   * 后由另一个窗口添加了声明同一 ghostId 的来源 —— 所以真正产生副作用之前必须
   * 用同一口径重新确认。服务端与自定义两条安装路径共用这道闸。
   */
  private async assertSourceOwnsGhostId(input: {
    owner: ActiveAppSession;
    ghostId: string;
    ownsInstall: boolean;
    knownServerPlugins?: readonly VisiblePluginSummary[];
  }): Promise<void> {
    // 已经拥有当前安装记录的来源保留所有权（先装先得，与列表判定一致）。
    if (input.ownsInstall) return;
    const { duplicates, customComplete } = await this.crossSourceDuplicateGhostIds(
      input.owner,
      input.knownServerPlugins,
    );
    // 任一来源暂时不可读时,冲突集合是不完整的——此刻放行安装会在坏来源恢复前
    // 抢占它声明的 ghostId(先装先得被绕过)。fail closed:提示先修复或移除。
    if (!customComplete) {
      throwIpcError(
        'PRECONDITION_FAILED',
        'A marketplace source is unavailable; refresh or remove it before installing',
      );
    }
    if (duplicates.has(input.ghostId)) {
      throwIpcError('ALREADY_EXISTS', 'Another marketplace already provides this Plugin ID');
    }
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
        await this.assertSourceOwnsGhostId({ owner, ghostId: plugin.ghostId, ownsInstall });
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
          // 打包耗时,期间另一窗口可以经独立的 market-sources 互斥键添加声明同一
          // ghostId 的来源(来源变更与插件安装不共享互斥边界)。所以在真正改动
          // Ghost 运行时之前把所有权再算一遍,而不是只依赖打包前那一次。
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
            await this.assertSourceOwnsGhostId({ owner, ghostId: plugin.ghostId, ownsInstall });
            // runtime 所有权也要复核,不只来源所有权:打包窗口(秒到分钟级)内,
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
  ): Promise<{ entries: CustomMarketEntry[]; complete: boolean }> {
    try {
      const manager = owner
        ? this.sourceManagerForOwner(owner)
        : new MarketSourceManager({
            store: this.sourceStore,
            cloneRoot: ownerScopedUserDataPath('plugin-market', 'sources'),
          });
      const discovered = await manager.discoverAll();
      const entries: CustomMarketEntry[] = [];
      // "目录不完整"与"来源确实为空"必须分开:任一来源发现失败时,合并冲突集合
      // 缺了它声明的 ghostId,自动安装/所有权提交会在它暂时不可读的窗口里抢占
      // 先装先得。展示照旧容错(单源失败不拖垮列表),但 complete=false 要让
      // 写路径 fail closed。
      let complete = true;
      for (const { config, result } of discovered) {
        if (!result.ok) {
          complete = false;
          log.warn('custom marketplace discovery failed', {
            market: config.name,
            code: result.code,
          });
          continue;
        }
        // 粒度到条目的同一口径:某个插件的 ghost.json 暂时读不到(文件锁/网络盘
        // 抖动/权限)时,这个市场声明了哪些 ghostId 就给不出完整答案——展示照旧
        // 容错,但写路径必须 fail closed,否则同 ghostId 的默认安装会在这个窗口
        // 里抢占所有权,恢复后该插件永久 conflict。内容非法(skippedCount)不算。
        if (result.marketplace.unreadableCount > 0) {
          complete = false;
          log.warn('custom marketplace has unreadable plugin entries', {
            market: config.name,
            unreadableCount: result.marketplace.unreadableCount,
          });
        }
        for (const plugin of result.marketplace.plugins) {
          entries.push({ config, plugin });
        }
      }
      return { entries, complete };
    } catch (error) {
      log.warn('custom marketplace enumeration failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { entries: [], complete: false };
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
    // 已拥有当前安装记录的来源保留所有权（installed / update-available）；
    // duplicate 只把未拥有安装的竞争来源标为冲突，避免“先装先得”被降格。
    const conflict = Boolean(
      (duplicateGhostIds.has(plugin.ghostId) && !ownsInstall) ||
        (ghost && !ownsInstall && !adoptable),
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
    plugin: VisiblePluginDetail,
    options: {
      allowPermissionExpansion?: boolean;
      /** 扩权批准所依据的已装权限指纹;安装锁内复核,详见 install() 的说明。 */
      reviewedBaseline?: string;
      /** 用户确认过的真实下载包 SHA。 */
      approvedPackageSha256?: string;
      /** 确认操作时的安装意图;下载窗口期目标被另一窗口卸载时拒绝滑入首装。 */
      expectedInstalled: boolean;
      /**
       * 提交副作用前的所有权复核。下载可能持续数分钟,期间另一窗口可经独立的
       * market-sources 互斥键添加声明同一 ghostId 的来源,入口处那次判定已过期。
       */
      recheckOwnership?: () => Promise<void>;
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
    /**
     * 扩权闸门:按**传入时刻的**已装 manifest 判定。下面调用两次——
     *  1. 锁外一次:快速失败,不为注定被拒的更新白下载几十 MB;
     *  2. 落位前在 withGhostInstallLock 内再一次(权威):下载可能持续数分钟,
     *     期间本地 `ghosts:update` 能整体替换已装 manifest。只在锁外判定的话,
     *     旧的 reviewedBaseline 会放行相对**新** manifest 多出来的权限——
     *     那些权限用户从没审过。锁内这次才是不可绕过的那道。
     */
    const assertExpansionApproved = (installedNow: GhostManifest | null): void => {
      if (!installedNow) return;
      if (diffGhostPermissionItems(installedNow, compatible.manifest).added.length === 0) return;
      if (options.allowPermissionExpansion !== true) {
        throwIpcError('PRECONDITION_FAILED', 'Plugin permissions changed and require review');
      }
      assertReviewedBaselineFresh(installedNow, options.reviewedBaseline);
    };
    assertExpansionApproved(existing?.manifest ?? null);
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
      // 复核 + 落位 + 溯源写入在同一对锁内完成:
      // - SOURCE_MUTATION_KEY:`installOrUpdateMarketGhostPackage` 会先 await 包
      //   检查才开始改动运行时,复核若在锁外做,结论会在这段等待里过期。
      // - withGhostInstallLock(ghostId):与本地 .cindy 装入/更新/卸载共用同一按 id
      //   互斥。少了它,本地装入能在包检查窗口里落入同 id 的包,随后被本次安装当作
      //   更新目标覆盖,而权限差异确认因审阅时目标不存在而没跑过。账本写入也必须在
      //   锁内:否则本地装入可以插在"落位"与"写溯源"之间,让账本认领一个其实已被
      //   替换掉的包(服务端记录不带 manifestDigest,投影时判不出来)。
      // 锁序:pluginId → SOURCE_MUTATION_KEY → ghostId → ledgerMutation,不可反向。
      const ghost = await this.withMutation(SOURCE_MUTATION_KEY, () =>
        withGhostInstallLock(plugin.ghostId, async () => {
          // 改动 Ghost 运行时之前的最后一道:跨来源 ghostId 所有权按当前事实重算。
          await options.recheckOwnership?.();
          requireSameMarketOwner(owner);
          // 权限扩权的**权威**判定点:锁内按当前已装 manifest 重算。锁外那次
          // 只是快速失败;下载窗口期本地装入/更新若换掉了已装包,旧批准在这里
          // 被基线比对拦下,并发替换绕不过去(落位就在下面几行)。
          assertExpansionApproved(
            getGhostManager()
              .list()
              .find((ghost) => ghost.manifest.id === plugin.ghostId)?.manifest ?? null,
          );
          // 市场首装一律装完即开(2026-07-26 定案,见 installOrUpdateMarketGhostPackage);
          // 已装过则走原位更新,唤醒/沉睡状态延续当前值。
          const installed = await installOrUpdateMarketGhostPackage(tempPath, {
            ghostId: plugin.ghostId,
            version: plugin.currentRelease.version,
            // 确认框渲染的就是这份服务端 manifest;包里若多出权限项,出口处先
            // 暂停落位并返回真实包权限——服务端投影层与客户端清单契约漂移时,
            // 必须让用户按实际要安装的能力面重新确认。
            reviewedManifest: compatible.manifest,
            ...(options.approvedPackageSha256 !== undefined
              ? {
                  approvedPackageSha256: options.approvedPackageSha256,
                  reviewedBaseline: options.reviewedBaseline,
                }
              : {}),
          });
          // Once the package directory is committed, finish provenance against
          // the owner captured at operation start even if the active session
          // changes. The bound ledger prevents this write from leaking into the
          // new owner.
          await this.withCapturedLedgerMutation(ledger, () => {
            ledger.upsertInstallation(recordFrom(plugin, 'market'));
          });
          return installed;
        }),
      );
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
    const installSubject = defaultInstallSubject(owner);
    for (const record of Object.values(ledger.read().installations)) {
      if (!record.installed) continue;
      await this.withLedgerMutation(owner, () => {
        // 在场判定必须与写入同处一把锁内且即时重取:manager.update 的两次
        // rename 之间 ghosts/<id> 短暂不存在,锁外的一次性快照会把这类瞬态
        // 误判成"已卸载",把 pluginId 永久写进 defaultInstallOptOuts,该
        // 默认安装插件从此不再自动装回。
        const stillInstalled = getGhostManager()
          .list()
          .some((ghost) => ghost.manifest.id === record.ghostId);
        if (!stillInstalled) ledger.markRemoved(record.ghostId, installSubject);
      });
    }
  }

  private async applyDefaultInstalls(
    plugins: readonly VisiblePluginSummary[],
    owner: ActiveAppSession,
    ledger: PluginMarketLedger,
    /** 服务端 + 全部自定义来源合并算出的重复 ghostId;命中的默认项一律跳过。 */
    duplicateGhostIds: ReadonlySet<string>,
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
      // 跨来源重名:自动安装会替用户做出"服务端胜出"的抢占决定,必须交回用户手动
      // 处置(列表把两边都标成 conflict)。
      if (duplicateGhostIds.has(summary.ghostId)) continue;
      if (ledgerData.defaultInstallOptOuts[installSubject]?.includes(summary.id)) continue;
      if (isBuiltinGhostRemovedByUser(summary.ghostId)) continue;
      const state = this.toItem(summary, duplicateGhostIds, local).installState;
      if (state !== 'not-installed') continue;
      try {
        await this.withMutation(summary.id, async () => {
          requireSameMarketOwner(owner);
          const detail = await this.api.detail(summary.id);
          // 装完即开语义已收敛进市场安装入口本身,这里无需再显式声明。
          await this.installDetail(
            detail,
            {
              expectedInstalled: false,
              // 默认安装同样有下载窗口:提交前按当前事实重算跨来源所有权,
              // 复用已有的服务端目录,不额外打网络请求。
              recheckOwnership: () =>
                this.assertSourceOwnsGhostId({
                  owner,
                  ghostId: summary.ghostId,
                  ownsInstall: false,
                  knownServerPlugins: plugins,
                }),
            },
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

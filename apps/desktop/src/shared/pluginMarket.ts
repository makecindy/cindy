import type { GhostManifest, GhostPermissionDiff, InstalledGhost } from './ghost';
import type { PluginIconMetadata } from '@cindy/plugin-protocol';
import type { DataOwnerPushStamp } from './dataOwnerPush';

export type PluginMarketScope = 'public' | 'organization' | 'personal';
export type PluginMarketInstallState =
  | 'not-installed'
  | 'installed'
  | 'update-available'
  | 'conflict';

/** 市场项来源：服务端市场，或用户添加的 Git / 本地自定义市场。 */
export type PluginMarketItemSource = 'server' | 'git-market' | 'local-market';

/** Renderer-safe Plugin 市场列表项；所有字段都来自协议或本地安装事实。 */
export interface PluginMarketItem {
  pluginId: string;
  ghostId: string;
  name: string;
  description: string | null;
  author: string | null;
  scope: PluginMarketScope;
  organizationId: string | null;
  defaultInstall: boolean;
  releaseId: string;
  version: string;
  publishedAt: string;
  icon: PluginIconMetadata | null;
  /**
   * 自定义市场图标的本地身份键。它是 Main 根据当前来源事实计算的本地投影身份，
   * 不包含本地路径或字节；读取失败或事实不确定时也可能携带该键并由 localIcons
   * 返回 missing/retryable。服务端市场与未声明 icon 的自定义插件不携带。
   */
  customIconKey?: string;
  installState: PluginMarketInstallState;
  enabled: boolean | null;
  /** 来源类型；服务端市场项为 'server'。 */
  sourceType: PluginMarketItemSource;
  /** 来源市场名（自定义市场项必填；服务端项为 null）。 */
  sourceMarketName: string | null;
}
/** 市场快照。服务不可用时 renderer 保留本地插件并只展示非阻断提示。 */
export interface PluginMarketSnapshot {
  items: PluginMarketItem[];
  unavailableReason: string | null;
  /** 已添加的自定义市场名（按添加顺序）；驱动"自定义"筛选 tab 的可见性。 */
  customSourceNames: string[];
  /** 本轮发现失败的自定义市场名；失败来源不影响其它来源和官方市场。 */
  unavailableCustomSourceNames: string[];
}

/** 服务端清理的一次性汇总提示：按 owner 缓存，consume 前跨多轮对账累加，consume 后即清。 */
export interface PluginRemovalUserNotice {
  count: number;
  /** 累计单条且插件名经安全过滤后非空时为插件名；其余情况为 null，只展示数量。 */
  name: string | null;
}

export interface PluginUpgradePermissionNotice {
  /** Shared permission item identity; Renderer resolves labelKey through i18n. */
  key: string;
  labelKey: string;
  labelArgs?: Record<string, string>;
}

export interface PluginUpgradeUserNotice {
  count: number;
  name: string | null;
  /** Added permissions for the sole upgraded plugin; null for multi-plugin batches. */
  permissions: PluginUpgradePermissionNotice[] | null;
  /** Whether any upgrade in the aggregate added permissions. */
  hasPermissionExpansion: boolean;
}

/** 详情携带安装前展示给用户的 manifest；官方来自 release，自定义来自本地发现。 */
export interface PluginMarketDetail extends PluginMarketItem {
  manifest: GhostManifest;
}

/** Main 生成并接受的自定义市场图标身份键形状；首位 0 为保留值。 */
export const PLUGIN_MARKET_CUSTOM_ICON_KEY_RE = /^[1-9a-f][a-f0-9]{63}$/;
export const PLUGIN_MARKET_CUSTOM_ICON_SOURCE_TOKEN_LENGTH = 16;
export const PLUGIN_MARKET_CUSTOM_ICON_PROJECTION_TOKEN_LENGTH = 16;

export function isPluginMarketCustomIconKey(value: string): boolean {
  return PLUGIN_MARKET_CUSTOM_ICON_KEY_RE.test(value);
}

/** Renderer 只用这个不透明 token 做同来源传输限流，不解析 Main 侧身份事实。 */
export function pluginMarketCustomIconSourceToken(value: string): string | null {
  if (!isPluginMarketCustomIconKey(value)) return null;
  return value.slice(1, 1 + PLUGIN_MARKET_CUSTOM_ICON_SOURCE_TOKEN_LENGTH);
}

/** Main 从图标键恢复快照投影代际，用于读取时重算并核对完整键。 */
export function pluginMarketCustomIconProjectionToken(value: string): string | null {
  if (!isPluginMarketCustomIconKey(value)) return null;
  const start = 1 + PLUGIN_MARKET_CUSTOM_ICON_SOURCE_TOKEN_LENGTH;
  return value.slice(start, start + PLUGIN_MARKET_CUSTOM_ICON_PROJECTION_TOKEN_LENGTH);
}

/** Renderer 请求 Main 按当前自定义市场事实读取一个本地图标。 */
export interface PluginMarketLocalIconRequest {
  pluginId: string;
  expectedIconKey: string;
}

/** Main 的批量图标读取结果；请求身份原样带回，供 Renderer 安全归并。 */
export type PluginMarketLocalIconResult =
  | (PluginMarketLocalIconRequest & { status: 'loaded'; dataUrl: string })
  | (PluginMarketLocalIconRequest & { status: 'missing' | 'retryable' });

/** Main 从已验证真实包中提取的权限复核事实。 */
export interface PluginMarketPackageReviewFacts {
  /** 已按当前界面语言本地化，仅用于展示；安全指纹由 Main 基于原始清单计算。 */
  manifest: GhostManifest;
  /** Main 基于当前已装原始清单与真实包原始清单算出的权限差异；无可靠基线时为 null。 */
  permissionDiff: GhostPermissionDiff | null;
  /** Main 根据安装锁内的实际落位状态判定；不从 permissionDiff 间接推断。 */
  isUpdate: boolean;
  packageSha256: string;
  /** 产生复核结果时的可靠已装权限基线；null 也可能是旧安装基线不可读。 */
  installedBaseline: string | null;
  /** 只用于让确认卡如实说明包来自官方还是用户添加的市场。 */
  sourceType: PluginMarketItemSource;
}

/** Main 在安装事务内请求当前窗口立即确认真实包权限；不暴露内部批准绑定。 */
export interface PluginMarketPackageReviewRequest {
  requestId: string;
  /** Main 投递这份私有包事实时的账号代际；Renderer 必须匹配后才可展示。 */
  ownerStamp: DataOwnerPushStamp;
  manifest: GhostManifest;
  permissionDiff: GhostPermissionDiff | null;
  isUpdate: boolean;
  sourceType: PluginMarketItemSource;
}

export interface PluginMarketInstallOptions {
  /** 用户点击时看到的目标 release；Main 会在下载前重新核对。 */
  expectedReleaseId: string;
  /** 安装前展示给用户的完整清单；Main 会与当前来源事实重新核对。 */
  expectedManifest?: GhostManifest;
  /** 仅用于自定义市场确认其本地真实 manifest 的扩权。 */
  allowPermissionExpansion?: boolean;
  /** 用户审阅目标权限时的已装权限基线。 */
  reviewedBaseline?: string;
  /**
   * receipt 模型的并发护栏：receipt 派生 token。确认与落位之间批准状态若变化即拒绝。
   */
  expectedInstalledApproval?: string;
  /** 仅详情页上用户明确点击“替换”时为 true；更新和批量更新不得切换来源。 */
  allowSourceReplacement?: boolean;
}

/** 安装成功，或用户在事务内取消真实包权限确认。 */
export type PluginMarketInstallResult =
  | { ghost: InstalledGhost; cancelled?: never }
  | { ghost?: never; cancelled: true };

/* ------------------------------------------------------------------------ */
/* 自定义市场源（Git / 本地文件夹）                                           */
/* ------------------------------------------------------------------------ */

/** 用户添加的市场来源。Git 源支持可选引用与稀疏检出；本地源指向文件夹。 */
export type MarketSource =
  | { type: 'git'; url: string; ref?: string; sparsePaths: string[] }
  | { type: 'local'; path: string };

/** 持久化的市场来源配置（sources.v1.json）。 */
export interface MarketSourceConfig {
  /** 市场名，来自 marketplace.json 的 name；全局唯一，作为管理主键。 */
  name: string;
  addedAt: string;
  lastSyncedAt: string | null;
  /** 最近一次同步到的 Git commit SHA；本地源为 null。 */
  lastRevision: string | null;
  source: MarketSource;
}

/** Renderer 管理视图使用的来源摘要。 */
export interface MarketSourceSummary extends MarketSourceConfig {
  /** 最近一次发现到的插件数；发现失败时为 0 并携带 status。 */
  pluginCount: number;
  /** 清单中因内容非法被跳过的插件条目数。 */
  skippedCount: number;
  /** 清单中因权限、文件锁或瞬时 I/O 暂时无法读取的插件条目数。 */
  unreadableCount: number;
  status: 'ok' | 'error';
  /** status === 'error' 时的 IPC 错误码（Renderer 按码本地化）。 */
  errorCode: string | null;
}

/**
 * 来源的规范化指纹。市场名是 marketplace.json 自报的、**可复用**——移除来源 A 后
 * 添加一个同名的来源 B,`customMarketPluginId` 完全相同;账本所有权若只锚在
 * pluginId 上,无关甚至恶意仓库就能借同名市场"更新"A 装出来的插件。所以自定义
 * 安装的账本记录同时记下这个指纹,所有权校验必须两者都对上。
 * 与 sources/store 的 sourcesEqual、sources/index 的 marketCloneSlug 同一套
 * 判定维度(type + 定位 + ref + 稀疏路径)。
 *
 * 序列化必须**无歧义**:用分隔符拼接(`join(',')`、`#ref:sparse`)会产生可构造的
 * 碰撞——`sparsePaths:['a,b','c']` 与 `['a','b,c']`、`ref:'x' + ['p']` 与
 * `ref:'x:p' + []` 都会得到同一 key,两个不同来源被判成同一个,所有权校验随之
 * 失效。JSON 数组序列化对每个元素定界,不存在拼接歧义。
 */
export function marketSourceKey(source: MarketSource): string {
  return source.type === 'local'
    ? JSON.stringify(['local', source.path])
    : JSON.stringify(['git', source.url, source.ref ?? null, source.sparsePaths]);
}

/**
 * 自定义市场插件的合成 pluginId。与服务端 CUID（^c[a-z0-9]{24}$）互不相交，
 * Main 在 detail/install/uninstall 入口据此分流，Renderer 无需感知差异。
 */
export const CUSTOM_MARKET_PLUGIN_ID_PREFIX = 'custom:';

export function customMarketPluginId(marketName: string, ghostId: string): string {
  return `${CUSTOM_MARKET_PLUGIN_ID_PREFIX}${encodeURIComponent(marketName)}/${encodeURIComponent(ghostId)}`;
}

export function parseCustomMarketPluginId(
  pluginId: string,
): { marketName: string; ghostId: string } | null {
  if (!pluginId.startsWith(CUSTOM_MARKET_PLUGIN_ID_PREFIX)) return null;
  const rest = pluginId.slice(CUSTOM_MARKET_PLUGIN_ID_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  try {
    return {
      marketName: decodeURIComponent(rest.slice(0, slash)),
      ghostId: decodeURIComponent(rest.slice(slash + 1)),
    };
  } catch {
    return null;
  }
}

/**
 * 自定义市场插件的合成 releaseId。版本变化即产生新 releaseId，
 * 从而复用服务端市场既有的 update-available / expectedReleaseId 机制。
 */
export function customMarketReleaseId(marketName: string, ghostId: string, version: string): string {
  return `custom:${encodeURIComponent(marketName)}:${encodeURIComponent(ghostId)}:${encodeURIComponent(version)}`;
}

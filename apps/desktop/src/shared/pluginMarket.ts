import type { GhostManifest, InstalledGhost } from './ghost';
import type { PluginIconMetadata } from '@cindy/plugin-protocol';

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
}

/** 服务端清理的一次性汇总提示：按 owner 缓存，consume 前跨多轮对账累加，consume 后即清。 */
export interface PluginRemovalUserNotice {
  count: number;
  /** 累计单条且插件名经安全过滤后非空时为插件名；其余情况为 null，只展示数量。 */
  name: string | null;
}

/** 详情额外携带经 Desktop 当前 runtime validator 验证过的完整清单。 */
export interface PluginMarketDetail extends PluginMarketItem {
  manifest: GhostManifest;
}

/** Main 验证真实下载包后，交给 Renderer 展示的权限复核事实。 */
export interface PluginMarketPackageReview {
  /** 已按当前界面语言本地化，仅用于展示；安全指纹由 Main 基于原始清单计算。 */
  manifest: GhostManifest;
  packageSha256: string;
  /** 产生复核结果时的已装权限基线；null 表示当时尚未安装。 */
  installedBaseline: string | null;
}

export interface PluginMarketInstallOptions {
  /** 用户审阅时看到的目标 release；Main 会在下载前重新核对。 */
  expectedReleaseId: string;
  /** 自定义市场审阅过的完整清单；服务端市场由 Main 读取 release 清单。 */
  expectedManifest?: GhostManifest;
  allowPermissionExpansion?: boolean;
  /** 用户审阅扩权时的已装权限基线。 */
  reviewedBaseline?: string;
  /** 用户确认过的真实下载包；Main 会重新下载并核对 SHA。 */
  approvedPackageSha256?: string;
}

/** 安装成功，或真实包权限与市场展示不一致而需要用户复核。 */
export type PluginMarketInstallResult =
  | { ghost: InstalledGhost; reviewRequired?: never }
  | { ghost?: never; reviewRequired: PluginMarketPackageReview };

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

/**
 * Plugin list/detail view models derived only from the installed Ghost contract.
 *
 * Inputs: shared Ghost manifests and install records.
 * Outputs: renderer-safe list/detail facts without marketplace or runtime invention.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import {
  ghostContentKeys,
  ghostPermissionItems,
  type GhostPermissionItem,
  type GhostTrustInfo,
  type GhostToolDecl,
  type InstalledGhost,
} from '../../../../shared/ghost';
import type { PluginMarketItem } from '../../../../shared/pluginMarket';

export interface GhostPluginListItem {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  canUse: boolean;
  trust?: GhostTrustInfo;
  iconDataUrl?: string;
}
export interface GhostPluginDetail extends GhostPluginListItem {
  trust: GhostTrustInfo;
  author: string | null;
  contents: readonly string[];
  permissions: GhostPermissionItem[];
  tools: readonly GhostToolDecl[];
  hasSettingsUi: boolean;
  cindyCapabilities: readonly string[];
  panelMinWidth: number | null;
  installDir: string | null;
}

/**
 * 展示投影只覆盖用户能看到的四个字段；运行时仍完全来自本地安装包。
 *
 * `iconDataUrl` 是有意要求存在的字段：市场项的 `icon: null` 也必须覆盖本地
 * 包图标，而不是因为缺少 URL 又显示旧图标。
 */
export interface GhostPluginMarketPresentation {
  name: string;
  description: string;
  author: string | null;
  iconDataUrl: string | undefined;
}

/**
 * Returns a market presentation only when the installed package is the exact
 * market-owned version. A local install, a conflicting ghostId, an unavailable
 * market item, or a pending version update must keep using its local manifest.
 */
export function marketPresentationForInstalledGhost(
  ghost: Pick<InstalledGhost, 'manifest'>,
  marketItem:
    | Pick<
        PluginMarketItem,
        'ghostId' | 'installState' | 'version' | 'name' | 'description' | 'author' | 'icon'
      >
    | null
    | undefined,
): GhostPluginMarketPresentation | null {
  if (
    !marketItem ||
    marketItem.ghostId !== ghost.manifest.id ||
    marketItem.installState !== 'installed' ||
    marketItem.version !== ghost.manifest.version
  ) {
    return null;
  }
  return {
    name: marketItem.name,
    description: marketItem.description ?? '',
    author: marketItem.author,
    iconDataUrl: marketItem.icon?.url,
  };
}

export type GhostFallbackIconKind =
  'diagram' | 'media' | 'search' | 'communication' | 'code' | 'calendar' | 'generic';

/**
 * Chooses a restrained local symbol when a Plugin package has no icon asset.
 * This is presentation-only: a package-provided icon always wins.
 */
export function ghostFallbackIconKind(name: string, id: string): GhostFallbackIconKind {
  const identity = `${id} ${name}`.toLocaleLowerCase();
  if (/mermaid|diagram|flow|chart|draw|绘图|流程|图表/u.test(identity)) return 'diagram';
  if (/mivo|art|image|video|media|photo|图片|图像|视频/u.test(identity)) return 'media';
  if (/search|browser|web|网页|搜索/u.test(identity)) return 'search';
  if (/feishu|lark|slack|chat|message|mail|飞书|消息/u.test(identity)) return 'communication';
  if (/github|gitlab|git|code|dev|代码/u.test(identity)) return 'code';
  if (/calendar|schedule|日历|日程/u.test(identity)) return 'calendar';
  return 'generic';
}

/**
 * Applies the Plugin list's search semantics in one place so the result list
 * and every count use the same matching set.
 */
export function filterGhostPluginItems<T extends GhostPluginListItem>(
  items: readonly T[],
  query: string,
): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return items.filter((item) =>
    `${item.name} ${item.description} ${item.id}`
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );
}

/**
 * Orders installed shortcuts by host-recorded recency while keeping never-used items stable.
 * Unknown/stale ids are ignored, so uninstall or migration residue cannot hide an item.
 */
export function sortGhostPluginItemsByRecentUse<T extends Pick<GhostPluginListItem, 'id'>>(
  items: readonly T[],
  recentIds: readonly string[],
): T[] {
  const recentIndex = new Map(recentIds.map((id, index) => [id, index]));
  return items
    .map((item, stableIndex) => ({ item, stableIndex }))
    .sort((a, b) => {
      const aRecent = recentIndex.get(a.item.id);
      const bRecent = recentIndex.get(b.item.id);
      if (aRecent !== undefined || bRecent !== undefined) {
        if (aRecent === undefined) return 1;
        if (bRecent === undefined) return -1;
        if (aRecent !== bRecent) return aRecent - bRecent;
      }
      return a.stableIndex - b.stableIndex;
    })
    .map(({ item }) => item);
}

/**
 * 将安装清单转换成列表卡片需要的最小字段。
 *
 * 这里刻意不加入安装量、使用量、认证徽章等旧原型字段;这些字段在 Ghost
 * runtime 中没有事实来源,页面不应继续展示伪数据。
 */
export function toGhostPluginListItem(
  ghost: InstalledGhost,
  presentation?: GhostPluginMarketPresentation | null,
): GhostPluginListItem {
  const { manifest } = ghost;
  const display = presentation ?? {
    name: manifest.name,
    description: manifest.description ?? '',
    iconDataUrl: ghost.iconDataUrl,
  };
  return {
    id: manifest.id,
    name: display.name,
    description: display.description,
    version: manifest.version,
    enabled: ghost.enabled,
    canUse: Boolean(manifest.command),
    trust: ghost.trust ?? {
      level: 'unverified',
      publisherSigned: false,
      publisherVerified: false,
      reviewed: false,
    },
    ...(display.iconDataUrl !== undefined ? { iconDataUrl: display.iconDataUrl } : {}),
  };
}

/**
 * 详情页复用列表 adapter 的基础字段,再补充 manifest 明确声明的权限与工具。
 * 权限与详情卡共用 shared/ghost.ts 的纯推导函数,不在 renderer 复制规则。
 */
export function toGhostPluginDetail(
  ghost: InstalledGhost,
  presentation?: GhostPluginMarketPresentation | null,
): GhostPluginDetail {
  const listItem = toGhostPluginListItem(ghost, presentation);
  const { manifest } = ghost;
  return {
    ...listItem,
    trust: listItem.trust!,
    author: presentation ? presentation.author : manifest.author ?? null,
    contents: ghostContentKeys(manifest),
    permissions: ghostPermissionItems(manifest),
    tools: manifest.tools ?? [],
    hasSettingsUi: Boolean(manifest.settingsHtml),
    cindyCapabilities: [
      ...(manifest.cindy?.image ?? []).map((action) => `image.${action}`),
      ...(manifest.cindy?.video ?? []).map((action) => `video.${action}`),
    ],
    panelMinWidth: manifest.panel ? (manifest.panel.minWidth ?? 280) : null,
    installDir: ghost.dir,
  };
}

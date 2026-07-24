import type { GhostManifest } from './ghost';
import type { PluginIconMetadata } from '@cindy/plugin-protocol';

export type PluginMarketScope = 'public' | 'organization' | 'personal';
export type PluginMarketInstallState =
  | 'not-installed'
  | 'installed'
  | 'update-available'
  | 'conflict';

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
}
/** 市场快照。服务不可用时 renderer 保留本地插件并只展示非阻断提示。 */
export interface PluginMarketSnapshot {
  items: PluginMarketItem[];
  unavailableReason: string | null;
}

/** 详情额外携带经 Desktop 当前 runtime validator 验证过的完整清单。 */
export interface PluginMarketDetail extends PluginMarketItem {
  manifest: GhostManifest;
}

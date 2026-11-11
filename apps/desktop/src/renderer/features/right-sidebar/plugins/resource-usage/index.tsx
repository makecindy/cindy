/**
 * resource-usage —— 本机进程 CPU / 内存快照视图。
 *
 * 新入口由独立的资源用量 BrowserWindow 承载；这里继续注册隐藏的兼容
 * plugin，让数据库中已持久化的旧页签仍可原位恢复和关闭，但不再允许新建。
 */

import { lazy } from 'react';
import { Activity } from 'lucide-react';
import type { TFunction } from 'i18next';

import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';
const ResourceUsageBody = lazy(() =>
  import('./ResourceUsageBody').then((module) => ({ default: module.ResourceUsageBody })),
);

export type ResourceUsageState = Record<never, never>;

function ResourceUsageTabPillTitle({ t }: { state: ResourceUsageState; t: TFunction }) {
  return <>{t('rightSidebar.tabs.kinds.resourceUsage')}</>;
}

function ResourceUsageTabPillIcon() {
  return <Activity size={13} />;
}

const plugin: TabKindPlugin<ResourceUsageState> = {
  kind: 'resource-usage',
  menu: {
    kind: 'resource-usage',
    labelKey: 'rightSidebar.tabs.kinds.resourceUsage',
    icon: Activity,
    order: 18,
    enabled: true,
    hiddenFromMenu: true,
    singleton: true,
  },
  TabPillTitle: ResourceUsageTabPillTitle,
  TabPillIcon: ResourceUsageTabPillIcon,
  TabBody: ResourceUsageBody,
  defaultState: () => ({}),
  serializeState: () => ({}),
  hydrateState: () => ({}),
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);

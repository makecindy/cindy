/**
 * resource-usage plugin —— 右栏「资源用量」页签(本机进程 CPU / 内存快照)。
 *
 * 约束:
 *  - 每会话单例(singleton),进「+」菜单;数据是全局的(本机进程),不随
 *    session 变化 —— 单例只是避免同一会话开一堆重复面板。SSH 任务不订阅
 *    本机数据,以明确不可用态避免把控制端进程误认为远端任务进程。
 *  - 无持久化状态(纯实时视图,重启后从头采样即可)。
 *  - 注册:模块顶层 import-side-effect,由 plugins/index.ts 汇总。
 */

import { Activity } from 'lucide-react';
import type { TFunction } from 'i18next';

import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';
import { ResourceUsageBody } from './ResourceUsageBody';

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
    order: 18, // background-tasks=17 与 web-browser=20 之间
    enabled: true,
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

/**
 * background-tasks plugin —— 右栏「后台任务」页签(本会话所有后台任务的主视图)。
 *
 * 约束:
 *  - 每会话单例(singleton),进「+」菜单;程序化入口见
 *    lib/openBackgroundTasksTab.ts。
 *  - state 只持有一次性详情定位 focusTaskId(openBackgroundTasksTab 写入,
 *    Body 消费后清空);serialize/hydrate 防御式,坏形状一律回落默认。
 *  - 注册:模块顶层 import-side-effect,由 plugins/index.ts 汇总。
 */

import { ListTodo } from 'lucide-react';
import type { TFunction } from 'i18next';

import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';
import { BackgroundTasksBody } from './BackgroundTasksBody';

export interface BackgroundTasksState {
  /** 一次性详情定位请求:对应 workflow 任务时直接进详情,消费后清空。 */
  focusTaskId?: string | null;
}

const DEFAULT_STATE: BackgroundTasksState = {};

function BackgroundTasksTabPillTitle({ t }: { state: BackgroundTasksState; t: TFunction }) {
  return <>{t('rightSidebar.tabs.kinds.backgroundTasks')}</>;
}

function BackgroundTasksTabPillIcon() {
  return <ListTodo size={13} />;
}

const plugin: TabKindPlugin<BackgroundTasksState> = {
  kind: 'background-tasks',
  menu: {
    kind: 'background-tasks',
    labelKey: 'rightSidebar.tabs.kinds.backgroundTasks',
    icon: ListTodo,
    order: 17, // review=15 与 web-browser=20 之间
    enabled: true,
    singleton: true, // 每个对话至多 1 个后台任务面板
  },
  TabPillTitle: BackgroundTasksTabPillTitle,
  TabPillIcon: BackgroundTasksTabPillIcon,
  TabBody: BackgroundTasksBody,
  defaultState: () => ({ ...DEFAULT_STATE }),
  // 持久化只留 focusTaskId(未消费的定位请求跨重启至多重放一次;无请求写空对象)。
  serializeState: (state) =>
    typeof state.focusTaskId === 'string' && state.focusTaskId
      ? { focusTaskId: state.focusTaskId }
      : {},
  hydrateState: (raw): BackgroundTasksState => {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_STATE };
    const obj = raw as Record<string, unknown>;
    return typeof obj.focusTaskId === 'string' && obj.focusTaskId
      ? { focusTaskId: obj.focusTaskId }
      : { ...DEFAULT_STATE };
  },
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);

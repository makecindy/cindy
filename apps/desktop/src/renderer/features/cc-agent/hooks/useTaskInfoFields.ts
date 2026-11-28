/**
 * useTaskInfoFields — 任务行右侧信息复选的共享状态(sidebar-redesign C 期)。
 * ---------------------------------------------------------------------------
 * 消费方分散(整理菜单 / SessionItem / SessionCard),不适合走 useSidebarFilter
 * 的单实例 state——那样菜单切换后列表行拿不到新值。采用与 useSidebarCardMode
 * 同款模式:模块级内存 SoT + listener 集合(同标签页实例间同步)+ storage 事件
 * (跨窗口同步)。持久化读写复用 sidebarFilterCore 的纯函数(已有单测)。
 */

import { useCallback } from 'react';
import { createSidebarModePreference } from '@/hooks/sidebarModePreference';

import {
  DEFAULT_TASK_INFO_FIELDS,
  TASK_INFO_KEY,
  loadTaskInfoFields,
  nextTaskInfoAfterToggle,
  persistTaskInfoFields,
  type TaskInfoField,
} from './helpers/sidebarFilterCore';

export type { TaskInfoField } from './helpers/sidebarFilterCore';

const useFields = createSidebarModePreference<readonly TaskInfoField[]>(
  TASK_INFO_KEY, loadTaskInfoFields, persistTaskInfoFields,
);

export function useTaskInfoFields() {
  const { value: fields, store } = useFields();
  const toggleField = useCallback((field: TaskInfoField) => {
    store.set(nextTaskInfoAfterToggle(store.get(), field));
  }, [store]);
  return { fields, toggleField };
}

export { DEFAULT_TASK_INFO_FIELDS };

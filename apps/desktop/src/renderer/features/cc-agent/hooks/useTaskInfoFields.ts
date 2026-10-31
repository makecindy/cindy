/**
 * useTaskInfoFields — 任务行右侧信息复选的共享状态(sidebar-redesign C 期)。
 * ---------------------------------------------------------------------------
 * 消费方分散(整理菜单 / SessionItem / SessionCard),不适合走 useSidebarFilter
 * 的单实例 state——那样菜单切换后列表行拿不到新值。采用与 useSidebarCardMode
 * 同款模式:模块级内存 SoT + listener 集合(同标签页实例间同步)+ storage 事件
 * (跨窗口同步)。持久化读写复用 sidebarFilterCore 的纯函数(已有单测)。
 */

import { useCallback, useEffect, useState } from 'react';

import {
  DEFAULT_TASK_INFO_FIELDS,
  TASK_INFO_KEY,
  loadTaskInfoFields,
  nextTaskInfoAfterToggle,
  persistTaskInfoFields,
  parseTaskInfoFields,
  type TaskInfoField,
} from './helpers/sidebarFilterCore';

export type { TaskInfoField } from './helpers/sidebarFilterCore';

let memoryValue: readonly TaskInfoField[] | null = null;

/** 同步读——首个读取者从 storage 落定一次。 */
export function getTaskInfoFields(): readonly TaskInfoField[] {
  ensureStorageListener();
  if (memoryValue !== null) return memoryValue;
  return (memoryValue = loadTaskInfoFields());
}

const listeners = new Set<() => void>();
let storageListenerBound = false;

function ensureStorageListener(): void {
  if (storageListenerBound || typeof window === 'undefined') return;
  storageListenerBound = true;
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== TASK_INFO_KEY) return;
    memoryValue = parseTaskInfoFields(event.newValue);
    listeners.forEach(fn => fn());
  });
}

export function useTaskInfoFields(): {
  fields: readonly TaskInfoField[];
  toggleField: (field: TaskInfoField) => void;
} {
  const [fields, setFieldsState] = useState<readonly TaskInfoField[]>(getTaskInfoFields);

  const toggleField = useCallback((field: TaskInfoField) => {
    const next = nextTaskInfoAfterToggle(getTaskInfoFields(), field);
    memoryValue = next;
    setFieldsState(next);
    persistTaskInfoFields(next);
    listeners.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    ensureStorageListener();
    const sync = () => setFieldsState(getTaskInfoFields());
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);

  return { fields, toggleField };
}

export { DEFAULT_TASK_INFO_FIELDS };

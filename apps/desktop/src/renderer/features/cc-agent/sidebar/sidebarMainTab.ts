import { useCallback, useSyncExternalStore } from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { readSidebarOwnerStorage, writeSidebarOwnerStorage } from '@/lib/sidebarOwnerStorage';

/**
 * 侧栏顶部标签(2026-11-19 用户裁决):任务 / 伙伴 / 对话 / 自动化横向切换,
 * 每次只显示一类，不再把伙伴段、对话组、自动化组竖着插进任务列表。
 * 按账号记在本机，下次打开停在上次的标签。
 */
export type SidebarMainTab = 'tasks' | 'buddies' | 'chats' | 'automations';

export const SIDEBAR_MAIN_TABS: readonly SidebarMainTab[] = ['tasks', 'buddies', 'chats', 'automations'];

const KEY = 'sidebar.mainTab.v1';

function parse(value: string | null): SidebarMainTab {
  return SIDEBAR_MAIN_TABS.includes(value as SidebarMainTab) ? (value as SidebarMainTab) : 'tasks';
}

// 同一窗口里标签条和列表共用一份选择;写入后通知所有订阅者。
const listeners = new Set<() => void>();
const memory = new Map<string, SidebarMainTab>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function read(ownerId: string | null): SidebarMainTab {
  const key = ownerId ?? '';
  const cached = memory.get(key);
  if (cached) return cached;
  const value = parse(readSidebarOwnerStorage(KEY, ownerId));
  memory.set(key, value);
  return value;
}

export function useSidebarMainTab(): [SidebarMainTab, (tab: SidebarMainTab) => void] {
  const { dataOwnerId } = useAuth();
  const tab = useSyncExternalStore(subscribe, () => read(dataOwnerId));
  const setTab = useCallback(
    (next: SidebarMainTab) => {
      memory.set(dataOwnerId ?? '', next);
      writeSidebarOwnerStorage(KEY, dataOwnerId, next);
      for (const listener of listeners) listener();
    },
    [dataOwnerId],
  );
  return [tab, setTab];
}

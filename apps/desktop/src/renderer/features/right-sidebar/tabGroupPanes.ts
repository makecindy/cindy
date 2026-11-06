/**
 * tabGroupPanes —— 左 / 上 / 下边页签组的「在场」判定与 pane 注册。
 *
 * 一个边组只在「本窗口当前能看到至少一个页签」时存在:任务页签看当前任务桶,
 * 全局页签全局在场,两者都按 Shell 同一口径的可用性投影(buildTabAvailabilities)
 * 并排除已弹出到独立窗口的页签。在场 → 向面板注册表注册 `tab-group:<边>` 并保证
 * 布局树里有它的 pane(第一次用到时按边插入);不在场 → 注销 kind,引擎把 pane
 * 隐藏、空间回流(树数据保留,下次原位回来)。右侧组始终注册,不经这里。
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
  ensureTabGroupPane,
  findSplitChildByPanelKind,
  TAB_GROUP_IDS,
  tabGroupPanelKind,
  type TabGroupId,
} from '../../../shared/layoutTree';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { createLogger } from '@/lib/logger';
import { useSidebarTabWindowsState } from '@/lib/sidebarTabWindowState';
import {
  hasPanelKind,
  registerPanelKind,
  setPanelKindParked,
  unregisterPanelKind,
} from '@/panels/registry';
import { useGlobalTabs } from './globalTabs';
import { getBucket, subscribe } from './store';
import { projectAvailableTabs, buildTabAvailabilities } from './tabAvailability';
import { tabGroupPanelComponent } from './TabGroupPanel';
import { tabGroupOf, useTabGroupAssignments } from './tabGroups';

const log = createLogger('rightSidebar.tabGroupPanes');

export type EdgeTabGroupId = Exclude<TabGroupId, 'right'>;
export const EDGE_TAB_GROUP_IDS = TAB_GROUP_IDS.filter(
  (id): id is EdgeTabGroupId => id !== 'right',
);

export interface TabGroupPanesInput {
  sessionId: string | null;
  /** 本窗口能承载边组(右栏窗口状态已加载、未整栏分离、不在设置页);false 时所有边组一律注销。 */
  enabled: boolean;
  /**
   * 内容区在聊天路由上(右侧栏可用),默认 true。false 时在聊天页出现过的组停放而不注销;
   * 从未在聊天页出现过的组不挂载(不创建 webview)。
   */
  onChatRoute?: boolean;
  remoteHostId: string | null;
  deviceLinkDeviceId?: string | null;
  subagentsAvailable?: boolean;
}

/** 纯函数:哪些边组当前有可见页签。 */
export function presentEdgeTabGroups(input: {
  sessionTabs: readonly { id: string }[];
  globalTabs: readonly { id: string }[];
  assignments: Readonly<Record<string, TabGroupId>>;
}): Set<EdgeTabGroupId> {
  const out = new Set<EdgeTabGroupId>();
  for (const tab of [...input.globalTabs, ...input.sessionTabs]) {
    const group = tabGroupOf(input.assignments, tab.id);
    if (group !== 'right') out.add(group);
  }
  return out;
}

function ensurePaneInTree(groupId: EdgeTabGroupId): void {
  try {
    const api = window.electronAPI?.layout;
    if (!api) return;
    const layout = api.getStateSync().layout;
    if (findSplitChildByPanelKind(layout, tabGroupPanelKind(groupId))) return;
    const op = ensureTabGroupPane(layout, groupId);
    if (!op.applied) {
      log.warn('ensure tab group pane rejected', { groupId, reason: op.reason });
      return;
    }
    void api.set(op.layout).catch((err) => {
      log.warn('persist tab group pane failed', { groupId, err });
    });
  } catch (err) {
    log.warn('ensure tab group pane failed', { groupId, err });
  }
}

/**
 * 挂在主窗口(MainLayout):随任务桶 / 全局页签 / 组归属 / 弹出状态的变化维护
 * 边组 pane 的注册与树里的在场。
 */
export function useTabGroupPanes(input: TabGroupPanesInput): void {
  const {
    sessionId,
    enabled,
    onChatRoute = true,
    remoteHostId,
    deviceLinkDeviceId,
    subagentsAvailable,
  } = input;
  const subscribeBucket = useCallback(
    (onChange: () => void) =>
      subscribe((changedSessionId) => {
        if (changedSessionId === sessionId) onChange();
      }),
    [sessionId],
  );
  const getBucketSnapshot = useCallback(() => getBucket(sessionId), [sessionId]);
  const bucket = useSyncExternalStore(subscribeBucket, getBucketSnapshot);
  const globalTabs = useGlobalTabs();
  const assignments = useTabGroupAssignments();
  const poppedOut = useSidebarTabWindowsState();
  const installedGhosts = useInstalledGhosts();

  const present = useMemo(() => {
    if (!enabled) return new Set<EdgeTabGroupId>();
    const hidden = Object.keys(poppedOut);
    const availability = buildTabAvailabilities({
      installedGhosts,
      remoteHostId,
      deviceLinkDeviceId,
      subagentsAvailable,
      hiddenTabIds: hidden.length > 0 ? new Set(hidden) : undefined,
    });
    const sessionTabs = bucket.hydrated
      ? projectAvailableTabs(bucket.tabs, bucket.activeTabId, availability.session).tabs
      : [];
    const pinned = projectAvailableTabs(globalTabs, null, availability.global).tabs;
    return presentEdgeTabGroups({ sessionTabs, globalTabs: pinned, assignments });
  }, [
    assignments,
    bucket,
    deviceLinkDeviceId,
    enabled,
    globalTabs,
    installedGhosts,
    poppedOut,
    remoteHostId,
    subagentsAvailable,
  ]);
  const presentKey = [...present].sort().join(',');

  // 布局被重置 / 外部改写后重新保证在场组的 pane 还在树里。
  const [layoutRevision, setLayoutRevision] = useState(0);
  useEffect(() => {
    const api = window.electronAPI?.layout;
    if (!api?.onChanged) return;
    return api.onChanged(() => setLayoutRevision((revision) => revision + 1));
  }, []);

  // 在聊天页出现过、此后一直有可见页签的组:离开聊天页时只停放这些组。
  const mountedOnChatRef = useRef(new Set<EdgeTabGroupId>());

  useEffect(() => {
    const mountedOnChat = mountedOnChatRef.current;
    for (const groupId of EDGE_TAB_GROUP_IDS) {
      const kind = tabGroupPanelKind(groupId);
      if (!present.has(groupId)) mountedOnChat.delete(groupId);
      else if (onChatRoute) mountedOnChat.add(groupId);
      if (!mountedOnChat.has(groupId)) {
        unregisterPanelKind(kind);
        continue;
      }
      if (!hasPanelKind(kind)) {
        registerPanelKind({
          kind,
          Component: tabGroupPanelComponent(groupId),
          collapseMemory: 'none',
        });
      }
      setPanelKindParked(kind, !onChatRoute);
      ensurePaneInTree(groupId);
    }
    // presentKey 是 present 的稳定字符串化;layoutRevision 触发树重检。
  }, [present, presentKey, onChatRoute, layoutRevision]);

  useEffect(() => {
    const mountedOnChat = mountedOnChatRef.current;
    return () => {
      mountedOnChat.clear();
      for (const groupId of EDGE_TAB_GROUP_IDS) unregisterPanelKind(tabGroupPanelKind(groupId));
    };
  }, []);
}

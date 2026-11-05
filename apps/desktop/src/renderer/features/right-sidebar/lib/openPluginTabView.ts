import { addGlobalPluginTabView, getActiveGlobalTabId, requestRevealSessionTab, setActiveGlobalTabId } from '../globalTabs';
import { addTab, ensureHydrated, getBucket, setActiveTab } from '../store';
import { getTabGroup, setGroupActiveTabId } from '../tabGroups';
import { isTabPoppedOut } from '@/lib/sidebarTabWindowState';
import { requestRightSidebarVisibility } from './sidebarCommands';
import type { PluginTabViewState } from '../../../../shared/pluginUi';

/** Called only in the Host-selected native tab owner; never accepts page URLs. */
export async function openPluginTabView(instanceId: string, id: string, sessionId: string | null,
  beforeReveal?: (tabId: string) => void): Promise<string> {
  let tabId: string;
  if (sessionId === null) {
    const tab = addGlobalPluginTabView(instanceId, id);
    if (!tab) throw new Error('VIEW_UNAVAILABLE');
    tabId = tab.id;
    beforeReveal?.(tabId);
    setActiveGlobalTabId(tabId);
  } else {
    await ensureHydrated(sessionId);
    const existing = getBucket(sessionId).tabs.find(tab => tab.kind === 'plugin-tab-view' &&
      (tab.state as PluginTabViewState)?.instanceId === instanceId && (tab.state as PluginTabViewState)?.id === id);
    if (existing) beforeReveal?.(existing.id);
    const tab = existing ?? await addTab(sessionId, 'plugin-tab-view', { instanceId, id, scope: 'session' } satisfies PluginTabViewState,
      { onOptimisticAdd: beforeReveal });
    tabId = tab.id;
    await setActiveTab(sessionId, tabId);
    if (!isTabPoppedOut(tabId)) {
      const group = getTabGroup(tabId);
      setGroupActiveTabId(group, sessionId, tabId);
      const global = getActiveGlobalTabId();
      if (global && getTabGroup(global) === group) setActiveGlobalTabId(null);
    }
    requestRevealSessionTab(sessionId, tabId);
  }
  if (isTabPoppedOut(tabId)) await window.electronAPI?.sidebarTabWindow?.focus(tabId);
  else if (getTabGroup(tabId) === 'right') requestRightSidebarVisibility('open', sessionId ? { sessionId } : {});
  return tabId;
}

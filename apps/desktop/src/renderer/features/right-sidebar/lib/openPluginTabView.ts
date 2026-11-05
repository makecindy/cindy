import { addGlobalPluginTabView, getActiveGlobalTabId, requestRevealSessionTab, setActiveGlobalTabId } from '../globalTabs';
import { addTab, ensureHydrated, getBucket, setActiveTab } from '../store';
import { getTabGroup, setGroupActiveTabId } from '../tabGroups';
import { isTabPoppedOut } from '@/lib/sidebarTabWindowState';
import { requestRightSidebarVisibility } from './sidebarCommands';
import type { PluginTabViewState } from '../../../../shared/pluginUi';

/** Called only in the Host-selected native tab owner; never accepts page URLs. */
export async function openPluginTabView(instanceId: string, id: string, sessionId: string | null,
  options: { beforeReveal?(tabId: string): void; current?(): boolean; focus?(): boolean } = {}): Promise<string> {
  const current = () => options.current?.() !== false;
  const focus = () => current() && options.focus?.() !== false;
  if (!current()) throw new Error('VIEW_UNAVAILABLE');
  let tabId: string;
  if (sessionId === null) {
    const tab = addGlobalPluginTabView(instanceId, id);
    if (!tab) throw new Error('VIEW_UNAVAILABLE');
    tabId = tab.id;
    options.beforeReveal?.(tabId);
    if (focus()) setActiveGlobalTabId(tabId);
  } else {
    await ensureHydrated(sessionId);
    if (!current()) throw new Error('VIEW_UNAVAILABLE');
    const existing = getBucket(sessionId).tabs.find(tab => tab.kind === 'plugin-tab-view' &&
      (tab.state as PluginTabViewState)?.instanceId === instanceId && (tab.state as PluginTabViewState)?.id === id);
    const previousActive = getBucket(sessionId).activeTabId, previousGlobal = getActiveGlobalTabId();
    if (existing) options.beforeReveal?.(existing.id);
    const tab = existing ?? await addTab(sessionId, 'plugin-tab-view', { instanceId, id, scope: 'session' } satisfies PluginTabViewState,
      { onOptimisticAdd: options.beforeReveal, activate: false });
    tabId = tab.id;
    // The Shell can select the optimistic first tab while creation awaits IPC.
    const activeNow = getBucket(sessionId).activeTabId;
    if (!focus() || (activeNow !== previousActive && activeNow !== tabId) || getActiveGlobalTabId() !== previousGlobal) return tabId;
    await setActiveTab(sessionId, tabId);
    if (!focus() || getBucket(sessionId).activeTabId !== tabId || getActiveGlobalTabId() !== previousGlobal) return tabId;
    if (!isTabPoppedOut(tabId)) {
      const group = getTabGroup(tabId);
      setGroupActiveTabId(group, sessionId, tabId);
      const global = getActiveGlobalTabId();
      if (global && getTabGroup(global) === group) setActiveGlobalTabId(null);
    }
    requestRevealSessionTab(sessionId, tabId);
  }
  if (!focus()) return tabId;
  if (isTabPoppedOut(tabId)) await window.electronAPI?.sidebarTabWindow?.focus(tabId);
  else if (getTabGroup(tabId) === 'right') requestRightSidebarVisibility('open', sessionId ? { sessionId } : {});
  return tabId;
}

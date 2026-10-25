/**
 * globalTabs —— 右侧栏「不跟对话」的全局页签。
 *
 * 右侧栏的页签分两类:任务页签(store.ts,按任务分桶、切任务跟着换)与全局页签
 * (本模块,全局一份、切任务留在原位)。全局页签今天只有一种内容:插件视图
 * (kind `plugin-view`,承载插件的 `mainView` 或 `panel` 页面)。
 *
 * 持久化:renderer 自有的 localStorage(按数据所有者分键,重启保留,不经 main),
 * 与旧停靠面板的最小化状态同一条路;`storage` 事件做跨窗口同步(主窗 / 副窗 /
 * 弹出的页签窗口各自一份镜像)。存的是 UI 配置,不是任务数据,所以不进 SQLite。
 *
 * 兼容:插件 manifest 里声明了 `panel`(非 `tab` 形态)的插件,启用后自动以全局页签
 * 出现(reconcileGlobalPluginTabs),用户关掉后记入 dismissed 不再自动加回;卸载即
 * 清掉它的页签与 dismissed 记录,重装再按首次启用处理。`mainView` 插件不自动加,
 * 由左侧栏入口「在侧边栏中打开」加入。
 *
 * 放置记忆:全局页签的 id 由插件实例决定(`g_<instanceId>`),所以组归属(tabGroups)在
 * 关掉再打开后仍然有效;首次出现时按插件声明放到默认边(panel.position / mainView.side),
 * 之后以用户拖到的位置为准;弹到独立窗口过的插件下次从左侧栏入口点开也进窗口。
 * 「恢复默认位置」清掉这些记忆。
 */

import { useSyncExternalStore } from 'react';

import { ghostPanelKind, type InstalledGhost } from '../../../shared/ghost';
import { paneEdgeRelativeToChat, type Layout } from '../../../shared/layoutTree';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { createLogger } from '@/lib/logger';
import { isSidebarTabWindow } from '@/lib/sidebarTabWindow';
import { isTabPoppedOut } from '@/lib/sidebarTabWindowState';
import { clearTabGroup, getTabGroupAssignments, setTabGroup, type TabGroupId } from './tabGroups';
import type { TabState } from './types';

const log = createLogger('rightSidebar.globalTabs');

const STORAGE_KEY_PREFIX = 'xdt:rightSidebarGlobalTabs:v1:';
/**
 * 全局页签数量上限只是防损坏存档的兜底,必须远大于已装插件的现实数量:存量停靠面板要全部迁移,
 * 不能被会话页签那种小上限截断(截断 = 升级后部分面板插件静默不可用)。
 */
const MAX_GLOBAL_TABS = 500;

/** 页签承载插件的哪个页面:停靠面板(panel.html)或主视图(mainView.html)。 */
export type PluginViewKind = 'panel' | 'main';

export interface PluginViewTabState {
  /** 插件物理实例 id(storage part)。 */
  instanceId: string;
  /**
   * 承载的页面。缺省(旧数据)按插件声明推导:有停靠面板 → panel,否则 main——
   * 与升级前「panel 优先」的行为一致。
   */
  view?: PluginViewKind;
}

/** 插件有没有停靠形态(非 tab)的面板。 */
export function ghostHasDockedPanel(ghost: InstalledGhost): boolean {
  return ghost.manifest.panel !== undefined && ghost.manifest.panel.position !== 'tab';
}

/** 页签实际承载的页面:显式记录优先,旧数据按插件声明推导。 */
export function effectivePluginView(
  state: PluginViewTabState | null | undefined,
  ghost: InstalledGhost | undefined,
): PluginViewKind {
  if (state?.view) return state.view;
  return ghost && ghostHasDockedPanel(ghost) ? 'panel' : 'main';
}

/**
 * 该页签承载的页面是不是插件的主视图(整页入口那一份)。panel 与 mainView 指向不同
 * html 的插件,两个页面是不同的界面,可以并存;同一 html 或页签本身承载主视图才算同一视图。
 */
export function tabShowsMainView(
  state: PluginViewTabState | null | undefined,
  ghost: InstalledGhost,
): boolean {
  const view = effectivePluginView(state, ghost);
  if (view === 'main') return true;
  const panelHtml = ghost.manifest.panel?.html;
  return panelHtml !== undefined && panelHtml === ghost.manifest.mainView?.html;
}

export interface GlobalTabsSnapshot {
  tabs: TabState[];
  /** 用户主动关掉过、不再自动加回的插件实例。 */
  dismissedInstanceIds: string[];
  /** 已按插件声明放过默认边的实例(之后不再重新套默认,以用户放置为准)。 */
  placedInstanceIds: string[];
  /** 上次是弹在独立窗口里的实例:左侧栏入口点开时直接进窗口。 */
  windowInstanceIds: string[];
}

const EMPTY: GlobalTabsSnapshot = Object.freeze({
  tabs: [],
  dismissedInstanceIds: [],
  placedInstanceIds: [],
  windowInstanceIds: [],
}) as GlobalTabsSnapshot;

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string' && !!id) : [];
}

let cache: GlobalTabsSnapshot | null = null;
let cacheOwnerKey: string | null = null;
/** 当前窗口里被激活的全局页签;切任务时保持,选中任务页签时清空。不持久化。 */
let activeGlobalTabId: string | null = null;
const subscribers = new Set<() => void>();
let storageListenerWired = false;

function ownerKey(): string {
  return STORAGE_KEY_PREFIX + (getDataOwnerGeneration().dataOwnerId ?? 'none');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 解析并清洗持久化数据:坏条目整条丢弃,fail closed 不进状态。 */
export function sanitizeGlobalTabsSnapshot(raw: unknown): GlobalTabsSnapshot {
  if (!isPlainObject(raw)) return EMPTY;
  const tabs: TabState[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.tabs)) {
    for (const entry of raw.tabs) {
      if (!isPlainObject(entry)) continue;
      if (typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)) continue;
      if (entry.kind !== 'plugin-view') continue;
      if (!isPlainObject(entry.state) || typeof entry.state.instanceId !== 'string') continue;
      seen.add(entry.id);
      tabs.push({
        id: entry.id,
        kind: 'plugin-view',
        state: {
          instanceId: entry.state.instanceId,
          ...(entry.state.view === 'panel' || entry.state.view === 'main'
            ? { view: entry.state.view }
            : {}),
        } satisfies PluginViewTabState,
      });
      if (tabs.length >= MAX_GLOBAL_TABS) break;
    }
  }
  return {
    tabs,
    dismissedInstanceIds: stringList(raw.dismissedInstanceIds),
    placedInstanceIds: stringList(raw.placedInstanceIds),
    windowInstanceIds: stringList(raw.windowInstanceIds),
  };
}

function load(): GlobalTabsSnapshot {
  try {
    const raw = window.localStorage.getItem(ownerKey());
    if (!raw) return EMPTY;
    return sanitizeGlobalTabsSnapshot(JSON.parse(raw));
  } catch {
    return EMPTY;
  }
}

function notify(): void {
  for (const cb of [...subscribers]) cb();
}

function ensureStorageListener(): void {
  if (storageListenerWired || typeof window === 'undefined') return;
  storageListenerWired = true;
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== cacheOwnerKey) return;
    cache = null;
    notify();
  });
}

/**
 * 写路径专用:先丢掉本窗口内存缓存、从 localStorage 重读最新一份再改。主窗与每扇弹出窗口各有
 * 独立缓存,拿旧缓存做「读—改—写」会把别的窗口刚做的修改(刚关掉的页签等)整份覆盖回去。
 * localStorage 同步且跨窗口共享,同一 JS 任务内「重读 + 写回」之间没有别的窗口能插进来。
 */
function freshSnapshot(): GlobalTabsSnapshot {
  cache = null;
  return getGlobalTabsSnapshot();
}

export function getGlobalTabsSnapshot(): GlobalTabsSnapshot {
  const key = ownerKey();
  if (cache === null || cacheOwnerKey !== key) {
    cache = load();
    cacheOwnerKey = key;
    ensureStorageListener();
  }
  return cache;
}

export function getGlobalTabs(): TabState[] {
  return getGlobalTabsSnapshot().tabs;
}

export function isGlobalTabId(tabId: string): boolean {
  return getGlobalTabs().some((tab) => tab.id === tabId);
}

export function findGlobalTab(tabId: string): TabState | null {
  return getGlobalTabs().find((tab) => tab.id === tabId) ?? null;
}

function persist(next: GlobalTabsSnapshot): void {
  const key = ownerKey();
  cache = next;
  cacheOwnerKey = key;
  try {
    if (
      next.tabs.length === 0 &&
      next.dismissedInstanceIds.length === 0 &&
      next.placedInstanceIds.length === 0 &&
      next.windowInstanceIds.length === 0
    ) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, JSON.stringify(next));
    }
  } catch (err) {
    log.warn('persist global tabs failed', { err });
  }
  notify();
}

/** 全局页签 id 由插件实例决定:关掉再打开仍是同一个 id,组归属等记忆因此跟着实例走。 */
export function globalTabIdForInstance(instanceId: string): string {
  return `g_${instanceId}`;
}

/**
 * 插件声明的默认放置边,按页签承载的页面取:
 *  - 主视图(main):`mainView.open:'sidebar'` 的 `side`,缺省右侧;
 *  - 停靠面板(panel):`panel.position`,缺省 left(与历史停靠面板「停在聊天区左侧」一致)。
 * 两个页面都声明时互不影响对方的默认边。
 */
export function defaultGroupForGhost(ghost: InstalledGhost, view?: PluginViewKind): TabGroupId {
  const { manifest } = ghost;
  const resolved = view ?? (ghostHasDockedPanel(ghost) ? 'panel' : 'main');
  if (resolved === 'main') {
    return manifest.mainView?.open === 'sidebar' ? (manifest.mainView.side ?? 'right') : 'right';
  }
  const position = manifest.panel?.position;
  return position && position !== 'tab' ? position : 'left';
}

/**
 * 加入(或返回已有的)某个插件的全局页签。幂等:同一实例只有一个页签。
 * 用户手动加入会清掉它的 dismissed 记录。
 * 放置:显式 `groupId` 优先;否则首次出现的实例按插件声明放默认边(之后以用户放置为准,
 * 不再重新套默认);都没有就沿用已有组归属(缺省右侧组)。
 */
export function addGlobalPluginTab(
  instanceId: string,
  opts?: { groupId?: TabGroupId; ghost?: InstalledGhost; view?: PluginViewKind },
): TabState | null {
  const current = freshSnapshot();
  const existing = current.tabs.find(
    (tab) => (tab.state as PluginViewTabState | null)?.instanceId === instanceId,
  );
  const dismissed = current.dismissedInstanceIds.filter((id) => id !== instanceId);
  if (existing) {
    if (opts?.groupId) setTabGroup(existing.id, opts.groupId);
    // 同一插件只有一个页签:明确要求另一个页面时把页签切过去(panel 与 mainView 不同页面时)。
    const existingState = existing.state as PluginViewTabState;
    const wantedView = opts?.view;
    const switched =
      wantedView !== undefined && effectivePluginView(existingState, opts?.ghost) !== wantedView;
    const next = switched
      ? { ...existing, state: { ...existingState, view: wantedView } as PluginViewTabState }
      : existing;
    if (switched || dismissed.length !== current.dismissedInstanceIds.length) {
      persist({
        ...current,
        tabs: switched ? current.tabs.map((tab) => (tab === existing ? next : tab)) : current.tabs,
        dismissedInstanceIds: dismissed,
      });
    }
    return next;
  }
  if (current.tabs.length >= MAX_GLOBAL_TABS) {
    log.warn('global tab limit reached', { instanceId });
    return null;
  }
  const view: PluginViewKind | undefined =
    opts?.view ?? (opts?.ghost ? effectivePluginView(undefined, opts.ghost) : undefined);
  const tab: TabState = {
    id: globalTabIdForInstance(instanceId),
    kind: 'plugin-view',
    state: { instanceId, ...(view ? { view } : {}) } satisfies PluginViewTabState,
  };
  let placed = current.placedInstanceIds;
  // 组归属先于页签出现落定,首帧就在目标组里。
  if (opts?.groupId) {
    setTabGroup(tab.id, opts.groupId);
  } else if (opts?.ghost && !placed.includes(instanceId)) {
    setTabGroup(tab.id, defaultGroupForGhost(opts.ghost, view));
    placed = [...placed, instanceId];
  }
  persist({
    ...current,
    tabs: [...current.tabs, tab],
    dismissedInstanceIds: dismissed,
    placedInstanceIds: placed,
  });
  return tab;
}

/** 用户关闭全局页签:全局动作,同时记 dismissed,插件不再自动加回。 */
export function removeGlobalTab(tabId: string): void {
  const current = freshSnapshot();
  const tab = current.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return;
  const instanceId = (tab.state as PluginViewTabState).instanceId;
  const dismissed = current.dismissedInstanceIds.includes(instanceId)
    ? current.dismissedInstanceIds
    : [...current.dismissedInstanceIds, instanceId];
  if (activeGlobalTabId === tabId) activeGlobalTabId = null;
  // 组归属不清:关掉再打开回到用户上次放的那一边(放置记忆)。
  persist({
    ...current,
    tabs: current.tabs.filter((candidate) => candidate.id !== tabId),
    dismissedInstanceIds: dismissed,
  });
  // 页签正弹在独立窗口里:窗口没有内容可交回,直接销毁(与任务页签同一规则)。
  if (!isSidebarTabWindow() && isTabPoppedOut(tabId)) {
    void window.electronAPI?.sidebarTabWindow?.closeForTab(tabId).catch((err) => {
      log.warn('close sidebar tab window for removed global tab failed', { tabId, err });
    });
  }
}

export function reorderGlobalTabs(orderedIds: string[]): void {
  const current = freshSnapshot();
  if (orderedIds.length !== current.tabs.length) return;
  const byId = new Map(current.tabs.map((tab) => [tab.id, tab]));
  const next: TabState[] = [];
  for (const id of orderedIds) {
    const tab = byId.get(id);
    if (!tab) return;
    next.push(tab);
  }
  persist({ ...current, tabs: next });
}

/** 记住 / 忘记「这个插件上次弹在独立窗口里」。 */
export function rememberPluginWindowPlacement(instanceId: string, inWindow: boolean): void {
  const current = freshSnapshot();
  const has = current.windowInstanceIds.includes(instanceId);
  if (has === inWindow) return;
  persist({
    ...current,
    windowInstanceIds: inWindow
      ? [...current.windowInstanceIds, instanceId]
      : current.windowInstanceIds.filter((id) => id !== instanceId),
  });
}

export function isPluginWindowPlacement(instanceId: string): boolean {
  return getGlobalTabsSnapshot().windowInstanceIds.includes(instanceId);
}

/** 用户是否放置过这个插件(拖到别的边 / 弹过窗口 / 已套过默认边):有记忆才给「恢复默认位置」。 */
export function hasPluginPlacementMemory(instanceId: string): boolean {
  const current = getGlobalTabsSnapshot();
  const tabId = globalTabIdForInstance(instanceId);
  return (
    current.windowInstanceIds.includes(instanceId) ||
    current.placedInstanceIds.includes(instanceId) ||
    tabId in getTabGroupAssignments()
  );
}

/**
 * 恢复默认位置:清掉窗口记忆与组归属;页签还在时按插件声明重新放到默认边。
 * 弹在窗口里的页签由调用方先合并回侧边栏(这里不碰窗口)。
 */
export function resetPluginPlacement(instanceId: string, ghost?: InstalledGhost): void {
  const current = freshSnapshot();
  const tabId = globalTabIdForInstance(instanceId);
  clearTabGroup(tabId);
  const presentTab = current.tabs.find((tab) => tab.id === tabId);
  let placed = current.placedInstanceIds.filter((id) => id !== instanceId);
  if (presentTab && ghost) {
    setTabGroup(
      tabId,
      defaultGroupForGhost(
        ghost,
        effectivePluginView(presentTab.state as PluginViewTabState, ghost),
      ),
    );
    placed = [...placed, instanceId];
  }
  persist({
    ...current,
    placedInstanceIds: placed,
    windowInstanceIds: current.windowInstanceIds.filter((id) => id !== instanceId),
  });
}

/**
 * 页签标题,按页签实际承载的页面取:panel 用 panel.title,main 用 mainView.title,缺省回落到
 * 另一个声明再回落插件名。不传 view 时按插件声明推导(有停靠面板 → panel,与升级前一致)。
 */
export function globalTabTitleForGhost(ghost: InstalledGhost, view?: PluginViewKind): string {
  const { manifest } = ghost;
  const resolved = view ?? effectivePluginView(undefined, ghost);
  const first = resolved === 'main' ? manifest.mainView?.title : manifest.panel?.title;
  const second = resolved === 'main' ? manifest.panel?.title : manifest.mainView?.title;
  return first ?? second ?? manifest.name;
}

export function findGlobalTabByInstance(instanceId: string): TabState | null {
  return (
    getGlobalTabs().find(
      (tab) => (tab.state as PluginViewTabState | null)?.instanceId === instanceId,
    ) ?? null
  );
}

/** 停靠形态(非 `tab`)的插件面板 = 应自动出现在右侧栏的全局页签。 */
export function isAutoGlobalPanelGhost(ghost: InstalledGhost): boolean {
  return (
    ghost.enabled !== false &&
    ghost.manifest.panel !== undefined &&
    ghost.manifest.panel.position !== 'tab'
  );
}

/** 插件是否能作为全局页签承载(有 mainView 或停靠形态 panel 的已启用插件)。 */
export function isGlobalTabCapableGhost(ghost: InstalledGhost): boolean {
  return (
    ghost.enabled !== false &&
    (ghost.manifest.mainView !== undefined || isAutoGlobalPanelGhost(ghost))
  );
}

/** 升级前停靠面板「最小化到气泡」的持久化键(旧实现已移除,这里只读一次做迁移)。 */
const LEGACY_PANEL_BUBBLE_KEY = 'xdt:ghostPanelBubble:v1';

/** 旧版里被用户收进气泡(= 主动隐藏)的插件实例;读失败 / 坏数据视为没有。 */
function legacyMinimizedInstanceIds(): Set<string> {
  const out = new Set<string>();
  try {
    const raw = window.localStorage.getItem(LEGACY_PANEL_BUBBLE_KEY);
    if (!raw) return out;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out;
    for (const [id, entry] of Object.entries(parsed)) {
      if ((entry as { minimized?: unknown } | null)?.minimized === true) out.add(id);
    }
  } catch {
    // 旧数据读不出来就当没有:最坏是面板作为页签重新出现,用户可关掉。
  }
  return out;
}

/** 升级前该插件停靠面板在布局树里相对聊天区的边;树里没有 / 读不到返回 null。 */
function legacyPanelEdge(instanceId: string): TabGroupId | null {
  try {
    const layout = window.electronAPI?.layout?.getStateSync().layout as Layout | undefined;
    return layout ? paneEdgeRelativeToChat(layout, ghostPanelKind(instanceId)) : null;
  } catch {
    return null;
  }
}

/**
 * 与已装清单对齐(启动 + ghosts:changed):
 *  - 已启用、声明停靠面板、未被用户关掉的插件 → 自动加页签(存量插件兼容:
 *    升级前靶在布局树里的停靠面板,升级后出现在右侧栏,用户什么都不用做);
 *  - 清单里不存在的实例 → 删页签与 dismissed 记录(重装视同首次启用)。
 * 停用的插件页签**保留**(投影时按可用性隐藏),重新启用原位回来。
 */
export function reconcileGlobalPluginTabs(ghosts: readonly InstalledGhost[]): void {
  const current = freshSnapshot();
  const installed = new Map(ghosts.map((ghost) => [installedGhostStoragePart(ghost), ghost]));
  let tabs = current.tabs.filter((tab) =>
    installed.has((tab.state as PluginViewTabState).instanceId),
  );
  let dismissed = current.dismissedInstanceIds.filter((id) => installed.has(id));
  let placed = current.placedInstanceIds.filter((id) => installed.has(id));
  const windowed = current.windowInstanceIds.filter((id) => installed.has(id));
  const present = new Set(tabs.map((tab) => (tab.state as PluginViewTabState).instanceId));
  let legacyMinimized: Set<string> | undefined;
  for (const [instanceId, ghost] of installed) {
    if (!isAutoGlobalPanelGhost(ghost)) continue;
    if (present.has(instanceId) || dismissed.includes(instanceId)) continue;
    const tabId = globalTabIdForInstance(instanceId);
    // 首次出现:按插件声明放默认边(存量 panel.position 的插件回到它原来停的那一边)。
    if (!placed.includes(instanceId)) {
      // 升级前用户把它收进了气泡 = 主动隐藏:迁成「已关闭」,不自动弹出;「+」菜单里可重开。
      legacyMinimized ??= legacyMinimizedInstanceIds();
      if (legacyMinimized.has(instanceId)) {
        dismissed = [...dismissed, instanceId];
        continue;
      }
      // 用户在旧布局里把它拖到过别处的,按旧位置迁(相对聊天区的那一边),没有再取默认边。
      setTabGroup(tabId, legacyPanelEdge(instanceId) ?? defaultGroupForGhost(ghost, 'panel'));
      placed = [...placed, instanceId];
    }
    // 自动出现的是停靠面板:显式记 panel,之后即使同时有 mainView 入口也不串页面。
    tabs = [...tabs, { id: tabId, kind: 'plugin-view', state: { instanceId, view: 'panel' } }];
    present.add(instanceId);
  }
  if (
    tabs.length === current.tabs.length &&
    tabs.every((tab, index) => tab === current.tabs[index]) &&
    dismissed.length === current.dismissedInstanceIds.length &&
    placed.length === current.placedInstanceIds.length &&
    windowed.length === current.windowInstanceIds.length
  ) {
    return;
  }
  if (activeGlobalTabId && !tabs.some((tab) => tab.id === activeGlobalTabId)) {
    activeGlobalTabId = null;
  }
  // 卸载的实例:页签与全部记忆(组归属 / 默认边 / 窗口)一起清。
  for (const id of current.placedInstanceIds) {
    if (!installed.has(id)) clearTabGroup(globalTabIdForInstance(id));
  }
  for (const tab of current.tabs) if (!tabs.includes(tab)) clearTabGroup(tab.id);
  persist({
    tabs,
    dismissedInstanceIds: dismissed,
    placedInstanceIds: placed,
    windowInstanceIds: windowed,
  });
}

export function getActiveGlobalTabId(): string | null {
  if (activeGlobalTabId && !isGlobalTabId(activeGlobalTabId)) activeGlobalTabId = null;
  return activeGlobalTabId;
}

/** 选中全局页签(null = 回到任务页签)。只影响本窗口。 */
export function setActiveGlobalTabId(tabId: string | null): void {
  const next = tabId && isGlobalTabId(tabId) ? tabId : null;
  if (next === activeGlobalTabId) return;
  activeGlobalTabId = next;
  notify();
}

type RevealSessionTabListener = (sessionId: string, tabId: string) => void;
const revealListeners = new Set<RevealSessionTabListener>();

/**
 * 程序替某任务打开的任务页签(插件任务页)要露出来:全局激活位优先于任务激活位,
 * 只写任务桶会被前排的全局页签挡住。只有正在显示该任务、且页签归本组的 Shell 响应。
 */
export function requestRevealSessionTab(sessionId: string, tabId: string): void {
  for (const listener of revealListeners) listener(sessionId, tabId);
}

export function subscribeRevealSessionTab(listener: RevealSessionTabListener): () => void {
  revealListeners.add(listener);
  return () => {
    revealListeners.delete(listener);
  };
}

export function subscribeGlobalTabs(cb: () => void): () => void {
  getGlobalTabsSnapshot();
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** React hook:全局页签列表(引用变化 = 有写入或跨窗口同步)。 */
export function useGlobalTabs(): TabState[] {
  return useSyncExternalStore(subscribeGlobalTabs, getGlobalTabs);
}

export function useActiveGlobalTabId(): string | null {
  return useSyncExternalStore(subscribeGlobalTabs, getActiveGlobalTabId);
}

/** 仅测试用。 */
export function __resetGlobalTabsForTest(): void {
  cache = null;
  cacheOwnerKey = null;
  activeGlobalTabId = null;
  subscribers.clear();
}

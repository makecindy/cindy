import type { InstalledGhost } from '../../../shared/ghost';
import { CINDY_MAKE_ENABLED } from '@cindy/maker-shared/cindy-make-feature';
import { FEATURE_RETIREMENTS } from '../../../shared/featureRetirements';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity';
import { isGlobalTabCapableGhost, type PluginViewTabState } from './globalTabs';
import type { TabState } from './types';

export interface RightSidebarTabAvailability {
  installedGhosts: readonly InstalledGhost[];
  subagentsAvailable: boolean;
  /**
   * 已弹出到独立窗口的页签:数据仍在桶里,但本 Shell 不投影、不挂 body,其
   * 窗口关闭后再回到投影。缺省 = 没有弹出。
   */
  hiddenTabIds?: ReadonlySet<string>;
  /**
   * 插件视图页签(`plugin-view`)可承载的本机已装插件。与 installedGhosts 分开:
   * 后者在远程任务下被清空以关闭本地专属能力,而插件视图是全局页签、运行在本机,
   * 不随任务归属变化。缺省 = 不做可用性过滤。
   */
  pluginViewGhosts?: readonly InstalledGhost[];
  /** 任务归属未解析时仍保留本机插件页签的投影;正文另按已确认的归属加载。 */
  pluginTaskGhosts?: readonly InstalledGhost[];
}

function isUnavailablePluginView(
  tab: TabState,
  availability: RightSidebarTabAvailability,
): boolean {
  if (tab.kind !== 'plugin-view' || !availability.pluginViewGhosts) return false;
  const instanceId = (tab.state as PluginViewTabState | null)?.instanceId;
  if (!instanceId) return true;
  const ghost = availability.pluginViewGhosts.find(
    (candidate) => installedGhostStoragePart(candidate) === instanceId,
  );
  return !ghost || !isGlobalTabCapableGhost(ghost);
}

/** 任务页签(plugin-task):本机已装、启用且仍声明 taskView 的插件实例才投影。 */
function isUnavailablePluginTask(
  tab: TabState,
  availability: RightSidebarTabAvailability,
): boolean {
  if (tab.kind !== 'plugin-task') return false;
  const instanceId = (tab.state as { instanceId?: unknown } | null)?.instanceId;
  if (typeof instanceId !== 'string' || !instanceId) return true;
  const ghost = (availability.pluginTaskGhosts ?? availability.installedGhosts).find(
    (candidate) => installedGhostStoragePart(candidate) === instanceId,
  );
  return !ghost || ghost.enabled === false || !ghost.manifest.taskView;
}

function retiredTab(
  tab: TabState,
  availability: RightSidebarTabAvailability,
): TabState | null | undefined {
  const descriptor = FEATURE_RETIREMENTS.find((entry) =>
    entry.source.sidebarKinds?.includes(tab.kind),
  );
  if (!descriptor) return undefined;
  const source = availability.installedGhosts.find(
    (ghost) => ghost.retirement?.id === descriptor.id,
  );
  return source
    ? {
        ...tab,
        kind: 'retired-feature',
        state: { retirementId: descriptor.id, pluginId: source.manifest.id },
      }
    : null;
}

function isUnavailableTab(tab: TabState, availability: RightSidebarTabAvailability): boolean {
  return (
    availability.hiddenTabIds?.has(tab.id) === true ||
    isUnavailablePluginView(tab, availability) ||
    isUnavailablePluginTask(tab, availability) ||
    (!CINDY_MAKE_ENABLED && tab.kind === 'cindy-make') ||
    retiredTab(tab, availability) === null ||
    (tab.kind === 'subagents' && !availability.subagentsAvailable)
  );
}

/** Legacy persisted tabs become host notices, never load the removed implementation. */
export function projectAvailableTabs(
  tabs: readonly TabState[],
  activeTabId: string | null,
  availability: RightSidebarTabAvailability,
): { tabs: TabState[]; activeTabId: string | null } {
  const visibleTabs = tabs
    .filter((tab) => !isUnavailableTab(tab, availability))
    .map((tab) => retiredTab(tab, availability) ?? tab);
  return {
    tabs: visibleTabs,
    activeTabId: visibleTabs.some((tab) => tab.id === activeTabId)
      ? activeTabId
      : (visibleTabs[0]?.id ?? null),
  };
}

/** Preserve unavailable slots when reordering visible tabs. */
export function mergeAvailableTabOrder(
  allTabs: readonly TabState[],
  orderedVisibleIds: readonly string[],
  availability: RightSidebarTabAvailability,
): string[] {
  const visibleTabs = allTabs.filter((tab) => !isUnavailableTab(tab, availability));
  const expectedIds = new Set(visibleTabs.map((tab) => tab.id));
  if (
    orderedVisibleIds.length !== visibleTabs.length ||
    new Set(orderedVisibleIds).size !== orderedVisibleIds.length ||
    orderedVisibleIds.some((id) => !expectedIds.has(id))
  )
    return allTabs.map((tab) => tab.id);
  let index = 0;
  return allTabs.map((tab) =>
    isUnavailableTab(tab, availability) ? tab.id : (orderedVisibleIds[index++] ?? tab.id),
  );
}

export interface TabAvailabilityInput {
  installedGhosts: readonly InstalledGhost[];
  remoteHostId: string | null;
  /** device-link 会话归属:null = 已确认本机,undefined = 尚未解析。 */
  deviceLinkDeviceId?: string | null;
  /** Subagents 资格三态:undefined = 会话行仍在加载,先不把它折成"不可用"。 */
  subagentsAvailable?: boolean;
  hiddenTabIds?: ReadonlySet<string>;
}

export interface TabAvailabilities {
  /** 任务页签的可用性:远程 / 他机会话关闭本地插件能力。 */
  session: RightSidebarTabAvailability;
  /** 全局页签(插件视图)的可用性:只看本机已装插件,不随任务归属变化。 */
  global: RightSidebarTabAvailability;
}

/**
 * Shell 与页签组在场判定共用的可用性构造:两处必须用同一口径算"哪些页签可见",
 * 否则会出现「组被判定为有页签而显示,Shell 里却一个都不投影」的空组。
 */
export function buildTabAvailabilities(input: TabAvailabilityInput): TabAvailabilities {
  const eligibilityKnown = typeof input.subagentsAvailable === 'boolean';
  return {
    session: {
      installedGhosts:
        input.remoteHostId || input.deviceLinkDeviceId !== null ? [] : input.installedGhosts,
      pluginTaskGhosts:
        input.remoteHostId || input.deviceLinkDeviceId ? [] : input.installedGhosts,
      subagentsAvailable: input.subagentsAvailable === true || !eligibilityKnown,
      hiddenTabIds: input.hiddenTabIds,
    },
    global: {
      installedGhosts: [],
      subagentsAvailable: true,
      hiddenTabIds: input.hiddenTabIds,
      pluginViewGhosts: input.installedGhosts,
    },
  };
}

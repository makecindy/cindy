import type { InstalledGhost } from '../../../shared/ghost';
import type { TabState } from './types';

/**
 * The Host owns the simulator runtime and viewer implementation, while the
 * public product surface is contributed by the installed plugin. Fail closed:
 * only an enabled plugin that explicitly declares the capability slot can
 * expose the Host viewer. The slot, rather than one package id, is the Host
 * contract so an approved replacement provider follows the same gate.
 */
export function isIOSSimulatorPluginAvailable(ghosts: readonly InstalledGhost[]): boolean {
  return ghosts.some(
    ({ enabled, manifest }) => enabled === true && manifest.slots.includes('ios-simulator'),
  );
}

function isHiddenSimulatorTab(tab: TabState, pluginAvailable: boolean): boolean {
  return tab.kind === 'ios-simulator' && !pluginAvailable;
}

export interface RightSidebarTabAvailability {
  iosSimulatorAvailable: boolean;
  subagentsAvailable: boolean;
}

function isUnavailableTab(tab: TabState, availability: RightSidebarTabAvailability): boolean {
  return (
    isHiddenSimulatorTab(tab, availability.iosSimulatorAvailable) ||
    (tab.kind === 'subagents' && !availability.subagentsAvailable)
  );
}

/** Preserve unavailable persisted tabs while projecting only product-eligible surfaces. */
export function projectAvailableTabs(
  tabs: readonly TabState[],
  activeTabId: string | null,
  availability: RightSidebarTabAvailability,
): { tabs: TabState[]; activeTabId: string | null } {
  const visibleTabs = tabs.filter((tab) => !isUnavailableTab(tab, availability));
  const visibleActiveTabId = visibleTabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : (visibleTabs[0]?.id ?? null);
  return { tabs: visibleTabs, activeTabId: visibleActiveTabId };
}

/** Merge visible ordering into the full persisted list without moving hidden slots. */
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
  ) {
    return allTabs.map((tab) => tab.id);
  }

  let visibleIndex = 0;
  return allTabs.map((tab) =>
    isUnavailableTab(tab, availability)
      ? tab.id
      : (orderedVisibleIds[visibleIndex++] ?? tab.id),
  );
}

/**
 * Hide persisted Host viewer tabs while the plugin is absent or asleep, but do
 * not delete their state. Re-enabling/reinstalling the plugin restores them in
 * place, matching the plugin layout-preservation contract.
 */
export function projectIOSSimulatorTabs(
  tabs: readonly TabState[],
  activeTabId: string | null,
  pluginAvailable: boolean,
): { tabs: TabState[]; activeTabId: string | null } {
  return projectAvailableTabs(tabs, activeTabId, {
    iosSimulatorAvailable: pluginAvailable,
    subagentsAvailable: true,
  });
}

/**
 * `reorderTabs` requires every persisted tab id. When simulator tabs are
 * hidden, merge the visible ordering back into the full list while preserving
 * each hidden slot instead of accidentally deleting or moving hidden state.
 */
export function mergeIOSSimulatorVisibleTabOrder(
  allTabs: readonly TabState[],
  orderedVisibleIds: readonly string[],
  pluginAvailable: boolean,
): string[] {
  return mergeAvailableTabOrder(allTabs, orderedVisibleIds, {
    iosSimulatorAvailable: pluginAvailable,
    subagentsAvailable: true,
  });
}

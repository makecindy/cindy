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
  const visibleTabs = pluginAvailable
    ? [...tabs]
    : tabs.filter((tab) => !isHiddenSimulatorTab(tab, pluginAvailable));
  const visibleActiveTabId = visibleTabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : (visibleTabs[0]?.id ?? null);
  return { tabs: visibleTabs, activeTabId: visibleActiveTabId };
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
  if (pluginAvailable) return [...orderedVisibleIds];

  const visibleTabs = allTabs.filter((tab) => !isHiddenSimulatorTab(tab, pluginAvailable));
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
    isHiddenSimulatorTab(tab, pluginAvailable)
      ? tab.id
      : (orderedVisibleIds[visibleIndex++] ?? tab.id),
  );
}

import { describe, expect, it } from 'vitest';

import type { InstalledGhost } from '../../../../shared/ghost';
import {
  isIOSSimulatorPluginAvailable,
  mergeAvailableTabOrder,
  mergeIOSSimulatorVisibleTabOrder,
  projectAvailableTabs,
  projectIOSSimulatorTabs,
} from '../iosSimulatorPluginAvailability';
import type { TabState } from '../types';

function ghost(id: string, enabled: boolean, hasCapability: boolean): InstalledGhost {
  return {
    enabled,
    manifest: { id, ...(hasCapability ? { iosSimulator: true } : {}) },
  } as unknown as InstalledGhost;
}

const TABS: TabState[] = [
  { id: 'file-a', kind: 'file-browser', state: null },
  { id: 'sim-a', kind: 'ios-simulator', state: { instanceId: 'instance-a' } },
  { id: 'web-a', kind: 'web-browser', state: null },
  { id: 'sim-b', kind: 'ios-simulator', state: { instanceId: 'instance-b' } },
];

const TABS_WITH_SUBAGENTS: TabState[] = [
  TABS[0],
  { id: 'subagents-a', kind: 'subagents', state: { selectedRunId: null } },
  TABS[2],
];

describe('iOS Simulator plugin availability', () => {
  it('requires an enabled plugin with the capability slot', () => {
    expect(isIOSSimulatorPluginAvailable([])).toBe(false);
    expect(isIOSSimulatorPluginAvailable([ghost('ios-simulator', false, true)])).toBe(
      false,
    );
    expect(isIOSSimulatorPluginAvailable([ghost('ios-simulator', true, false)])).toBe(false);
    expect(isIOSSimulatorPluginAvailable([ghost('another-plugin', true, true)])).toBe(
      true,
    );
    expect(isIOSSimulatorPluginAvailable([ghost('ios-simulator', true, true)])).toBe(true);
  });

  it('hides persisted simulator tabs and selects a visible active fallback', () => {
    expect(projectIOSSimulatorTabs(TABS, 'sim-a', false)).toEqual({
      tabs: [TABS[0], TABS[2]],
      activeTabId: 'file-a',
    });
    expect(projectIOSSimulatorTabs([TABS[1], TABS[3]], 'sim-a', false)).toEqual({
      tabs: [],
      activeTabId: null,
    });
    expect(projectIOSSimulatorTabs(TABS, 'sim-a', true)).toEqual({
      tabs: TABS,
      activeTabId: 'sim-a',
    });
  });

  it('merges visible reordering without moving or deleting hidden simulator slots', () => {
    expect(mergeIOSSimulatorVisibleTabOrder(TABS, ['web-a', 'file-a'], false)).toEqual([
      'web-a',
      'sim-a',
      'file-a',
      'sim-b',
    ]);
    expect(mergeIOSSimulatorVisibleTabOrder(TABS, ['web-a'], false)).toEqual(
      TABS.map((tab) => tab.id),
    );
  });

  it('hides and preserves the Subagents tab outside Pi tasks', () => {
    const unavailable = { iosSimulatorAvailable: true, subagentsAvailable: false };
    expect(projectAvailableTabs(TABS_WITH_SUBAGENTS, 'subagents-a', unavailable)).toEqual({
      tabs: [TABS[0], TABS[2]],
      activeTabId: 'file-a',
    });
    expect(mergeAvailableTabOrder(TABS_WITH_SUBAGENTS, ['web-a', 'file-a'], unavailable)).toEqual([
      'web-a',
      'subagents-a',
      'file-a',
    ]);
  });
});

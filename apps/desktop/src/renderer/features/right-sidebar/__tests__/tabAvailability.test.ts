import { describe, expect, it } from 'vitest';
import type { InstalledGhost } from '../../../../shared/ghost';
import { mergeAvailableTabOrder, projectAvailableTabs } from '../tabAvailability';
import type { TabState } from '../types';
const tabs = [
  { id: 'file', kind: 'file-browser', state: null },
  { id: 'old', kind: 'ios-simulator', state: { instanceId: 'unused' } },
  { id: 'sub', kind: 'subagents', state: null },
] as unknown as TabState[];
const affected = {
  manifest: { id: 'ios-simulator' },
  enabled: false,
  retirement: { id: 'embedded-ios-simulator', eligible: true, unread: true },
} as InstalledGhost;
describe('sidebar availability', () => {
  it.each([true, false])('preserves an installed plugin old tab (migration eligible=%s)', (eligible) => {
    const visible = projectAvailableTabs(tabs, 'old', {
      installedGhosts: [{
        ...affected,
        retirement: { ...affected.retirement!, eligible, unread: eligible },
      }],
      subagentsAvailable: true,
    });
    expect(visible.activeTabId).toBe('old');
    expect(visible.tabs[1]).toMatchObject({
      id: 'old',
      kind: 'retired-feature',
      state: { pluginId: 'ios-simulator' },
    });
    expect(tabs[1].kind).toBe('ios-simulator');
  });
  it('does not show retired tabs to users without an affected install', () => {
    expect(
      projectAvailableTabs(tabs, 'old', { installedGhosts: [], subagentsAvailable: true }),
    ).toMatchObject({ activeTabId: 'file', tabs: [tabs[0], tabs[2]] });
  });
  it('preserves the separate Subagents eligibility and hidden ordering', () => {
    const availability = { installedGhosts: [affected], subagentsAvailable: false };
    expect(projectAvailableTabs(tabs, 'sub', availability).tabs.map((t) => t.id)).toEqual([
      'file',
      'old',
    ]);
    expect(mergeAvailableTabOrder(tabs, ['old', 'file'], availability)).toEqual([
      'old',
      'file',
      'sub',
    ]);
    expect(mergeAvailableTabOrder(tabs, ['file'], availability)).toEqual(['file', 'old', 'sub']);
  });
});

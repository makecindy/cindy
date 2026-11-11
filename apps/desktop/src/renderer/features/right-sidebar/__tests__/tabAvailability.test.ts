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
  // 全局插件视图页签:插件卸载 / 停用 / 失去面板声明时隐藏(数据保留),与远程任务无关。
  it('hides plugin-view tabs whose plugin is gone or disabled, only when the local plugin list is given', () => {
    const pluginTabs = [
      { id: 'view-a', kind: 'plugin-view', state: { instanceId: 'alpha' } },
      { id: 'view-b', kind: 'plugin-view', state: { instanceId: 'beta' } },
      { id: 'view-c', kind: 'plugin-view', state: { instanceId: 'gone' } },
    ] as unknown as TabState[];
    const alpha = { manifest: { id: 'alpha', panel: { html: 'p.html' } }, enabled: true } as InstalledGhost;
    const beta = { manifest: { id: 'beta', mainView: { html: 'm.html' } }, enabled: false } as InstalledGhost;
    const visible = projectAvailableTabs(pluginTabs, 'view-b', {
      installedGhosts: [],
      subagentsAvailable: true,
      pluginViewGhosts: [alpha, beta],
    });
    expect(visible.tabs.map((tab) => tab.id)).toEqual(['view-a']);
    expect(visible.activeTabId).toBe('view-a');
    // 不提供本机插件清单(如纯投影场景)时不做过滤。
    expect(
      projectAvailableTabs(pluginTabs, null, { installedGhosts: [], subagentsAvailable: true }).tabs,
    ).toHaveLength(3);
  });
  // 任务页页签(跟对话):存在任务桶里,插件卸载 / 停用 / 不再声明 taskView 时隐藏;远程任务不投影本机插件。
  it('hides plugin-task tabs whose plugin is gone, disabled or no longer has a task page', () => {
    const taskTabs = [
      { id: 'task-a', kind: 'plugin-task', state: { instanceId: 'alpha' } },
      { id: 'task-b', kind: 'plugin-task', state: { instanceId: 'beta' } },
      { id: 'task-c', kind: 'plugin-task', state: { instanceId: 'gamma' } },
      { id: 'task-d', kind: 'plugin-task', state: { instanceId: 'gone' } },
    ] as unknown as TabState[];
    const alpha = { manifest: { id: 'alpha', taskView: { html: 't.html' } }, enabled: true } as InstalledGhost;
    const beta = { manifest: { id: 'beta', taskView: { html: 't.html' } }, enabled: false } as InstalledGhost;
    const gamma = { manifest: { id: 'gamma', mainView: { html: 'm.html' } }, enabled: true } as InstalledGhost;
    expect(
      projectAvailableTabs(taskTabs, 'task-b', { installedGhosts: [alpha, beta, gamma], subagentsAvailable: true }).tabs.map((tab) => tab.id),
    ).toEqual(['task-a']);
    expect(projectAvailableTabs(taskTabs, null, { installedGhosts: [], subagentsAvailable: true }).tabs).toEqual([]);
  });
  it('filters persisted Cindy Make tabs when the product is disabled', () => {
    const cindyTabs = [
      { id: 'file', kind: 'file-browser', state: null },
      { id: 'make', kind: 'cindy-make', state: null },
    ] as unknown as TabState[];
    const visible = projectAvailableTabs(cindyTabs, 'make', { installedGhosts: [], subagentsAvailable: true });
    expect(visible.tabs.map((tab) => tab.id)).toEqual(['file']);
    expect(visible.activeTabId).toBe('file');
  });
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

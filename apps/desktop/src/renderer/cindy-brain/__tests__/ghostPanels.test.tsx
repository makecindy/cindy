// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果:syncGhostPanelRegistrations(启动首帧 / ghosts:changed 的唯一同步点)
 *   与 globalTabs 的 reconcile;可观察的是右侧栏全局页签列表:声明停靠面板的已启用插件
 *   自动出现、用户关掉后不再自动加回、卸载即清、停用保留页签数据、`tab` 形态与无面板插件
 *   不进右侧栏。
 * - Bug / 规则依据:plugin-security-and-authoring.md §5 存量插件兼容红线——停靠面板从布局树
 *   迁到右侧栏全局页签后,升级前已启用的 `panel` 插件升级后必须自动出现,用户什么都不做。
 * - 现有覆盖缺口:原停靠面板注册表用例随面板退场删除;新迁移路径此前无覆盖。
 * - 最小失败输入:一个 enabled 且 panel.position 缺省的插件 + 一次 sync。
 * - tier:unit(jsdom localStorage)。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GhostManifest, InstalledGhost } from '../../../shared/ghost';
import {
  __resetGlobalTabsForTest,
  getGlobalTabs,
  removeGlobalTab,
  type PluginViewTabState,
} from '../../features/right-sidebar/globalTabs';
import { pickGhostPanelMediaUri, syncGhostPanelRegistrations } from '../ghostPanels';
import { __resetTabGroupsForTest, getTabGroup } from '../../features/right-sidebar/tabGroups';

function ghost(
  id: string,
  opts: {
    enabled?: boolean;
    panel?: Partial<GhostManifest['panel']> | null;
    mainView?: boolean;
  } = {},
): InstalledGhost {
  const manifest: GhostManifest = {
    schemaVersion: 2,
    id,
    name: id,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    ...(opts.panel === null
      ? {}
      : { panel: { html: 'panel.html', title: `${id} panel`, ...(opts.panel ?? {}) } }),
    ...(opts.mainView ? { mainView: { html: 'main-view.html', title: `${id} view` } } : {}),
  } as GhostManifest;
  return {
    manifest,
    dir: `/fake/${id}`,
    enabled: opts.enabled ?? true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  } as InstalledGhost;
}

const instanceIds = () =>
  getGlobalTabs().map((tab) => (tab.state as PluginViewTabState).instanceId);

beforeEach(() => {
  window.localStorage.clear();
  __resetGlobalTabsForTest();
  __resetTabGroupsForTest();
});

afterEach(() => {
  __resetGlobalTabsForTest();
  __resetTabGroupsForTest();
  window.localStorage.clear();
});

describe('syncGhostPanelRegistrations · 停靠面板插件自动成为右侧栏全局页签', () => {
  it('声明停靠面板的已启用插件自动加入;tab 形态、无面板、仅 mainView 的插件不自动加', () => {
    syncGhostPanelRegistrations([
      ghost('docked-panel'),
      ghost('tabbed-panel', { panel: { position: 'tab' } }),
      ghost('tool-only', { panel: null }),
      ghost('view-only', { panel: null, mainView: true }),
    ]);
    expect(instanceIds()).toEqual(['docked-panel']);
    // 存量停靠面板缺省 position = 停在聊天区左侧:自动页签首次出现落在左侧组。
    expect(getTabGroup('g_docked-panel')).toBe('left');
    // 再同步一次不重复加。
    syncGhostPanelRegistrations([ghost('docked-panel')]);
    expect(instanceIds()).toEqual(['docked-panel']);
  });

  it('用户关掉后不再自动加回;卸载即清掉页签与关闭记录,重装视同首次启用', () => {
    syncGhostPanelRegistrations([ghost('docked-panel')]);
    const [tab] = getGlobalTabs();
    removeGlobalTab(tab.id);
    expect(instanceIds()).toEqual([]);
    syncGhostPanelRegistrations([ghost('docked-panel')]);
    expect(instanceIds()).toEqual([]);

    // 卸载(清单里消失)→ 关闭记录一并清掉。
    syncGhostPanelRegistrations([]);
    syncGhostPanelRegistrations([ghost('docked-panel')]);
    expect(instanceIds()).toEqual(['docked-panel']);
  });

  it('停用的插件保留页签数据(投影层按可用性隐藏),重新启用原位回来;停用期间不新加', () => {
    syncGhostPanelRegistrations([ghost('ghost-a'), ghost('ghost-b')]);
    expect(instanceIds()).toEqual(['ghost-a', 'ghost-b']);
    syncGhostPanelRegistrations([ghost('ghost-a', { enabled: false }), ghost('ghost-b')]);
    expect(instanceIds()).toEqual(['ghost-a', 'ghost-b']);
    // 从未加入过的停用插件不会被加进来。
    syncGhostPanelRegistrations([
      ghost('ghost-a', { enabled: false }),
      ghost('ghost-b'),
      ghost('ghost-c', { enabled: false }),
    ]);
    expect(instanceIds()).toEqual(['ghost-a', 'ghost-b']);
  });
});

describe('pickGhostPanelMediaUri · 右键命中参数挑媒体地址', () => {
  const uri = (p: string) => `cindy-ghost://my-ghost/${p}`;
  it('srcURL 优先(直接右键在 img/video 上);linkURL 兜底(视频缩略命中外层 <a>)', () => {
    expect(
      pickGhostPanelMediaUri(
        { srcURL: uri('media/a.png'), linkURL: uri('media/b.mp4') },
        'my-ghost',
      ),
    ).toBe(uri('media/a.png'));
    expect(pickGhostPanelMediaUri({ srcURL: '', linkURL: uri('preview/b.mp4') }, 'my-ghost')).toBe(
      uri('preview/b.mp4'),
    );
  });
  it('非媒体地址 / 别的意识地址返回 null,不弹菜单', () => {
    expect(
      pickGhostPanelMediaUri({ srcURL: 'https://x/a.png', linkURL: '' }, 'my-ghost'),
    ).toBeNull();
    expect(
      pickGhostPanelMediaUri(
        { srcURL: 'cindy-ghost://other/media/a.png', linkURL: '' },
        'my-ghost',
      ),
    ).toBeNull();
    expect(pickGhostPanelMediaUri({ srcURL: uri('a.png'), linkURL: '' }, 'my-ghost')).toBeNull();
  });
});

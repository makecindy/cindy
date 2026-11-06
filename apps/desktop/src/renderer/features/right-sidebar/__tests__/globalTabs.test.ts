// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果:globalTabs 的 add / remove / reorder / active 与 localStorage 持久化;
 *   可观察的是全局页签列表按数据所有者分键保存、用户关闭后记入 dismissed、另一个窗口的
 *   写入通过 storage 事件同步进来、激活位只认仍在列表里的页签。
 * - Bug / 规则依据:右侧栏「不跟对话」的全局页签(本 PR);多窗口共享同一份列表是产品承诺
 *   (弹出的页签窗口与主窗看到同一组全局页签)。
 * - 现有覆盖缺口:ghostPanels.test 只覆盖与已装清单的对齐,不覆盖用户动作与跨窗口同步。
 * - 最小失败输入:加一个页签后切换 owner、或在另一窗口写 localStorage。
 * - tier:unit(jsdom localStorage + storage 事件)。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import {
  __resetGlobalTabsForTest,
  addGlobalPluginTab,
  defaultGroupForGhost,
  effectivePluginView,
  getActiveGlobalTabId,
  getGlobalTabs,
  getGlobalTabsSnapshot,
  hasPluginPlacementMemory,
  isPluginWindowPlacement,
  rememberPluginWindowPlacement,
  removeGlobalTab,
  reconcileGlobalPluginTabs,
  reorderGlobalTabs,
  resetPluginPlacement,
  sanitizeGlobalTabsSnapshot,
  setActiveGlobalTabId,
  tabShowsMainView,
} from '../globalTabs';
import { __resetTabGroupsForTest, getTabGroup, setTabGroup } from '../tabGroups';

beforeEach(() => {
  window.localStorage.clear();
  __resetGlobalTabsForTest();
  __resetTabGroupsForTest();
  setDataOwnerGeneration('owner-a', 1);
});

afterEach(() => {
  __resetGlobalTabsForTest();
  __resetTabGroupsForTest();
  window.localStorage.clear();
});

describe('globalTabs', () => {
  it('adds one tab per plugin instance, persists per data owner and remembers dismissals', () => {
    const tab = addGlobalPluginTab('alpha')!;
    expect(addGlobalPluginTab('alpha')).toEqual(tab);
    expect(getGlobalTabs()).toHaveLength(1);
    expect(window.localStorage.getItem('xdt:rightSidebarGlobalTabs:v1:owner-a')).toContain('alpha');

    // 另一个数据所有者看不到这份列表。
    setDataOwnerGeneration('owner-b', 1);
    expect(getGlobalTabs()).toEqual([]);
    setDataOwnerGeneration('owner-a', 1);
    expect(getGlobalTabs()).toHaveLength(1);

    setActiveGlobalTabId(tab.id);
    expect(getActiveGlobalTabId()).toBe(tab.id);
    removeGlobalTab(tab.id);
    expect(getGlobalTabs()).toEqual([]);
    expect(getGlobalTabsSnapshot().dismissedInstanceIds).toEqual(['alpha']);
    // 关掉的页签不再是激活位;用户主动重新加入会清掉关闭记录。
    expect(getActiveGlobalTabId()).toBeNull();
    addGlobalPluginTab('alpha');
    expect(getGlobalTabsSnapshot().dismissedInstanceIds).toEqual([]);
  });

  it('reorders only with a complete id list and picks up writes from other windows', () => {
    const a = addGlobalPluginTab('alpha')!;
    const b = addGlobalPluginTab('beta')!;
    reorderGlobalTabs([b.id]);
    expect(getGlobalTabs().map((tab) => tab.id)).toEqual([a.id, b.id]);
    reorderGlobalTabs([b.id, a.id]);
    expect(getGlobalTabs().map((tab) => tab.id)).toEqual([b.id, a.id]);

    // 另一个窗口写入同一键:storage 事件让本窗口重新读取。
    const key = 'xdt:rightSidebarGlobalTabs:v1:owner-a';
    window.localStorage.setItem(
      key,
      JSON.stringify({
        tabs: [{ id: 'g_other', kind: 'plugin-view', state: { instanceId: 'gamma' } }],
        dismissedInstanceIds: [],
      }),
    );
    window.dispatchEvent(new StorageEvent('storage', { key }));
    expect(getGlobalTabs().map((tab) => tab.id)).toEqual(['g_other']);
  });

  it('drops malformed persisted entries instead of loading them', () => {
    expect(
      sanitizeGlobalTabsSnapshot({
        tabs: [
          { id: 'ok', kind: 'plugin-view', state: { instanceId: 'alpha' } },
          { id: 'ok', kind: 'plugin-view', state: { instanceId: 'dup' } },
          { id: 'bad-kind', kind: 'terminal', state: {} },
          { id: 'bad-state', kind: 'plugin-view', state: null },
          'junk',
        ],
        dismissedInstanceIds: ['x', 3, ''],
      }),
    ).toEqual({
      tabs: [{ id: 'ok', kind: 'plugin-view', state: { instanceId: 'alpha' } }],
      dismissedInstanceIds: ['x'],
      placedInstanceIds: [],
      windowInstanceIds: [],
    });
    expect(sanitizeGlobalTabsSnapshot('nope')).toEqual({
      tabs: [],
      dismissedInstanceIds: [],
      placedInstanceIds: [],
      windowInstanceIds: [],
    });
  });

  // 测试价值
  // - 生产入口与可观察结果:addGlobalPluginTab({ghost}) / removeGlobalTab / resetPluginPlacement /
  //   rememberPluginWindowPlacement;可观察的是页签 id 跟插件实例走(关掉再打开同一 id)、首次
  //   出现按 panel.position / mainView.side 放默认边、关掉再打开保留用户拖到的边、「恢复默认
  //   位置」清掉窗口记忆并回到默认边。
  // - Bug / 规则依据:页签组模型第三阶段——插件给默认放置,用户的放置记忆优先。
  // - 现有覆盖缺口:新行为。
  // - 最小失败输入:一个 panel.position:'bottom' 的插件 + add → setTabGroup('top') → remove → add。
  // - tier:unit(jsdom localStorage)。
  it('keeps placement memory per plugin instance and resets it on demand', () => {
    const ghost = (position?: 'left' | 'right' | 'top' | 'bottom', mainView?: object) =>
      ({
        manifest: {
          id: 'beta',
          name: 'Beta',
          ...(position !== undefined || mainView === undefined
            ? { panel: { html: 'p.html', ...(position ? { position } : {}) } }
            : {}),
          ...(mainView ? { mainView: { html: 'm.html', ...mainView } } : {}),
        },
        enabled: true,
      }) as unknown as import('../../../../shared/ghost').InstalledGhost;

    const tab = addGlobalPluginTab('beta', { ghost: ghost('bottom') })!;
    expect(tab.id).toBe('g_beta');
    expect(getTabGroup('g_beta')).toBe('bottom');
    // 用户拖到上方,关掉再打开:还在上方,不重新套默认边。
    setTabGroup('g_beta', 'top');
    removeGlobalTab('g_beta');
    expect(addGlobalPluginTab('beta', { ghost: ghost('bottom') })!.id).toBe('g_beta');
    expect(getTabGroup('g_beta')).toBe('top');
    expect(hasPluginPlacementMemory('beta')).toBe(true);

    // 弹过窗口的记忆;恢复默认位置 = 清窗口记忆、回到声明的边。
    rememberPluginWindowPlacement('beta', true);
    expect(isPluginWindowPlacement('beta')).toBe(true);
    resetPluginPlacement('beta', ghost('bottom'));
    expect(isPluginWindowPlacement('beta')).toBe(false);
    expect(getTabGroup('g_beta')).toBe('bottom');

    // 缺省 position 的停靠面板 → left(与历史停靠面板一致);mainView.side 优先。
    expect(defaultGroupForGhost(ghost(undefined))).toBe('left');
    expect(defaultGroupForGhost(ghost(undefined, { open: 'sidebar', side: 'right' }))).toBe(
      'right',
    );
    expect(defaultGroupForGhost(ghost(undefined, { open: 'page' }))).toBe('right');
  });
  // 测试价值
  // - 生产入口与可观察结果:addGlobalPluginTab({view}) / tabShowsMainView / defaultGroupForGhost(view);
  //   可观察的是页签记录自己承载 panel 还是 mainView(panel 与 mainView 指向不同页面时互不串)、
  //   同一插件的页签被明确要求另一个页面时切换、单实例判定只看主视图那一份、mainView.open:'sidebar'
  //   未声明 side 时默认右侧(即使插件同时声明停靠面板)。
  // - Bug / 规则依据:PR #6468 review(主视图入口显示面板 / 主视图默认边不符)。
  // - 现有覆盖缺口:此前页签不记承载页面,panel 永远优先。
  // - 最小失败输入:panel.html ≠ mainView.html 的插件,先自动出现 panel,再从入口要 main。
  it('records which page a plugin-view tab hosts and defaults the side per page', () => {
    const ghost = (extra: object = {}) =>
      ({
        manifest: {
          id: 'gamma',
          name: 'Gamma',
          panel: { html: 'panel.html' },
          mainView: { html: 'view.html', open: 'sidebar' },
          ...extra,
        },
        enabled: true,
      }) as unknown as import('../../../../shared/ghost').InstalledGhost;
    const g = ghost();
    // 停靠面板自动出现:panel(缺省边 left);主视图 open:sidebar 未声明 side 默认右侧,不被 panel 带偏。
    const panelTab = addGlobalPluginTab('gamma', { ghost: g })!;
    expect((panelTab.state as { view?: string }).view).toBe('panel');
    expect(defaultGroupForGhost(g, 'panel')).toBe('left');
    expect(defaultGroupForGhost(g, 'main')).toBe('right');
    // 页面不同 → panel 页签不算主视图,整页单实例不互斥;入口要 main 时同一页签切到 main。
    expect(tabShowsMainView(panelTab.state as never, g)).toBe(false);
    const mainTab = addGlobalPluginTab('gamma', { ghost: g, view: 'main' })!;
    expect(mainTab.id).toBe(panelTab.id);
    expect((mainTab.state as { view?: string }).view).toBe('main');
    expect(tabShowsMainView(mainTab.state as never, g)).toBe(true);
    // 同一 html 的 panel 页签等于主视图那一份。
    const same = ghost({ mainView: { html: 'panel.html' } });
    expect(tabShowsMainView({ instanceId: 'gamma', view: 'panel' }, same)).toBe(true);
    // 旧数据没有 view:按插件声明推导(有停靠面板 → panel)。
    expect(effectivePluginView({ instanceId: 'gamma' }, g)).toBe('panel');
    expect(effectivePluginView({ instanceId: 'gamma' }, ghost({ panel: undefined }))).toBe('main');
  });
  // 测试价值
  // - 生产入口与可观察结果:reconcileGlobalPluginTabs / removeGlobalTab / setTabGroup 的写路径;可观察的是
  //   超过 20 个停靠面板的存量插件全部迁移成页签(不被会话页签的小上限截断),以及另一个窗口刚做的
  //   修改(storage 事件还没送到、本窗口缓存是旧的)不会被本窗口接下来的写入整份覆盖回去。
  // - Bug / 规则依据:PR #6468 review(迁移截断 / 跨窗口全局页签写入互相覆盖);存量插件兼容红线。
  // - 现有覆盖缺口:此前只有单窗口读写。
  // - 最小失败输入:25 个面板插件;窗口 A 缓存旧列表,localStorage 被窗口 B 改过后窗口 A 再关另一个页签。
  it('migrates every stored docked panel and never overwrites another window with a stale cache', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      manifest: { id: `p${i}`, name: `P${i}`, panel: { html: 'p.html' } },
      enabled: true,
    })) as unknown as import('../../../../shared/ghost').InstalledGhost[];
    reconcileGlobalPluginTabs(many);
    expect(getGlobalTabs()).toHaveLength(25);

    // 本窗口缓存里是 25 个;另一个窗口把 p0 关掉并写回 localStorage(storage 事件尚未处理)。
    const key = 'xdt:rightSidebarGlobalTabs:v1:owner-a';
    const other = JSON.parse(window.localStorage.getItem(key)!);
    other.tabs = other.tabs.filter((tab: { id: string }) => tab.id !== 'g_p0');
    window.localStorage.setItem(key, JSON.stringify(other));
    // 本窗口再关 p1:必须基于 localStorage 最新一份,p0 不会被写回来。
    removeGlobalTab('g_p1');
    const ids = getGlobalTabs().map((tab) => tab.id);
    expect(ids).toHaveLength(23);
    expect(ids).not.toContain('g_p0');
    expect(ids).not.toContain('g_p1');
  });

  // 测试价值
  // - 生产入口与可观察结果:reconcileGlobalPluginTabs 读升级前 `xdt:ghostPanelBubble:v1`;可观察的是
  //   旧版里被收进气泡(最小化)的停靠面板升级后不自动变成可见页签、记入已关闭,其余面板照常出现。
  // - Bug / 规则依据:PR #6468 review「迁移最小化面板」;存量插件兼容红线(用户的隐藏偏好不丢)。
  // - 现有覆盖缺口:上一个用例只覆盖全部面板自动迁移,没有旧最小化状态。
  // - 最小失败输入:两个面板插件,其中一个在旧键里 minimized:true。
  it('keeps a panel the user had minimized hidden after upgrade instead of auto-adding it', () => {
    window.localStorage.setItem(
      'xdt:ghostPanelBubble:v1',
      JSON.stringify({ p0: { minimized: true }, p1: { minimized: false, x: 1, y: 2 } }),
    );
    const ghosts = ['p0', 'p1'].map((id) => ({
      manifest: { id, name: id, panel: { html: 'p.html' } },
      enabled: true,
    })) as unknown as import('../../../../shared/ghost').InstalledGhost[];
    reconcileGlobalPluginTabs(ghosts);
    expect(getGlobalTabs().map((tab) => tab.id)).toEqual(['g_p1']);
    expect(getGlobalTabsSnapshot().dismissedInstanceIds).toEqual(['p0']);
    // 再对齐一次结果稳定;用户从「+」重开后正常出现,不再被旧记录挡住。
    reconcileGlobalPluginTabs(ghosts);
    expect(getGlobalTabs()).toHaveLength(1);
    addGlobalPluginTab('p0', { ghost: ghosts[0] });
    expect(getGlobalTabs().map((tab) => tab.id)).toEqual(['g_p1', 'g_p0']);
    reconcileGlobalPluginTabs(ghosts);
    expect(getGlobalTabs()).toHaveLength(2);
  });

  // 测试价值
  // - 生产入口与可观察结果:reconcileGlobalPluginTabs 读布局树里旧的 `ghost:<id>` 位置;可观察的是
  //   用户把停靠面板拖到聊天区右侧后,升级首次对齐落在右侧组而不是插件声明的默认左侧,没有旧位置的照默认边。
  // - Bug / 规则依据:PR #6468 review「迁移时保留用户自定义的面板位置」;存量插件兼容红线。
  // - 现有覆盖缺口:其余用例都没有布局桥,只覆盖默认边。
  // - 最小失败输入:默认布局(right-tabs 在聊天右侧)里插入 ghost:p0 到右侧,另一个插件不在树里。
  it('keeps a legacy docked panel on the side the user had moved it to', () => {
    const layout = {
      schemaVersion: 1,
      sidebar: { type: 'pane', id: 's', panelKind: 'session-list', edge: 'left' },
      content: {
        type: 'split',
        id: 'root',
        direction: 'row',
        children: [
          { fraction: 0.5, node: { type: 'pane', id: 'c', panelKind: 'chat-main' } },
          { fraction: 0.2, node: { type: 'pane', id: 'g', panelKind: 'ghost:p0' } },
          { fraction: 0.3, node: { type: 'pane', id: 'r', panelKind: 'right-tabs' } },
        ],
      },
      float: [],
    };
    const win = window as unknown as { electronAPI?: unknown };
    win.electronAPI = { layout: { getStateSync: () => ({ layout }) } };
    try {
      const ghosts = ['p0', 'p1'].map((id) => ({
        manifest: { id, name: id, panel: { html: 'p.html' } },
        enabled: true,
      })) as unknown as import('../../../../shared/ghost').InstalledGhost[];
      reconcileGlobalPluginTabs(ghosts);
      expect(getTabGroup('g_p0')).toBe('right');
      expect(getTabGroup('g_p1')).toBe('left');
    } finally {
      delete win.electronAPI;
    }
  });

  // 测试价值
  // - 生产入口与可观察结果:plugin-view 的 hydrateState(经 hydrateTabState);可观察的是页签状态里记着的
  //   panel / main 视图在回读后保留,非法值被丢弃。
  // - Bug / 规则依据:review「hydrate 丢掉 view,主视图页签回落成停靠面板」。
  // - 现有覆盖缺口:此前没有测 hydrate。
  // - 最小失败输入:{instanceId:'a', view:'main'}。
  it('keeps the recorded plugin view when hydrating a plugin-view tab state', async () => {
    await import('../plugins/plugin-view');
    const { getTabKind } = await import('../registry');
    const plugin = getTabKind('plugin-view');
    const hydrate = (raw: unknown) => plugin?.hydrateState?.(raw);
    expect(hydrate({ instanceId: 'a', view: 'main' })).toEqual({
      instanceId: 'a',
      view: 'main',
    });
    expect(hydrate({ instanceId: 'a', view: 'bogus' })).toEqual({
      instanceId: 'a',
    });
  });
});

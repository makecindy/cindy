// SidebarTabWindowsController lifecycle state-machine tests (DI only, no electron).
//
// 测试价值
// - 生产入口与可观察结果:controller.open / mergeBack / closeForTab / 握手与窗口事件;
//   可观察的是 BrowserWindow 的 show / focus / destroy 时序、发给弹出窗口的指派 / 合并
//   请求、发给主窗的 tab-returned 通知与全量状态广播。
// - Bug / 规则依据:electron-security-and-process-boundaries.md §3.1(首份内容前不显示、
//   预热不抢焦点、崩溃恢复有界、原生关窗不得卡住);本 PR 把侧栏「弹出」改为单页签窗口。
// - 现有覆盖缺口:right-sidebar-window / ghost-panel-window 的用例针对各自状态机,
//   本 controller 的 spare 预热 + 指派、合并交回、原生关窗宽限超时都是新路径。
// - 最小失败输入:见各用例(单页签 open → 握手 → 关闭)。
// - tier:unit(mock deps 驱动状态机,fake timers 走超时)。
// - 实测耗时:< 1s。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, WebContents } from 'electron';

import type {
  SidebarTabReturnedPayload,
  SidebarTabWindowsState,
} from '../../../shared/sidebarTabWindow.js';
import {
  SIDEBAR_TAB_WINDOW_ASSIGNED_CHANNEL,
  SIDEBAR_TAB_WINDOW_CLOSE_REQUESTED_CHANNEL,
  SIDEBAR_TAB_WINDOW_VISIBILITY_CHANGED_CHANNEL,
} from '../../../shared/sidebarTabWindow.js';
import {
  SidebarTabWindowsController,
  type SidebarTabWindowsControllerDeps,
} from '../controller.js';

interface FakeWindow {
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  isMinimized: () => boolean;
  isVisible: () => boolean;
  isDestroyed: () => boolean;
  webContents: { id: number; on: ReturnType<typeof vi.fn>; isDestroyed: () => boolean };
  emitWindowEvent: (event: string, ...args: unknown[]) => void;
  emitWebContentsEvent: (event: string, ...args: unknown[]) => void;
}

let nextId = 1;
function fakeWindow(): FakeWindow {
  const id = nextId++;
  const winListeners = new Map<string, (...args: unknown[]) => void>();
  const wcListeners = new Map<string, (...args: unknown[]) => void>();
  let destroyed = false;
  let visible = false;
  const win: FakeWindow = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      winListeners.set(event, cb);
    }),
    close: vi.fn(() => {
      let prevented = false;
      winListeners.get('close')?.({
        preventDefault: () => {
          prevented = true;
        },
      });
      if (prevented) return;
      destroyed = true;
      visible = false;
      winListeners.get('closed')?.();
    }),
    destroy: vi.fn(() => {
      destroyed = true;
      visible = false;
      winListeners.get('closed')?.();
    }),
    hide: vi.fn(() => {
      visible = false;
    }),
    show: vi.fn(() => {
      visible = true;
    }),
    focus: vi.fn(),
    restore: vi.fn(),
    isMinimized: () => false,
    isVisible: () => visible,
    isDestroyed: () => destroyed,
    webContents: {
      id,
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        wcListeners.set(event, cb);
      }),
      isDestroyed: () => destroyed,
    },
    emitWindowEvent: (event, ...args) => {
      if (event === 'hide') visible = false;
      if (event === 'show') visible = true;
      winListeners.get(event)?.(...args);
    },
    emitWebContentsEvent: (event, ...args) => wcListeners.get(event)?.(...args),
  };
  return win;
}

function makeHarness(extra: Partial<SidebarTabWindowsControllerDeps> = {}) {
  let quitting = false;
  const created: FakeWindow[] = [];
  const broadcasts: SidebarTabWindowsState[] = [];
  const sends: Array<{ winId: number; channel: string; payload: unknown }> = [];
  const returned: SidebarTabReturnedPayload[] = [];
  const deps: SidebarTabWindowsControllerDeps = {
    createWindow: () => {
      const win = fakeWindow();
      created.push(win);
      return win as unknown as BrowserWindow;
    },
    broadcastState: (state) => {
      broadcasts.push(state);
    },
    sendToWindow: (win, channel, payload) => {
      sends.push({ winId: (win as unknown as FakeWindow).webContents.id, channel, payload });
    },
    notifyTabReturned: (payload) => {
      returned.push(payload);
    },
    isQuitting: () => quitting,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...extra,
  };
  const controller = new SidebarTabWindowsController(deps);
  return {
    controller,
    created,
    broadcasts,
    sends,
    returned,
    setQuitting: (value: boolean) => {
      quitting = value;
    },
    wc: (win: FakeWindow) => win.webContents as unknown as WebContents,
  };
}

const request = (tabId: string, sessionId: string | null = 's1') => ({
  tabId,
  sessionId,
  context: { workdir: '/repo', remoteHostId: null, deviceLinkDeviceId: null },
  handoff: null,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SidebarTabWindowsController', () => {
  it('prewarms a hidden spare and only shows it after the assigned tab presents content', () => {
    const h = makeHarness();
    h.controller.prewarm();
    expect(h.created).toHaveLength(1);
    const spare = h.created[0];
    expect(spare.show).not.toHaveBeenCalled();
    expect(spare.focus).not.toHaveBeenCalled();
    h.controller.markRendererReady(h.wc(spare));
    // 预热窗口壳就绪但未指派:不展示、不广播任何页签状态。
    expect(h.controller.getState()).toEqual({});

    h.controller.open(request('tab-a'));
    // spare 被直接消费,没有再冷建窗口;指派随即送达(壳已就绪)。
    expect(h.created).toHaveLength(1);
    const assigned = h.sends.find((s) => s.channel === SIDEBAR_TAB_WINDOW_ASSIGNED_CHANNEL);
    expect(assigned?.payload).toMatchObject({
      windowId: 'w1',
      sessionId: 's1',
      tabs: [{ tabId: 'tab-a', sessionId: 's1' }],
    });
    expect(h.controller.getState()).toEqual({
      'tab-a': { windowId: 'w1', sessionId: 's1', open: true },
    });
    // 首份内容前不显示。
    expect(spare.show).not.toHaveBeenCalled();
    h.controller.markPresentationReady(h.wc(spare));
    expect(spare.show).toHaveBeenCalledOnce();
    expect(spare.focus).toHaveBeenCalledOnce();
    expect(
      h.sends.some(
        (s) =>
          s.channel === SIDEBAR_TAB_WINDOW_VISIBILITY_CHANGED_CHANNEL &&
          (s.payload as { visible: boolean }).visible === true,
      ),
    ).toBe(true);
    expect(h.controller.getWebContentsForTab('tab-a')).toBe(h.wc(spare));
    expect(h.controller.isTabPoppedOut('tab-a')).toBe(true);

    // 指派后延迟补一扇 spare,供下一次弹出。
    vi.advanceTimersByTime(2_000);
    expect(h.created).toHaveLength(2);
    expect(h.created[1].show).not.toHaveBeenCalled();
  });

  it('cold-opens when no spare exists and delivers the assignment once the shell mounts', () => {
    const h = makeHarness();
    h.controller.open(request('tab-a'));
    expect(h.created).toHaveLength(1);
    const win = h.created[0];
    expect(h.sends.filter((s) => s.channel === SIDEBAR_TAB_WINDOW_ASSIGNED_CHANNEL)).toHaveLength(
      0,
    );
    h.controller.markRendererReady(h.wc(win));
    expect(h.sends.filter((s) => s.channel === SIDEBAR_TAB_WINDOW_ASSIGNED_CHANNEL)).toHaveLength(
      1,
    );
    // 重载后的 renderer 主动取指派也拿得到同一份。
    expect(h.controller.getAssignment(h.wc(win))).toMatchObject({
      tabs: [{ tabId: 'tab-a', sessionId: 's1' }],
    });
    expect(win.show).not.toHaveBeenCalled();

    // 同一页签再次 open = 聚焦已有窗口,不建第二扇。
    h.controller.markPresentationReady(h.wc(win));
    h.controller.open(request('tab-a'));
    expect(h.created).toHaveLength(1);
    expect(win.focus).toHaveBeenCalledTimes(2);
  });

  // focus 的对外结果包括选中具体页签；后台插件请求不能抢原生窗口焦点。
  it('sends the target tab selection to its host without native focus for background requests', () => {
    const h = makeHarness();
    h.controller.open(request('tab-a'));
    const win = h.created[0];
    h.controller.markRendererReady(h.wc(win));
    h.controller.markPresentationReady(h.wc(win));
    h.controller.open({ ...request('tab-b'), targetWindowId: h.controller.getState()['tab-a'].windowId });
    win.focus.mockClear(); win.show.mockClear();
    h.controller.focus('tab-a', { userInitiated: false });
    expect(h.sends.at(-1)).toMatchObject({ channel: SIDEBAR_TAB_WINDOW_ASSIGNED_CHANNEL, payload: { revealTabId: 'tab-a' } });
    expect(win.focus).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
  });

  it('returns the tab to the sidebar with its snapshot on merge-back and destroys the window', () => {
    const h = makeHarness();
    h.controller.open(request('tab-a'));
    const win = h.created[0];
    h.controller.markRendererReady(h.wc(win));
    h.controller.markPresentationReady(h.wc(win));

    const snapshot = {
      sessionId: 's1',
      tab: { id: 'tab-a', kind: 'web-browser', state: { url: 'x' } },
    };
    h.controller.mergeBack(h.wc(win), 'tab-a', snapshot);
    expect(win.destroy).toHaveBeenCalledOnce();
    expect(h.returned).toEqual([{ sessionId: 's1', tabId: 'tab-a', snapshot, reason: 'merge' }]);
    expect(h.broadcasts.at(-1)).toEqual({});
    expect(h.controller.getWebContentsForTab('tab-a')).toBeNull();
    // 未知 sender 的 merge-back 被忽略。
    h.controller.mergeBack({} as WebContents, 'tab-a', null);
    expect(h.returned).toHaveLength(1);
  });

  it('turns native close into a tab-close request and never returns the tab by itself', () => {
    const h = makeHarness();
    h.controller.open(request('tab-a'));
    const win = h.created[0];
    h.controller.markRendererReady(h.wc(win));
    h.controller.markPresentationReady(h.wc(win));

    win.close();
    // 原生关窗被拦下,转达给 renderer 走 closeTab;窗口留着等页签真正消失。
    expect(win.isDestroyed()).toBe(false);
    expect(
      h.sends.filter((s) => s.channel === SIDEBAR_TAB_WINDOW_CLOSE_REQUESTED_CHANNEL),
    ).toHaveLength(1);
    // 上一次可能被插件确认框否决,再次关窗要再转达一次。
    win.close();
    expect(
      h.sends.filter((s) => s.channel === SIDEBAR_TAB_WINDOW_CLOSE_REQUESTED_CHANNEL),
    ).toHaveLength(2);
    vi.advanceTimersByTime(60_000);
    expect(win.isDestroyed()).toBe(false);
    expect(h.returned).toHaveLength(0);

    // renderer 关掉页签后请求销毁:不交回页签,只告知主窗「已被关掉」(reason closed),
    // 主窗据此丢掉自己缓存里的副本(不可持久化会话没有数据库广播可依赖)。
    h.controller.closeForTab('tab-a');
    expect(win.destroy).toHaveBeenCalledOnce();
    expect(h.returned).toEqual([
      { sessionId: 's1', tabId: 'tab-a', snapshot: null, reason: 'closed' },
    ]);

    // renderer 还没挂上时没人能执行关闭流程:页签交回侧边栏而不是丢掉。
    const cold = makeHarness();
    cold.controller.open(request('tab-b'));
    cold.created[0].close();
    expect(cold.created[0].destroy).toHaveBeenCalledOnce();
    expect(cold.returned).toEqual([
      { sessionId: 's1', tabId: 'tab-b', snapshot: null, reason: 'merge' },
    ]);
  });

  // 测试价值
  // - 生产入口与可观察结果:open({targetWindowId}) / adoptTab / 按页签 mergeBack / closeForTab;
  //   可观察的是同任务页签搬进已有窗口后指派重发为全量、状态按 tabId 指向同一 windowId、
  //   只摘一个页签时窗口留着且重发指派、窗口清空才销毁、别的任务的页签不进这扇窗(新开)、
  //   崩溃时窗口里全部页签都交回。
  // - Bug / 规则依据:弹出窗口 = 住在别的窗口里的页签组(本 PR)。
  // - 现有覆盖缺口:其余用例都是单页签窗口。
  // - 最小失败输入:两个同任务页签 + targetWindowId。
  // - tier:unit(mock deps)。
  it('hosts several tabs per window: move-in, adopt, per-tab merge/close, crash returns all', () => {
    const h = makeHarness();
    h.controller.open(request('tab-a'));
    const win = h.created[0];
    h.controller.markRendererReady(h.wc(win));
    h.controller.markPresentationReady(h.wc(win));

    // 同任务页签搬进已有窗口:不建新窗,指派重发全量,状态指向同一扇窗。
    h.controller.open({ ...request('tab-b'), targetWindowId: 'w1' });
    expect(h.created).toHaveLength(1);
    const assigned = h.sends.filter((s) => s.channel === SIDEBAR_TAB_WINDOW_ASSIGNED_CHANNEL);
    expect(assigned.at(-1)?.payload).toMatchObject({
      windowId: 'w1',
      tabs: [
        { tabId: 'tab-a', sessionId: 's1' },
        { tabId: 'tab-b', sessionId: 's1' },
      ],
    });
    expect(h.controller.getState()).toEqual({
      'tab-a': { windowId: 'w1', sessionId: 's1', open: true },
      'tab-b': { windowId: 'w1', sessionId: 's1', open: true },
    });
    expect(h.controller.getWebContentsForTab('tab-b')).toBe(h.wc(win));

    // 全局页签可以进任何窗口;别的任务的页签进不来 → 新开一扇。
    h.controller.open({ ...request('tab-g', null), targetWindowId: 'w1' });
    expect(h.created).toHaveLength(1);
    h.controller.open({ ...request('tab-x', 's2'), targetWindowId: 'w1' });
    expect(h.created).toHaveLength(2);
    expect(h.controller.getState()['tab-x']).toMatchObject({ windowId: 'w2', sessionId: 's2' });

    // 窗口里新建的页签被收编;别的 sender 收编无效。
    h.controller.adoptTab(h.wc(win), 'tab-new', 's1');
    h.controller.adoptTab({} as WebContents, 'tab-nope', 's1');
    expect(Object.keys(h.controller.getState())).toEqual(
      expect.arrayContaining(['tab-a', 'tab-b', 'tab-g', 'tab-new']),
    );
    expect(h.controller.isTabPoppedOut('tab-nope')).toBe(false);

    // 合并回一个页签:窗口留着,指派重发,只交回那一个。
    h.controller.mergeBack(h.wc(win), 'tab-b', null);
    expect(win.isDestroyed()).toBe(false);
    expect(h.returned).toEqual([
      { sessionId: 's1', tabId: 'tab-b', snapshot: null, reason: 'merge' },
    ]);
    expect(h.controller.isTabPoppedOut('tab-b')).toBe(false);
    expect(
      (
        h.sends.filter((s) => s.channel === SIDEBAR_TAB_WINDOW_ASSIGNED_CHANNEL).at(-1)
          ?.payload as { tabs: { tabId: string }[] }
      ).tabs.map((tab) => tab.tabId),
    ).toEqual(['tab-a', 'tab-g', 'tab-new']);

    // 窗口里关掉一个页签:摘掉不交回(只告知 closed),窗口留着。
    h.controller.closeForTab('tab-new');
    expect(win.isDestroyed()).toBe(false);
    expect(h.returned.slice(1)).toEqual([
      { sessionId: 's1', tabId: 'tab-new', snapshot: null, reason: 'closed' },
    ]);

    // 主窗把窗里的全局页签交回(只限全局页签;任务页签必须由窗口自己合并回来)。
    expect(h.controller.returnGlobalTab('tab-a')).toBe(false);
    expect(h.controller.returnGlobalTab('tab-g')).toBe(true);
    expect(h.returned.at(-1)).toEqual({
      sessionId: null,
      tabId: 'tab-g',
      snapshot: null,
      reason: 'merge',
    });
    expect(h.controller.isTabPoppedOut('tab-g')).toBe(false);

    // 崩溃:剩下的页签全部交回。
    win.emitWebContentsEvent('render-process-gone', {}, { reason: 'crashed' });
    expect(win.destroy).toHaveBeenCalledOnce();
    expect(h.returned.slice(-1)).toEqual([
      { sessionId: 's1', tabId: 'tab-a', snapshot: null, reason: 'crash' },
    ]);
    expect(h.controller.getState()).toEqual({
      'tab-x': { windowId: 'w2', sessionId: 's2', open: true },
    });
  });

  // 测试价值
  // - 生产入口与可观察结果:mergeBack / adoptTab 带回的快照;可观察的是只有「页签 id 与该页签所属任务都
  //   对得上」的快照才会交回主窗或用于崩溃恢复,别的任务的快照、全局页签的快照一律丢弃。
  // - Bug / 规则依据:review「回传快照要绑定被指派的任务」(被攻破 / 过期 renderer 不能借页签 id
  //   把内容写进别的任务缓存)。
  // - 现有覆盖缺口:原用例只覆盖快照任务与页签任务一致的情况。
  // - 最小失败输入:s1 窗口回传 sessionId 为 s2 的快照;全局页签回传快照。
  // - tier:unit(mock deps)。
  it('drops returned snapshots that are not bound to the tab and its assigned session', () => {
    const h = makeHarness();
    h.controller.open(request('tab-a'));
    const win = h.created[0];
    h.controller.markRendererReady(h.wc(win));
    h.controller.markPresentationReady(h.wc(win));
    h.controller.open({ ...request('tab-g', null), targetWindowId: 'w1' });

    const foreign = { sessionId: 's2', tab: { id: 'tab-a', kind: 'web-browser', state: {} } };
    h.controller.mergeBack(h.wc(win), 'tab-a', foreign);
    expect(h.returned.at(-1)).toMatchObject({ tabId: 'tab-a', snapshot: null });

    const globalSnap = { sessionId: 's1', tab: { id: 'tab-g', kind: 'plugin-view', state: {} } };
    h.controller.mergeBack(h.wc(win), 'tab-g', globalSnap);
    expect(h.returned.at(-1)).toMatchObject({ tabId: 'tab-g', snapshot: null });

    // 收编:快照任务与指派任务不一致 → 不留作崩溃恢复用。
    h.controller.open(request('tab-b'));
    const win2 = h.created[1];
    h.controller.markRendererReady(h.wc(win2));
    h.controller.markPresentationReady(h.wc(win2));
    h.controller.adoptTab(h.wc(win2), 'tab-n', 's1', {
      sessionId: 's2',
      tab: { id: 'tab-n', kind: 'web-browser', state: {} },
    });
    win2.emitWebContentsEvent('render-process-gone', {}, { reason: 'crashed' });
    expect(h.returned.find((payload) => payload.tabId === 'tab-n')?.snapshot).toBeNull();
  });

  // 测试价值
  // - 生产入口与可观察结果:open 在窗口创建失败时返回 false(成功为 true);调用方据此不释放浏览器
  //   webview、不记窗口放置。
  // - Bug / 规则依据:review「createWindow 抛错时 IPC 仍当成功,页签状态被提前释放」。
  // - 现有覆盖缺口:创建失败路径没有断言。
  // - 最小失败输入:createWindow 抛错且没有 spare。
  it('reports a failed pop-out when no window can be created', () => {
    const h = makeHarness({
      createWindow: () => {
        throw new Error('boom');
      },
    });
    expect(h.controller.open(request('tab-a'))).toBe(false);
    expect(h.controller.isTabPoppedOut('tab-a')).toBe(false);
    const ok = makeHarness();
    expect(ok.controller.open(request('tab-a'))).toBe(true);
  });

  // 测试价值
  // - 生产入口与可观察结果:任务页签合并回侧栏后,窗口只剩全局页签时 getAssignment 的 sessionId
  //   为 null,另一任务的页签可以搬进这扇窗,而不是被旧任务绑定挡在门外新开一扇。
  // - Bug / 规则依据:review「最后一个任务页签离开后窗口仍绑旧任务」。
  // - 现有覆盖缺口:多页签用例只在窗口持有任务页签时断言指派。
  // - 最小失败输入:任务页签 + 全局页签同窗,合并回任务页签后再 open 另一任务页签。
  // - tier:unit(mock deps)。
  it('unbinds the window from its task once the last task tab leaves', () => {
    const h = makeHarness();
    h.controller.open(request('tab-a'));
    const win = h.created[0];
    h.controller.markRendererReady(h.wc(win));
    h.controller.markPresentationReady(h.wc(win));
    h.controller.open({ ...request('tab-g', null), targetWindowId: 'w1' });
    expect(h.controller.getAssignment(h.wc(win))).toMatchObject({ sessionId: 's1' });

    h.controller.mergeBack(h.wc(win), 'tab-a', null);
    expect(h.controller.getAssignment(h.wc(win))).toMatchObject({ sessionId: null });

    h.controller.open({ ...request('tab-x', 's2'), targetWindowId: 'w1' });
    expect(h.created).toHaveLength(1);
    expect(h.controller.getAssignment(h.wc(win))).toMatchObject({ sessionId: 's2' });
  });

  // 测试价值
  // - 生产入口与可观察结果:open({position}) → 首次展示前经 positionWindow 把窗口放到松手点,
  //   且只在 show 之前调一次;搬进已有窗口不改位置。
  // - Bug / 规则依据:页签拖出窗口松手即弹窗,新窗口要落在松手点附近而不是层叠默认位。
  // - 现有覆盖缺口:新增的 position 通道。
  // - 最小失败输入:open(request + position) 后 presentation-ready。
  // - tier:unit(mock deps)。
  it('positions a dragged-out window at the release point once, before showing it', () => {
    const positionWindow = vi.fn();
    const h = makeHarness({ positionWindow });
    h.controller.open({ ...request('tab-a'), position: { x: 1200, y: 300 } });
    const win = h.created[0];
    h.controller.markRendererReady(h.wc(win));
    expect(positionWindow).not.toHaveBeenCalled();
    h.controller.markPresentationReady(h.wc(win));
    expect(positionWindow).toHaveBeenCalledWith(win, { x: 1200, y: 300 });
    expect(win.show).toHaveBeenCalledOnce();
    expect(positionWindow.mock.invocationCallOrder[0]).toBeLessThan(
      win.show.mock.invocationCallOrder[0],
    );
    // 搬进已有窗口:不再定位。
    h.controller.open({ ...request('tab-b'), targetWindowId: 'w1', position: { x: 1, y: 1 } });
    expect(positionWindow).toHaveBeenCalledTimes(1);
  });

  // 测试价值
  // - 生产入口与可观察结果:owner 提交边界调用的 destroyAllWindows;可观察的是所有页签窗口(含 spare)
  //   被销毁、归属清空,并广播空状态让各 renderer 不再把页签当作「已弹出」。
  // - Bug / 规则依据:PR #6468 review(切换账号后弹出窗口仍显示旧 owner 的任务 / 插件内容)。
  // - 现有覆盖缺口:销毁只在主窗口关闭 / 退出时被测过,没有断言广播。
  // - 最小失败输入:一扇已展示的窗口 + 一扇 spare,调用 destroyAllWindows。
  // - tier:unit(mock deps)。
  it('destroys every window and clears the popped-out mirror at an owner boundary', () => {
    const h = makeHarness();
    h.controller.prewarm();
    h.controller.open(request('tab-a'));
    h.controller.markRendererReady(h.wc(h.created[0]));
    h.controller.markPresentationReady(h.wc(h.created[0]));
    vi.advanceTimersByTime(2_000);
    expect(h.created).toHaveLength(2);
    h.controller.destroyAllWindows();
    expect(h.created.every((win) => win.isDestroyed())).toBe(true);
    expect(h.controller.getState()).toEqual({});
    expect(h.controller.isTabPoppedOut('tab-a')).toBe(false);
    expect(h.broadcasts.at(-1)).toEqual({});
    // 旧窗口不当作崩溃把页签交回新 owner。
    expect(h.returned).toHaveLength(0);
  });

  // 测试价值
  // - 生产入口与可观察结果:adoptTab(snapshot) → 窗口崩溃;可观察的是不可持久化会话里窗口内新建的
  //   页签,崩溃时交回通知带着当时的内存快照(主窗从未见过这个页签,否则它随窗口一起消失)。
  // - Bug / 规则依据:PR #6468 review(保留崩溃窗口中新建的内存页签)。
  // - 现有覆盖缺口:崩溃交回快照固定为 null。
  // - 最小失败输入:adopt 一个带快照的页签后触发 render-process-gone。
  // - tier:unit(mock deps)。
  it('returns the snapshot of an adopted in-memory tab when the window crashes', () => {
    const h = makeHarness();
    h.controller.open(request('tab-a'));
    const win = h.created[0];
    h.controller.markRendererReady(h.wc(win));
    h.controller.markPresentationReady(h.wc(win));
    const snapshot = {
      sessionId: 's1',
      tab: { id: 'tab-n', kind: 'web-browser', state: { url: 'x' } },
    };
    h.controller.adoptTab(h.wc(win), 'tab-n', 's1', snapshot);
    win.emitWebContentsEvent('render-process-gone', {}, { reason: 'crashed' });
    expect(h.returned.find((payload) => payload.tabId === 'tab-n')).toEqual({
      sessionId: 's1',
      tabId: 'tab-n',
      snapshot,
      reason: 'crash',
    });
    expect(h.returned.find((payload) => payload.tabId === 'tab-a')?.snapshot).toBeNull();
  });

  it('closes a window whose tab was closed in the sidebar without returning the tab', () => {
    const h = makeHarness();
    h.controller.open(request('tab-a'));
    const win = h.created[0];
    h.controller.closeForTab('tab-a');
    expect(win.destroy).toHaveBeenCalledOnce();
    // 只有 closed 通知,没有 merge / crash 形式的「交回」。
    expect(h.returned.map((payload) => payload.reason)).toEqual(['closed']);
    expect(h.controller.getState()).toEqual({});
    // 未弹出的页签 no-op。
    h.controller.closeForTab('tab-missing');
    expect(h.created).toHaveLength(1);
  });

  it('returns the tab to the sidebar when the popped-out renderer crashes, with no rebuild loop', () => {
    const h = makeHarness();
    h.controller.open(request('tab-a'));
    const win = h.created[0];
    h.controller.markRendererReady(h.wc(win));
    h.controller.markPresentationReady(h.wc(win));
    win.emitWebContentsEvent('render-process-gone', {}, { reason: 'crashed' });
    expect(win.destroy).toHaveBeenCalledOnce();
    expect(h.returned).toEqual([
      { sessionId: 's1', tabId: 'tab-a', snapshot: null, reason: 'crash' },
    ]);
    // 不为崩溃的页签窗口自动重建 renderer:之后活着的只有补建的未指派 spare。
    vi.advanceTimersByTime(10_000);
    expect(h.controller.getState()).toEqual({});
    expect(h.controller.isTabPoppedOut('tab-a')).toBe(false);
    expect(h.created.filter((w) => !w.isDestroyed())).toHaveLength(1);
    expect(h.sends.filter((s) => s.channel === SIDEBAR_TAB_WINDOW_ASSIGNED_CHANNEL)).toHaveLength(
      1,
    );
  });

  it('replaces a crashed spare at most once', () => {
    const h = makeHarness();
    h.controller.prewarm();
    h.created[0].emitWebContentsEvent('render-process-gone', {}, { reason: 'oom' });
    vi.advanceTimersByTime(2_000);
    expect(h.created).toHaveLength(2);
    h.created[1].emitWebContentsEvent('render-process-gone', {}, { reason: 'oom' });
    vi.advanceTimersByTime(10_000);
    expect(h.created).toHaveLength(2);
    expect(h.returned).toHaveLength(0);
  });

  it('falls back on the open timeout: shows a mounted shell, returns the tab if nothing mounted', () => {
    const mounted = makeHarness();
    mounted.controller.open(request('tab-a'));
    const win = mounted.created[0];
    mounted.controller.markRendererReady(mounted.wc(win));
    vi.advanceTimersByTime(5_000);
    // 壳已挂载但首份内容迟迟不来:展示 Loading 壳而不是永久隐藏。
    expect(win.show).toHaveBeenCalledOnce();
    expect(mounted.returned).toHaveLength(0);

    const blank = makeHarness();
    blank.controller.open(request('tab-b'));
    vi.advanceTimersByTime(5_000);
    // 壳都没挂上:不展示空白窗口,页签回到侧边栏。
    expect(blank.created[0].show).not.toHaveBeenCalled();
    expect(blank.created[0].destroy).toHaveBeenCalledOnce();
    expect(blank.returned).toEqual([
      { sessionId: 's1', tabId: 'tab-b', snapshot: null, reason: 'crash' },
    ]);
  });

  it('ignores handshakes from unrelated senders and tears everything down on dispose', () => {
    const h = makeHarness();
    h.controller.prewarm();
    h.controller.open(request('tab-a'));
    const win = h.created[0];
    h.controller.markPresentationReady({} as WebContents);
    expect(win.show).not.toHaveBeenCalled();

    h.setQuitting(true);
    h.controller.dispose();
    expect(h.created.every((w) => w.isDestroyed())).toBe(true);
    // 退出时的销毁不交回页签(主窗 renderer 已不在)。
    expect(h.returned).toHaveLength(0);
    h.controller.open(request('tab-b'));
    expect(h.created).toHaveLength(1);
  });
});

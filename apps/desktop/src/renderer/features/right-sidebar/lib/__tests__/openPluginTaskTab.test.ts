// @vitest-environment jsdom
// - 生产入口与可观察结果:openPluginTaskTab 对真实 store 的写入(任务桶里的页签、激活页签、可见性请求)。
// - Bug / 规则依据:同一任务里每个插件实例至多一个任务页;不同任务各有自己的一份;
//   全局页签在前时,打开的任务页要请求露出(实机:全局「模拟器」挡住了刚开的任务页)。
// - 现有覆盖缺口:新入口。最小失败输入:同一插件在同一任务里连开两次。
// - tier:unit。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetStore, addTab, ensureHydrated, getBucket } from '../../store';
import { routeSidebarCommand } from '../detachedSidebarRouting';
import { __resetGlobalTabsForTest, addGlobalPluginTab, getActiveGlobalTabId, setActiveGlobalTabId, subscribeRevealSessionTab } from '../../globalTabs';
import { __resetTabGroupsForTest, getGroupActiveTabId, setTabGroup } from '../../tabGroups';
import { openPluginTaskTab } from '../openPluginTaskTab';
import { _resetSidebarCommandsForTests, onRequestRightSidebarVisibility } from '../sidebarCommands';
import { __resetSidebarTabWindowsStateForTest, __setSidebarTabWindowsStateForTest } from '@/lib/sidebarTabWindowState';

vi.mock('../detachedSidebarRouting', () => ({ routeSidebarCommand: vi.fn(async () => 'attached') }));

type Row = { id: string; sessionId: string; kind: string; position: number; state: unknown };
const rows = new Map<string, Row>();
const active = new Map<string, string | null>();
const ipc = {
  list: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
    tabs: [...rows.values()].filter((row) => row.sessionId === sessionId).sort((a, b) => a.position - b.position),
    activeTabId: active.get(sessionId) ?? null,
  })),
  upsert: vi.fn(async (row: Row) => { rows.set(row.id, row); }),
  close: vi.fn(async ({ id }: { id: string }) => { rows.delete(id); }),
  setActive: vi.fn(async ({ sessionId, id }: { sessionId: string; id: string | null }) => { active.set(sessionId, id); }),
  reorder: vi.fn(async () => {}),
};
const visibility = vi.fn();

beforeEach(() => {
  __resetGlobalTabsForTest(); __resetTabGroupsForTest();
  __resetSidebarTabWindowsStateForTest();
  _resetStore(); _resetSidebarCommandsForTests();
  rows.clear(); active.clear(); localStorage.clear(); vi.clearAllMocks();
  vi.mocked(routeSidebarCommand).mockResolvedValue('attached');
  window.electronAPI = { localDb: { rightSidebarTabs: ipc }, platform: 'darwin' } as unknown as Window['electronAPI'];
  onRequestRightSidebarVisibility(visibility);
});
afterEach(() => { _resetStore(); _resetSidebarCommandsForTests(); __resetGlobalTabsForTest(); __resetTabGroupsForTest(); });

const taskTabs = (sessionId: string) =>
  getBucket(sessionId).tabs.filter((tab) => tab.kind === 'plugin-task').map((tab) => tab.state);

describe('openPluginTaskTab', () => {
  // PR #6939 discussion_r4357791816：先开页、后挂载目标任务时不能丢失选中。
  // unit：无 Shell 订阅，验证真实任务桶与全局/组激活位；保留其他组与弹出窗口选择。
  it.each(['same-group', 'other-group', 'popped-out', 'passive'] as const)(
    'selects the target before its shell mounts without disturbing unrelated views: %s',
    async (state) => {
      const global = addGlobalPluginTab('manager')!;
      setActiveGlobalTabId(global.id);
      await openPluginTaskTab('task-2', 'sim', { userInitiated: false });
      const tab = getBucket('task-2').tabs[0];
      setTabGroup(tab.id, 'left');
      setTabGroup(global.id, state === 'other-group' ? 'right' : 'left');
      if (state === 'popped-out') {
        __setSidebarTabWindowsStateForTest({ [tab.id]: { windowId: 'window-1', sessionId: 'task-2', open: true } });
        window.electronAPI.sidebarTabWindow = { focus: vi.fn(async () => {}) } as unknown as Window['electronAPI']['sidebarTabWindow'];
      }
      await openPluginTaskTab('task-2', 'sim', { userInitiated: state !== 'passive' });
      expect(getBucket('task-2').activeTabId).toBe(tab.id);
      expect(getActiveGlobalTabId()).toBe(state === 'same-group' ? null : global.id);
      expect(getGroupActiveTabId('left', 'task-2')).toBe(
        state === 'same-group' || state === 'other-group' ? tab.id : null,
      );
    },
  );

  // 弹出窗口自己的激活位与主窗任务桶不同；即使桶已激活目标也必须送选中请求。
  it('reveals an existing popped-out tab without stealing native focus', async () => {
    await openPluginTaskTab('task-1', 'sim');
    const tab = getBucket('task-1').tabs[0];
    __setSidebarTabWindowsStateForTest({ [tab.id]: { windowId: 'window-1', sessionId: 'task-1', open: true } });
    const focus = vi.fn(async () => {});
    window.electronAPI.sidebarTabWindow = { focus } as unknown as Window['electronAPI']['sidebarTabWindow'];
    await openPluginTaskTab('task-1', 'sim', { userInitiated: false });
    expect(focus).toHaveBeenCalledWith(tab.id, { userInitiated: false });
    expect(taskTabs('task-1')).toEqual([{ instanceId: 'sim' }]);
  });
  it('keeps one task page per plugin per task, refocusing it instead of adding another', async () => {
    const reveal = vi.fn();
    const stop = subscribeRevealSessionTab(reveal);
    await openPluginTaskTab('task-1', 'sim', { userInitiated: false });
    await ensureHydrated('task-1');
    const files = await addTab('task-1', 'file-browser');
    expect(getBucket('task-1').activeTabId).toBe(files.id);
    await openPluginTaskTab('task-1', 'sim', { userInitiated: false });
    expect(taskTabs('task-1')).toEqual([{ instanceId: 'sim' }]);
    const simTab = getBucket('task-1').tabs.find((tab) => tab.kind === 'plugin-task')!;
    expect(getBucket('task-1').activeTabId).toBe(simTab.id);
    expect(reveal.mock.calls).toEqual([['task-1', simTab.id], ['task-1', simTab.id]]);
    expect(visibility).toHaveBeenLastCalledWith('open', { sessionId: 'task-1', userInitiated: false });
    stop();
  });

  it('gives every task its own page, and every plugin its own tab within a task', async () => {
    await openPluginTaskTab('task-1', 'sim');
    await openPluginTaskTab('task-2', 'sim');
    await openPluginTaskTab('task-1', 'other');
    expect(taskTabs('task-1')).toEqual([{ instanceId: 'sim' }, { instanceId: 'other' }]);
    expect(taskTabs('task-2')).toEqual([{ instanceId: 'sim' }]);
  });

  it('leaves the tab to the detached sidebar window when the command is routed there', async () => {
    vi.mocked(routeSidebarCommand).mockResolvedValue('routed');
    await openPluginTaskTab('task-1', 'sim', { userInitiated: false });
    expect(routeSidebarCommand).toHaveBeenCalledWith({ type: 'open-plugin-task', sessionId: 'task-1', instanceId: 'sim' }, { userInitiated: false });
    expect(ipc.upsert).not.toHaveBeenCalled();
    expect(visibility).toHaveBeenCalledWith('open', { sessionId: 'task-1', userInitiated: false });
  });
});

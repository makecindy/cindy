// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarFilterPopover } from '../SidebarFilterPopover';
import type { UseSidebarFilterReturn } from '../../hooks/useSidebarFilter';
import { useTaskListMode } from '@/hooks/useTaskListMode';
import translations from '@/i18n/locales/zh-CN/common.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const value = key
        .split('.')
        .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], translations);
      return String(value ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        String(values?.[name] ?? ''),
      );
    },
  }),
}));
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
const mainView = vi.hoisted(() => ({ setMode: (() => {}) as (mode: string) => void }));
vi.mock('@/hooks/useSidebarCardMode', () => ({
  useSidebarMainViewMode: () => ({ mode: 'list', setMode: (mode: string) => mainView.setMode(mode) }),
}));
vi.mock('../../hooks/useTaskInfoFields', () => ({
  useTaskInfoFields: () => ({ fields: ['pr'], toggleField: vi.fn() }),
}));
vi.mock('@/hooks/usePluginEngines', () => ({
  usePluginEngineIdentity: (providerId: string | null) => ({ name: `Engine ${providerId?.split(':').pop()}` }),
}));
vi.mock('@/features/device-link/useMachineSwitcher', () => ({
  useEffectiveSelectedMachineId: () => 'all',
}));
vi.mock('../../hooks/useRemoteHostProjectOrders', () => ({
  useLocalHostProjectOrder: () => ({ snapshot: undefined }),
  useRemoteHostProjectOrders: () => ({ orders: new Map() }),
  projectOrderWriteScopeForSelection: () => ({ kind: 'viewer' }),
  controllerManualOrderForDevice: () => [],
}));
vi.mock('@cindy/maker-shared/project-order-sync', () => ({
  resolveDisplayedProjectOrder: (_scope: unknown, _snapshot: unknown, viewer: unknown) => viewer,
  projectOrderWriteLedger: () => 'viewer',
}));

function makeFilter(overrides: Partial<UseSidebarFilterReturn> = {}): UseSidebarFilterReturn {
  return {
    creators: 'all',
    hideAutomations: false,
    setHideAutomations: vi.fn(),
    hideTaskCreated: false,
    setHideTaskCreated: vi.fn(),
    creatorOptions: [],
    toggleCreator: vi.fn(),
    setCreatorsAll: vi.fn(),
    setCreatorsNone: vi.fn(),
    status: 'active',
    projects: 'all',
    projectsAsSet: null,
    vendor: 'all',
    lastActivity: 'all',
    groupBy: 'project',
    groupDialogue: true,
    groupDevice: true,
    sortBy: 'priority',
    projectOrder: 'activity',
    manualProjectOrder: [],
    isFilterActive: true,
    setVendor: vi.fn(),
    toggleVendor: vi.fn(),
    setStatus: vi.fn(),
    setSortBy: vi.fn(),
    setProjectOrder: vi.fn(),
    setLastActivity: vi.fn(),
    resetContentFilters: vi.fn(),
    ...overrides,
  } as UseSidebarFilterReturn;
}
const PLUGIN_HARNESS = { key: 'acp-plugin:demo:alpha', providerId: 'acp-plugin:demo:alpha' };
function Preview({ filter, remote = true }: { filter: UseSidebarFilterReturn; remote?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <SidebarFilterPopover
      filter={filter}
      allKnownProjects={[]}
      pluginHarnesses={[PLUGIN_HARNESS]}
      hasRemoteDevices={remote}
      open={open}
      onOpenChange={setOpen}
    />
  );
}
async function openSubmenu(name: RegExp) {
  const trigger = screen.getByRole('menuitem', { name });
  fireEvent.keyDown(trigger, { key: 'ArrowRight' });
  return await screen.findByRole('menu', { name });
}
/**
 * Row names as the user reads them: the label, without the trailing hint or check mark. A row
 * that is only a segmented bar has no visible label and is named by its accessible name.
 */
const rowLabels = (rows: HTMLElement[]) =>
  rows.map((row) => row.getAttribute('aria-label')?.split(' ')[0] ?? row.querySelector('span')?.textContent);
beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { platform: 'darwin' },
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  // The list mode is a shared store; the inbox introduction is a separate one-time dialog.
  localStorage.setItem('featureIntro.taskInbox.seen', '1');
  const mode = renderHook(useTaskListMode);
  act(() => mode.result.current.setMode('tasks'));
  mode.unmount();
});
afterEach(cleanup);

describe('sidebar display settings menu', () => {
  it('does not enumerate project menu rows while closed, and uses fresh props on open', async () => {
    const projects = [] as NonNullable<
      React.ComponentProps<typeof SidebarFilterPopover>['allKnownProjects']
    >;
    const enumerate = vi.spyOn(projects, 'map');
    const filter = makeFilter();
    const { rerender } = render(
      <SidebarFilterPopover filter={filter} allKnownProjects={projects} open={false} />,
    );
    rerender(
      <SidebarFilterPopover filter={{ ...filter }} allKnownProjects={projects} open={false} />,
    );
    expect(enumerate).not.toHaveBeenCalled();
    rerender(<SidebarFilterPopover filter={filter} allKnownProjects={projects} open />);
    expect(enumerate).toHaveBeenCalled();
    const submenu = await openSubmenu(/^排序/);
    fireEvent.click(within(submenu).getByRole('menuitem', { name: /^创建时间/ }));
    expect(filter.setSortBy).toHaveBeenCalledWith('created');
  });

  // 2026-11-28 redesign (sidebar-redesign-plan.md §3): few-option settings are changed in place,
  // the two sort settings share one submenu, and the group summary no longer truncates.
  it('changes status and row style in place, and keeps task and project sorting in one submenu', async () => {
    const setMainViewMode = vi.fn();
    mainView.setMode = setMainViewMode;
    const filter = makeFilter({ groupAutomation: true });
    render(<Preview filter={filter} />);
    const root = screen.getByRole('menu');
    const rows = within(root).getAllByRole('menuitem');
    expect(rowLabels(rows)).toEqual(['任务模式', '分组', '排序', '任务状态', '筛选', '隐藏', '显示', '任务信息']);
    // Four active groups used to read 「项目、对话…」 in a 96px slot; the summary is now one icon each.
    expect(within(rows[1]).getByLabelText('设备、项目、对话、自动化').querySelectorAll('svg')).toHaveLength(4);

    fireEvent.click(within(root).getByRole('radio', { name: '已归档' }));
    expect(filter.setStatus).toHaveBeenCalledWith('archived');
    fireEvent.click(within(root).getByRole('radio', { name: '文字' }));
    expect(setMainViewMode).toHaveBeenCalledWith('text');
    // The row itself is the keyboard target: arrows move the choice without leaving the menu.
    fireEvent.keyDown(screen.getByRole('menuitem', { name: /^任务状态/ }), { key: 'ArrowLeft' });
    expect(filter.setStatus).toHaveBeenLastCalledWith('all');

    const submenu = await openSubmenu(/^排序/);
    // PR #6196: preserve the historical glass-menu clipping regression through
    // real unit DOM containment; content/click assertions alone miss a lost portal.
    expect(root.contains(submenu)).toBe(false);
    expect(document.body.contains(submenu)).toBe(true);
    expect(rowLabels(within(submenu).getAllByRole('menuitem'))).toEqual([
      '优先级', '最近活动', '创建时间', '跟随任务', '手动',
    ]);
    expect(within(submenu).getByRole('menuitem', { name: /^优先级/ }).textContent).toContain('等你处理的在前');
    fireEvent.click(within(submenu).getByRole('menuitem', { name: /^创建时间/ }));
    expect(filter.setSortBy).toHaveBeenCalledWith('created');
    fireEvent.click(within(submenu).getByRole('menuitem', { name: /^手动/ }));
    expect(filter.setProjectOrder).toHaveBeenCalledWith('custom');
    expect(screen.getAllByRole('menu')).toHaveLength(2);
  });

  // Harnesses are no longer a fixed list of three: plugins add their own, and several can be chosen.
  it('lists plugin harnesses beside the built-in ones and keeps hiding apart from filtering', async () => {
    const filter = makeFilter({ status: 'archived', vendor: ['pi'], hideAutomations: true });
    render(<Preview filter={filter} />);
    expect(screen.getByRole('menuitem', { name: /^筛选/ }).textContent).toContain('1 项生效');
    const submenu = await openSubmenu(/^筛选/);
    expect(within(submenu).queryByText('任务状态')).toBeNull();
    expect(within(submenu).queryByRole('menuitemcheckbox')).toBeNull();
    const harness = await openSubmenu(/^Harness/);
    const checked = (name: string) =>
      within(harness).getByRole('menuitemcheckbox', { name }).getAttribute('aria-checked');
    expect(within(harness).getAllByRole('menuitemcheckbox')).toHaveLength(4);
    expect(['Claude Code', 'Codex', 'Pi', 'Engine alpha'].map(checked)).toEqual(['false', 'false', 'true', 'false']);
    fireEvent.click(within(harness).getByRole('menuitemcheckbox', { name: 'Engine alpha' }));
    expect(filter.toggleVendor).toHaveBeenCalledWith(PLUGIN_HARNESS.key);
    fireEvent.click(within(harness).getByRole('menuitem', { name: '全部' }));
    expect(filter.setVendor).toHaveBeenCalledWith('all');
    fireEvent.click(within(submenu).getByRole('radio', { name: '7 天' }));
    expect(filter.setLastActivity).toHaveBeenCalledWith('7d');

    const hidden = await openSubmenu(/^隐藏/);
    expect(
      within(hidden).getAllByRole('menuitemcheckbox').map((row) => [row.textContent, row.getAttribute('aria-checked')]),
    ).toEqual([['自动化任务', 'true'], ['由其他任务创建的任务', 'false'], ['伙伴的任务', 'false']]);
    fireEvent.click(within(hidden).getByRole('menuitemcheckbox', { name: '由其他任务创建的任务' }));
    expect(filter.setHideTaskCreated).toHaveBeenCalledWith(true);
    // Hiding every teammate's tasks moved here from 筛选 › 伙伴 (2026-11-28 user decision).
    fireEvent.click(within(hidden).getByRole('menuitemcheckbox', { name: '伙伴的任务' }));
    expect(filter.setCreatorsNone).toHaveBeenCalledOnce();
  });

  // The inbox fixes its own sections and order; issue #13025 read the shorter menu as lost features.
  it('switches between the task list and the inbox from the menu and shows each mode its own rows', async () => {
    render(<Preview filter={makeFilter()} />);
    const root = screen.getByRole('menu');
    fireEvent.click(within(root).getByRole('radio', { name: '收件箱' }));
    expect(rowLabels(within(root).getAllByRole('menuitem'))).toEqual([
      '任务模式', '筛选', '隐藏', '显示', '任务信息', '收件箱使用技巧',
    ]);
    fireEvent.click(within(root).getByRole('radio', { name: '任务列表' }));
    expect(within(root).getByRole('menuitem', { name: /^分组/ })).not.toBeNull();
    expect(within(root).queryByRole('menuitem', { name: '收件箱使用技巧' })).toBeNull();
    // The introduction shows by itself only once per computer; this row brings it back on request.
    fireEvent.click(within(root).getByRole('radio', { name: '收件箱' }));
    fireEvent.click(within(root).getByRole('menuitem', { name: '收件箱使用技巧' }));
    expect(await screen.findByRole('dialog', { name: '认识收件箱' })).not.toBeNull();
  });
  // 2026-11-28 user decision: viewing archived tasks no longer marks the button (the status is
  // on the menu's first level). The dot is left for inbox filters and hidden kinds.
  it('marks the trigger only for an inbox filter, not for archived tasks', () => {
    const dot = (filter: UseSidebarFilterReturn) => {
      const { unmount } = render(<SidebarFilterPopover filter={filter} allKnownProjects={[]} open={false} />);
      const found = screen.getByRole('button', { name: /^侧边栏显示设置/ }).querySelector('[data-filter-reminder]') !== null;
      unmount();
      return found;
    };
    expect(dot(makeFilter({ status: 'archived' }))).toBe(false);
    const mode = renderHook(useTaskListMode);
    act(() => mode.result.current.setMode('inbox'));
    expect([dot(makeFilter()), dot(makeFilter({ hideAutomations: true }))]).toEqual([false, true]);
  });
  it('hides unavailable grouping choices and their summary without clearing saved device preference', async () => {
    const filter = makeFilter({ groupBy: 'flat' });
    render(<Preview filter={filter} remote={false} />);
    expect(within(screen.getByRole('menuitem', { name: /^分组/ })).getByLabelText('对话')).not.toBeNull();
    const group = await openSubmenu(/^分组/);
    expect(rowLabels(within(group).getAllByRole('menuitemcheckbox'))).toEqual(['项目', '对话', '自动化']);
    expect(filter.groupDevice).toBe(true);
    // Project order only means something while tasks are grouped by project.
    const sort = await openSubmenu(/^排序/);
    expect(within(sort).queryByRole('menuitem', { name: /^跟随任务/ })).toBeNull();
  });
});

it('keeps the creator submenu open for multiple selections and exposes an all reset', async () => {
  const filter = makeFilter({ creators: ['[null,"a"]'], creatorOptions: [
    { id: 'a', name: 'Dash', avatar: '', avatarColor: 'blue' },
    { id: 'a', name: 'Dash', deviceId: 'remote', deviceName: 'Laptop', avatar: '', avatarColor: 'blue' },
  ] });
  render(<Preview filter={filter} />);
  await openSubmenu(/^筛选/);
  const submenu = await openSubmenu(/^伙伴/);
  expect(within(submenu).getByRole('menuitemcheckbox', { name: 'Dash' }).getAttribute('aria-checked')).toBe('true');
  fireEvent.click(within(submenu).getByRole('menuitemcheckbox', { name: 'Dash Laptop' }));
  expect(filter.toggleCreator).toHaveBeenCalledWith('["remote","a"]');
  expect(screen.getAllByRole('menu')).toHaveLength(3);
  fireEvent.click(within(submenu).getByRole('menuitem', { name: '全部' }));
  expect(filter.setCreatorsAll).toHaveBeenCalledOnce();
  expect(within(submenu).queryByRole('menuitem', { name: '都不显示' })).toBeNull();
});

// A checked 「隐藏 › 伙伴的任务」 is the saved 'none' choice: the row shows it and unchecking shows everyone again.
it('shows hidden teammates as a checked hide option that returns to all', async () => {
  const filter = makeFilter({ creators: 'none' });
  render(<Preview filter={filter} />);
  expect(screen.getByRole('menuitem', { name: /^筛选/ }).textContent).toContain('无');
  const hidden = await openSubmenu(/^隐藏/);
  const teammates = within(hidden).getByRole('menuitemcheckbox', { name: '伙伴的任务' });
  expect(teammates.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(teammates);
  expect(filter.setCreatorsAll).toHaveBeenCalledOnce();
});

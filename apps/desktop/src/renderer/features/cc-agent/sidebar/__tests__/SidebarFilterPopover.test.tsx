// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarFilterPopover } from '../SidebarFilterPopover';
import type { UseSidebarFilterReturn } from '../../hooks/useSidebarFilter';
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
vi.mock('@/hooks/useSidebarCardMode', () => ({
  useSidebarMainViewMode: () => ({ mode: 'list', setMode: vi.fn() }),
}));
vi.mock('../../hooks/useTaskInfoFields', () => ({
  useTaskInfoFields: () => ({ fields: ['pr'], toggleField: vi.fn() }),
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
    setStatus: vi.fn(),
    setSortBy: vi.fn(),
    resetContentFilters: vi.fn(),
    ...overrides,
  } as UseSidebarFilterReturn;
}
function Preview({ filter, remote = true }: { filter: UseSidebarFilterReturn; remote?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <SidebarFilterPopover
      filter={filter}
      allKnownProjects={[]}
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
beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { platform: 'darwin' },
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe('sidebar display settings menu', () => {
  it('presents seven summarized parent rows with icons, and three direct task sorting choices', async () => {
    const filter = makeFilter();
    render(<Preview filter={filter} />);
    const root = screen.getByRole('menu');
    const rows = within(root).getAllByRole('menuitem');
    expect(rows.map((row) => row.querySelector('span')?.textContent)).toEqual([
      '分组',
      '任务排序',
      '项目排序',
      '任务状态',
      '筛选',
      '显示',
      '任务信息',
    ]);
    for (const row of rows) expect(row.querySelector('svg')).not.toBeNull();
    expect(rows[0].textContent).toContain('项目、对话、设备');
    expect(rows[2].textContent).toContain('跟随任务');
    const submenu = await openSubmenu(/^任务排序/);
    expect(
      within(submenu)
        .getAllByRole('menuitem')
        .map((row) => row.textContent),
    ).toEqual(['按优先级', '按最近活动', '按创建时间']);
    fireEvent.click(within(submenu).getByRole('menuitem', { name: '按创建时间' }));
    expect(filter.setSortBy).toHaveBeenCalledWith('created');
    expect(screen.getAllByRole('menu')).toHaveLength(2);
    expect(within(submenu).getByRole('menuitem', { name: '按创建时间' })).not.toBeNull();
  });

  it('keeps status independent from content filters and exposes a selectable Pi harness', async () => {
    const filter = makeFilter({ status: 'archived' });
    render(<Preview filter={filter} />);
    const submenu = await openSubmenu(/^筛选/);
    expect(within(submenu).queryByText('任务状态')).toBeNull();
    expect(
      within(submenu).getByRole('menuitem', { name: '重置筛选' }).getAttribute('data-disabled'),
    ).not.toBeNull();
    const harness = await openSubmenu(/^Harness/);
    expect(
      within(harness)
        .getAllByRole('menuitem')
        .map((row) => row.textContent),
    ).toEqual(['全部', 'Claude Code', 'Codex', 'Pi']);
    fireEvent.click(within(harness).getByRole('menuitem', { name: 'Pi' }));
    expect(filter.setVendor).toHaveBeenCalledWith('pi');
    expect(screen.getAllByRole('menu').length).toBeGreaterThan(1);
  });

  it('hides unavailable grouping choices and their summary without clearing saved device preference', async () => {
    const filter = makeFilter({ groupBy: 'flat' });
    render(<Preview filter={filter} remote={false} />);
    expect(screen.queryByRole('menuitem', { name: /^项目排序/ })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /^分组/ }).textContent).toBe('分组对话');
    const group = await openSubmenu(/^分组/);
    expect(
      within(group)
        .getAllByRole('menuitem')
        .map((row) => row.textContent),
    ).toEqual(['按项目', '按对话']);
    expect(filter.groupDevice).toBe(true);
  });
});

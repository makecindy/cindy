// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { ChevronsUpDown } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MainListScopeHeader } from '../MainListScopeHeader';
import type { UseSidebarFilterReturn } from '../../hooks/useSidebarFilter';
import { useTaskListMode, type TaskListMode } from '@/hooks/useTaskListMode';

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../MachineSwitcherMenu', () => ({ MachineSwitcherMenu: () => null }));
vi.mock('../SidebarFilterPopover', () => ({
  SidebarFilterPopover: () => <button type="button">display-settings</button>,
}));

afterEach(cleanup);

// 段头操作默认只在 hover/focus 时出现(用 opacity-0 + pointer-events-none 隐藏)。
// 设置按钮只在带提醒点时常驻:收件箱里有筛选或隐藏生效。查看「已归档」不再提醒、也不再常驻
// (2026-11-28 用户决定,取代 2026-10-20 的归档提醒);折叠按钮不受影响。
function hiddenUntilHover(element: HTMLElement): boolean {
  return element.closest('.opacity-0') !== null;
}
function renderHeader(mode: TaskListMode, filter: Partial<UseSidebarFilterReturn>) {
  const listMode = renderHook(useTaskListMode);
  act(() => listMode.result.current.setMode(mode));
  render(
    <MainListScopeHeader
      filter={{
        status: 'active', projects: 'all', vendor: 'all', lastActivity: 'all', creators: 'all',
        hideAutomations: false, hideTaskCreated: false, ...filter,
      } as UseSidebarFilterReturn}
      allKnownProjects={[]}
      hasRemoteDevices={false}
      fold={{ label: 'fold', Icon: ChevronsUpDown, onClick: vi.fn(), disabled: false }}
    />,
  );
  return {
    settings: screen.getByRole('button', { name: 'display-settings' }),
    fold: screen.getByRole('button', { name: 'fold' }),
  };
}

describe('MainListScopeHeader actions visibility', () => {
  it.each([
    ['the task list showing archived tasks', 'tasks', { status: 'archived' }, true],
    ['the inbox without a filter', 'inbox', {}, true],
    ['the inbox hiding automation tasks', 'inbox', { hideAutomations: true }, false],
    ['the inbox hiding teammates', 'inbox', { creators: 'none' }, false],
  ] as const)('in %s the settings button hides until hover: %s', (_name, mode, filter, hidden) => {
    const { settings, fold } = renderHeader(mode, filter);
    expect(hiddenUntilHover(settings)).toBe(hidden);
    expect(hiddenUntilHover(fold)).toBe(true);
  });
});

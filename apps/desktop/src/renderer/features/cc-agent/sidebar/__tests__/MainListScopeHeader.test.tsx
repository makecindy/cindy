// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { ChevronsUpDown } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MainListScopeHeader } from '../MainListScopeHeader';
import type { UseSidebarFilterReturn } from '../../hooks/useSidebarFilter';

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../MachineSwitcherMenu', () => ({ MachineSwitcherMenu: () => null }));
vi.mock('../SidebarFilterPopover', () => ({
  SidebarFilterPopover: () => <button type="button">display-settings</button>,
}));

afterEach(cleanup);

// 段头操作默认只在 hover/focus 时出现(用 opacity-0 + pointer-events-none 隐藏)。
// 查看「已归档」时设置按钮必须常驻,否则看不到提醒点;折叠按钮不受影响。
function hiddenUntilHover(element: HTMLElement): boolean {
  return element.closest('.opacity-0') !== null;
}
function renderHeader(status: 'active' | 'archived' | 'all') {
  render(
    <MainListScopeHeader
      filter={{ status } as UseSidebarFilterReturn}
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
    ['active', true],
    ['archived', false],
    ['all', true],
  ] as const)('with the %s filter the settings button hides until hover: %s', (status, hidden) => {
    const { settings, fold } = renderHeader(status);
    expect(hiddenUntilHover(settings)).toBe(hidden);
    expect(hiddenUntilHover(fold)).toBe(true);
  });
});

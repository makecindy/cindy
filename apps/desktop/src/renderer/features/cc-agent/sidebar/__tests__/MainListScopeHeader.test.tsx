// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

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

// Regression: the existing project callback had no visible sidebar entry, including an empty list.
// Native-picker pending blocks repeat clicks; no host/database needed (component tier).
describe('direct project folder action', () => {
  it('stays visible without hover and coalesces clicks until the picker finishes', async () => {
    let finish: () => void = () => {};
    const add = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <MainListScopeHeader
        filter={{ status: 'active' } as UseSidebarFilterReturn}
        allKnownProjects={[]}
        hasRemoteDevices={false}
        onCreateProject={add}
      />,
    );
    const button = screen.getByRole('button', { name: 'ccAgent.sidebar.addProjectFolder' });
    expect(hiddenUntilHover(button)).toBe(false);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(add).toHaveBeenCalledTimes(1);
    expect(button.hasAttribute('disabled')).toBe(true);
    await act(async () => finish());
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    fireEvent.click(button);
    expect(add).toHaveBeenCalledTimes(2);
    await act(async () => finish());
  });
});

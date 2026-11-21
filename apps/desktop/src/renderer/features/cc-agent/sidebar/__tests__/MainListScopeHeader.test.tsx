// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChevronsUpDown } from 'lucide-react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MainListScopeHeader } from '../MainListScopeHeader';
import { getDraft, patchDraft } from '@/state/newMakerDraft';
import type { UseSidebarFilterReturn } from '../../hooks/useSidebarFilter';

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../MachineSwitcherMenu', () => ({ MachineSwitcherMenu: () => null }));
vi.mock('../SidebarFilterPopover', () => ({
  SidebarFilterPopover: () => <button type="button">display-settings</button>,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
const modeMock = vi.hoisted(() => ({ mode: 'tasks' as 'tasks' | 'inbox' }));
vi.mock('@/hooks/useTaskListMode', () => ({
  useTaskListMode: () => ({ mode: modeMock.mode, setMode: () => {} }),
}));

// 段头最右侧「＋」的文案来自 ccAgent.sidebar.newDialogue(与其它图标式新建入口同一个键)。
const NEW_TASK_LABEL = 'ccAgent.sidebar.newDialogue';

afterEach(() => {
  cleanup();
  modeMock.mode = 'tasks';
});

// 段头操作默认只在 hover/focus 时出现(用 opacity-0 + pointer-events-none 隐藏)。
// 查看「已归档」时设置按钮必须常驻,否则看不到提醒点;折叠不受影响。
// 这里是既有的类名快照:jsdom 不加载 Tailwind,算不出真实的 hover 显示。
// 新增的「＋」不靠它证明悬停行为,那条由单页验证用真实样式断言(见下方注释)。
function hiddenUntilHover(element: HTMLElement): boolean {
  return element.closest('.opacity-0') !== null;
}

/** 读当前路由,用来验证「＋」落到哪个页面、走的是哪一种新建。 */
function LocationProbe() {
  const location = useLocation();
  const workspacePrompt = (location.state as { workspacePrompt?: string } | null)?.workspacePrompt;
  return <output data-testid="route">{location.pathname + '|' + (workspacePrompt ?? '')}</output>;
}

function renderHeader(
  status: 'active' | 'archived' | 'all',
  { fold = true }: { fold?: boolean } = {},
) {
  render(
    <MemoryRouter initialEntries={['/cc-agent']}>
      <MainListScopeHeader
        filter={{ status } as UseSidebarFilterReturn}
        allKnownProjects={[]}
        hasRemoteDevices={false}
        fold={
          fold
            ? { label: 'fold', Icon: ChevronsUpDown, onClick: vi.fn(), disabled: false }
            : null
        }
      />
      <LocationProbe />
    </MemoryRouter>,
  );
  return {
    settings: screen.getByRole('button', { name: 'display-settings' }),
    fold: fold ? screen.getByRole('button', { name: 'fold' }) : null,
    newTask: () => screen.queryByRole('button', { name: NEW_TASK_LABEL }),
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
    expect(hiddenUntilHover(fold!)).toBe(true);
  });

  it('keeps the new-task entry in inbox mode, where the list has no fold action', () => {
    modeMock.mode = 'inbox';
    const { fold, newTask } = renderHeader('active', { fold: false });
    expect(fold).toBeNull();
    // 入口随段头恒在,不跟着折叠按钮一起消失。悬停/键盘聚焦才出现这件事
    // 在 jsdom 里验不了(没有样式表),由 task-inbox 的 header-actions 场景
    // 用真实样式断言包裹层 opacity 0 → 1。
    expect(newTask()).not.toBeNull();
  });

  it('opens the generic new-task draft rather than a device-scoped dialogue', () => {
    const { newTask } = renderHeader('active');
    fireEvent.click(newTask()!);
    // 与左上角「新建」、⌘N 同一条链路:通用草稿(恢复上次创建的电脑与项目),
    // 不是按段头机器范围猜目标的 dialogue 新建。
    expect(screen.getByTestId('route').textContent).toBe('/cc-agent/new|generic');
  });

  it('leaves the saved draft workspace untouched', () => {
    patchDraft({ workingDir: '/workspace/keep-me' });
    // getDraft() 返回内存里的同一份对象,先拍一份快照才能看出改动。
    const before = structuredClone(getDraft());
    const { newTask } = renderHeader('active');
    fireEvent.click(newTask()!);
    // 通用「新建」只导航,不重置 newMakerDraft:选好的工程目录不能被清回默认值
    // (2026-07 回归)。
    expect(getDraft()).toEqual(before);
    expect(getDraft().workingDir).toBe('/workspace/keep-me');
  });
});

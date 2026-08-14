// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerInfo } from '../hooks/useWorkers';
import { WorkerListToolbar } from '../RolePillDropdown';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useAppShortcut', () => ({
  useAppShortcutDisplay: () => '',
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => false) }),
}));

// 与 RolePillDropdown.tsx 顶部的 hover 时序常量保持一致。
const HOVER_OPEN_DELAY_MS = 60;
const HOVER_CLOSE_DELAY_MS = 160;

function worker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    workerId: 'worker-a',
    sessionId: 'session-a',
    role: 'developer',
    agent: 'codex',
    model: 'gpt-5.4',
    effort: null,
    label: null,
    status: 'idle',
    focused: true,
    idleSince: null,
    ...overrides,
  };
}

function renderToolbar(overrides: Partial<Parameters<typeof WorkerListToolbar>[0]> = {}) {
  const current = worker();
  return render(
    <WorkerListToolbar
      worker={current}
      workers={[current]}
      selectedWorkerId={current.workerId}
      activeWorkerCount={1}
      softLimit={5}
      hardLimit={8}
      onSwitchFocus={vi.fn()}
      onOpenCreate={vi.fn()}
      onOpenSettings={vi.fn()}
      onArchiveWorker={vi.fn()}
      {...overrides}
    />,
  );
}

function menuButton(): HTMLElement {
  return screen.getByRole('button', { name: 'orca.rolePill.layoutMenuLabel' });
}

// Tip 与 Radix Tooltip 都不产生 DOM 包装节点，⋮ 按钮的父元素即菜单 wrapper。
function wrapperOf(element: HTMLElement): HTMLElement {
  return element.parentElement as HTMLElement;
}

describe('WorkerLayoutMenu hover interaction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('hover 后经打开延迟临时展开菜单', () => {
    renderToolbar();
    const wrapper = wrapperOf(menuButton());
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS);
    });
    expect(screen.getByText('orca.rolePill.workersHeader')).toBeTruthy();
  });

  it('鼠标移出后经关闭延迟收起临时展开的菜单', () => {
    renderToolbar();
    const wrapper = wrapperOf(menuButton());
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS);
    });
    fireEvent.mouseLeave(wrapper);
    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS);
    });
    expect(screen.queryByText('orca.rolePill.workersHeader')).toBeNull();
  });

  it('点击固定菜单，鼠标移出后保持打开', () => {
    renderToolbar();
    const wrapper = wrapperOf(menuButton());
    fireEvent.click(menuButton());
    fireEvent.mouseLeave(wrapper);
    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS);
    });
    expect(screen.getByText('orca.rolePill.workersHeader')).toBeTruthy();
  });

  it('再次点击取消固定并关闭菜单', () => {
    renderToolbar();
    fireEvent.click(menuButton());
    expect(screen.getByText('orca.rolePill.workersHeader')).toBeTruthy();
    fireEvent.click(menuButton());
    expect(screen.queryByText('orca.rolePill.workersHeader')).toBeNull();
  });

  it('hover 临时展开后点击可固定，移出不再关闭', () => {
    renderToolbar();
    const wrapper = wrapperOf(menuButton());
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS);
    });
    fireEvent.click(menuButton());
    fireEvent.mouseLeave(wrapper);
    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 2);
    });
    expect(screen.getByText('orca.rolePill.workersHeader')).toBeTruthy();
  });

  it('点击外部区域关闭菜单', () => {
    renderToolbar();
    fireEvent.click(menuButton());
    expect(screen.getByText('orca.rolePill.workersHeader')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('orca.rolePill.workersHeader')).toBeNull();
  });

  it('按 Escape 关闭菜单', () => {
    renderToolbar();
    fireEvent.click(menuButton());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('orca.rolePill.workersHeader')).toBeNull();
  });

  it('选择布局选项后关闭菜单', () => {
    renderToolbar();
    fireEvent.click(menuButton());
    fireEvent.click(screen.getByRole('button', { name: 'orca.rolePill.layoutDropdown' }));
    expect(screen.queryByText('orca.rolePill.workersHeader')).toBeNull();
  });
});

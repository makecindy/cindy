// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkerInfo } from '../hooks/useWorkers';
import { RolePillDropdown, WorkerListToolbar } from '../RolePillDropdown';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useAppShortcut', () => ({
  useAppShortcutDisplay: () => '',
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => false) }),
}));

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

describe('RolePillDropdown collaboration settings entry', () => {
  afterEach(() => {
    cleanup();
  });

  it('does not show settings link in the dropdown (moved to + button)', () => {
    const current = worker();

    render(
      <RolePillDropdown
        worker={current}
        workers={[current]}
        selectedWorkerId={current.workerId}
        activeWorkerCount={5}
        onSwitchFocus={vi.fn()}
        onArchiveWorker={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /developer/ }));

    // 设置链接已从下拉菜单中移除
    expect(screen.queryByText('orca.rolePill.settingsCollaboration')).toBeNull();
  });

  it('keeps create worker available after the last worker is archived', () => {
    const onOpenCreate = vi.fn();
    render(
      <WorkerListToolbar
        worker={null}
        workers={[]}
        selectedWorkerId={null}
        activeWorkerCount={0}
        softLimit={5}
        hardLimit={8}
        onSwitchFocus={vi.fn()}
        onOpenCreate={onOpenCreate}
        onOpenSettings={vi.fn()}
        onArchiveWorker={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'orca.rolePill.createWorker' }));
    expect(onOpenCreate).toHaveBeenCalledTimes(1);
  });

  it('routes the + button to collaboration settings when at the hard limit', () => {
    const onOpenCreate = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <WorkerListToolbar
        worker={null}
        workers={[]}
        selectedWorkerId={null}
        activeWorkerCount={8}
        softLimit={5}
        hardLimit={8}
        onSwitchFocus={vi.fn()}
        onOpenCreate={onOpenCreate}
        onOpenSettings={onOpenSettings}
        onArchiveWorker={vi.fn()}
      />,
    );

    // 硬上限下 + 按钮不再 disabled no-op，而是以「设置 · 协同」为可访问名、点击跳转设置。
    fireEvent.click(screen.getByRole('button', { name: 'orca.rolePill.settingsCollaboration' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenCreate).not.toHaveBeenCalled();
  });

  it('keeps the + button disabled at hard limit when settings navigation is unavailable (detached sidebar)', () => {
    const onOpenCreate = vi.fn();
    render(
      <WorkerListToolbar
        worker={null}
        workers={[]}
        selectedWorkerId={null}
        activeWorkerCount={8}
        softLimit={5}
        hardLimit={8}
        onSwitchFocus={vi.fn()}
        onOpenCreate={onOpenCreate}
        // onOpenSettings 省略 → 分离侧栏窗口无法导航到设置路由。
        onArchiveWorker={vi.fn()}
      />,
    );

    // 无设置跳转入口时，硬上限 + 按钮回退为 disabled no-op：不再是「设置 · 协同」，也不触发新建。
    const button = screen.getByRole('button', { name: 'orca.rolePill.createWorker' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(onOpenCreate).not.toHaveBeenCalled();
  });
});

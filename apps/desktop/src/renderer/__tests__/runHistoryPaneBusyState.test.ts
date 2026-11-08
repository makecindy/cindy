// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Schedule } from '@cindy/maker-scheduler';
import { RunHistoryPane } from '@/features/scheduler/components/RunHistoryPane';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/hooks/useCCSessions', () => ({
  useCCSessions: () => ({ sessions: [] }),
}));

// This test covers run-now isolation between schedules; the Webhook panel has
// separate component coverage and must not initialize account/chat stores here.
vi.mock('@/features/scheduler/components/WebhookTriggerPanel', () => ({
  WebhookTriggerPanel: () => null,
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({
    confirm: vi.fn(async () => true),
  }),
}));

vi.mock('@/lib/sessionAttentionStore', () => ({
  clearSessionAttentionMany: vi.fn(),
}));

vi.mock('@/features/scheduler/hooks/useRuns', () => ({
  useRuns: (scheduleId: string) => ({
    runs: [],
    runsScheduleId: scheduleId,
    hasLoaded: true,
    error: null,
  }),
}));

vi.mock('@/components/ui/dropdown-menu', async () => {
  const React = await import('react');
  const passthrough = ({ children }: { children: ReactNode }) =>
    React.createElement(React.Fragment, null, children);

  return {
    DropdownMenu: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuSeparator: () => React.createElement('hr'),
    DropdownMenuItem: ({
      children,
      disabled,
      onSelect,
    }: {
      children: ReactNode;
      disabled?: boolean;
      onSelect?: () => void;
    }) =>
      React.createElement(
        'button',
        {
          type: 'button',
          disabled,
          onClick: () => onSelect?.(),
        },
        children,
      ),
  };
});

function makeSchedule(id: string): Schedule {
  return {
    id,
    name: `Schedule ${id}`,
    prompt: 'Run',
    kind: 'cron',
    cronExpr: '0 9 * * *',
    timezone: 'UTC',
    recurring: true,
    manual: false,
    agentKind: 'codex',
    model: 'gpt-5',
    effort: 'medium',
    workspaceKind: 'project',
    workingDir: '/repo',
    useWorktree: false,
    persistentSession: false,
    notify: { desktop: false, feishu: false },
    silentWhenIdle: false,
    source: 'user',
    status: 'active',
    nextFireAt: Date.parse('2026-01-02T09:00:00.000Z'),
    createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
    updatedAt: Date.parse('2026-01-01T00:00:00.000Z'),
  };
}

function renderPane(
  schedule: Schedule,
  onRunNow: (schedule: Schedule) => Promise<void>,
  runNowBusy = false,
) {
  const noop = vi.fn();
  return createElement(RunHistoryPane, {
    schedule,
    onRunNow,
    onTogglePause: noop,
    onEdit: noop,
    onDelete: noop,
    runNowBusy,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('RunHistoryPane busy state', () => {
  it('does not disable another schedule while a different run-now action is pending', () => {
    const onRunNow = vi.fn();

    // schedule-a has a run-now in flight (runNowBusy=true comes from SchedulerPage's useRunNowBusyGuard)
    const view = render(renderPane(makeSchedule('schedule-a'), onRunNow, true));

    expect(
      (screen.getByRole('button', { name: 'scheduler.button.runNow' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // Switch to schedule-b — parent passes runNowBusy=false because schedule-b has no pending run-now
    view.rerender(renderPane(makeSchedule('schedule-b'), onRunNow, false));

    expect(
      (screen.getByRole('button', { name: 'scheduler.button.runNow' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

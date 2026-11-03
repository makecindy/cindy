// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Schedule, ScheduleRun } from '@cindy/maker-scheduler';
import type { SessionReference } from '../../../../../shared/sessionReference';

import { prefillErrorDiagnosisDraft } from '@/lib/errorDiagnosisPrompt';
import { RunHistoryCard } from '../RunHistoryCard';
import { RunHistoryPane } from '../RunHistoryPane';

const history = vi.hoisted(() => ({
  runs: [] as ScheduleRun[],
  runsScheduleId: 'schedule-a',
}));
vi.mock('../../hooks/useRuns', () => ({
  useRuns: () => ({ ...history, hasLoaded: true, loading: false, error: null }),
}));
vi.mock('../../hooks/useSessionReferences', () => ({
  useSessionReferences: () => new Map(),
}));
vi.mock('@/hooks/useCCSessions', () => ({
  useCCSessions: () => ({ sessions: [] }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));
vi.mock('@/lib/sessionAttentionStore', () => ({
  clearSessionAttentionMany: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { exists: () => true } }),
}));

vi.mock('@/lib/errorDiagnosisPrompt', () => ({
  buildErrorDiagnosisPrompt: (_t: unknown, url: string | null, source: { details: string }) => `${url ?? 'no session'}\n${source.details}`,
  prefillErrorDiagnosisDraft: vi.fn(),
}));
afterEach(cleanup);

function renderRun(run: ScheduleRun, sessionReference?: SessionReference) {
  return render(
    <MemoryRouter>
      <RunHistoryCard run={run} agentKind="codex" sessionReference={sessionReference} />
    </MemoryRouter>,
  );
}

describe('RunHistoryPane diagnosis ownership', () => {
  const actions = { onRunNow: vi.fn(), onTogglePause: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() };
  const schedule = (id: string, targetSessionId: string) => ({
    id, targetSessionId, name: id, status: 'active', agentKind: 'codex',
    manual: true, workspaceKind: 'dialogue', source: 'user',
  }) as Schedule;
  const pane = (value: Schedule) => (
    <MemoryRouter><RunHistoryPane schedule={value} {...actions} /></MemoryRouter>
  );

  it.each([undefined, 'recorded-task'])(
    'keeps retained run identity when switching schedules (recorded task: %s)',
    (sessionId) => {
      history.runsScheduleId = 'schedule-a';
      history.runs = [{
        id: 'run-a', scheduleId: 'schedule-a', sessionId, status: 'failed',
        firedAt: 1, finishedAt: 2, readAt: 2, errorMsg: 'failure from A',
      }];
      const { rerender } = render(pane(schedule('schedule-a', 'target-a')));
      // useRuns keeps A's rows visible while B's request is pending.
      rerender(pane(schedule('schedule-b', 'target-b')));
      fireEvent.click(screen.getByText('chat.errorBanner.networkShowRaw'));
      fireEvent.click(screen.getByText('chat.errorBanner.diagnose'));
      const prompt = vi.mocked(prefillErrorDiagnosisDraft).mock.calls.at(-1)![0];
      expect(prompt).toContain('scheduleId: schedule-a\nrunId: run-a');
      expect(prompt).not.toContain('target-b');
      expect(prompt).toContain(sessionId ?? 'no session');
    },
  );

  it('does not assign a later target to a run that never recorded a task', () => {
    history.runsScheduleId = 'schedule-a';
    history.runs = [{
      id: 'early-run', scheduleId: 'schedule-a', status: 'failed',
      firedAt: 1, finishedAt: 2, readAt: 2, errorMsg: 'early failure',
    }];
    render(pane(schedule('schedule-a', 'later-target')));
    fireEvent.click(screen.getByText('chat.errorBanner.networkShowRaw'));
    fireEvent.click(screen.getByText('chat.errorBanner.diagnose'));
    expect(prefillErrorDiagnosisDraft).toHaveBeenLastCalledWith(
      expect.stringContaining('no session\nscheduleId: schedule-a\nrunId: early-run'),
    );
  });
});

describe('RunHistoryCard 会话引用状态', () => {
  it('保留历史记录但将软删除会话显示为不可点击状态', () => {
    renderRun(
      {
        id: 'run-deleted-session',
        scheduleId: 'schedule-1',
        sessionId: 'session-deleted',
        firedAt: 1,
        finishedAt: 11,
        status: 'success',
        readAt: 11,
      },
      {
        sessionId: 'session-deleted',
        state: 'deleted',
        status: 'deleted',
        title: 'Deleted session',
        agentKind: 'codex',
      },
    );

    expect(screen.getByText('scheduler.runs.sessionDeleted')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'scheduler.runs.openSession' })).toBeNull();
  });
});

describe('RunHistoryCard 前置检查结果', () => {
  // A failed model selection is persisted in errorMsg, not an agent message.
  // Verify this separate consumer also hides technical text behind details.
  it('shows switch guidance with expandable diagnostics in failed run history', () => {
    renderRun({ id: 'run-selection', scheduleId: 'schedule-1', firedAt: 1,
      finishedAt: 2, status: 'failed', readAt: 2,
      errorMsg: '[MODEL_SELECTION_UNAVAILABLE] Scheduled model test is unavailable' });
    expect(screen.getByText('chat.remoteError.MODEL_SELECTION_UNAVAILABLE')).toBeTruthy();
    expect(screen.queryByText(/Scheduled model test/)).toBeNull();
    fireEvent.click(screen.getByText('chat.errorBanner.networkShowRaw'));
    expect(screen.getByText(/Scheduled model test/)).toBeTruthy();
  });
  it('diagnoses an execution failure before a task was created without fabricating a link', () => {
    renderRun({ id: 'early-run', scheduleId: 'schedule-1', firedAt: 1,
      finishedAt: 2, status: 'failed', errorMsg: 'provider mismatch' });
    expect(screen.queryByText('provider mismatch')).toBeNull();
    fireEvent.click(screen.getByText('chat.errorBanner.networkShowRaw'));
    fireEvent.click(screen.getByText('chat.errorBanner.diagnose'));
    expect(prefillErrorDiagnosisDraft).toHaveBeenLastCalledWith(expect.stringContaining('no session\nscheduleId: schedule-1\nrunId: early-run'));
  });
  it('通过结果显示摘要且默认折叠', () => {
    const { container } = renderRun({
      id: 'run-passed',
      scheduleId: 'schedule-1',
      firedAt: 1,
      finishedAt: 11,
      status: 'success',
      readAt: 11,
      preRunHookResult: {
        status: 'passed',
        decision: 'run',
        exitCode: 0,
        durationMs: 10,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        aborted: false,
      },
    });

    expect(screen.getByText(/scheduler\.runs\.preRun\.status\.passed/)).toBeTruthy();
    expect(container.querySelector('details')?.open).toBe(false);
  });

  it('失败结果默认展开并展示错误、stdout、stderr 与截断提示', () => {
    const { container } = renderRun({
      id: 'run-failed',
      scheduleId: 'schedule-1',
      firedAt: 1,
      finishedAt: 11,
      status: 'failed',
      errorMsg: 'pre-run hook failed',
      readAt: 11,
      preRunHookResult: {
        status: 'failed',
        decision: 'block',
        exitCode: 1,
        durationMs: 10,
        stdout: 'captured stdout',
        stderr: 'captured stderr',
        stdoutTruncated: true,
        stderrTruncated: false,
        timedOut: false,
        aborted: false,
        error: 'command failed',
      },
    });

    expect(container.querySelector('details')?.open).toBe(true);
    expect(screen.getByText('command failed')).toBeTruthy();
    expect(screen.getByText('captured stdout')).toBeTruthy();
    expect(screen.getByText('captured stderr')).toBeTruthy();
    expect(screen.getByText(/scheduler\.runs\.preRun\.truncated/)).toBeTruthy();
  });
});

describe('RunHistoryCard 费用展示', () => {
  it('有真实费用时只显示费用，不同时显示估算价值或 Token', () => {
    renderRun({
      id: 'run-priced',
      scheduleId: 'schedule-1',
      firedAt: 1,
      finishedAt: 11,
      status: 'success',
      costAttribution: 'exact',
      costUsd: 0.12,
      estimatedValueUsd: 0.2,
      totalTokens: 12_400,
    });

    expect(screen.getByText('scheduler.runs.runCost')).toBeTruthy();
    expect(screen.queryByText('scheduler.runs.runValue')).toBeNull();
    expect(screen.queryByText('scheduler.runs.runTokens')).toBeNull();
  });

  it('只有估算价值时改为显示 Token 用量', () => {
    renderRun({
      id: 'run-estimate-only',
      scheduleId: 'schedule-1',
      firedAt: 1,
      finishedAt: 11,
      status: 'success',
      costAttribution: 'exact',
      estimatedValueUsd: 0.2,
      totalTokens: 12_400,
    });

    expect(screen.getByText('scheduler.runs.runTokens')).toBeTruthy();
    expect(screen.queryByText('scheduler.runs.runCost')).toBeNull();
    expect(screen.queryByText('scheduler.runs.runValue')).toBeNull();
  });

  it('不可可靠计价但有 Token 事实时显示 Token 用量', () => {
    renderRun({
      id: 'run-unavailable-token-usage',
      scheduleId: 'schedule-1',
      firedAt: 1,
      finishedAt: 11,
      status: 'success',
      costAttribution: 'unavailable',
      totalTokens: 8_000,
    });

    expect(screen.getByText('scheduler.runs.runTokens')).toBeTruthy();
    expect(screen.queryByText('scheduler.runs.costUnavailable')).toBeNull();
  });

  it('不可可靠计价时不显示假 $0.00', () => {
    renderRun({
      id: 'run-unavailable-cost',
      scheduleId: 'schedule-1',
      firedAt: 1,
      finishedAt: 11,
      status: 'success',
      costAttribution: 'unavailable',
    });

    expect(screen.getByText('scheduler.runs.costUnavailable')).toBeTruthy();
    expect(screen.queryByText(/scheduler\.runs\.runCost/)).toBeNull();
  });

  it('已确认真实零费用时显示 $0.00', () => {
    renderRun({
      id: 'run-zero-cost',
      scheduleId: 'schedule-1',
      firedAt: 1,
      finishedAt: 11,
      status: 'success',
      costAttribution: 'zero',
      costUsd: 0,
      estimatedValueUsd: 0,
    });

    expect(screen.getByText('scheduler.runs.runCost')).toBeTruthy();
  });
});

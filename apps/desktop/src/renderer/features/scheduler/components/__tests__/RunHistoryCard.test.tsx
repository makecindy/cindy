// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleRun } from '@cindy/maker-scheduler';
import type { SessionReference } from '../../../../../shared/sessionReference';

import { RunHistoryCard } from '../RunHistoryCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

function renderRun(run: ScheduleRun, sessionReference?: SessionReference) {
  return render(
    <MemoryRouter>
      <RunHistoryCard run={run} agentKind="codex" sessionReference={sessionReference} />
    </MemoryRouter>,
  );
}

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

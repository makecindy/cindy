// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Schedule } from '@cindy/maker-scheduler';

import { TaskListCell } from '../TaskListCell';

// t 直接回传 key,断言用 i18n key 即可。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const schedule: Schedule = {
  id: 's1',
  name: 'My task',
  prompt: 'do something',
  kind: 'cron',
  cronExpr: '0 9 * * *',
  timezone: 'Asia/Shanghai',
  recurring: true,
  manual: false,
  agentKind: 'claude-code',
  workspaceKind: 'dialogue',
  useWorktree: false,
  notify: { desktop: false, feishu: false },
  status: 'active',
  createdAt: 0,
  updatedAt: 0,
};

afterEach(cleanup);

describe('TaskListCell 立即运行按钮', () => {
  it('点运行的同时选中该任务(打开其运行历史)并 fire runNow', () => {
    const onSelect = vi.fn();
    const onRunNow = vi.fn();
    render(
      createElement(TaskListCell, {
        schedule,
        selected: false,
        onSelect,
        onRunNow,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'scheduler.button.runNow' }));

    // 关键:选中动作必须一并触发(此前 stopPropagation 会吞掉它)。
    expect(onSelect).toHaveBeenCalledWith(schedule);
    expect(onRunNow).toHaveBeenCalledWith(schedule);
  });

  it('runBusy 时按钮 disabled 且不会再 fire runNow(防双发守卫仍在)', () => {
    const onSelect = vi.fn();
    const onRunNow = vi.fn();
    render(
      createElement(TaskListCell, {
        schedule,
        selected: false,
        onSelect,
        onRunNow,
        runBusy: true,
      }),
    );

    const btn = screen.getByRole('button', {
      name: 'scheduler.button.runNow',
    }) as HTMLButtonElement;
    // 真实浏览器 disabled 按钮不产生 click;这里断言 disabled 本身(环境无关),
    // 并确认按钮自身的 runBusy 守卫不会再触发 runNow。
    expect(btn.disabled).toBe(true);

    fireEvent.click(btn);
    expect(onRunNow).not.toHaveBeenCalled();
  });
});

describe('TaskListCell 并发等待提示', () => {
  it('仅在运行时快照明确标记等待时替换过期的 Next 文案', () => {
    render(
      createElement(TaskListCell, {
        schedule: { ...schedule, nextFireAt: Date.now() - 60_000 },
        selected: false,
        onSelect: vi.fn(),
        waitingForResources: { inFlight: 4, maxConcurrentRuns: 4 },
      }),
    );

    expect(screen.getByText('scheduler.cell.subtitleWaitingForResources')).toBeTruthy();
    expect(screen.queryByText(/Next less than 1 min/)).toBeNull();
  });
});

describe('TaskListCell 费用展示', () => {
  it('无汇总时不伪造 $0.00', () => {
    render(
      createElement(TaskListCell, {
        schedule,
        selected: false,
        onSelect: vi.fn(),
      }),
    );

    expect(screen.queryByText('scheduler.cell.totalCost')).toBeNull();
  });

  it('不可可靠计价时显示费用不可用', () => {
    render(
      createElement(TaskListCell, {
        schedule,
        selected: false,
        onSelect: vi.fn(),
        totalCostUsd: 0,
        hasUnavailableCost: true,
      }),
    );

    expect(screen.getByText('scheduler.cell.costUnavailable')).toBeTruthy();
    expect(screen.queryByText('scheduler.cell.totalCost')).toBeNull();
  });

  it('已确认真实零费用时仍显示 $0.00', () => {
    render(
      createElement(TaskListCell, {
        schedule,
        selected: false,
        onSelect: vi.fn(),
        totalCostUsd: 0,
        hasUnavailableCost: false,
      }),
    );

    expect(screen.getByText('scheduler.cell.totalCost')).toBeTruthy();
  });
});

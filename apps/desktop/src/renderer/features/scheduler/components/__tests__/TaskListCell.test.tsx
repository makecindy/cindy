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

  it('排队等对话空闲优先于「等执行资源」:这一轮已经触发过了', () => {
    render(
      createElement(TaskListCell, {
        schedule: { ...schedule, nextFireAt: Date.now() - 60_000 },
        selected: false,
        onSelect: vi.fn(),
        // 引擎会把排队 run 从闸门里摘出去,理论上两者不同时出现;这里同时给，
        // 断言优先级不会退化成显示"还没抢到槽"。
        waitingForResources: { inFlight: 1, maxConcurrentRuns: 8 },
        queuedForSession: true,
      }),
    );

    expect(screen.getByText('scheduler.cell.subtitleQueuedForSession')).toBeTruthy();
    expect(screen.queryByText('scheduler.cell.subtitleWaitingForResources')).toBeNull();
  });

  // 依据：绑定任务因目标任务长时忙碌连续顺延且未占队列/槽位时，列表副标题应可见顺延态而非假装正常等待；
  // 既有测试只覆盖 queuedForSession 与 waitingForResources；
  // 最小失败输入：active 调度带 deferredForSession={count:3} 时渲染顺延副标题，paused 或排队时让位。tier: unit。
  it('连续顺延时在活跃态展示顺延副标题，排队或暂停时按优先级让位', () => {
    const { rerender } = render(
      createElement(TaskListCell, {
        schedule: { ...schedule, nextFireAt: Date.now() + 60_000 },
        selected: false,
        onSelect: vi.fn(),
        deferredForSession: { count: 3, firstAt: Date.now() - 600_000, lastReason: 'session-running' },
      }),
    );

    expect(screen.getByText('scheduler.cell.subtitleDeferredForSession')).toBeTruthy();

    rerender(
      createElement(TaskListCell, {
        schedule: { ...schedule, status: 'paused' },
        selected: false,
        onSelect: vi.fn(),
        deferredForSession: { count: 3, firstAt: Date.now() - 600_000 },
      }),
    );
    expect(screen.getByText('scheduler.cell.subtitlePaused')).toBeTruthy();
    expect(screen.queryByText('scheduler.cell.subtitleDeferredForSession')).toBeNull();
  });
});

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
});

// 测试价值：
// - 防退化点：暂停治理引入 pausedUntil / pauseReason 后，列表项副标题需按「定时恢复 > 暂停原因 > 普通暂停」优先级展示，避免用户在列表中看不到定时恢复或暂停原因。
// - 触发条件：分别渲染带未来 pausedUntil、仅带 pauseReason、以及无元数据的 paused schedule。
// - 生产入口与可观察结果：TaskListCell 组件渲染的副标题文案 key。
// - 依赖策略：纯 jsdom 渲染与 mock i18n t 函数，零网络或真实定时器。
// - 对应规则或根因：暂停治理 UI 可见性。
describe('TaskListCell 暂停治理副标题', () => {
  it('优先展示定时自动恢复，其次展示暂停原因，缺省回落普通已暂停', () => {
    const { rerender } = render(
      createElement(TaskListCell, {
        schedule: {
          ...schedule,
          status: 'paused',
          pausedUntil: Date.now() + 30 * 60_000,
          pauseReason: 'rate limit',
        },
        selected: false,
        onSelect: vi.fn(),
      }),
    );
    expect(screen.getByText('scheduler.cell.subtitlePausedUntil')).toBeTruthy();

    rerender(
      createElement(TaskListCell, {
        schedule: {
          ...schedule,
          status: 'paused',
          pauseReason: 'awaiting maintainer',
        },
        selected: false,
        onSelect: vi.fn(),
      }),
    );
    expect(screen.getByText('scheduler.cell.subtitlePausedWithReason')).toBeTruthy();

    rerender(
      createElement(TaskListCell, {
        schedule: { ...schedule, status: 'paused' },
        selected: false,
        onSelect: vi.fn(),
      }),
    );
    expect(screen.getByText('scheduler.cell.subtitlePaused')).toBeTruthy();
  });
});

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/makerChatStore';

import { PinnedPlanPanel } from '../PinnedPlanPanel';

vi.mock('@/components/chat/TodoListCard', () => ({
  TodoListCard: ({
    todos,
    onDismiss,
  }: {
    todos: Array<{ content: string }>;
    onDismiss?: () => void;
  }) => (
    <div>
      <div data-testid="plan-pill">{todos.map((todo) => todo.content).join(',')}</div>
      {onDismiss && (
        <button type="button" onClick={onDismiss}>
          Dismiss Plan
        </button>
      )}
    </div>
  ),
}));

const T0 = 1_700_000_000_000;

function planMessage(
  status: 'pending' | 'in_progress' | 'completed',
  createdAtMs: number | null = T0,
  planUpdatedAtMs?: number,
  stepCount = 2,
): ChatMessage {
  const plan = Array.from({ length: stepCount }, (_, index) => ({
    step: index === 0 ? 'Finish work' : `Follow-up ${index}`,
    status:
      status === 'completed' ? ('completed' as const) : index === 0 ? status : ('pending' as const),
  }));

  return {
    clientId: 'plan-1',
    role: 'tool_use',
    content: '',
    toolName: 'update_plan',
    toolUseId: 'plan:turn-1',
    toolInput: { plan },
    ...(createdAtMs === null ? {} : { createdAt: new Date(createdAtMs).toISOString() }),
    ...(planUpdatedAtMs === undefined ? {} : { planUpdatedAtMs }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PinnedPlanPanel completed plan lifetime', () => {
  it('does not show a progress pill for a single-step plan', () => {
    render(
      <PinnedPlanPanel
        sessionId="single-step"
        messages={[planMessage('in_progress', T0, undefined, 1)]}
        animated
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('does not show a Task plan while older messages may contain earlier steps', () => {
    const messages: ChatMessage[] = [
      {
        clientId: 'task-2',
        role: 'tool_use',
        content: '',
        toolName: 'TaskCreate',
        toolUseId: 'create-2',
        toolInput: { subject: 'Fix renderer' },
      },
      {
        clientId: 'result-2',
        role: 'tool_result',
        content: 'Task #2 created successfully: Fix renderer',
        toolUseId: 'create-2',
      },
      {
        clientId: 'task-3',
        role: 'tool_use',
        content: '',
        toolName: 'TaskCreate',
        toolUseId: 'create-3',
        toolInput: { subject: 'Run tests' },
      },
      {
        clientId: 'result-3',
        role: 'tool_result',
        content: 'Task #3 created successfully: Run tests',
        toolUseId: 'create-3',
      },
    ];

    const view = render(
      <PinnedPlanPanel
        sessionId="partial-task-plan"
        messages={messages}
        animated
        width={400}
        taskHistoryMayBeIncomplete
      />,
    );
    expect(screen.queryByTestId('plan-pill')).toBeNull();

    view.rerender(
      <PinnedPlanPanel
        sessionId="partial-task-plan"
        messages={messages}
        animated
        width={400}
        taskHistoryMayBeIncomplete={false}
      />,
    );
    expect(screen.getByTestId('plan-pill').textContent).toBe('Fix renderer,Run tests');
  });

  it('keeps a completed plan visible for 2 seconds, then hides it', () => {
    render(
      <PinnedPlanPanel
        sessionId="completed-lifetime"
        messages={[planMessage('completed')]}
        animated={false}
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1_999));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('does not hide a plan that is still running', () => {
    render(
      <PinnedPlanPanel
        sessionId="running-plan"
        messages={[planMessage('in_progress')]}
        animated
        width={400}
      />,
    );

    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
  });

  it('keeps the current plan snapshot hidden after the user dismisses it', () => {
    const running = planMessage('in_progress');
    const view = render(
      <PinnedPlanPanel sessionId="manual-dismiss" messages={[running]} animated width={400} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Plan' }));
    expect(screen.queryByTestId('plan-pill')).toBeNull();

    view.rerender(
      <PinnedPlanPanel
        sessionId="manual-dismiss"
        messages={[
          running,
          {
            clientId: 'unrelated-answer',
            role: 'assistant',
            content: 'Unrelated response',
          },
        ]}
        animated={false}
        width={400}
      />,
    );
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('shows a dismissed plan again when the agent reports a newer snapshot', () => {
    const running = planMessage('in_progress');
    const view = render(
      <PinnedPlanPanel sessionId="dismiss-update" messages={[running]} animated width={400} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Plan' }));
    expect(screen.queryByTestId('plan-pill')).toBeNull();

    view.rerender(
      <PinnedPlanPanel
        sessionId="dismiss-update"
        messages={[planMessage('completed', T0, T0 + 1_000)]}
        animated={false}
        width={400}
      />,
    );
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
  });

  it('stays hidden after an interaction card temporarily hides the panel', () => {
    const completed = planMessage('completed');
    const view = render(
      <PinnedPlanPanel
        sessionId="interaction-hidden"
        messages={[completed]}
        animated={false}
        width={400}
        visible
      />,
    );

    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.queryByTestId('plan-pill')).toBeNull();

    view.rerender(
      <PinnedPlanPanel
        sessionId="interaction-hidden"
        messages={[completed]}
        animated={false}
        width={400}
        visible={false}
      />,
    );
    view.rerender(
      <PinnedPlanPanel
        sessionId="interaction-hidden"
        messages={[completed]}
        animated={false}
        width={400}
        visible
      />,
    );
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('starts a fresh 2-second wait when a running plan completes', () => {
    const running = planMessage('in_progress');
    const view = render(
      <PinnedPlanPanel sessionId="running-completes" messages={[running]} animated width={400} />,
    );

    act(() => vi.advanceTimersByTime(5_000));
    view.rerender(
      <PinnedPlanPanel
        sessionId="running-completes"
        messages={[planMessage('completed', T0, T0 + 5_000)]}
        animated={false}
        width={400}
      />,
    );
    act(() => vi.advanceTimersByTime(1_999));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('does not restart the completion lifetime after the session view remounts', () => {
    const completed = planMessage('completed');
    const view = render(
      <PinnedPlanPanel
        sessionId="session-remount"
        messages={[completed]}
        animated={false}
        width={400}
      />,
    );

    act(() => vi.advanceTimersByTime(1_000));
    view.unmount();

    render(
      <PinnedPlanPanel
        sessionId="session-remount"
        messages={[completed]}
        animated={false}
        width={400}
      />,
    );
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(999));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('plan-pill')).toBeNull();

    cleanup();
    render(
      <PinnedPlanPanel
        sessionId="session-remount"
        messages={[completed]}
        animated={false}
        width={400}
      />,
    );
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('keeps an already-expired historical completion hidden without retaining session state', () => {
    vi.setSystemTime(T0 + 10_000);

    render(
      <PinnedPlanPanel
        sessionId="historical-completion"
        messages={[planMessage('completed')]}
        animated={false}
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('keeps a legacy open Codex plan when its old completed seal is ambiguous', () => {
    vi.setSystemTime(T0 + 10_000);
    const completedAssistant: ChatMessage = {
      clientId: 'answer-1',
      role: 'assistant',
      content: 'Dev server is running.',
      createdAt: new Date(T0 + 1_000).toISOString(),
      turnCompleted: true,
    };

    render(
      <PinnedPlanPanel
        sessionId="legacy-open-plan"
        messages={[planMessage('in_progress'), completedAssistant]}
        animated={false}
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
  });

  it('falls back to a component-local lifetime when the completion timestamp is missing', () => {
    render(
      <PinnedPlanPanel
        sessionId="missing-completion-timestamp"
        messages={[planMessage('completed', null)]}
        animated={false}
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });
});

/**
 * 终态盖章。main 只在「这一轮成功收尾」时给该计划行盖 terminalPlanSnapshot;
 * 胶囊的退场只认这枚章,不看勾选状态——agent 收尾时没把每一步勾完是常态
 * (Codex 官方同样如实保留未勾项),要求"全勾完才退场"等于要求它撒谎。
 *
 * 反过来,中断、失败、断线自动续跑都不盖章,计划照旧挂着:任务还活着,用户
 * 正要接着指挥,这时候摘牌比不摘更糟。
 */
describe('PinnedPlanPanel terminal seal', () => {
  function sealedPlanMessage(planUpdatedAtMs?: number, stepCount = 2): ChatMessage {
    return {
      ...planMessage('in_progress', T0, planUpdatedAtMs, stepCount),
      terminalPlanSnapshot: true,
    };
  }

  it('does not cut short a running grace when a past-clock sealed row arrives', () => {
    // 执行端偏慢:本地已按实时 done 起了 2 秒缓冲,随后到达的落库行带过去的
    // 章时刻(算出的期限已过期)。取较晚者——缓冲不被远端时钟掐断。
    const view = render(
      <PinnedPlanPanel
        sessionId="slow-clock"
        messages={[{ ...planMessage('in_progress', T0), terminalPlanSnapshot: true }]}
        animated={false}
        width={400}
      />,
    );
    // 无 sealedAtMs → fallback 通道在本地起 2 秒缓冲。
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(500));

    // 持久化行到达:执行端时钟慢 10 分钟,章时刻在本地视角早已过期。
    view.rerender(
      <PinnedPlanPanel
        sessionId="slow-clock"
        messages={[
          {
            ...planMessage('in_progress', T0),
            terminalPlanSnapshot: true,
            terminalPlanAtMs: T0 - 10 * 60_000,
          },
        ]}
        animated={false}
        width={400}
      />,
    );

    // 本地缓冲还剩 1.5 秒:不得瞬间消失。
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1_499));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('clamps a future terminal seal timestamp to the local clock (device-link skew)', () => {
    // 章的时刻来自执行端时钟。被控场景下执行端偏快时,sealedAtMs 在本机看是
    // "未来"——不钳制的话胶囊会多挂整个偏差时长;钳到本地此刻后仍是标准 2 秒。
    const sealedInFuture: ChatMessage = {
      ...planMessage('in_progress', T0),
      terminalPlanSnapshot: true,
      terminalPlanAtMs: T0 + 10 * 60_000, // 执行端快 10 分钟
    };

    render(
      <PinnedPlanPanel
        sessionId="skewed-seal"
        messages={[sealedInFuture]}
        animated={false}
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('starts the grace period at the terminal seal, not when the plan was created', () => {
    // 真实复现:计划先展示了 4 秒,agent 才回答完成。若拿 createdAt 算 2 秒,
    // 章一到就已过期,用户会看到泡泡在收尾瞬间直接消失。
    vi.setSystemTime(T0 + 4_000);
    const sealedLater: ChatMessage = {
      ...planMessage('in_progress', T0),
      terminalPlanSnapshot: true,
      terminalPlanAtMs: T0 + 4_000,
    };

    render(
      <PinnedPlanPanel
        sessionId="late-seal"
        messages={[sealedLater]}
        animated={false}
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1_999));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('retires a sealed plan that still has open steps', () => {
    render(
      <PinnedPlanPanel
        sessionId="sealed-open-steps"
        messages={[sealedPlanMessage(T0)]}
        animated={false}
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1_999));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('keeps a sealed plan hidden when the task is reopened later', () => {
    vi.setSystemTime(T0 + 60_000);
    render(
      <PinnedPlanPanel
        sessionId="sealed-reopened"
        messages={[sealedPlanMessage()]}
        animated={false}
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).toBeNull();
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('keeps an unsealed plan visible while the turn is still open', () => {
    render(
      <PinnedPlanPanel
        sessionId="unsealed"
        messages={[planMessage('in_progress')]}
        animated
        width={400}
      />,
    );

    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
  });

  it('keeps the plan visible when the turn was interrupted instead of finished', () => {
    // main 对中断/失败的匹配 turn 只打 turnCompleted:false,不盖终态章。
    const interrupted: ChatMessage = {
      ...planMessage('in_progress'),
      turnCompleted: false,
    };

    render(
      <PinnedPlanPanel
        sessionId="interrupted-turn"
        messages={[interrupted]}
        animated={false}
        width={400}
      />,
    );

    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
  });

  it('shows the capsule again when a new plan update clears the seal', () => {
    const view = render(
      <PinnedPlanPanel
        sessionId="sealed-then-updated"
        messages={[sealedPlanMessage(T0)]}
        animated={false}
        width={400}
      />,
    );
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.queryByTestId('plan-pill')).toBeNull();

    // 新一轮真的更新了计划:store 把章清成 false,胶囊重新亮牌。
    view.rerender(
      <PinnedPlanPanel
        sessionId="sealed-then-updated"
        messages={[
          {
            ...planMessage('in_progress', T0, T0 + 5_000, 3),
            terminalPlanSnapshot: false,
          },
        ]}
        animated
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
  });

  it('does not retire an unsealed all-done codex plan while the turn is still streaming', () => {
    // 真实复现:Codex 在终态事件前就把全部步骤勾成 completed,随后最终回复流式
    // 超过 2 秒。若 allDone 兜底在等章期间抢跑,胶囊会先消失,章一到又带着新
    // sealedAtMs 复活 2 秒——消失再闪回。等章期间必须留在原地。
    const allDoneStreaming = planMessage('completed', T0, T0);
    const view = render(
      <PinnedPlanPanel
        sessionId="streaming-all-done"
        messages={[allDoneStreaming]}
        animated
        streaming
        width={400}
      />,
    );

    act(() => vi.advanceTimersByTime(4_000));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();

    // 章落地:退场计时从 sealedAtMs 起数,整个过程无中断、无闪回。
    vi.setSystemTime(T0 + 4_000);
    view.rerender(
      <PinnedPlanPanel
        sessionId="streaming-all-done"
        messages={[
          {
            ...allDoneStreaming,
            terminalPlanSnapshot: true,
            terminalPlanAtMs: T0 + 4_000,
          },
        ]}
        animated={false}
        streaming={false}
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1_999));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('keeps an all-done codex plan visible when its turn failed instead of sealing', () => {
    // Codex 把步骤全勾完后 turn 以中断/失败终态收场:host 按设计不盖章,只给该行
    // 盖 turnCompleted:false。此时流式已结束,但任务还活着——不得因为"非流式 +
    // 全勾完"就当旧数据兜底退场,否则用户正要接着指挥的计划被摘牌。
    const failedAllDone: ChatMessage = {
      ...planMessage('completed', T0, T0),
      turnCompleted: false,
    };

    render(
      <PinnedPlanPanel
        sessionId="failed-turn-all-done"
        messages={[failedAllDone]}
        animated={false}
        streaming={false}
        width={400}
      />,
    );

    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
  });

  it('still retires an all-done codex plan from old history data without a seal', () => {
    // 旧数据没有章(升级前落库),也永远不会再有:全勾完兜底照旧生效,
    // 否则旧会话的计划会永远挂在屏幕上。非流式 = 没有在等章的 turn。
    render(
      <PinnedPlanPanel
        sessionId="old-history-all-done"
        messages={[planMessage('completed', T0, T0)]}
        animated={false}
        streaming={false}
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('does not revive an old unsealed all-done plan when a later turn starts streaming', () => {
    const oldCompletedPlan = planMessage('completed', T0, T0);
    vi.setSystemTime(T0 + 10_000);
    const view = render(
      <PinnedPlanPanel
        sessionId="old-plan-new-turn"
        messages={[oldCompletedPlan]}
        animated={false}
        streaming={false}
        width={400}
      />,
    );
    expect(screen.queryByTestId('plan-pill')).toBeNull();

    view.rerender(
      <PinnedPlanPanel
        sessionId="old-plan-new-turn"
        messages={[
          oldCompletedPlan,
          {
            clientId: 'new-turn-user',
            role: 'user',
            content: 'Start the next turn',
            createdAt: new Date(T0 + 10_000).toISOString(),
            delivery: 'turn',
          },
        ]}
        animated
        streaming
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('keeps a current-turn unsealed all-done codex plan visible while streaming', () => {
    const currentPlan = planMessage('completed', T0, T0);
    render(
      <PinnedPlanPanel
        sessionId="current-plan-streaming"
        messages={[currentPlan]}
        animated
        streaming
        width={400}
      />,
    );

    act(() => vi.advanceTimersByTime(4_000));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
  });

  it('keeps the all-done fallback for TodoWrite plans even while streaming', () => {
    // TodoWrite / Task 计划永远不会被盖章,全勾完兜底是它们唯一的退场路径,
    // 流式与否都不该被"等章"逻辑挡住。
    const todoAllDone: ChatMessage = {
      clientId: 'todo-1',
      role: 'tool_use',
      content: '',
      toolName: 'TodoWrite',
      toolUseId: 'todo:turn-1',
      toolInput: {
        todos: [
          { content: 'Step 1', status: 'completed' },
          { content: 'Step 2', status: 'completed' },
        ],
      },
      createdAt: new Date(T0).toISOString(),
      planUpdatedAtMs: T0,
    };

    render(
      <PinnedPlanPanel
        sessionId="todo-streaming-all-done"
        messages={[todoAllDone]}
        animated
        streaming
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });
});

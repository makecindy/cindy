// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/makerChatStore';

import { PinnedPlanPanel } from '../PinnedPlanPanel';

vi.mock('@/components/chat/TodoListCard', () => ({
  TodoListCard: ({ todos }: { todos: Array<{ content: string }> }) => (
    <div data-testid="plan-pill">{todos.map((todo) => todo.content).join(',')}</div>
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

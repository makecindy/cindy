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

function planMessage(status: 'pending' | 'in_progress' | 'completed'): ChatMessage {
  return {
    clientId: 'plan-1',
    role: 'tool_use',
    content: '',
    toolName: 'update_plan',
    toolUseId: 'plan:turn-1',
    toolInput: { plan: [{ step: 'Finish work', status }] },
    createdAt: new Date(T0).toISOString(),
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
  it('keeps a completed plan visible for 2 seconds, then hides it', () => {
    render(<PinnedPlanPanel messages={[planMessage('completed')]} animated={false} width={400} />);

    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1_999));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('does not hide a plan that is still running', () => {
    render(<PinnedPlanPanel messages={[planMessage('in_progress')]} animated width={400} />);

    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
  });

  it('stays hidden after an interaction card temporarily hides the panel', () => {
    const completed = planMessage('completed');
    const view = render(
      <PinnedPlanPanel messages={[completed]} animated={false} width={400} visible />,
    );

    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.queryByTestId('plan-pill')).toBeNull();

    view.rerender(
      <PinnedPlanPanel messages={[completed]} animated={false} width={400} visible={false} />,
    );
    view.rerender(
      <PinnedPlanPanel messages={[completed]} animated={false} width={400} visible />,
    );
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('starts a fresh 2-second wait when a running plan completes', () => {
    const running = planMessage('in_progress');
    const view = render(<PinnedPlanPanel messages={[running]} animated width={400} />);

    act(() => vi.advanceTimersByTime(5_000));
    view.rerender(<PinnedPlanPanel messages={[planMessage('completed')]} animated={false} width={400} />);
    act(() => vi.advanceTimersByTime(1_999));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });
});

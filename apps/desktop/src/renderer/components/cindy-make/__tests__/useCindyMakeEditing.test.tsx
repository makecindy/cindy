// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ChatMessage } from '@/lib/makerChatStore';
import { getCindyMakeTestRecovery } from '@/lib/cindyMakeComposer';
import { useCindyMakeEditing } from '../useCindyMakeEditing';

afterEach(cleanup);
const completion: ChatMessage = {
  clientId: 'completion',
  role: 'assistant',
  content: '',
  systemCardType: 'cindy-make-complete',
  systemCardData: { reportedAt: 123, continuedAt: 456, commit: 'a'.repeat(40) },
};
const intent = { sessionId: 'task', completionId: completion.clientId };
function Visit({ messages, enabled = true }: { messages: ChatMessage[]; enabled?: boolean }) {
  const { dismissedId, continueEditing } = useCindyMakeEditing('task', enabled);
  const location = useLocation();
  const recovery = getCindyMakeTestRecovery({
    session: { id: 'task', source: 'cindy-make', status: 'active', clearedAt: null },
    messages,
    busy: false,
    historyLoaded: true,
  });
  return (
    <>
      <output data-testid="composer">input</output>
      <output data-testid="actions">{recovery}</output>
      <output data-testid="editing">{dismissedId}</output>
      <output data-testid="navigation">{JSON.stringify(location.state)}</output>
      <button onClick={() => continueEditing(recovery!)}>continue</button>
    </>
  );
}

it('consumes History continuation while keeping input and optional actions available', async () => {
  const view = (messages: ChatMessage[]) => (
    <MemoryRouter
      initialEntries={[
        {
          pathname: '/cc-agent/task',
          state: { cindyMakeEditing: intent, from: 'history' },
        },
      ]}
    >
      <Visit messages={messages} />
    </MemoryRouter>
  );
  const result = render(view([completion]));
  expect(screen.getByTestId('composer').textContent).toBe('input');
  await waitFor(() =>
    expect(screen.getByTestId('navigation').textContent).toBe('{"from":"history"}'),
  );
  const messages: ChatMessage[] = [
    completion,
    { clientId: 'request', role: 'user', content: 'edit again' },
    { clientId: 'next', role: 'assistant', content: 'Done', turnCompleted: true },
  ];
  result.rerender(view(messages));
  expect(screen.getByTestId('composer').textContent).toBe('input');
  expect(screen.getByTestId('actions').textContent).toBe('next');
  fireEvent.click(screen.getByText('continue'));
  expect(screen.getByTestId('composer').textContent).toBe('input');
  expect(screen.getByTestId('editing').textContent).toBe('next');
  // Reopening preserves input without needing a navigation intent.
  result.unmount();
  render(
    <MemoryRouter initialEntries={['/cc-agent/task']}>
      <Visit messages={[completion]} />
    </MemoryRouter>,
  );
  expect(screen.getByTestId('composer').textContent).toBe('input');
  expect(screen.getByTestId('actions').textContent).toBe('completion');
});

it.each([
  [{ ...intent, sessionId: 'another-task' }, true],
  [intent, false],
] as const)(
  'does not apply another task or remote/read-only editing intent',
  (cindyMakeEditing, enabled) => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/cc-agent/task',
            state: { cindyMakeEditing },
          },
        ]}
      >
        <Visit messages={[completion]} enabled={enabled} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('editing').textContent).toBe('');
  },
);

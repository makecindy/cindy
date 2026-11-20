// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as ReactI18next from 'react-i18next';
import { findErrorTailMessage } from '@/lib/errorTailMessage';
import { makerChatStore, remoteErrorMessageForBanner, type ChatMessage } from '@/lib/makerChatStore';
import type { Message } from '@/lib/ccAgent.types';
import { ErrorTailErrorBanner } from '../InterruptedTurnBanner';

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof ReactI18next>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: async () => true }),
}));
vi.mock('@/hooks/useCodexRuntimeRoute', () => ({
  useCodexRuntimeRoute: () => ({ authInjection: 'env-key' }),
}));

// #10744, unit/jsdom: existing banner tests start with an already selected error.
// Exercise real DB-row projection + tail selection + the recovery component for
// the missing input: user, reconnect timeout, agent_switch, with no assistant output.
const raw = 'The model connection has been retrying for 120s without making progress; the turn was interrupted automatically.';
function restoredRows(): ChatMessage[] {
  const row = (clientId: string, role: Message['role'], content: unknown, time: number): Message => ({
    id: clientId, clientId, sessionId: 'terminal-tail', role, content,
    createdAt: new Date(time).toISOString(),
  } as Message);
  return makerChatStore.__mapServerMessagesForTest([
    row('request', 'user', 'Check the project', 1000),
    row('timeout', 'error', { message: raw, reason: 'codex_reconnect_stalled' }, 2000),
    row('location', 'agent_switch', { fromAgentKind: 'codex', toAgentKind: 'codex', nativeHistory: 'restored' }, 3000),
  ]);
}

afterEach(cleanup);

describe('terminal error tail across noninteractive boundaries', () => {
  it('retains the timeout reason and working recovery controls after a location change', () => {
    const messages = restoredRows();
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', systemCardType: 'agent-switch' });
    const error = findErrorTailMessage(messages);
    expect(error?.clientId).toBe('timeout');
    const retry = vi.fn();
    const dismiss = vi.fn();
    render(<ErrorTailErrorBanner errorText={remoteErrorMessageForBanner(error!.content)}
      errorReason={error!.errorReason} agentKind="codex" onContinue={retry} onDismiss={dismiss} />);
    expect(screen.getByText('logic.errors.upstreamResponseIdleTimeout')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'chat.errorBanner.retry' }));
    expect(retry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'chat.errorBanner.cancelTitle' }));
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it.each(['agent-switch', 'context-rebuild', 'session-import', 'compact'] as const)(
    'preserves an unresolved failure through a %s record', systemCardType => {
      const messages = restoredRows();
      expect(findErrorTailMessage([...messages, { clientId: 'boundary', role: 'assistant', content: '', systemCardType }])?.clientId).toBe('timeout');
    },
  );

  it.each([
    { clientId: 'next-user', role: 'user', content: 'Try another approach' },
    { clientId: 'next-assistant', role: 'assistant', content: 'Here is the result' },
    { clientId: 'next-tool', role: 'tool_use', content: 'Read' },
    { clientId: 'retry', role: 'user', content: 'Continue', isSyntheticTrigger: true },
    { clientId: 'interactive', role: 'assistant', content: '', systemCardType: 'bot-authorization' },
  ] satisfies ChatMessage[])('does not resurrect an error past later progress: $clientId', progress => {
    const messages = restoredRows();
    expect(findErrorTailMessage([...messages, progress, messages.at(-1)!])).toBeNull();
  });

  it('does not scan past dismissed or disposed failures to revive an older error', () => {
    const messages = restoredRows();
    const earlier = { ...messages[1]!, clientId: 'earlier' };
    const dismissed = messages.map(message => message.role === 'error' ? { ...message, errorDismissed: true } : message);
    expect(findErrorTailMessage([earlier, ...dismissed])).toBeNull();
    expect(findErrorTailMessage([earlier, ...messages], 'timeout')).toBeNull();
  });
});

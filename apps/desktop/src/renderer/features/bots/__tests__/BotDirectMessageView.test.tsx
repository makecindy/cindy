// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BotDirectMessageView } from '../BotDirectMessageView';

const mocks = vi.hoisted(() => ({
  getThread: vi.fn(),
  navigate: vi.fn(),
  registerHeader: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));
vi.mock('react-router-dom', () => ({
  useLocation: () => ({
    state: { botDirectMessageReturnTo: '/bots/bot-a/session/a-main' },
  }),
  useNavigate: () => mocks.navigate,
  useParams: () => ({ botId: 'bot-a', threadId: 'dm-1' }),
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => 1,
  isDataOwnerGenerationCurrent: () => true,
  isDataOwnerPushCurrent: () => true,
}));
vi.mock('../../feature-context', () => ({
  useRegisterContentHeader: (node: unknown) => mocks.registerHeader(node),
}));
vi.mock('../botStore', () => ({
  useBotProfiles: () => [
    { id: 'bot-a', name: 'Cindy', avatar: '', avatarColor: 'red' },
    { id: 'bot-b', name: 'Planner', avatar: '', avatarColor: 'blue' },
  ],
}));
vi.mock('../BotAvatar', () => ({
  BotAvatar: ({ bot }: { bot: { name: string } }) => <span data-avatar={bot.name} />,
}));

beforeEach(() => {
  mocks.navigate.mockClear();
  mocks.registerHeader.mockClear();
  mocks.getThread.mockReset();
  mocks.getThread.mockResolvedValue({
    ok: true,
    thread: {
      id: 'dm-1',
      botAId: 'bot-a',
      botAName: 'Cindy',
      botBId: 'bot-b',
      botBName: 'Planner',
      status: 'closed',
      closeReason: 'message-limit',
      messageCount: 2,
      maxMessages: 12,
      createdAt: 1,
      updatedAt: 2,
      closedAt: 2,
      messages: [
        {
          id: 'message-1',
          sequence: 1,
          senderBotId: 'bot-a',
          senderBotName: 'Cindy',
          recipientBotId: 'bot-b',
          recipientBotName: 'Planner',
          content: 'Can you check this?',
          createdAt: 1,
        },
        {
          id: 'message-2',
          sequence: 2,
          senderBotId: 'bot-b',
          senderBotName: 'Planner',
          recipientBotId: 'bot-a',
          recipientBotName: 'Cindy',
          content: 'Checked.',
          createdAt: 2,
        },
      ],
    },
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: {
        getBotDirectMessageThread: (...args: unknown[]) => mocks.getThread(...args),
        onBotDirectMessageChanged: () => () => undefined,
      },
    },
  });
});

afterEach(cleanup);

describe('BotDirectMessageView', () => {
  it('shows both sides read-only, renders the hard-limit ending, and returns to the source timeline', async () => {
    render(<BotDirectMessageView />);
    expect(await screen.findByText('Can you check this?')).toBeTruthy();
    expect(screen.getByText('Checked.')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('bots.directMessage.limitReached')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'bots.directMessage.close' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-a/session/a-main', { replace: true });
    expect(mocks.registerHeader).toHaveBeenCalled();
  });

  it('fails closed when the thread is unavailable', async () => {
    mocks.getThread.mockResolvedValueOnce({ ok: false, errorCode: 'NOT_FOUND', message: 'missing' });
    render(<BotDirectMessageView />);
    expect(await screen.findByText('bots.directMessage.unavailable')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

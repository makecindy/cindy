// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BotDirectMessageCard } from '../BotDirectMessageCard';

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/bots/bot-a/session/a-main', search: '?from=chat' }),
  useNavigate: () => mocks.navigate,
}));
vi.mock('../botStore', () => ({
  useBotProfiles: () => [{ id: 'bot-b', name: 'Planner', avatar: '', avatarColor: 'blue' }],
}));
vi.mock('../BotAvatar', () => ({
  BotAvatar: ({ bot }: { bot: { name: string } }) => <span data-avatar={bot.name} />,
}));

beforeEach(() => {
  mocks.navigate.mockClear();
});

afterEach(cleanup);

describe('BotDirectMessageCard', () => {
  const data = {
    v: 1,
    threadId: 'dm-1',
    viewerBotId: 'bot-a',
    peerBotId: 'bot-b',
    peerBotName: 'Planner',
    direction: 'sent',
    sequence: 3,
    preview: 'hello',
  };

  it('renders nothing for malformed timeline metadata', () => {
    const { container } = render(<BotDirectMessageCard data={{ ...data, v: 2 }} />);
    expect(container.firstChild).toBeNull();
  });

  it('opens the hidden route and carries the exact timeline return path', () => {
    render(<BotDirectMessageCard data={data} />);
    const label = screen.getByText(/bots\.directMessage\.sentTo/);
    fireEvent.click(label);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-a/direct/dm-1', {
      state: { botDirectMessageReturnTo: '/bots/bot-a/session/a-main?from=chat' },
    });
  });
});

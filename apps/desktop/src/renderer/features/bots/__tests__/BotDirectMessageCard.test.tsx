// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BotDirectMessageCard } from '../BotDirectMessageCard';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), getThread: vi.fn(), remoteGetThread: vi.fn(), device: undefined as string | undefined }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/bots/bot-a/session/a-main', search: '?from=chat' }),
  useNavigate: () => mocks.navigate,
}));
vi.mock('../botStore', () => ({
  useBotProfiles: () => [
    { id: 'bot-a', name: 'LiZi', avatar: '', avatarColor: 'red' },
    { id: 'bot-b', name: 'Planner', avatar: '', avatarColor: 'blue' },
  ],
}));
vi.mock('../BotAvatar', () => ({
  BotAvatar: ({ bot }: { bot: { name: string } }) => <span data-avatar={bot.name} />,
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: { getSessionDeviceId: () => mocks.device },
}));
vi.mock('@/lib/makerTransport', () => ({
  makerApiForDevice: () => ({ getBotDirectMessageThread: mocks.remoteGetThread }),
}));

beforeEach(() => {
  mocks.navigate.mockClear();
  mocks.device = undefined;
  mocks.getThread.mockReset();
  mocks.remoteGetThread.mockReset();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { maker: { getBotDirectMessageThread: mocks.getThread } },
  });
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
    sequence: 1,
    preview: 'Does **PR 6051** conflict?',
  };

  it('renders nothing for malformed timeline metadata', () => {
    const { container } = render(<BotDirectMessageCard data={{ ...data, v: 2 }} />);
    expect(container.firstChild).toBeNull();
  });

  // Restore the pre-card interaction: a single trace opens the existing read-only view.
  it.each(['sent', 'received'])('shows only the %s trace and opens its conversation', (direction) => {
    render(<BotDirectMessageCard data={{ ...data, direction }} />);
    const label = direction === 'sent' ? 'sentTo' : 'receivedFrom';
    const button = screen.getByRole('button', { name: `bots.directMessage.${label}:{"name":"Planner"}` });
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByText(data.preview)).toBeNull();
    expect(mocks.getThread).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-a/direct/dm-1', {
      state: { botDirectMessageReturnTo: '/bots/bot-a/session/a-main?from=chat' },
    });
  });

  it('keeps the remote owner in the conversation route and uses its recorded name', () => {
    mocks.device = 'home';
    render(<BotDirectMessageCard data={{ ...data, peerBotName: 'Remote planner' }} sessionId="remote-main" />);
    fireEvent.click(screen.getByRole('button', { name: 'bots.directMessage.sentTo:{"name":"Remote planner"}' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-a/direct/dm-1?deviceId=home', {
      state: { botDirectMessageReturnTo: '/bots/bot-a/session/a-main?from=chat' },
    });
    expect(mocks.getThread).not.toHaveBeenCalled();
    expect(mocks.remoteGetThread).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content, allowPrivilegedLinks }: any) => (
    <div data-testid="markdown" data-privileged={String(allowPrivilegedLinks)}>{content}</div>
  ),
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: { getSessionDeviceId: () => mocks.device },
}));
vi.mock('@/lib/makerTransport', () => ({
  makerApiForDevice: () => ({ getBotDirectMessageThread: mocks.remoteGetThread }),
}));

const thread = {
  id: 'dm-1', botAId: 'bot-a', botAName: 'LiZi', botBId: 'bot-b', botBName: 'Planner',
  status: 'closed', closeReason: 'idle-timeout', messageCount: 2, maxMessages: 12,
  createdAt: 1, updatedAt: 2, closedAt: 2,
  messages: [
    { id: 'm1', sequence: 1, senderBotId: 'bot-a', senderBotName: 'LiZi', recipientBotId: 'bot-b',
      recipientBotName: 'Planner', content: 'Does **PR 6051** conflict?', createdAt: 1 },
    { id: 'm2', sequence: 2, senderBotId: 'bot-b', senderBotName: 'Planner', recipientBotId: 'bot-a',
      recipientBotName: 'LiZi', content: 'No conflict.', createdAt: 2 },
  ],
};

beforeEach(() => {
  mocks.navigate.mockClear();
  mocks.device = undefined;
  mocks.getThread.mockReset().mockResolvedValue({ ok: true, thread });
  mocks.remoteGetThread.mockReset().mockResolvedValue({ ok: true, thread });
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

  it('is a card with the peer, direction and an excerpt, not a separator', () => {
    render(<BotDirectMessageCard data={data} />);
    expect(screen.getByText('bots.directMessage.sentHeader:{"name":"Planner"}')).toBeTruthy();
    expect(screen.getByText('Does **PR 6051** conflict?')).toBeTruthy();
    expect(screen.queryByRole('separator')).toBeNull();
    expect(mocks.getThread).not.toHaveBeenCalled();
  });

  it('labels a received message by its sender', () => {
    render(<BotDirectMessageCard data={{ ...data, direction: 'received' }} />);
    expect(screen.getByText('bots.directMessage.receivedHeader:{"name":"Planner"}')).toBeTruthy();
  });

  it('opens the full read-only page and carries the exact timeline return path', () => {
    render(<BotDirectMessageCard data={data} />);
    fireEvent.click(screen.getByRole('button', { name: /bots\.directMessage\.fullThread/ }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-a/direct/dm-1', {
      state: { botDirectMessageReturnTo: '/bots/bot-a/session/a-main?from=chat' },
    });
  });

  it('expands the exchange inline from the thread IPC with Markdown and the closed ending', async () => {
    render(<BotDirectMessageCard data={data} />);
    const toggle = screen.getByRole('button', { name: /bots\.directMessage\.expandThread/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(mocks.getThread).toHaveBeenCalledWith('dm-1', 'bot-a');
    await waitFor(() => expect(screen.getAllByTestId('markdown')).toHaveLength(2));
    expect(screen.getAllByTestId('markdown').map((node) => node.textContent))
      .toEqual(['Does **PR 6051** conflict?', 'No conflict.']);
    expect(screen.getAllByTestId('markdown').every((node) => node.dataset.privileged === 'false')).toBe(true);
    expect(screen.getByText('bots.directMessage.threadClosed')).toBeTruthy();
    const collapse = screen.getByRole('button', { name: /bots\.directMessage\.exchangeCountShort.*bots\.directMessage\.collapse/ });
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(collapse);
    expect(screen.queryByTestId('markdown')).toBeNull();
  });

  it('reads a remote thread from the device that owns the bot chat', async () => {
    mocks.device = 'home';
    render(<BotDirectMessageCard data={data} sessionId="remote-main" />);
    fireEvent.click(screen.getByRole('button', { name: /bots\.directMessage\.expandThread/ }));
    await waitFor(() => expect(mocks.remoteGetThread).toHaveBeenCalledWith('dm-1', 'bot-a'));
    expect(mocks.getThread).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /bots\.directMessage\.fullThread/ }));
    expect(mocks.navigate.mock.calls[0][0]).toBe('/bots/bot-a/direct/dm-1?deviceId=home');
  });

  it('fails closed when the thread is unavailable', async () => {
    mocks.getThread.mockResolvedValue({ ok: false, errorCode: 'NOT_FOUND', message: 'missing' });
    render(<BotDirectMessageCard data={data} />);
    fireEvent.click(screen.getByRole('button', { name: /bots\.directMessage\.expandThread/ }));
    expect(await screen.findByText('bots.directMessage.unavailable')).toBeTruthy();
  });
});

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const translate = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}));

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  profiles: [] as unknown[],
  health: new Map<string, string>(),
  unread: {} as Record<string, number>,
  refreshBotProfiles: vi.fn(),
  registered: { node: null as ReactNode },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => ({}),
}));
vi.mock('../../feature-context', () => ({
  useSidebarCollapsedState: () => false,
  useRegisterSidebarUpper: (node: ReactNode) => {
    mocks.registered.node = node;
  },
}));
vi.mock('../botStore', () => ({
  useBotProfiles: () => mocks.profiles,
  useBotUnreadCounts: () => mocks.unread,
  getBotHealth: async (botId: string) => ({ status: mocks.health.get(botId) ?? 'healthy' }),
  refreshBotProfiles: mocks.refreshBotProfiles,
}));

import type { BotInboxItemView } from '../../../../shared/botSessionEvents';
import { BotsSidebar } from '../BotsSidebar';
import { markBotRead, resetBotReadStateForTests } from '../botReadState';

interface BotFixture {
  id: string;
  name: string;
  description?: string;
  lastMessagePreview?: string | null;
  lastMessageAt?: number | null;
}

function bot(fixture: BotFixture) {
  return {
    channel: 'local',
    avatar: '🧭',
    avatarColor: 'violet',
    enabled: true,
    status: 'active',
    skills: [],
    capabilities: {},
    createdAt: 0,
    sessions: [{ id: `${fixture.id}-chat`, kind: 'chat' }],
    canonicalSessionId: `${fixture.id}-chat`,
    channels: [],
    routes: [],
    description: '',
    ...fixture,
  };
}

let messageListeners: Array<(payload: unknown) => void> = [];

async function renderSidebar() {
  render(<BotsSidebar />);
  const view = render(<>{mocks.registered.node}</>);
  await waitFor(() => expect(view.container.querySelector('button')).not.toBeNull());
  return view;
}

beforeEach(() => {
  messageListeners = [];
  window.localStorage.clear();
  resetBotReadStateForTests();
  mocks.navigate.mockReset();
  mocks.refreshBotProfiles.mockReset();
  mocks.health = new Map();
  mocks.unread = {};
  mocks.profiles = [];
  mocks.registered.node = null;
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      maker: {
        botInbox: {
          list: vi.fn(async () => []),
          onChanged: vi.fn(() => () => undefined),
        },
      },
      localDb: {
        messages: {
          onCreated: (cb: (payload: unknown) => void) => {
            messageListeners.push(cb);
            return () => {
              messageListeners = messageListeners.filter((entry) => entry !== cb);
            };
          },
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('BotsSidebar rows', () => {
  it('shows the latest message and its time instead of a channel label', async () => {
    const at = new Date();
    at.setHours(9, 7, 0, 0);
    mocks.profiles = [
      bot({
        id: 'bot-1',
        name: 'PR steward',
        description: 'Delivery steward',
        lastMessagePreview: 'Two checks are still red on #2829',
        lastMessageAt: at.getTime(),
      }),
    ];

    const view = await renderSidebar();

    expect(screen.getByText('Two checks are still red on #2829')).toBeTruthy();
    expect(screen.getByText('09:07')).toBeTruthy();
    expect(view.container.textContent).not.toContain('Local');
    expect(screen.queryByText('Delivery steward')).toBeNull();
  });

  it('falls back to the description and then to the start-chat prompt', async () => {
    mocks.profiles = [
      bot({ id: 'bot-1', name: 'With description', description: 'Delivery steward' }),
      bot({ id: 'bot-2', name: 'Brand new' }),
    ];

    await renderSidebar();

    expect(screen.getByText('Delivery steward')).toBeTruthy();
    expect(screen.getByText('bots.list.startChat')).toBeTruthy();
  });

  it('marks only the hands-on teammates with the ⚠ badge', async () => {
    mocks.profiles = [
      bot({ id: 'bot-asks', name: 'Asks first' }),
      { ...bot({ id: 'bot-trusted', name: 'Hands on' }), capabilities: { permissions: 'trusted' } },
    ];

    await renderSidebar();

    // icon-only,没有文字标签(既有状态徽标裁决);一行一个,不是每行都挂。
    expect(screen.getAllByLabelText('bots.trustedBadge.label')).toHaveLength(1);
  });

  it('shows a health icon only for abnormal Bots', async () => {
    mocks.profiles = [
      bot({ id: 'bot-healthy', name: 'Healthy' }),
      bot({ id: 'bot-attention', name: 'Attention' }),
    ];
    mocks.health.set('bot-attention', 'attention');

    await renderSidebar();

    await waitFor(() =>
      expect(screen.getByLabelText('bots.lifecycle.healthStatus.attention')).toBeTruthy(),
    );
    expect(screen.queryByLabelText('bots.lifecycle.healthStatus.healthy')).toBeNull();
  });

  it('opens Bot settings from the row gear without opening the chat', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];

    await renderSidebar();

    const gear = screen.getByRole('button', { name: 'bots.settings' });
    fireEvent.click(gear);
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-1?settings=1');

    // The row itself still opens the conversation.
    mocks.navigate.mockClear();
    fireEvent.click(screen.getByText('PR steward'));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-1');
  });

  it('shows an unread count only for Bots with unread replies, capped at 99+', async () => {
    mocks.profiles = [
      bot({ id: 'bot-read', name: 'Read', lastMessagePreview: 'Nothing new' }),
      bot({ id: 'bot-unread', name: 'Unread', lastMessagePreview: 'Fresh reply' }),
      bot({ id: 'bot-flooded', name: 'Flooded', lastMessagePreview: 'Many replies' }),
    ];
    mocks.unread = { 'bot-unread': 3, 'bot-flooded': 100 };

    await renderSidebar();

    expect(screen.getByLabelText('bots.list.unread:{"count":3}').textContent).toBe('3');
    expect(screen.getByLabelText('bots.list.unread:{"count":100}').textContent).toBe('99+');
    // A read Bot carries no badge at all — zero must never render as "0".
    expect(screen.queryByLabelText('bots.list.unread:{"count":0}')).toBeNull();
    expect(screen.getByText('Nothing new').className).not.toContain('font-medium');
    expect(screen.getByText('Fresh reply').className).toContain('font-medium');
    expect(screen.getByText('Read').className).not.toContain('font-medium');
    expect(screen.getByText('Unread').className).toContain('font-medium');
  });

  it('gives the numeric slot to unread messages and degrades inbox attention to a dot', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'Busy' })];
    mocks.unread = { 'bot-1': 2 };
    window.electronAPI.maker.botInbox.list = vi.fn(
      async () =>
        [
          { id: 'i1', status: 'pending' },
          { id: 'i2', status: 'failed' },
        ] as unknown as BotInboxItemView[],
    );

    await renderSidebar();

    await waitFor(() =>
      expect(screen.getByLabelText('bots.inbox.sidebarAttention:{"count":2}')).toBeTruthy(),
    );
    // Attention keeps its meaning in the label but stops competing for the count.
    expect(screen.getByLabelText('bots.inbox.sidebarAttention:{"count":2}').textContent).toBe('');
    expect(screen.getByLabelText('bots.list.unread:{"count":2}').textContent).toBe('2');
  });

  it('re-reads the list when a Bot conversation is marked read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];

    render(<BotsSidebar />);
    render(<>{mocks.registered.node}</>);
    await vi.waitFor(() => expect(messageListeners.length).toBe(1));
    mocks.refreshBotProfiles.mockClear();

    act(() => {
      markBotRead('bot-1', 1_000);
      markBotRead('bot-1', 2_000);
      vi.advanceTimersByTime(2000);
    });
    // Debounced the same way as the message feed: one refresh per burst.
    expect(mocks.refreshBotProfiles).toHaveBeenCalledTimes(1);
  });

  it('refreshes the list when a message lands in a Bot task, and ignores other tasks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];

    render(<BotsSidebar />);
    render(<>{mocks.registered.node}</>);
    await vi.waitFor(() => expect(messageListeners.length).toBe(1));

    act(() => {
      for (const listener of messageListeners) listener({ sessionId: 'some-other-session' });
      vi.advanceTimersByTime(2000);
    });
    expect(mocks.refreshBotProfiles).not.toHaveBeenCalled();

    act(() => {
      for (const listener of messageListeners) listener({ sessionId: 'bot-1-chat' });
      for (const listener of messageListeners) listener({ sessionId: 'bot-1-chat' });
      vi.advanceTimersByTime(2000);
    });
    // Debounced: a burst of rows from one turn triggers a single refresh.
    expect(mocks.refreshBotProfiles).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 工作台在右侧栏里有自己的数据订阅，这里只验证伙伴对话的挂载与读位。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  read: undefined as undefined | ((at: number) => void),
  params: { botId: 'bot-1', sessionId: 'session-1' } as Record<string, string | undefined>,
  demoted: [] as string[],
}));
vi.mock('../companionCloudStore', () => ({ useCompanionCloud: () => ({ enabled: false, selfDeviceId: null, humanActorId: null, actors: [], demotedBotIds: mocks.demoted }) }));
vi.mock('../CompanionShadowBanner', () => ({ CompanionShadowBanner: ({ botId }: { botId: string }) => <div data-testid="shadow-banner">{botId}</div> }));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => mocks.params,
  useLocation: () => ({ search: '', state: null }),
  Navigate: () => <div data-testid="original-task" />,
}));
// The private-chat topic host belongs to the chat surface these tests isolate.
vi.mock('../BotDmThreadHost', () => ({ BotDmThreadHost: ({ children }: { children: import('react').ReactNode }) => <>{children}</> }));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({
  CCAgentSessionView: ({ botUnreadBoundaryAt, onBotReadThrough, readOnly, botIdentity }: { botUnreadBoundaryAt?: number | null; onBotReadThrough?: (at: number) => void; readOnly?: boolean; botIdentity?: { canonicalChat?: boolean } }) => {
    mocks.read = onBotReadThrough;
    return <div data-testid="chat" data-unread-boundary={botUnreadBoundaryAt ?? ''} data-readonly={readOnly ? 'yes' : 'no'} data-canonical-chat={String(botIdentity?.canonicalChat)} />;
  },
}));

import { BotSessionView } from '../BotSessionView';
import {
  getBotLastReadAt,
  markBotRead,
  resetBotReadStateForTests,
  setBotReadStateOwner,
} from '../botReadState';

let messageListeners: Array<(payload: unknown) => void> = [];

function installElectronApi(bot: unknown, listedBot: unknown = bot): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      localDb: {
        bots: {
          get: vi.fn(async () => bot),
          list: vi.fn(async () => [listedBot]),
        },
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
}

const readyBot = {
  id: 'bot-1',
  name: 'PR steward',
  status: 'active',
  enabled: true,
  sessions: [{ id: 'session-1', kind: 'chat', role: 'canonical', status: 'active' }],
};

beforeEach(() => {
  mocks.read = undefined;
  messageListeners = [];
  window.localStorage.clear();
  resetBotReadStateForTests();
  setBotReadStateOwner('owner-1');
  mocks.params = { botId: 'bot-1', sessionId: 'session-1' };
  mocks.demoted = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(10_000);
  installElectronApi(readyBot);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetBotReadStateForTests();
});

describe('Bot conversation read position', () => {
  it('waits for a rendered reply rather than marking a mounted chat read to wall-clock time', async () => {
    const view = render(<BotSessionView />);
    await waitFor(() => expect(view.getByTestId('chat')).toBeTruthy());
    // Private-chat actions (add to group) belong to the canonical chat only.
    expect(view.getByTestId('chat').dataset.canonicalChat).toBe('true');
    expect(getBotLastReadAt('bot-1')).toBeNull();
    act(() => mocks.read?.(3_000));
    expect(getBotLastReadAt('bot-1')).toBe(3_000);
    act(() => mocks.read?.(2_000));
    expect(getBotLastReadAt('bot-1')).toBe(3_000);
  });
  it('preserves the entry boundary and ignores message arrival without a viewport receipt', async () => {
    markBotRead('bot-1', 5_000);
    installElectronApi(readyBot, { ...readyBot, unreadCount: 2 });
    const view = render(<BotSessionView />);
    await waitFor(() => expect(view.getByTestId('chat').dataset.unreadBoundary).toBe('5000'));
    act(() => messageListeners.forEach(listener => listener({ sessionId: 'session-1' })));
    expect(getBotLastReadAt('bot-1')).toBe(5_000);
    act(() => mocks.read?.(7_000));
    expect(getBotLastReadAt('bot-1')).toBe(7_000);
    expect(view.getByTestId('chat').dataset.unreadBoundary).toBe('5000');
  });
  it('opening an older Bot task cannot acknowledge the canonical chat', async () => {
    markBotRead('bot-1', 5_000);
    installElectronApi({ ...readyBot, sessions: [{ id: 'session-1', kind: 'chat', role: 'history', status: 'active' }] });
    const view = render(<BotSessionView />);
    await waitFor(() => expect(view.getByTestId('original-task')).toBeTruthy());
    expect(view.queryByTestId('chat')).toBeNull();
    expect(mocks.read).toBeUndefined();
    expect(getBotLastReadAt('bot-1')).toBe(5_000);
  });

  it('does not mark anything read when the Bot task cannot be opened', async () => {
    installElectronApi({ ...readyBot, status: 'archived' });

    render(<BotSessionView />);

    await waitFor(() => expect(messageListeners.length).toBe(0));
    expect(getBotLastReadAt('bot-1')).toBeNull();
  });
});

describe('a demoted copy', () => {
  it('shows the main-computer banner and keeps the main task read only', async () => {
    mocks.demoted = ['bot-1'];
    const view = render(<BotSessionView />);
    await waitFor(() => expect(view.getByTestId('chat')).toBeTruthy());
    expect(view.getByTestId('shadow-banner').textContent).toBe('bot-1');
    expect(view.getByTestId('chat').getAttribute('data-readonly')).toBe('yes');
    expect(view.getByTestId('chat').dataset.canonicalChat).toBe('false');
  });

  it('keeps an ordinary companion writable', async () => {
    const view = render(<BotSessionView />);
    await waitFor(() => expect(view.getByTestId('chat')).toBeTruthy());
    expect(view.queryByTestId('shadow-banner')).toBeNull();
    expect(view.getByTestId('chat').getAttribute('data-readonly')).toBe('no');
    expect(view.getByTestId('chat').dataset.canonicalChat).toBe('true');
  });
});

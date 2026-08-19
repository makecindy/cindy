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
  /** 灵动岛活动镜像:sessionId -> phase。侧栏据此显示「正在输入…」。 */
  islandActivity: new Map<string, { sessionId: string; phase: string }>(),
}));

vi.mock('@/state/agentIslandActivity', () => ({
  useAgentIslandActivityMap: () => mocks.islandActivity,
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
  mocks.islandActivity = new Map();
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

describe('BotsSidebar 「正在输入…」', () => {
  it('回合进行中时第二行让位给「正在输入…」', async () => {
    mocks.profiles = [
      bot({
        id: 'bot-1',
        name: 'PR steward',
        lastMessagePreview: 'Two checks are still red on #2829',
        lastMessageAt: Date.now(),
      }),
    ];
    mocks.islandActivity = new Map([
      ['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'running' }],
    ]);
    const view = await renderSidebar();

    expect(view.container.textContent).toContain('bots.list.typing');
    // 进行中时不再同时挂上一句说过什么 —— 这一行只回答「TA 现在怎么样」。
    expect(view.container.textContent).not.toContain('Two checks are still red');
  });

  it('回合结束后落回最新消息预览,不留痕', async () => {
    mocks.profiles = [
      bot({
        id: 'bot-1',
        name: 'PR steward',
        lastMessagePreview: 'Two checks are still red on #2829',
        lastMessageAt: Date.now(),
      }),
    ];
    // completed 不是 running:同一份镜像里的终态不该继续显示「正在输入…」。
    mocks.islandActivity = new Map([
      ['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'completed' }],
    ]);
    const view = await renderSidebar();

    expect(view.container.textContent).not.toContain('bots.list.typing');
    expect(view.container.textContent).toContain('Two checks are still red on #2829');
  });

  it('只认这个伙伴自己的主任务 —— 别人的会话在跑不该点亮这一行', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward', description: 'Delivery steward' })];
    mocks.islandActivity = new Map([
      ['someone-else', { sessionId: 'someone-else', phase: 'running' }],
    ]);
    const view = await renderSidebar();

    expect(view.container.textContent).not.toContain('bots.list.typing');
    expect(view.container.textContent).toContain('Delivery steward');
  });

  it('是斜体三级色的过程说明,即使有未读也不跟着提到一级', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    mocks.unread = { 'bot-1': 4 };
    mocks.islandActivity = new Map([
      ['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'running' }],
    ]);
    const view = await renderSidebar();

    const line = [...view.container.querySelectorAll('span')].find(
      (el) => el.textContent === 'bots.list.typing',
    );
    expect(line).toBeTruthy();
    expect(line?.className).toContain('italic');
    expect(line?.className).toContain('text-[var(--sidebar-list-muted)]');
    expect(line?.className).not.toContain('font-medium');
  });
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

  it('never marks a row with the hands-on ⚠ badge', async () => {
    mocks.profiles = [
      bot({ id: 'bot-asks', name: 'Asks first' }),
      { ...bot({ id: 'bot-trusted', name: 'Hands on' }), capabilities: { permissions: 'trusted' } },
    ];

    await renderSidebar();

    // 产品裁决 2026-08-18:伙伴列表是聊天列表,不是权限看板。
    expect(screen.queryAllByLabelText('bots.trustedBadge.label')).toHaveLength(0);
  });

  it('carries no health icon column at all — a chat row answers "any new messages", nothing else', async () => {
    mocks.profiles = [
      bot({ id: 'bot-healthy', name: 'Healthy' }),
      bot({ id: 'bot-attention', name: 'Attention' }),
    ];
    mocks.health.set('bot-attention', 'attention');

    await renderSidebar();

    // 一行右侧同时挂「未读数 + 待办点 + 状态图标」时三处右对齐元素互相抢注意力。
    // 异常态另有出口:待办点(收件箱)与 TA 的设置页「健康与历史」。
    await waitFor(() => expect(screen.getByText('Attention')).toBeTruthy());
    for (const status of ['attention', 'recovering', 'paused', 'healthy']) {
      expect(screen.queryByLabelText(`bots.lifecycle.healthStatus.${status}`)).toBeNull();
    }
  });

  it('paints the unread badge and the todo dot with the registered IM-unread blue, not the inverse CTA', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'Busy' })];
    mocks.unread = { 'bot-1': 2 };
    window.electronAPI.maker.botInbox.list = vi.fn(
      async () => [{ id: 'i1', status: 'pending' }] as unknown as BotInboxItemView[],
    );

    await renderSidebar();

    const badge = screen.getByLabelText('bots.list.unread:{"count":2}');
    // 反相 CTA 白底药丸落在选中行的浅灰选中态上会和选中态抢焦点;未读在 IM 里
    // 本来就有一个所有人都认得的颜色。token 登记见 DESIGN.md §10。
    expect(badge.className).toContain('bg-[var(--bot-unread-bg)]');
    expect(badge.className).toContain('text-[var(--bot-unread-fg)]');
    expect(badge.className).not.toContain('accent-cta-bg');

    await waitFor(() =>
      expect(screen.getByLabelText('bots.inbox.sidebarAttention:{"count":1}')).toBeTruthy(),
    );
    expect(
      screen.getByLabelText('bots.inbox.sidebarAttention:{"count":1}').className,
    ).toContain('bg-[var(--bot-unread-bg)]');
  });

  it('opens the roster page instead of a modal from every "add" affordance', async () => {
    mocks.profiles = [];

    await renderSidebar();

    // 空态卡与小节头的「＋」都去主区阵容页;`?add=1` 那层模态已经没有了。
    fireEvent.click(screen.getByText('bots.emptyTitle'));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/roster');
    mocks.navigate.mockClear();
    fireEvent.click(screen.getByLabelText('bots.add'));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/roster');
  });

  it('has no per-row gear and no section-header import: a row only opens the chat', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];

    await renderSidebar();

    // 进设置的入口收敛到对话顶栏;导入下沉到创建面板与「设置 › 伙伴」。
    expect(screen.queryByRole('button', { name: 'bots.settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.portability.import' })).toBeNull();

    fireEvent.click(screen.getByText('PR steward'));
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
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

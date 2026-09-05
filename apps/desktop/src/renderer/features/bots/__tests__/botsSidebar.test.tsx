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
  groupMessages: new Map<string, unknown[]>(),
  pathname: '/bots',
  refreshBotProfiles: vi.fn(),
  setBotHidden: vi.fn(async () => undefined),
  setBotPinned: vi.fn(async () => undefined),
  duplicateBotProfile: vi.fn(async () => ({ id: 'copy' })),
  registered: { node: null as ReactNode },
  /** 灵动岛活动镜像:sessionId -> phase。侧栏据此显示「正在输入…」。 */
  islandActivity: new Map<string, { sessionId: string; phase: string }>(),
}));

vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => [] }));

vi.mock('@/state/agentIslandActivity', () => ({
  useAgentIslandActivityMap: () => mocks.islandActivity,
}));
vi.mock('@/hooks/useSessionRunningStatus', () => ({
  useSessionRunningStatus: () => ({
    runningSessionIds: new Set<string>(),
    notifications: new Set<string>(),
    clearNotification: vi.fn(),
  }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ pathname: mocks.pathname }),
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
  refreshBotProfiles: mocks.refreshBotProfiles,
  setBotHidden: mocks.setBotHidden,
  setBotPinned: mocks.setBotPinned,
  duplicateBotProfile: mocks.duplicateBotProfile,
  canonicalBotSessionId: (bot: {
    sessions?: Array<{ id: string; role?: string; kind?: string }>;
  }) =>
    bot.sessions?.find((session) => session.role === 'canonical' || session.kind === 'chat')?.id,
}));
vi.mock('../BotDeleteDialog', () => ({
  BotDeleteDialog: ({ bot }: { bot: { name: string } | null }) =>
    bot ? <div data-testid="bot-delete-dialog">{bot.name}</div> : null,
}));

import { BotsSidebar } from '../BotsSidebar';
import { markBotRead, resetBotReadStateForTests } from '../botReadState';

interface BotFixture {
  id: string;
  name: string;
  description?: string;
  lastMessagePreview?: string | null;
  lastMessageAt?: number | null;
  needsAttention?: boolean;
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
  mocks.setBotHidden.mockReset();
  mocks.setBotPinned.mockReset();
  mocks.duplicateBotProfile.mockReset();
  mocks.setBotHidden.mockResolvedValue(undefined);
  mocks.setBotPinned.mockResolvedValue(undefined);
  mocks.duplicateBotProfile.mockResolvedValue({ id: 'copy' });
  mocks.health = new Map();
  mocks.unread = {};
  mocks.groupMessages = new Map();
  mocks.pathname = '/bots';
  mocks.profiles = [];
  mocks.registered.node = null;
  mocks.islandActivity = new Map();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      localDb: {
        messages: {
          list: vi.fn(async (sessionId: string) => mocks.groupMessages.get(sessionId) ?? []),
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
    mocks.islandActivity = new Map([['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'running' }]]);
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
    mocks.islandActivity = new Map([['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'running' }]]);
    await renderSidebar();

    const line = screen.getByText('bots.list.typing');
    expect(line).toBeTruthy();
    expect(line?.className).toContain('italic');
    expect(line?.className).toContain('text-[var(--sidebar-list-muted)]');
    expect(line?.className).not.toContain('font-medium');
  });
});

describe('BotsSidebar rows', () => {
  it('shows durable Hermes attention without reviving the permissions badge', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'Needs help', needsAttention: true })];

    await renderSidebar();

    expect(screen.getByLabelText('bots.list.needsAttention')).toBeTruthy();
  });
  it('does not duplicate recent Bots in a separate Active now area', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'Active steward', lastMessageAt: Date.now() })];

    await renderSidebar();

    expect(screen.queryByLabelText('bots.list.activeNow')).toBeNull();
    expect(screen.getAllByText('Active steward')).toHaveLength(1);
  });

  it('keeps hidden Bots recoverable and reveals a match automatically while searching', async () => {
    mocks.profiles = [
      bot({ id: 'visible', name: 'Visible' }),
      { ...bot({ id: 'hidden', name: 'Hidden release steward' }), hiddenAt: 2 },
      { ...bot({ id: 'other', name: 'Other hidden' }), hiddenAt: 3 },
      bot({ id: 'v2', name: 'V2' }),
      bot({ id: 'v3', name: 'V3' }),
      bot({ id: 'v4', name: 'V4' }),
      bot({ id: 'v5', name: 'V5' }),
      bot({ id: 'v6', name: 'V6' }),
    ];

    await renderSidebar();
    expect(screen.queryByText('Hidden release steward')).toBeNull();
    fireEvent.change(screen.getByLabelText('bots.list.search'), { target: { value: 'release' } });
    expect(screen.getByText('Hidden release steward')).toBeTruthy();
    expect(screen.queryByText('Other hidden')).toBeNull();
  });

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
    // 2026-08-19:BotTrustedBadge 与 bots.trustedBadge.* 已删除,所以改查 ⚠
    // 图标本身 —— 按已不存在的 i18n key 断言等于没有守卫。
    expect(document.querySelector('.lucide-triangle-alert')).toBeNull();
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

  it('paints the unread badge with the registered IM-unread blue, not the inverse CTA', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'Busy' })];
    mocks.unread = { 'bot-1': 2 };

    await renderSidebar();

    const badge = screen.getByLabelText('bots.list.unread:{"count":2}');
    // 反相 CTA 白底药丸落在选中行的浅灰选中态上会和选中态抢焦点;未读在 IM 里
    // 本来就有一个所有人都认得的颜色。token 登记见 DESIGN.md §10。
    expect(badge.className).toContain('bg-[var(--bot-unread-bg)]');
    expect(badge.className).toContain('text-[var(--bot-unread-fg)]');
    expect(badge.className).not.toContain('accent-cta-bg');
  });

  it('keeps settings and import out of each row while the row itself opens chat', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];

    await renderSidebar();

    // 进设置的入口收敛到对话顶栏;导入下沉到创建面板与「设置 › 伙伴」。
    expect(screen.queryByRole('button', { name: 'bots.settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.portability.import' })).toBeNull();

    fireEvent.click(screen.getByText('PR steward'));
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-1');
  });

  it('keeps legacy stopped Bots reachable for deletion without presenting archive or restore', async () => {
    mocks.profiles = [
      { ...bot({ id: 'legacy-stopped', name: 'Legacy stopped' }), status: 'archived' },
    ];

    await renderSidebar();

    expect(screen.getByText('bots.lifecycle.stoppedBots')).toBeTruthy();
    expect(screen.queryByText('bots.lifecycle.archivedBots')).toBeNull();
    fireEvent.click(screen.getByText('Legacy stopped'));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/legacy-stopped?settings=1');
  });

  it('keeps the row management menu open after a right click', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];

    await renderSidebar();
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.deleteTitle' })).toBeNull();
    fireEvent.mouseOver(screen.getByText('PR steward'));
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.deleteTitle' })).toBeNull();
    expect(screen.queryByTestId('bot-delete-dialog')).toBeNull();

    fireEvent.contextMenu(screen.getAllByText('PR steward')[0]);

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'bots.list.pin' })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: 'bots.list.hide' })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: 'bots.list.duplicate' })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: 'bots.lifecycle.delete' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('menuitem', { name: 'bots.lifecycle.delete' }));
    expect(screen.getByTestId('bot-delete-dialog').textContent).toBe('PR steward');
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
    expect(screen.getByText('Fresh reply').className).not.toContain('font-medium');
    expect(screen.getByLabelText('bots.list.unread:{"count":3}').className).toContain('tabular-nums');
    expect(screen.getByText('Read').className).not.toContain('font-medium');
    expect(screen.getByText('Unread').className).toContain('font-medium');
  });

  it.each([
    { button: 2, ctrlKey: false },
    { button: 0, ctrlKey: true },
    { button: 0, ctrlKey: false },
  ])('does not select Pin on the opening release ($button / ctrl=$ctrlKey)', async (pointer) => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    await renderSidebar();
    fireEvent.contextMenu(screen.getByText('PR steward'), { clientX: 120, clientY: 180 });
    const pin = await screen.findByRole('menuitem', { name: 'bots.list.pin' });

    // On macOS the context menu can open before the original button is released.
    fireEvent(pin, new MouseEvent('pointerup', { bubbles: true, cancelable: true, ...pointer }));
    if (pointer.button !== 0 || pointer.ctrlKey) fireEvent.click(pin, pointer);
    expect(mocks.setBotPinned).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('menuitem', { name: 'bots.list.pin' })).toBeTruthy();

    fireEvent(pin, new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    fireEvent(pin, new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    fireEvent.click(pin);
    expect(mocks.setBotPinned).toHaveBeenCalledExactlyOnceWith('bot-1', true);
  });

  it('supports keyboard selection and restores row focus when dismissed', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    await renderSidebar();
    const row = screen.getByText('PR steward').closest('button')!;
    row.focus();
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    const pin = await screen.findByRole('menuitem', { name: 'bots.list.pin' });
    expect(mocks.setBotPinned).not.toHaveBeenCalled();
    fireEvent.keyDown(pin, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.keyDown(row, { key: 'ContextMenu' });
    fireEvent.keyDown(await screen.findByRole('menuitem', { name: 'bots.list.pin' }), { key: 'Enter' });
    expect(mocks.setBotPinned).toHaveBeenCalledExactlyOnceWith('bot-1', true);
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

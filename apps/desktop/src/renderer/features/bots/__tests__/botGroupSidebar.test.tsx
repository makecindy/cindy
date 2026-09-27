// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotGroupSummary } from '../../../../shared/botGroupChat';

vi.mock('@/hooks/useProviderOnboarding', () => ({
  useProviderOnboarding: () => ({ visible: false }),
}));
vi.mock('@/components/onboarding/ConnectProviderCard', () => ({
  ConnectProviderCard: () => null,
}));

const translate = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { resolvedLanguage: 'en' } }),
}));

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  profiles: [] as unknown[],
  groups: [] as BotGroupSummary[],
  params: {} as { botId?: string; groupId?: string },
  registered: { node: null as ReactNode },
  islandActivity: new Map<string, { sessionId: string; phase: string; workingPhase?: string }>(),
  runningStatusOptions: null as null | {
    onSessionDone: (sessionId: string) => void;
    onSessionNeedsReply: (sessionId: string) => void;
  },
  sendNotification: vi.fn(),
  laneSentinel: Symbol('lane'),
  ownedTitle: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => [] }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => [],
}));
vi.mock('@/state/agentIslandActivity', () => ({
  useAgentIslandActivityMap: () => mocks.islandActivity,
}));
vi.mock('@/hooks/useSessionRunningStatus', () => ({
  useSessionRunningStatus: (_sessionId: string | undefined, options: typeof mocks.runningStatusOptions) => {
    mocks.runningStatusOptions = options;
    return { runningSessionIds: new Set<string>(), notifications: new Set<string>(), clearNotification: vi.fn() };
  },
}));
vi.mock('@/lib/sessionEventNotification', () => ({
  BOT_GROUP_LANE_SESSION: mocks.laneSentinel,
  botOwnedSessionNotificationTitle: (...args: unknown[]) => mocks.ownedTitle(...args),
  sendSessionEventNotification: (...args: unknown[]) => mocks.sendNotification(...args),
}));
vi.mock('@/lib/sessionService', () => ({ get: (...args: unknown[]) => mocks.getSession(...args) }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ pathname: '/bots', search: '', hash: '' }),
  useParams: () => mocks.params,
}));
vi.mock('../../feature-context', () => ({
  useSidebarCollapsedState: () => false,
  useRegisterSidebarUpper: (node: ReactNode) => {
    mocks.registered.node = node;
  },
}));
vi.mock('../botStore', () => ({
  useBotProfiles: () => mocks.profiles,
  useBotUnreadCounts: () => ({}),
  refreshBotProfiles: vi.fn(),
  setBotHidden: vi.fn(),
  setBotPinned: vi.fn(),
  duplicateBotProfile: vi.fn(),
  canonicalBotSessionId: (bot: { sessions?: Array<{ id: string; role?: string }> }) =>
    bot.sessions?.find((session) => session.role === 'canonical')?.id,
}));
vi.mock('../botGroupStore', () => ({
  useBotGroupList: () => ({ groups: mocks.groups, loaded: true }),
}));
vi.mock('../BotDeleteDialog', () => ({ BotDeleteDialog: () => null }));
vi.mock('../BotGroupCreateDialog', () => ({
  BotGroupCreateDialog: () => <div role="dialog">create-group-dialog</div>,
}));
vi.mock('../BotGenerationLabel', () => ({
  BotGenerationLabel: ({ sessionId }: { sessionId?: string }) => <span>{`generation:${sessionId}`}</span>,
}));

import { BotsSidebar } from '../BotsSidebar';

function bot(id: string, name: string, extraSessions: unknown[] = []) {
  return {
    id,
    name,
    description: '',
    avatar: '🧭',
    avatarColor: 'violet',
    enabled: true,
    status: 'active',
    skills: [],
    capabilities: {},
    createdAt: 0,
    lastMessagePreview: `${name} private preview`,
    sessions: [{ id: `${id}-chat`, kind: 'chat', role: 'canonical', title: name }, ...extraSessions],
  };
}

function group(overrides: Partial<BotGroupSummary> = {}): BotGroupSummary {
  return {
    id: 'g1',
    name: '周末出游',
    replyMode: 'all',
    speakingMode: 'auto',
    members: [
      { botId: 'mimi', name: '咪咪', avatar: '', avatarColor: 'red', status: 'active' },
      { botId: 'xiaoman', name: '小满', avatar: '', avatarColor: 'blue', status: 'active' },
    ],
    lastMessage: { authorKind: 'bot', authorName: '阿布', preview: '下午\n有小概率阵雨', createdAt: 10 },
    speakingBotIds: [],
    createdAt: 1,
    updatedAt: 10,
    ...overrides,
  };
}

async function renderSidebar() {
  render(<BotsSidebar />);
  const view = render(<>{mocks.registered.node}</>);
  await waitFor(() => expect(view.container.querySelector('button')).not.toBeNull());
  return view;
}

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.sendNotification.mockReset();
  mocks.ownedTitle.mockReset().mockResolvedValue(null);
  mocks.getSession.mockReset();
  mocks.params = {};
  mocks.groups = [];
  mocks.islandActivity = new Map();
  mocks.runningStatusOptions = null;
  mocks.profiles = [
    bot('mimi', '咪咪', [{ id: 'lane-mimi', kind: 'group', role: 'group', title: 'group lane' }]),
    bot('xiaoman', '小满'),
  ];
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: { localDb: { messages: { onCreated: () => () => undefined } } },
  });
});

afterEach(cleanup);

describe('BotsSidebar group chats', () => {
  it('lists groups below teammates with an author preview and opens them', async () => {
    mocks.groups = [group(), group({ id: 'g2', name: '读书会', lastMessage: null, updatedAt: 1 })];
    mocks.params = { groupId: 'g1' };
    await renderSidebar();
    expect(screen.getByText('bots.groupChat.sidebar.title')).toBeTruthy();
    const rows = screen.getAllByRole('button', { current: 'page' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('周末出游');
    expect(
      screen.getByText('bots.groupChat.sidebar.preview:{"name":"阿布","text":"下午 有小概率阵雨"}'),
    ).toBeTruthy();
    expect(screen.getByText('bots.groupChat.sidebar.empty')).toBeTruthy();
    fireEvent.click(screen.getByText('读书会'));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/groups/g2');

    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.title' }));
    expect(screen.getByRole('dialog').textContent).toBe('create-group-dialog');
  });

  it('shows the running mark on the group, not on the speaking teammate’s own row', async () => {
    mocks.groups = [group({ speakingBotIds: ['mimi'] })];
    mocks.islandActivity = new Map([
      ['lane-mimi', { sessionId: 'lane-mimi', phase: 'running', workingPhase: 'searching' }],
    ]);
    await renderSidebar();
    const running = screen.getByTestId('bot-group-running');
    expect(running.textContent).toContain('咪咪');
    expect(running.textContent).toContain('generation:lane-mimi');
    // The teammate row keeps its private-chat preview.
    expect(screen.getByText('咪咪 private preview')).toBeTruthy();
    expect(screen.getAllByText('generation:lane-mimi')).toHaveLength(1);
  });

  it('never sends system notifications for group lanes', async () => {
    await renderSidebar();
    const options = mocks.runningStatusOptions!;
    options.onSessionDone('lane-mimi');
    options.onSessionNeedsReply('lane-mimi');
    expect(mocks.sendNotification).not.toHaveBeenCalled();

    options.onSessionDone('mimi-chat');
    expect(mocks.sendNotification).toHaveBeenCalledWith('mimi-chat', '咪咪', 'done');

    // A lane the cached profiles have not caught up with yet is re-checked.
    mocks.sendNotification.mockReset();
    mocks.getSession.mockResolvedValue({ id: 'lane-new', title: 'lane', source: 'bot' });
    mocks.ownedTitle.mockResolvedValue(mocks.laneSentinel);
    options.onSessionDone('lane-new');
    await waitFor(() => expect(mocks.ownedTitle).toHaveBeenCalledWith('lane-new'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });
});

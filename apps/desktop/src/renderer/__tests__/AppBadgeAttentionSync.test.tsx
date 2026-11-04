// @vitest-environment jsdom
import { cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentIslandCompanionChatRead, AgentIslandCompanionChatsInput } from '../../shared/agentIsland';
import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush';

const state = vi.hoisted(() => ({
  sessions: ['a', 'b', 'c'].map((id) => ({ id, status: 'active' })) as { id: string; status: string; source?: string }[],
  history: null as { id: string; status: string; source?: string }[] | null,
  remoteSessions: [] as { id: string; status: string; source?: string; deviceLinkDeviceId?: string }[],
  attention: new Map<string, string>([
    ['a', 'done'],
    ['b', 'done'],
    ['c', 'done'],
  ]),
  empty: new Map(),
  running: new Map<string, { isRunning: boolean }>(),
  starting: new Set<string>(),
  background: new Set<string>(),
  workers: new Map<string, ReadonlySet<string>>(),
  owner: { dataOwnerId: 'owner-a', generation: 1 },
  isLoading: false,
  historyLoading: false,
  historyError: null as Error | null,
  publish: vi.fn().mockResolvedValue(undefined),
}));
const botState = vi.hoisted(() => ({
  bots: [] as unknown[],
  unread: {} as Record<string, number>,
  groups: [] as unknown[],
  unreadGroups: new Set<string>(),
  remote: [] as unknown[],
  markRead: vi.fn(),
  markRemoteRead: vi.fn(),
}));
vi.mock('@/features/bots/useBotUnreadSync', () => ({ useBotUnreadSync: () => {} }));
vi.mock('@/features/bots/botStore', () => ({ useBotProfiles: () => botState.bots, useBotUnreadCounts: () => botState.unread,
  canonicalBotSessionId: (bot: { sessions: { id: string; role?: string; kind?: string }[] }) => bot.sessions.find(session => session.role === 'canonical' || session.kind === 'chat')?.id,
}));
vi.mock('@/features/bots/botGroupStore', () => ({ useBotGroupList: () => ({ groups: botState.groups }) }));
vi.mock('@/features/bots/botReadState', () => ({
  isBotGroupUnread: (group: { id: string }) => botState.unreadGroups.has(group.id),
  subscribeBotReadState: () => () => {},
  getBotLastReadAtMap: () => ({}),
  markBotRead: botState.markRead,
}));
vi.mock('@/features/bots/useRemoteBots', () => ({ useRemoteBotSync: () => {}, useRemoteBots: () => botState.remote, markRemoteBotRead: botState.markRemoteRead }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({}) }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => state.owner,
  isDataOwnerPushCurrent: (stamp: { dataOwnerId: string; ownerGeneration: number }) =>
    stamp.dataOwnerId === state.owner.dataOwnerId && stamp.ownerGeneration === state.owner.generation,
  isDataOwnerGenerationCurrent: (owner: typeof state.owner) =>
    owner.dataOwnerId === state.owner.dataOwnerId && owner.generation === state.owner.generation,
}));
vi.mock('@/lib/sessionStartingStore', () => ({ useStartingSessionIds: () => state.starting }));
vi.mock('@/lib/sessionBackgroundActivityStore', () => ({
  useBackgroundActivitySessionIds: () => state.background,
}));
vi.mock('@/features/cc-agent/hooks/useOrcaLeadWorkerMap', () => ({
  useOrcaLeadWorkerMap: (sessions: { id: string }[]) =>
    new Map([...state.workers].filter(([lead]) => sessions.some((session) => session.id === lead))),
}));

vi.mock('@/hooks/useCCSessions', () => ({
  useCCSessions: (options: { includeArchived: string }) => ({
    sessions:
      options.includeArchived === 'all' ? (state.history ?? state.sessions) : state.sessions,
    isLoading: options.includeArchived === 'all' ? state.historyLoading : state.isLoading,
    error: options.includeArchived === 'all' ? state.historyError : null,
  }),
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: {
    subscribe: () => () => {},
    getMergedRemoteSessions: () => state.remoteSessions,
  },
}));
vi.mock('@/features/cc-agent/hooks/useAutomationScheduleSessionIndex', () => ({
  usePublishedAutomationScheduleSessionIndex: () => state.empty,
}));
vi.mock('@/features/device-link/remoteSessionActivityStore', () => ({}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: { subscribeAll: () => () => {}, getRunningSnapshot: () => state.running },
}));
vi.mock('@/lib/sessionAttentionStore', () => ({
  useSessionAttentionKinds: () => state.attention,
  getSessionAttentionKinds: () => state.attention,
  subscribeSessionAttention: () => () => undefined,
}));
vi.mock('@/state/agentIslandActivity', () => ({ useAgentIslandActivityMap: () => state.empty }));
vi.mock('@/lib/orcaSessionIdentity', () => ({ isOrcaWorkerSession: () => false }));

import { AppBadgeAttentionSync } from '../components/layout/AppBadgeAttentionSync';
import { useSessionDisplayRunningState } from '../features/cc-agent/hooks/useSessionDisplayRunningState';

afterEach(() => {
  cleanup();
  botState.bots = []; botState.unread = {}; botState.groups = []; botState.unreadGroups = new Set(); botState.remote = [];
  vi.unstubAllGlobals();
  state.publish.mockClear();
  botState.markRead.mockClear(); botState.markRemoteRead.mockClear();
  state.isLoading = false;
  state.historyLoading = false;
  state.historyError = null;
  state.sessions = ['a', 'b', 'c'].map((id) => ({ id, status: 'active' }));
  state.history = null;
  state.remoteSessions = [];
  state.running = new Map();
  state.starting = new Set();
  state.background = new Set();
  state.workers = new Map();
  state.attention = new Map([
    ['a', 'done'],
    ['b', 'done'],
    ['c', 'done'],
  ]);
});

describe('app badge projection lifecycle', () => {
  // Existing Dock tests did not verify the island or its read action. One unread local chat
  // and one offline remote chat must survive task-list loading and use the same read positions (unit).
  it('syncs companion unread independently of task loading and applies owner-fenced island reads', () => {
    const set = vi.fn<(input: AgentIslandCompanionChatsInput) => Promise<{ ok: true }>>().mockResolvedValue({ ok: true });
    let read!: (chat: AgentIslandCompanionChatRead, stamp: DataOwnerPushStamp) => void;
    vi.stubGlobal('electronAPI', { notificationSetAppAttentionCount: state.publish, agentIsland: {
      setCompanionChats: set,
      onCompanionChatRead: (cb: typeof read) => { read = cb; return () => {}; },
    } });
    const local = { id: 'bot', name: 'Cindy', avatar: '', avatarColor: 'blue', createdAt: 1,
      lastMessageAt: 100, lastMessageRole: 'assistant', lastMessagePreview: 'new reply',
      sessions: [{ id: 'chat', role: 'canonical' }] };
    botState.bots = [local, { ...local, id: 'hidden', hiddenAt: 1, sessions: [{ id: 'hidden-chat', role: 'canonical' }] }];
    botState.unread = { bot: 2, hidden: 1 };
    botState.remote = [{ id: 'remote', sessionId: 'remote-chat', deviceId: 'other-computer', name: 'Remote',
      avatar: '', avatarColor: 'blue', activityAt: 100, lastReplyAt: 100, readAt: 50, preview: 'remote reply', online: false }];
    state.isLoading = true;
    const view = render(<AppBadgeAttentionSync />);
    const snapshot = set.mock.calls.at(-1)![0];
    expect(snapshot.chats).toEqual([
      expect.objectContaining({ sessionId: 'chat', visible: true, unread: true }),
      expect.objectContaining({ sessionId: 'hidden-chat', visible: false }),
      expect.objectContaining({ sessionId: 'remote-chat', deviceId: 'other-computer', unread: true }),
    ]);
    const stamp = { dataOwnerId: state.owner.dataOwnerId, ownerGeneration: state.owner.generation };
    read({ ...snapshot.chats[0], readThroughAt: 100 }, stamp);
    expect(botState.markRead).toHaveBeenCalledWith('bot', 100);
    read({ ...snapshot.chats[2], readThroughAt: 100 }, stamp);
    expect(botState.markRemoteRead).toHaveBeenCalledWith('other-computer', 'remote', 100);
    read({ ...snapshot.chats[0], readThroughAt: 200 }, { ...stamp, ownerGeneration: 0 });
    expect(botState.markRead).toHaveBeenCalledTimes(1);
    botState.remote = botState.remote.map(bot => ({ ...(bot as object), online: true }));
    view.rerender(<AppBadgeAttentionSync />);
    expect(set).toHaveBeenCalledTimes(2);
    botState.unread = {};
    view.rerender(<AppBadgeAttentionSync />);
    expect(set.mock.calls.at(-1)![0].chats[0].unread).toBe(false);
  });
  it.each(['done', 'awaiting', 'error'])('excludes hidden Make tasks with %s attention while retaining notification deduplication IDs', (kind) => {
    vi.stubGlobal('electronAPI', { notificationSetAppAttentionCount: state.publish });
    state.sessions = [
      ...state.sessions,
      { id: 'make', status: 'active', source: 'cindy-make' },
      { id: 'make-merge', status: 'active', source: 'cindy-make-merge' },
    ];
    state.history = [{ id: 'archived-make', status: 'archived', source: 'cindy-make' }];
    state.remoteSessions = [{ id: 'remote-make', status: 'active', source: 'cindy-make', deviceLinkDeviceId: 'device-a' }];
    state.attention.set('make', kind);
    state.attention.set('make-merge', kind);
    render(<AppBadgeAttentionSync />);
    expect(state.publish).toHaveBeenLastCalledWith(expect.objectContaining({
      count: 3,
      sessionIds: ['a', 'b', 'c', 'make', 'make-merge', 'remote-make', 'archived-make'],
    }));
  });

  it('retains active attention when archived history fills the all bucket', () => {
    vi.stubGlobal('electronAPI', { notificationSetAppAttentionCount: state.publish });
    state.history = Array.from({ length: 1000 }, (_, index) => ({
      id: `archived-${index}`,
      status: 'archived',
    }));
    state.attention.set('archived-0', 'done');
    render(<AppBadgeAttentionSync />);
    expect(state.publish).toHaveBeenLastCalledWith(expect.objectContaining({ count: 3 }));
    const projection = state.publish.mock.calls.at(-1)?.[0];
    expect(projection.sessionIds).toHaveLength(1003);
    expect(projection.sessionIds).toEqual(expect.arrayContaining(['a', 'b', 'c', 'archived-0']));
  });

  it('keeps publishing the projection when the archived bucket is still loading or broken', () => {
    vi.stubGlobal('electronAPI', { notificationSetAppAttentionCount: state.publish });
    // 历史桶只补齐去重目录；它一直 loading / 报错也不得把计入数的投影一次次吞掉，
    // 否则角标会永久停在最后一次推送的旧值（界面上已经没有未读了）。
    state.historyLoading = true;
    state.historyError = new Error('db busy');
    const view = render(<AppBadgeAttentionSync />);
    expect(state.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ count: 3, sessionIds: ['a', 'b', 'c'] }),
    );
    // 历史桶一直坏着，同一个组件在未读清零后也必须把 0 推下去。
    state.attention = new Map();
    view.rerender(<AppBadgeAttentionSync />);
    expect(state.publish).toHaveBeenLastCalledWith(expect.objectContaining({ count: 0 }));
  });

  it('keeps remote IDs in the projection but excludes remote attention from the badge', () => {
    vi.stubGlobal('electronAPI', { notificationSetAppAttentionCount: state.publish });
    state.remoteSessions = [
      { id: 'remote-lead', status: 'active', deviceLinkDeviceId: 'device-a' },
    ];
    state.attention.set('remote-lead', 'done');
    state.workers = new Map([['remote-lead', new Set(['remote-worker'])]]);
    state.starting = new Set(['remote-worker']);
    const view = render(<AppBadgeAttentionSync />);
    expect(state.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ count: 3, sessionIds: ['a', 'b', 'c', 'remote-lead'] }),
    );
    state.starting = new Set();
    view.rerender(<AppBadgeAttentionSync />);
    expect(state.publish).toHaveBeenLastCalledWith(expect.objectContaining({ count: 3 }));
  });

  it('tracks starting, background and worker activity through their transitions', () => {
    vi.stubGlobal('electronAPI', { notificationSetAppAttentionCount: state.publish });
    const view = render(<AppBadgeAttentionSync />);
    state.starting = new Set(['a']);
    view.rerender(<AppBadgeAttentionSync />);
    expect(state.publish).toHaveBeenLastCalledWith(expect.objectContaining({ count: 2 }));
    state.background = new Set(['b']);
    state.workers = new Map([['c', new Set(['worker'])]]);
    state.running = new Map([['worker', { isRunning: true }]]);
    view.rerender(<AppBadgeAttentionSync />);
    expect(state.publish).toHaveBeenLastCalledWith(expect.objectContaining({ count: 0 }));
    state.starting = new Set();
    state.running = new Map([['a', { isRunning: true }]]);
    state.background = new Set(['b', 'worker']);
    view.rerender(<AppBadgeAttentionSync />);
    expect(state.publish).toHaveBeenLastCalledWith(expect.objectContaining({ count: 0 }));
    state.running = new Map();
    state.background = new Set();
    view.rerender(<AppBadgeAttentionSync />);
    expect(state.publish).toHaveBeenLastCalledWith(expect.objectContaining({ count: 3 }));
  });

  it.each(['running', 'starting', 'background'] as const)(
    'promotes %s workers without broadening operation guards',
    (source) => {
      const running = new Set(source === 'running' ? ['worker'] : []);
      state.starting = new Set(source === 'starting' ? ['worker'] : []);
      state.background = new Set(source === 'background' ? ['worker'] : []);
      state.workers = new Map([['lead', new Set(['worker'])]]);
      const { result } = renderHook(() =>
        useSessionDisplayRunningState(
          [{ id: 'lead' } as Parameters<typeof useSessionDisplayRunningState>[0][number]],
          running,
        ),
      );
      expect(result.current.displayRunningSessionIds.has('lead')).toBe(true);
      expect(result.current.effectiveRunningSessionIds.has('lead')).toBe(source === 'running');
      expect(running.has('lead')).toBe(false);
      expect(state.starting.has('lead')).toBe(false);
      expect(state.background.has('lead')).toBe(false);
    },
  );

  it('publishes current totals, retains them on focus and unmount, and resyncs on mount', () => {
    vi.stubGlobal('electronAPI', { notificationSetAppAttentionCount: state.publish });
    const view = render(<AppBadgeAttentionSync />);
    expect(state.publish).toHaveBeenLastCalledWith({
      count: 3,
      sessionIds: ['a', 'b', 'c'],
      dataOwnerId: 'owner-a',
      ownerGeneration: 1,
    });
    window.dispatchEvent(new Event('focus'));
    expect(state.publish).toHaveBeenCalledTimes(1);
    state.attention = new Map([
      ['b', 'done'],
      ['c', 'done'],
    ]);
    view.rerender(<AppBadgeAttentionSync />);
    expect(state.publish).toHaveBeenLastCalledWith(expect.objectContaining({ count: 2 }));
    view.unmount();
    expect(state.publish).toHaveBeenCalledTimes(2);
    render(<AppBadgeAttentionSync />);
    expect(state.publish).toHaveBeenLastCalledWith(expect.objectContaining({ count: 2 }));
    expect(state.publish).toHaveBeenCalledTimes(3);
  });

  it('waits for the initial task inventory instead of overwriting the badge while loading', () => {
    vi.stubGlobal('electronAPI', { notificationSetAppAttentionCount: state.publish });
    state.isLoading = true;
    const view = render(<AppBadgeAttentionSync />);
    expect(state.publish).not.toHaveBeenCalled();
    state.isLoading = false;
    view.rerender(<AppBadgeAttentionSync />);
    expect(state.publish).toHaveBeenLastCalledWith(expect.objectContaining({ count: 3 }));
  });
});

it('maps each unread chat once and fences all Bot lanes out of event-backed Dock attention', () => {
  vi.stubGlobal('electronAPI', { notificationSetAppAttentionCount: state.publish });
  botState.bots = [
    { id: 'bot', status: 'active', sessions: [{ id: 'canonical' }, { id: 'group-lane' }] },
    { id: 'hidden', hiddenAt: 100, sessions: [{ id: 'hidden-chat' }] },
    { id: 'archived', status: 'archived', sessions: [{ id: 'old-chat' }] },
  ];
  botState.unread = { bot: 8, hidden: 3, archived: 2 };
  const view = render(<AppBadgeAttentionSync />);
  expect(state.publish).toHaveBeenLastCalledWith(expect.objectContaining({ count: 4,
    sessionIds: expect.arrayContaining(['canonical', 'group-lane', 'hidden-chat', 'old-chat']) }));
  botState.unread = {};
  view.rerender(<AppBadgeAttentionSync />);
  expect(state.publish).toHaveBeenLastCalledWith(expect.objectContaining({ count: 3 }));
});

it('excludes archived group unread state from the app badge', () => {
  vi.stubGlobal('electronAPI', { notificationSetAppAttentionCount: state.publish });
  botState.groups = [
    { id: 'active-group', archived: false },
    { id: 'archived-group', archived: true },
  ];
  botState.unreadGroups = new Set(['active-group', 'archived-group']);
  render(<AppBadgeAttentionSync />);
  expect(state.publish).toHaveBeenLastCalledWith(expect.objectContaining({ count: 4 }));
});

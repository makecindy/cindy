// @vitest-environment jsdom
import { cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  sessions: ['a', 'b', 'c'].map((id) => ({ id, status: 'active' })),
  remoteSessions: [] as { id: string; status: string }[],
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
  publish: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({}) }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => state.owner }));
vi.mock('@/lib/sessionStartingStore', () => ({ useStartingSessionIds: () => state.starting }));
vi.mock('@/lib/sessionBackgroundActivityStore', () => ({
  useBackgroundActivitySessionIds: () => state.background,
}));
vi.mock('@/features/cc-agent/hooks/useOrcaLeadWorkerMap', () => ({
  useOrcaLeadWorkerMap: (sessions: { id: string }[]) =>
    new Map([...state.workers].filter(([lead]) => sessions.some((session) => session.id === lead))),
}));

vi.mock('@/hooks/useCCSessions', () => ({
  useCCSessions: () => ({ sessions: state.sessions, isLoading: state.isLoading, error: null }),
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  useRemoteProjectSessions: () => state.remoteSessions,
  useRemoteScheduleIndex: () => state.empty,
}));
vi.mock('@/features/cc-agent/hooks/useAutomationScheduleSessionIndex', () => ({
  usePublishedAutomationScheduleSessionIndex: () => state.empty,
}));
vi.mock('@/features/device-link/remoteSessionActivityStore', () => ({
  getRemoteSessionActivity: () => undefined,
  useRemoteSessionActivityRevision: () => 0,
}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: { subscribeAll: () => () => {}, getRunningSnapshot: () => state.running },
}));
vi.mock('@/lib/sessionAttentionStore', () => ({ useSessionAttentionKinds: () => state.attention }));
vi.mock('@/state/agentIslandActivity', () => ({ useAgentIslandActivityMap: () => state.empty }));
vi.mock('@/lib/orcaSessionIdentity', () => ({ isOrcaWorkerSession: () => false }));

import { AppBadgeAttentionSync } from '../components/layout/AppBadgeAttentionSync';
import { useSessionDisplayRunningState } from '../features/cc-agent/hooks/useSessionDisplayRunningState';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  state.publish.mockClear();
  state.isLoading = false;
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
  it('includes remote leads when projecting active workers', () => {
    vi.stubGlobal('electronAPI', { notificationSetAppAttentionCount: state.publish });
    state.remoteSessions = [{ id: 'remote-lead', status: 'active' }];
    state.attention.set('remote-lead', 'done');
    state.workers = new Map([['remote-lead', new Set(['remote-worker'])]]);
    state.starting = new Set(['remote-worker']);
    const view = render(<AppBadgeAttentionSync />);
    expect(state.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ count: 3, sessionIds: ['a', 'b', 'c', 'remote-lead'] }),
    );
    state.starting = new Set();
    view.rerender(<AppBadgeAttentionSync />);
    expect(state.publish).toHaveBeenLastCalledWith(expect.objectContaining({ count: 4 }));
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

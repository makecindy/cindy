// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  sessions: ['a', 'b', 'c'].map((id) => ({ id, status: 'active' })),
  attention: new Map<string, string>([
    ['a', 'done'],
    ['b', 'done'],
    ['c', 'done'],
  ]),
  empty: new Map(),
  isLoading: false,
  publish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/useCCSessions', () => ({
  useCCSessions: () => ({ sessions: state.sessions, isLoading: state.isLoading, error: null }),
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  useRemoteProjectSessions: () => [],
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
  makerChatStore: { subscribeAll: () => () => {}, getRunningSnapshot: () => state.empty },
}));
vi.mock('@/lib/sessionAttentionStore', () => ({ useSessionAttentionKinds: () => state.attention }));
vi.mock('@/state/agentIslandActivity', () => ({ useAgentIslandActivityMap: () => state.empty }));
vi.mock('@/lib/orcaSessionIdentity', () => ({ isOrcaWorkerSession: () => false }));

import { AppBadgeAttentionSync } from '../components/layout/AppBadgeAttentionSync';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  state.publish.mockClear();
  state.isLoading = false;
  state.attention = new Map([
    ['a', 'done'],
    ['b', 'done'],
    ['c', 'done'],
  ]);
});

describe('app badge projection lifecycle', () => {
  it('publishes current totals, retains them on focus and unmount, and resyncs on mount', () => {
    vi.stubGlobal('electronAPI', { notificationSetAppAttentionCount: state.publish });
    const view = render(<AppBadgeAttentionSync />);
    expect(state.publish).toHaveBeenLastCalledWith(3);
    window.dispatchEvent(new Event('focus'));
    expect(state.publish).toHaveBeenCalledTimes(1);
    state.attention = new Map([
      ['b', 'done'],
      ['c', 'done'],
    ]);
    view.rerender(<AppBadgeAttentionSync />);
    expect(state.publish).toHaveBeenLastCalledWith(2);
    view.unmount();
    expect(state.publish).toHaveBeenCalledTimes(2);
    render(<AppBadgeAttentionSync />);
    expect(state.publish).toHaveBeenLastCalledWith(2);
    expect(state.publish).toHaveBeenCalledTimes(3);
  });

  it('waits for the initial task inventory instead of overwriting the badge while loading', () => {
    vi.stubGlobal('electronAPI', { notificationSetAppAttentionCount: state.publish });
    state.isLoading = true;
    const view = render(<AppBadgeAttentionSync />);
    expect(state.publish).not.toHaveBeenCalled();
    state.isLoading = false;
    view.rerender(<AppBadgeAttentionSync />);
    expect(state.publish).toHaveBeenLastCalledWith(3);
  });
});

// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  setStatus: vi.fn(),
  refreshSessions: vi.fn(),
  emitRefresh: vi.fn(),
  patchLocal: vi.fn(),
  beginStatusTransition: vi.fn(),
  hasPendingStatusTransition: vi.fn(),
  waitForStatusTransition: vi.fn(),
  completeStatusTransition: vi.fn(),
  rollbackStatusTransition: vi.fn(),
  getStickySessionDeviceId: vi.fn(),
  closeSessionQuery: vi.fn(),
  purgeSession: vi.fn(),
  clearComposerDraft: vi.fn(),
  cleanupSessionLayoutPrefs: vi.fn(),
  cleanupSessionImages: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: mocks.toastError },
}));

vi.mock('@/lib/sessionService', () => ({
  setStatus: mocks.setStatus,
}));

vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    closeSessionQuery: mocks.closeSessionQuery,
    purgeSession: mocks.purgeSession,
  },
}));

vi.mock('@/lib/composerDraftStore', () => ({
  discardDraft: mocks.clearComposerDraft,
}));

vi.mock('@/lib/sessionLayoutPrefs', () => ({
  cleanupSessionLayoutPrefs: mocks.cleanupSessionLayoutPrefs,
}));

vi.mock('@/lib/sessionsBus', () => ({
  emitRefresh: mocks.emitRefresh,
}));

vi.mock('@/lib/sessionsStore', () => ({
  sessionsStore: {
    beginStatusTransition: mocks.beginStatusTransition,
    hasPendingStatusTransition: mocks.hasPendingStatusTransition,
    waitForStatusTransition: mocks.waitForStatusTransition,
    completeStatusTransition: mocks.completeStatusTransition,
    rollbackStatusTransition: mocks.rollbackStatusTransition,
  },
}));

vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: mocks.getStickySessionDeviceId,
}));

vi.mock('@/hooks/useCCSessions', () => ({
  useCCSessions: () => ({
    refreshSessions: mocks.refreshSessions,
    patchLocal: mocks.patchLocal,
  }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn() }),
}));

import { useSessionLifecycleActions } from '../useSessionLifecycleActions';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setStatus.mockImplementation(async (id: string, status: string) => ({
    id,
    status,
    title: `title-${id}`,
    updatedAt: '2026-08-27T00:00:00.000Z',
  }));
  mocks.beginStatusTransition.mockImplementation((sessionId: string) => ({
    sessionId,
    token: 1,
  }));
  mocks.hasPendingStatusTransition.mockReturnValue(false);
  mocks.waitForStatusTransition.mockResolvedValue(true);
  mocks.completeStatusTransition.mockReturnValue(true);
  mocks.rollbackStatusTransition.mockReturnValue(true);
  mocks.getStickySessionDeviceId.mockReturnValue(undefined);
  mocks.refreshSessions.mockResolvedValue([]);
  mocks.cleanupSessionImages.mockResolvedValue(undefined);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { cleanupSessionImages: mocks.cleanupSessionImages },
  });
});

describe('useSessionLifecycleActions archive optimistic ordering', () => {
  it('drops the row before navigating away when the row leaves the list', async () => {
    // active 桶:store 已把行就地移出,高亮随行消失 → 先让行消失,别把
    // navigate 的整屏视图切换同步渲染堵在前面。
    const { result } = renderHook(() =>
      useSessionLifecycleActions({ includeArchived: 'active' }),
    );

    await act(async () => {
      await result.current.runSessionAction('session-1', 'archive', {
        activeSessionId: 'session-1',
      });
    });

    expect(mocks.beginStatusTransition).toHaveBeenCalledWith('session-1', {
      status: 'archived',
      pinnedAt: null,
    });
    expect(mocks.beginStatusTransition.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.navigate.mock.invocationCallOrder[0],
    );
    expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/new');
    expect(mocks.completeStatusTransition).toHaveBeenCalledWith(
      { sessionId: 'session-1', token: 1 },
      expect.objectContaining({ id: 'session-1', status: 'archived' }),
    );
    expect(mocks.emitRefresh).not.toHaveBeenCalled();
    expect(mocks.refreshSessions).not.toHaveBeenCalled();
  });

  it('navigates first when the archived row stays visible in the all bucket', async () => {
    // 'all' 桶:行只是重排到归档段,还在列表里 → 必须先 paint 掉 isActive 高亮,
    // 否则会看到"归档后的行在新位置还高亮"。
    const { result } = renderHook(() => useSessionLifecycleActions({ includeArchived: 'all' }));

    await act(async () => {
      await result.current.runSessionAction('session-1', 'archive', {
        activeSessionId: 'session-1',
      });
    });

    expect(mocks.navigate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.beginStatusTransition.mock.invocationCallOrder[0],
    );
  });

  it('does not navigate when archiving a session that is not the active one', async () => {
    const { result } = renderHook(() =>
      useSessionLifecycleActions({ includeArchived: 'active' }),
    );

    await act(async () => {
      await result.current.runSessionAction('session-1', 'archive', {
        activeSessionId: 'other-session',
      });
    });

    expect(mocks.beginStatusTransition).toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('patches optimistically before the status write, and rolls back when it fails', async () => {
    mocks.setStatus.mockRejectedValueOnce(new Error('write failed'));
    const { result } = renderHook(() =>
      useSessionLifecycleActions({ includeArchived: 'active' }),
    );

    await act(async () => {
      await result.current.runSessionAction('session-1', 'archive', {
        activeSessionId: null,
      });
    });

    expect(mocks.beginStatusTransition).toHaveBeenCalledWith('session-1', {
      status: 'archived',
      pinnedAt: null,
    });
    expect(mocks.beginStatusTransition.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setStatus.mock.invocationCallOrder[0],
    );
    expect(mocks.rollbackStatusTransition).toHaveBeenCalledWith({
      sessionId: 'session-1',
      token: 1,
    });
    expect(mocks.toastError).toHaveBeenCalledWith('ccAgent.sidebar.archiveFailed');
    expect(mocks.purgeSession).not.toHaveBeenCalled();
  });

  it('does not turn consecutive archives into global or current-bucket refreshes', async () => {
    const { result } = renderHook(() =>
      useSessionLifecycleActions({ includeArchived: 'active' }),
    );

    await act(async () => {
      await result.current.runSessionAction('session-1', 'archive', { activeSessionId: null });
      await result.current.runSessionAction('session-2', 'archive', { activeSessionId: null });
      await result.current.runSessionAction('session-3', 'archive', { activeSessionId: null });
    });

    expect(mocks.setStatus).toHaveBeenCalledTimes(3);
    expect(mocks.beginStatusTransition).toHaveBeenCalledTimes(3);
    expect(mocks.completeStatusTransition).toHaveBeenCalledTimes(3);
    expect(mocks.emitRefresh).not.toHaveBeenCalled();
    expect(mocks.refreshSessions).not.toHaveBeenCalled();
  });

  it('waits for an in-flight restore before starting the opposite archive write', async () => {
    mocks.hasPendingStatusTransition.mockReturnValue(true);
    const { result } = renderHook(() =>
      useSessionLifecycleActions({ includeArchived: 'all' }),
    );

    await act(async () => {
      await result.current.runSessionAction('session-1', 'archive', {
        activeSessionId: null,
      });
    });

    expect(mocks.waitForStatusTransition).toHaveBeenCalledWith('session-1');
    expect(mocks.waitForStatusTransition.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.beginStatusTransition.mock.invocationCallOrder[0],
    );
    expect(mocks.beginStatusTransition.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setStatus.mock.invocationCallOrder[0],
    );
  });

  it('leaves device-link archive convergence to the remote mirror', async () => {
    mocks.getStickySessionDeviceId.mockReturnValue('device-1');
    const { result } = renderHook(() =>
      useSessionLifecycleActions({ includeArchived: 'active' }),
    );

    await act(async () => {
      await result.current.runSessionAction('remote-session', 'archive', {
        activeSessionId: null,
      });
    });

    expect(mocks.setStatus).toHaveBeenCalledWith('remote-session', 'archived');
    expect(mocks.beginStatusTransition).not.toHaveBeenCalled();
    expect(mocks.completeStatusTransition).not.toHaveBeenCalled();
    expect(mocks.patchLocal).not.toHaveBeenCalled();
  });
});

describe('useSessionLifecycleActions delete cache invalidation', () => {
  it('patches every loaded status bucket only after the delete write succeeds', async () => {
    const { result } = renderHook(() => useSessionLifecycleActions({ includeArchived: 'all' }));

    await act(async () => {
      await result.current.runSessionAction('session-1', 'delete', { activeSessionId: null });
    });

    expect(mocks.setStatus).toHaveBeenCalledWith('session-1', 'deleted');
    expect(mocks.patchLocal).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ id: 'session-1', status: 'deleted' }),
    );
    expect(mocks.setStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.patchLocal.mock.invocationCallOrder[0],
    );
    expect(mocks.emitRefresh).not.toHaveBeenCalled();
    expect(mocks.refreshSessions).not.toHaveBeenCalled();
  });

  it('keeps cached sessions unchanged when the delete write fails', async () => {
    mocks.setStatus.mockRejectedValueOnce(new Error('write failed'));
    const { result } = renderHook(() => useSessionLifecycleActions({ includeArchived: 'all' }));

    await act(async () => {
      await result.current.runSessionAction('session-1', 'delete', { activeSessionId: null });
    });

    expect(mocks.patchLocal).not.toHaveBeenCalled();
    expect(mocks.emitRefresh).not.toHaveBeenCalled();
    expect(mocks.purgeSession).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('ccAgent.sidebar.deleteFailed');
  });
});

describe('useSessionLifecycleActions unarchive convergence', () => {
  it('waits for an in-flight archive before starting the opposite write', async () => {
    mocks.hasPendingStatusTransition.mockReturnValue(true);
    const { result } = renderHook(() =>
      useSessionLifecycleActions({ includeArchived: 'archived' }),
    );

    await act(async () => {
      await result.current.unarchiveSession('session-1');
    });

    expect(mocks.waitForStatusTransition).toHaveBeenCalledWith('session-1');
    expect(mocks.waitForStatusTransition.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.beginStatusTransition.mock.invocationCallOrder[0],
    );
    expect(mocks.beginStatusTransition.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setStatus.mock.invocationCallOrder[0],
    );
  });

  it('stops a queued restore when the session store resets', async () => {
    mocks.hasPendingStatusTransition.mockReturnValue(true);
    mocks.waitForStatusTransition.mockResolvedValueOnce(false);
    const { result } = renderHook(() =>
      useSessionLifecycleActions({ includeArchived: 'archived' }),
    );

    await act(async () => {
      await result.current.unarchiveSession('session-1');
    });

    expect(mocks.beginStatusTransition).not.toHaveBeenCalled();
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it('uses a serialized local transition and the persisted row without refreshing', async () => {
    const { result } = renderHook(() =>
      useSessionLifecycleActions({ includeArchived: 'archived' }),
    );

    await act(async () => {
      await result.current.unarchiveSession('session-1');
    });

    expect(mocks.beginStatusTransition).toHaveBeenCalledWith('session-1', {
      status: 'active',
    });
    expect(mocks.beginStatusTransition.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setStatus.mock.invocationCallOrder[0],
    );
    expect(mocks.completeStatusTransition).toHaveBeenCalledWith(
      { sessionId: 'session-1', token: 1 },
      expect.objectContaining({ id: 'session-1', status: 'active' }),
    );
    expect(mocks.emitRefresh).not.toHaveBeenCalled();
    expect(mocks.refreshSessions).not.toHaveBeenCalled();
  });

  it('rolls back every loaded local bucket when the restore write fails', async () => {
    mocks.setStatus.mockRejectedValueOnce(new Error('write failed'));
    const { result } = renderHook(() =>
      useSessionLifecycleActions({ includeArchived: 'archived' }),
    );

    await act(async () => {
      await result.current.unarchiveSession('session-1');
    });

    expect(mocks.rollbackStatusTransition).toHaveBeenCalledWith({
      sessionId: 'session-1',
      token: 1,
    });
    expect(mocks.refreshSessions).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('ccAgent.sidebar.unarchiveFailed');
  });

  it('leaves device-link restore convergence to the remote mirror', async () => {
    mocks.getStickySessionDeviceId.mockReturnValue('device-1');
    const { result } = renderHook(() =>
      useSessionLifecycleActions({ includeArchived: 'archived' }),
    );

    await act(async () => {
      await result.current.unarchiveSession('remote-session');
    });

    expect(mocks.setStatus).toHaveBeenCalledWith('remote-session', 'active');
    expect(mocks.beginStatusTransition).not.toHaveBeenCalled();
    expect(mocks.completeStatusTransition).not.toHaveBeenCalled();
    expect(mocks.patchLocal).not.toHaveBeenCalled();
    expect(mocks.refreshSessions).not.toHaveBeenCalled();
  });
});

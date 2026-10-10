// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  setStatus: vi.fn(),
  resolveStatusWriteTarget: vi.fn(),
  refreshSessions: vi.fn(),
  emitRefresh: vi.fn(),
  patchLocal: vi.fn(),
  beginStatusTransition: vi.fn(),
  beginStatusTransitionWhenReady: vi.fn(),
  completeStatusTransition: vi.fn(),
  rollbackStatusTransition: vi.fn(),
  closeSessionQuery: vi.fn(),
  purgeSession: vi.fn(),
  releaseRemoteArchivedTombstone: vi.fn(),
  beginPendingStatus: vi.fn(),
  completePendingStatus: vi.fn(),
  rollbackPendingStatus: vi.fn(),
  isPendingStatusCurrent: vi.fn(),
  clearComposerDraft: vi.fn(),
  cleanupSessionLayoutPrefs: vi.fn(),
  cleanupSessionImages: vi.fn(),
  toastError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
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
  resolveStatusWriteTarget: mocks.resolveStatusWriteTarget,
}));

vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    closeSessionQuery: mocks.closeSessionQuery,
    purgeSession: mocks.purgeSession,
    releaseRemoteArchivedTombstone: mocks.releaseRemoteArchivedTombstone,
  },
}));

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: {
    beginPendingStatus: mocks.beginPendingStatus,
    completePendingStatus: mocks.completePendingStatus,
    rollbackPendingStatus: mocks.rollbackPendingStatus,
    isPendingStatusCurrent: mocks.isPendingStatusCurrent,
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
    beginStatusTransitionWhenReady: mocks.beginStatusTransitionWhenReady,
    completeStatusTransition: mocks.completeStatusTransition,
    rollbackStatusTransition: mocks.rollbackStatusTransition,
  },
}));

vi.mock('@/hooks/useCCSessions', () => ({
  useCCSessions: () => ({
    refreshSessions: mocks.refreshSessions,
    patchLocal: mocks.patchLocal,
  }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: mocks.logInfo,
    warn: mocks.logWarn,
    error: mocks.logError,
  }),
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
  mocks.resolveStatusWriteTarget.mockResolvedValue({ kind: 'local' });
  mocks.beginStatusTransition.mockImplementation((sessionId: string) => ({
    sessionId,
    token: 1,
  }));
  mocks.beginStatusTransitionWhenReady.mockImplementation(
    async (sessionId: string, patch: unknown, apply?: (begin: () => unknown) => unknown) => {
      const begin = () => mocks.beginStatusTransition(sessionId, patch);
      return apply ? apply(begin) : begin();
    },
  );
  mocks.completeStatusTransition.mockReturnValue(true);
  mocks.beginPendingStatus.mockImplementation(
    (deviceId: string, sessionId: string, status: string) => ({ deviceId, sessionId, status }),
  );
  mocks.completePendingStatus.mockReturnValue(true);
  mocks.rollbackPendingStatus.mockReturnValue(true);
  mocks.isPendingStatusCurrent.mockReturnValue(true);
  mocks.rollbackStatusTransition.mockReturnValue(true);
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
    expect(mocks.logInfo).toHaveBeenCalledWith(
      'archive timing',
      expect.objectContaining({
        event: 'renderer.session.archive.timing',
        outcome: 'success',
        sessionId: 'session-1',
        deviceLink: false,
        preWriteMs: expect.any(Number),
        writeMs: expect.any(Number),
        convergeMs: expect.any(Number),
        cleanupMs: expect.any(Number),
        totalMs: expect.any(Number),
      }),
    );
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
    expect(mocks.logWarn).toHaveBeenCalledWith(
      'archive timing',
      expect.objectContaining({
        event: 'renderer.session.archive.timing',
        outcome: 'failed',
        sessionId: 'session-1',
        deviceLink: false,
        preWriteMs: expect.any(Number),
        writeMs: expect.any(Number),
        totalMs: expect.any(Number),
      }),
    );
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

  it('uses the serialized begin before starting the archive write', async () => {
    const { result } = renderHook(() =>
      useSessionLifecycleActions({ includeArchived: 'all' }),
    );

    await act(async () => {
      await result.current.runSessionAction('session-1', 'archive', {
        activeSessionId: null,
      });
    });

    expect(mocks.beginStatusTransitionWhenReady).toHaveBeenCalledWith(
      'session-1',
      { status: 'archived', pinnedAt: null },
      expect.any(Function),
    );
    expect(mocks.beginStatusTransition.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setStatus.mock.invocationCallOrder[0],
    );
  });

  it('converges a disabled remote-id collision through the local status buckets', async () => {
    mocks.resolveStatusWriteTarget.mockResolvedValueOnce({ kind: 'local' });
    const { result } = renderHook(() =>
      useSessionLifecycleActions({ includeArchived: 'active' }),
    );

    await act(async () => {
      await result.current.runSessionAction('copied-local-session', 'archive', {
        activeSessionId: null,
      });
    });

    expect(mocks.setStatus).toHaveBeenCalledWith('copied-local-session', 'archived', {
      kind: 'local',
    });
    expect(mocks.beginStatusTransition).toHaveBeenCalledWith('copied-local-session', {
      status: 'archived',
      pinnedAt: null,
    });
    expect(mocks.completeStatusTransition).toHaveBeenCalledWith(
      { sessionId: 'copied-local-session', token: 1 },
      expect.objectContaining({ id: 'copied-local-session', status: 'archived' }),
    );
  });

  it('hides a device-link row through the remote overlay before the write and completes it', async () => {
    mocks.resolveStatusWriteTarget.mockResolvedValueOnce({
      kind: 'device-link',
      deviceId: 'device-1',
    });
    const { result } = renderHook(() =>
      useSessionLifecycleActions({ includeArchived: 'active' }),
    );

    await act(async () => {
      await result.current.runSessionAction('remote-session', 'archive', {
        activeSessionId: 'remote-session',
      });
    });

    const token = { deviceId: 'device-1', sessionId: 'remote-session', status: 'archived' };
    expect(mocks.beginPendingStatus).toHaveBeenCalledWith('device-1', 'remote-session', 'archived');
    expect(mocks.beginPendingStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.navigate.mock.invocationCallOrder[0],
    );
    expect(mocks.beginPendingStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setStatus.mock.invocationCallOrder[0],
    );
    expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/new');
    expect(mocks.setStatus).toHaveBeenCalledWith('remote-session', 'archived', {
      kind: 'device-link',
      deviceId: 'device-1',
    });
    expect(mocks.completePendingStatus).toHaveBeenCalledWith(
      token,
      expect.objectContaining({ id: 'remote-session', status: 'archived' }),
    );
    expect(mocks.beginStatusTransition).not.toHaveBeenCalled();
    expect(mocks.patchLocal).not.toHaveBeenCalled();
    expect(mocks.logInfo).toHaveBeenCalledWith(
      'archive timing',
      expect.objectContaining({ outcome: 'success', deviceLink: true }),
    );
  });

  it('drops a pre-begun remote archive that a later restore superseded during the preflight', async () => {
    mocks.resolveStatusWriteTarget.mockResolvedValue({ kind: 'device-link', deviceId: 'device-1' });
    // 「全部」筛选里预检期间用户已点了恢复:预先隐藏的归档凭据已被取代。
    mocks.isPendingStatusCurrent.mockReturnValue(false);
    const token = { deviceId: 'device-1', sessionId: 'remote-session', status: 'archived' as const };
    const { result } = renderHook(() => useSessionLifecycleActions({ includeArchived: 'all' }));

    await act(async () => {
      await result.current.runSessionAction('remote-session', 'archive', {
        activeSessionId: null,
        remoteArchiveToken: token,
      });
    });

    expect(mocks.isPendingStatusCurrent).toHaveBeenCalledWith(token);
    expect(mocks.setStatus).not.toHaveBeenCalled();
    expect(mocks.completePendingStatus).not.toHaveBeenCalled();
    expect(mocks.rollbackPendingStatus).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('sends an unarchive only after the in-flight remote archive of the same task settles', async () => {
    const target = { kind: 'device-link', deviceId: 'device-1' };
    mocks.resolveStatusWriteTarget.mockResolvedValue(target);
    let releaseArchive!: () => void;
    mocks.setStatus.mockImplementationOnce(
      (id: string, status: string) =>
        new Promise((resolve) => {
          releaseArchive = () => resolve({ id, status, title: id });
        }),
    );
    const { result } = renderHook(() => useSessionLifecycleActions({ includeArchived: 'all' }));

    let archiving!: Promise<void>;
    let unarchiving!: Promise<void>;
    await act(async () => {
      archiving = result.current.runSessionAction('remote-session', 'archive', {
        activeSessionId: null,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      unarchiving = result.current.unarchiveSession('remote-session');
      await Promise.resolve();
      await Promise.resolve();
    });
    // 两次叠加层都已当帧切换,但恢复的写库要等归档那笔结算,被控端按操作顺序落库。
    expect(mocks.beginPendingStatus).toHaveBeenCalledWith('device-1', 'remote-session', 'active');
    expect(mocks.setStatus.mock.calls.map((call) => call[1])).toEqual(['archived']);

    await act(async () => {
      releaseArchive();
      await archiving;
      await unarchiving;
    });
    expect(mocks.setStatus.mock.calls.map((call) => call[1])).toEqual(['archived', 'active']);
  });

  it('rolls the device-link overlay back and reports when the remote write fails', async () => {
    mocks.resolveStatusWriteTarget.mockResolvedValueOnce({
      kind: 'device-link',
      deviceId: 'device-1',
    });
    mocks.setStatus.mockRejectedValueOnce(new Error('tunnel down'));
    const { result } = renderHook(() =>
      useSessionLifecycleActions({ includeArchived: 'active' }),
    );

    await act(async () => {
      await result.current.runSessionAction('remote-session', 'archive', {
        activeSessionId: null,
      });
    });

    expect(mocks.rollbackPendingStatus).toHaveBeenCalledWith({
      deviceId: 'device-1',
      sessionId: 'remote-session',
      status: 'archived',
    });
    expect(mocks.completePendingStatus).not.toHaveBeenCalled();
    expect(mocks.purgeSession).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('ccAgent.sidebar.archiveFailed');
    expect(mocks.logWarn).toHaveBeenCalledWith(
      'archive timing',
      expect.objectContaining({ outcome: 'failed', deviceLink: true }),
    );
  });

  it('reuses a pre-begun remote archive without hiding or navigating twice', async () => {
    mocks.resolveStatusWriteTarget.mockResolvedValue({
      kind: 'device-link',
      deviceId: 'device-1',
    });
    const { result } = renderHook(() =>
      useSessionLifecycleActions({ includeArchived: 'active' }),
    );

    let token: unknown;
    act(() => {
      token = result.current.beginRemoteArchive('remote-session', 'device-1', 'remote-session');
    });
    // 预检之前:行已消失、视图已跳离。
    expect(mocks.beginPendingStatus).toHaveBeenCalledTimes(1);
    expect(mocks.beginPendingStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.navigate.mock.invocationCallOrder[0],
    );
    expect(mocks.navigate).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.runSessionAction('remote-session', 'archive', {
        activeSessionId: 'remote-session',
        remoteArchiveToken: token as never,
      });
    });

    expect(mocks.beginPendingStatus).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.completePendingStatus).toHaveBeenCalledWith(
      token,
      expect.objectContaining({ status: 'archived' }),
    );
  });

  it('navigates before hiding a pre-begun remote row that stays in the all bucket', () => {
    const { result } = renderHook(() => useSessionLifecycleActions({ includeArchived: 'all' }));

    act(() => {
      result.current.beginRemoteArchive('remote-session', 'device-1', 'remote-session');
    });

    expect(mocks.navigate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.beginPendingStatus.mock.invocationCallOrder[0],
    );
  });

  it('restores a pre-begun remote row when the caller cancels', () => {
    const { result } = renderHook(() =>
      useSessionLifecycleActions({ includeArchived: 'active' }),
    );

    act(() => {
      const token = result.current.beginRemoteArchive('remote-session', 'device-1', null);
      result.current.cancelRemoteArchive(token);
    });

    expect(mocks.rollbackPendingStatus).toHaveBeenCalledWith({
      deviceId: 'device-1',
      sessionId: 'remote-session',
      status: 'archived',
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it('drops a pre-begun remote overlay when the write resolves to a local row', async () => {
    mocks.resolveStatusWriteTarget.mockResolvedValueOnce({ kind: 'local' });
    const { result } = renderHook(() =>
      useSessionLifecycleActions({ includeArchived: 'active' }),
    );
    const token = { deviceId: 'device-1', sessionId: 'copied', status: 'archived' as const };

    await act(async () => {
      await result.current.runSessionAction('copied', 'archive', {
        activeSessionId: null,
        remoteArchiveToken: token,
      });
    });

    expect(mocks.rollbackPendingStatus).toHaveBeenCalledWith(token);
    expect(mocks.beginStatusTransition).toHaveBeenCalledWith('copied', {
      status: 'archived',
      pinnedAt: null,
    });
    expect(mocks.completePendingStatus).not.toHaveBeenCalled();
  });
});

describe('useSessionLifecycleActions delete cache invalidation', () => {
  it('patches every loaded status bucket only after the delete write succeeds', async () => {
    const { result } = renderHook(() => useSessionLifecycleActions({ includeArchived: 'all' }));

    await act(async () => {
      await result.current.runSessionAction('session-1', 'delete', { activeSessionId: null });
    });

    expect(mocks.setStatus).toHaveBeenCalledWith('session-1', 'deleted', { kind: 'local' });
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
  it('uses the serialized begin before starting the restore write', async () => {
    const { result } = renderHook(() =>
      useSessionLifecycleActions({ includeArchived: 'archived' }),
    );

    await act(async () => {
      await result.current.unarchiveSession('session-1');
    });

    expect(mocks.beginStatusTransitionWhenReady).toHaveBeenCalledWith('session-1', {
      status: 'active',
    });
    expect(mocks.beginStatusTransition.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setStatus.mock.invocationCallOrder[0],
    );
  });

  it('stops a queued restore when the session store resets', async () => {
    mocks.beginStatusTransitionWhenReady.mockResolvedValueOnce(null);
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

  it('restores a device-link row optimistically and releases the archived tombstone', async () => {
    mocks.resolveStatusWriteTarget.mockResolvedValueOnce({
      kind: 'device-link',
      deviceId: 'device-1',
    });
    const { result } = renderHook(() =>
      useSessionLifecycleActions({ includeArchived: 'archived' }),
    );

    await act(async () => {
      await result.current.unarchiveSession('remote-session');
    });

    const token = { deviceId: 'device-1', sessionId: 'remote-session', status: 'active' };
    expect(mocks.beginPendingStatus).toHaveBeenCalledWith('device-1', 'remote-session', 'active');
    expect(mocks.beginPendingStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setStatus.mock.invocationCallOrder[0],
    );
    expect(mocks.releaseRemoteArchivedTombstone).toHaveBeenCalledWith(
      'remote-session',
      'device-1',
    );
    expect(mocks.completePendingStatus).toHaveBeenCalledWith(
      token,
      expect.objectContaining({ id: 'remote-session', status: 'active' }),
    );
    expect(mocks.beginStatusTransition).not.toHaveBeenCalled();
    expect(mocks.patchLocal).not.toHaveBeenCalled();
    expect(mocks.refreshSessions).not.toHaveBeenCalled();
  });

  it('rolls a failed device-link restore back without releasing the tombstone', async () => {
    mocks.resolveStatusWriteTarget.mockResolvedValueOnce({
      kind: 'device-link',
      deviceId: 'device-1',
    });
    mocks.setStatus.mockRejectedValueOnce(new Error('tunnel down'));
    const { result } = renderHook(() =>
      useSessionLifecycleActions({ includeArchived: 'archived' }),
    );

    await act(async () => {
      await result.current.unarchiveSession('remote-session');
    });

    expect(mocks.rollbackPendingStatus).toHaveBeenCalledWith({
      deviceId: 'device-1',
      sessionId: 'remote-session',
      status: 'active',
    });
    expect(mocks.releaseRemoteArchivedTombstone).not.toHaveBeenCalled();
    expect(mocks.completePendingStatus).not.toHaveBeenCalled();
    expect(mocks.refreshSessions).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('ccAgent.sidebar.unarchiveFailed');
  });
});

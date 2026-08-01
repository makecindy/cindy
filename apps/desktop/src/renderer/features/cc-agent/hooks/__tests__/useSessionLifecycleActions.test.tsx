// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  setStatus: vi.fn(),
  refreshSessions: vi.fn(),
  emitRefresh: vi.fn(),
  patchLocal: vi.fn(),
  closeSessionQuery: vi.fn(),
  purgeSession: vi.fn(),
  clearComposerDraft: vi.fn(),
  cleanupSessionLayoutPrefs: vi.fn(),
  refreshWorktrees: vi.fn(),
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
  clearDraft: mocks.clearComposerDraft,
}));

vi.mock('@/lib/sessionLayoutPrefs', () => ({
  cleanupSessionLayoutPrefs: mocks.cleanupSessionLayoutPrefs,
}));

vi.mock('@/lib/sessionsBus', () => ({
  emitRefresh: mocks.emitRefresh,
}));

vi.mock('@/hooks/useCCSessions', () => ({
  useCCSessions: () => ({
    refreshSessions: mocks.refreshSessions,
    patchLocal: mocks.patchLocal,
  }),
}));

vi.mock('@/contexts/WorktreeContext', () => ({
  useRefreshWorktrees: () => mocks.refreshWorktrees,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn() }),
}));

import { useSessionLifecycleActions } from '../useSessionLifecycleActions';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setStatus.mockResolvedValue({});
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

    expect(mocks.patchLocal).toHaveBeenCalledWith('session-1', {
      status: 'archived',
      pinnedAt: null,
    });
    expect(mocks.patchLocal.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.navigate.mock.invocationCallOrder[0],
    );
    expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/new');
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
      mocks.patchLocal.mock.invocationCallOrder[0],
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

    expect(mocks.patchLocal).toHaveBeenCalled();
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

    expect(mocks.patchLocal.mock.calls).toEqual([
      ['session-1', { status: 'archived', pinnedAt: null }],
      ['session-1', { status: 'active' }],
    ]);
    expect(mocks.patchLocal.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setStatus.mock.invocationCallOrder[0],
    );
    expect(mocks.toastError).toHaveBeenCalledWith('ccAgent.sidebar.archiveFailed');
    expect(mocks.purgeSession).not.toHaveBeenCalled();
  });
});

describe('useSessionLifecycleActions delete cache invalidation', () => {
  it('patches every loaded status bucket only after the delete write succeeds', async () => {
    const { result } = renderHook(() => useSessionLifecycleActions({ includeArchived: 'all' }));

    await act(async () => {
      await result.current.runSessionAction('session-1', 'delete', { activeSessionId: null });
    });

    expect(mocks.setStatus).toHaveBeenCalledWith('session-1', 'deleted');
    expect(mocks.patchLocal).toHaveBeenCalledWith('session-1', { status: 'deleted' });
    expect(mocks.setStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.patchLocal.mock.invocationCallOrder[0],
    );
    // 兜底重拉走 emitRefresh(强制重拉所有已加载桶),不是只刷当前桶的
    // refreshSessions —— 见 hook 里关于 archived 目标桶的注释。
    expect(mocks.patchLocal.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.emitRefresh.mock.invocationCallOrder[0],
    );
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

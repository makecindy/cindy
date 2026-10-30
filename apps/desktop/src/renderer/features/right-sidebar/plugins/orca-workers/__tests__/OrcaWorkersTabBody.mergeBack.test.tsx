// @vitest-environment jsdom

/**
 * 分离侧栏窗口「在主窗口查看」Worker：意图写进协同 tab 状态后再合并回主窗，
 * 主窗靠这份状态选中该 Worker。用真实 store 验证交接内容与先后顺序。
 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrcaWorkersTabBody } from '../OrcaWorkersTabBody';
import type { OrcaWorkersState } from '../actions';
import { _resetStore, ensureHydrated, getBucket, importTabSnapshot } from '../../../store';

const mocks = vi.hoisted(() => ({
  panelProps: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/sidebarWindow', () => ({ isSidebarWindow: () => true }));
vi.mock('@/hooks/useCCSessions', () => ({
  useCCSessions: () => ({ sessions: [], isLoading: false }),
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  useRemoteProjectSessions: () => [],
  getSessionDeviceId: () => undefined,
}));
vi.mock('@/hooks/useWindowVisible', () => ({
  useWindowVisible: () => true,
  useDocumentVisible: () => true,
}));
vi.mock('@/features/cc-agent/hooks/useOrcaWorkerAttentionWatcher', () => ({
  useOrcaWorkerAttentionByLeadIds: vi.fn(),
}));
vi.mock('@/features/cc-agent/hooks/useStopOrcaCollab', () => ({
  useStopOrcaCollabWithoutNavigation: () => ({ requestStop: vi.fn() }),
}));
vi.mock('@/features/cc-agent/hooks/workerProjectionStore', () => ({
  useWorkerProjectionOwner: vi.fn(),
  revalidateActiveWorkersProjection: vi.fn(),
  revalidateActiveWorkerSettings: vi.fn(),
}));
vi.mock('@/features/cc-agent/OrcaWorkerPanel', () => ({
  OrcaWorkerPanel: (props: Record<string, unknown>) => {
    mocks.panelProps = props;
    return null;
  },
}));

const ctx = {
  tabId: 'orca-tab',
  sessionId: 'lead-1',
  workdir: '/projects/lead',
  remoteHostId: null,
  deviceLinkDeviceId: null,
  patchState: vi.fn(),
  onVisibilityChange: vi.fn(),
  setCloseInterceptor: vi.fn(() => vi.fn()),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function orcaTabState(): OrcaWorkersState {
  return getBucket('lead-1').tabs.find((tab) => tab.id === 'orca-tab')?.state as OrcaWorkersState;
}

function panelProp<T>(name: string): T {
  return mocks.panelProps?.[name] as T;
}

describe('OrcaWorkersTabBody view Worker in main window', () => {
  let setDetached: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetStore();
    mocks.panelProps = null;
    setDetached = vi.fn().mockResolvedValue({ detached: false, lastOpen: true, open: false });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      platform: 'darwin',
      rightSidebarWindow: { setDetached },
    };
  });

  afterEach(() => {
    cleanup();
    _resetStore();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('hands the Worker selection intent to the main window with the memory-only tab snapshot', async () => {
    importTabSnapshot({
      sessionId: 'lead-1',
      tabs: [{ id: 'orca-tab', kind: 'orca-workers', state: {} }],
      activeTabId: 'orca-tab',
      persistable: false,
    });
    render(<OrcaWorkersTabBody ctx={ctx} state={{}} active />);

    act(() => {
      panelProp<(sessionId: string) => void>('onViewWorkerInMainWindow')('worker-s1');
      // 本窗的选择 hook 会在同一时刻看到新意图并尝试消费；合并期间不能把它清掉。
      panelProp<(revision: number) => void>('onFocusWorkerSessionIdConsumed')(1);
    });

    await waitFor(() => expect(setDetached).toHaveBeenCalledOnce());
    expect(setDetached).toHaveBeenCalledWith(false, {
      snapshots: [
        {
          sessionId: 'lead-1',
          tabs: [
            {
              id: 'orca-tab',
              kind: 'orca-workers',
              state: { focusWorkerSessionId: 'worker-s1', focusWorkerHintRevision: 1 },
            },
          ],
          activeTabId: 'orca-tab',
          persistable: false,
        },
      ],
    });
  });

  it('merges a persisted session only after the intent is written', async () => {
    const upsertDone = deferred<{ ok: true }>();
    const upsert = vi.fn(() => upsertDone.promise);
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI.localDb = {
      rightSidebarTabs: {
        list: vi.fn().mockResolvedValue({
          tabs: [{ id: 'orca-tab', kind: 'orca-workers', state: {} }],
          activeTabId: 'orca-tab',
        }),
        upsert,
      },
    };
    await ensureHydrated('lead-1');
    render(<OrcaWorkersTabBody ctx={ctx} state={{}} active />);

    act(() => {
      panelProp<(sessionId: string) => void>('onViewWorkerInMainWindow')('worker-s1');
    });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'orca-tab',
        sessionId: 'lead-1',
        state: { focusWorkerSessionId: 'worker-s1', focusWorkerHintRevision: 1 },
      }),
    );
    expect(setDetached).not.toHaveBeenCalled();

    await act(async () => upsertDone.resolve({ ok: true }));
    await waitFor(() => expect(setDetached).toHaveBeenCalledWith(false, undefined));
  });

  it('consumes the skipped intent after a failed merge and lets the user retry', async () => {
    importTabSnapshot({
      sessionId: 'lead-1',
      tabs: [{ id: 'orca-tab', kind: 'orca-workers', state: {} }],
      activeTabId: 'orca-tab',
      persistable: false,
    });
    setDetached.mockRejectedValueOnce(new Error('merge failed'));
    render(<OrcaWorkersTabBody ctx={ctx} state={{}} active />);

    act(() => {
      panelProp<(sessionId: string) => void>('onViewWorkerInMainWindow')('worker-s1');
      // 选择 hook 对这个 revision 只回调这一次，合并期间被跳过。
      panelProp<(revision: number) => void>('onFocusWorkerSessionIdConsumed')(1);
    });
    await waitFor(() => expect(setDetached).toHaveBeenCalledTimes(1));
    // 合并失败后不再有人回调消费，意图必须由失败路径自己清掉。
    await waitFor(() =>
      expect(orcaTabState()).toMatchObject({
        focusWorkerSessionId: null,
        focusWorkerHintRevision: 1,
      }),
    );

    act(() => {
      panelProp<(sessionId: string) => void>('onViewWorkerInMainWindow')('worker-s1');
    });
    await waitFor(() => expect(setDetached).toHaveBeenCalledTimes(2));
    expect(orcaTabState()).toMatchObject({
      focusWorkerSessionId: 'worker-s1',
      focusWorkerHintRevision: 2,
    });
  });
});

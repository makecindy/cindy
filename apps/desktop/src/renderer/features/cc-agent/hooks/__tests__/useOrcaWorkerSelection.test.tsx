// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerInfo } from '../useWorkers';
import {
  __resetWorkerAttentionStoreForTest,
  hasWorkerAttention,
  markWorkerAttention,
} from '../../lib/workerAttentionStore';

const mocks = vi.hoisted(() => ({
  workers: [] as WorkerInfo[],
  refresh: vi.fn(),
  createWorker: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => undefined),
  switchFocus: vi.fn(async () => undefined),
  idleWorker: vi.fn(async () => ({ ok: true as const, workerId: 'worker-b' })),
  toastError: vi.fn(),
}));

vi.mock('../useWorkers', () => ({
  useWorkers: () => ({
    workers: mocks.workers,
    focusedWorker: mocks.workers.find((worker) => worker.focused) ?? mocks.workers[0] ?? null,
    activeWorkerCount: mocks.workers.length,
    softLimit: 5,
    hardLimit: 8,
    refresh: mocks.refresh,
  }),
}));

vi.mock('@/lib/makerTransport', () => ({
  orcaWorkflowsFor: () => ({
    createWorker: mocks.createWorker,
    switchFocus: mocks.switchFocus,
    idleWorker: mocks.idleWorker,
    archiveWorker: vi.fn(async () => undefined),
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/toast', () => ({
  toast: {
    error: mocks.toastError,
  },
}));

import { useOrcaWorkerSelection as useOrcaWorkerSelectionImpl } from '../useOrcaWorkerSelection';

type TestSelectionOptions = Parameters<typeof useOrcaWorkerSelectionImpl>[0];

/** Most hook tests render an active worker pane; visibility-specific cases override this default. */
function useOrcaWorkerSelection(
  options: Omit<TestSelectionOptions, 'viewVisible'> & { viewVisible?: boolean },
) {
  return useOrcaWorkerSelectionImpl({
    ...options,
    viewVisible: options.viewVisible ?? true,
  });
}

function makeWorker(
  workerId: string,
  sessionId: string,
  focused = false,
  status: WorkerInfo['status'] = 'idle',
): WorkerInfo {
  return {
    workerId,
    sessionId,
    role: workerId,
    agent: 'codex',
    model: 'gpt-5.4',
    effort: null,
    label: null,
    status,
    focused,
    idleSince: null,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/cc-agent/lead-1']}>{children}</MemoryRouter>;
}

describe('useOrcaWorkerSelection', () => {
  beforeEach(() => {
    mocks.workers = [
      makeWorker('worker-a', 'session-a', true),
      makeWorker('worker-b', 'session-b'),
    ];
    mocks.refresh.mockClear();
    mocks.refresh.mockResolvedValue({
      leadSessionId: 'lead-1',
      requestId: 1,
      status: 'applied',
      workers: mocks.workers,
    });
    mocks.switchFocus.mockClear();
    mocks.idleWorker.mockClear();
    mocks.idleWorker.mockResolvedValue({ ok: true, workerId: 'worker-b' });
    mocks.toastError.mockClear();
    __resetWorkerAttentionStoreForTest();
    mocks.createWorker.mockReset().mockResolvedValue(undefined);
  });

  it('acknowledges a done worker after switching focus and clears attention after success', async () => {
    mocks.workers = [
      makeWorker('worker-a', 'session-a', true),
      makeWorker('worker-b', 'session-b', false, 'done'),
    ];
    markWorkerAttention('worker-b');
    const { result } = renderHook(
      () => useOrcaWorkerSelection({ leadSessionId: 'lead-1' }),
      { wrapper },
    );

    act(() => result.current.handleSwitchFocus('worker-b'));

    await waitFor(() => {
      expect(mocks.idleWorker).toHaveBeenCalledWith('lead-1', 'worker-b', 'done');
    });
    expect(hasWorkerAttention('worker-b')).toBe(false);
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it('silently keeps done attention and refreshes when acknowledgement loses a state race', async () => {
    mocks.workers = [
      makeWorker('worker-a', 'session-a', true),
      makeWorker('worker-b', 'session-b', false, 'done'),
    ];
    mocks.idleWorker.mockRejectedValueOnce(
      new Error('[WORKER_STATE_CHANGED] worker worker-b has a dispatch in progress'),
    );
    markWorkerAttention('worker-b');
    const { result } = renderHook(
      () => useOrcaWorkerSelection({ leadSessionId: 'lead-1' }),
      { wrapper },
    );

    act(() => result.current.handleSwitchFocus('worker-b'));

    await waitFor(() => {
      expect(mocks.idleWorker).toHaveBeenCalledWith('lead-1', 'worker-b', 'done');
    });
    expect(hasWorkerAttention('worker-b')).toBe(true);
    expect(mocks.refresh).toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('silently keeps done attention when the remote target lacks automatic-ack support', async () => {
    mocks.workers = [
      makeWorker('worker-a', 'session-a', true),
      makeWorker('worker-b', 'session-b', false, 'done'),
    ];
    mocks.idleWorker.mockRejectedValueOnce(
      new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] automatic done acknowledgement is unsupported'),
    );
    markWorkerAttention('worker-b');
    const { result } = renderHook(
      () => useOrcaWorkerSelection({ leadSessionId: 'lead-1' }),
      { wrapper },
    );

    act(() => result.current.handleSwitchFocus('worker-b'));

    await waitFor(() => {
      expect(mocks.idleWorker).toHaveBeenCalledWith('lead-1', 'worker-b', 'done');
    });
    expect(hasWorkerAttention('worker-b')).toBe(true);
    expect(mocks.refresh).toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('refreshes after switch focus even when done acknowledgement fails unexpectedly', async () => {
    mocks.workers = [
      makeWorker('worker-a', 'session-a', true),
      makeWorker('worker-b', 'session-b', false, 'done'),
    ];
    mocks.idleWorker.mockRejectedValueOnce(new Error('idle store unavailable'));
    markWorkerAttention('worker-b');
    const { result } = renderHook(
      () => useOrcaWorkerSelection({ leadSessionId: 'lead-1' }),
      { wrapper },
    );

    act(() => result.current.handleSwitchFocus('worker-b'));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(hasWorkerAttention('worker-b')).toBe(true);
    expect(mocks.toastError).toHaveBeenCalledWith('idle store unavailable');
  });

  it('does not idle a running worker when switching focus', async () => {
    mocks.workers = [
      makeWorker('worker-a', 'session-a', true),
      makeWorker('worker-b', 'session-b', false, 'running'),
    ];
    const { result } = renderHook(
      () => useOrcaWorkerSelection({ leadSessionId: 'lead-1' }),
      { wrapper },
    );

    act(() => result.current.handleSwitchFocus('worker-b'));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(mocks.idleWorker).not.toHaveBeenCalled();
  });

  it('does not issue duplicate done acknowledgements while the first one is pending', async () => {
    mocks.workers = [
      makeWorker('worker-a', 'session-a', true),
      makeWorker('worker-b', 'session-b', false, 'done'),
    ];
    let resolveIdle!: (value: { ok: true; workerId: string }) => void;
    mocks.idleWorker.mockReturnValueOnce(
      new Promise<{ ok: true; workerId: string }>((resolve) => {
        resolveIdle = resolve;
      }),
    );
    const { result } = renderHook(
      () => useOrcaWorkerSelection({ leadSessionId: 'lead-1' }),
      { wrapper },
    );

    act(() => {
      result.current.handleSwitchFocus('worker-b');
      result.current.handleSwitchFocus('worker-b');
    });

    await waitFor(() => expect(mocks.idleWorker).toHaveBeenCalledTimes(1));
    await act(async () => resolveIdle({ ok: true, workerId: 'worker-b' }));
  });

  it('acknowledges a done worker revealed by a focus hint', async () => {
    mocks.workers = [
      makeWorker('worker-a', 'session-a', true),
      makeWorker('worker-b', 'session-b', false, 'done'),
    ];
    markWorkerAttention('worker-b');

    renderHook(
      () =>
        useOrcaWorkerSelection({
          leadSessionId: 'lead-1',
          focusWorkerSessionId: 'session-b',
          focusWorkerHintRevision: 1,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(mocks.idleWorker).toHaveBeenCalledWith('lead-1', 'worker-b', 'done');
    });
    expect(hasWorkerAttention('worker-b')).toBe(false);
    expect(mocks.switchFocus).not.toHaveBeenCalled();
  });

  it('waits to acknowledge the selected done worker until the worker view is visible', async () => {
    mocks.workers = [makeWorker('worker-a', 'session-a', true, 'done')];
    markWorkerAttention('worker-a');

    const { rerender } = renderHook(
      ({ viewVisible }) =>
        useOrcaWorkerSelection({
          leadSessionId: 'lead-1',
          viewVisible,
        }),
      { initialProps: { viewVisible: false }, wrapper },
    );

    expect(mocks.idleWorker).not.toHaveBeenCalled();
    expect(hasWorkerAttention('worker-a')).toBe(true);

    rerender({ viewVisible: true });

    await waitFor(() => {
      expect(mocks.idleWorker).toHaveBeenCalledWith('lead-1', 'worker-a', 'done');
    });
    expect(hasWorkerAttention('worker-a')).toBe(false);
  });

  it('acknowledges a visible selected done worker without a reveal hint', async () => {
    mocks.workers = [makeWorker('worker-a', 'session-a', true, 'done')];
    markWorkerAttention('worker-a');

    renderHook(
      () => useOrcaWorkerSelection({ leadSessionId: 'lead-1', viewVisible: true }),
      { wrapper },
    );

    await waitFor(() => {
      expect(mocks.idleWorker).toHaveBeenCalledWith('lead-1', 'worker-a', 'done');
    });
    expect(hasWorkerAttention('worker-a')).toBe(false);
  });

  it('pins an explicit focusWorkerSessionId ahead of the current focused worker until the user switches', async () => {
    const consumed = vi.fn();
    const { result, rerender } = renderHook(
      ({ focusWorkerSessionId, focusWorkerHintRevision }) =>
        useOrcaWorkerSelection({
          leadSessionId: 'lead-1',
          focusWorkerSessionId,
          focusWorkerHintRevision,
          onFocusWorkerSessionIdConsumed: consumed,
        }),
      {
        initialProps: {
          focusWorkerSessionId: 'session-b' as string | null,
          focusWorkerHintRevision: 1,
        },
        wrapper,
      },
    );

    expect(result.current.workerSessionId).toBe('session-b');

    await waitFor(() => {
      expect(consumed).toHaveBeenCalledTimes(1);
    });

    rerender({ focusWorkerSessionId: null, focusWorkerHintRevision: 1 });

    expect(result.current.workerSessionId).toBe('session-b');

    act(() => {
      result.current.handleSwitchFocus('worker-a');
    });

    expect(result.current.workerSessionId).toBe('session-a');
    expect(mocks.switchFocus).toHaveBeenCalledWith({
      leadSessionId: 'lead-1',
      workerIdOrLabel: 'worker-a',
    });
  });

  it('advances to the next label when an archived worker owns the generated label', async () => {
    mocks.workers = [];
    mocks.createWorker
      .mockRejectedValueOnce(new Error('[DUPLICATE_LABEL] label already used'))
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(
      () => useOrcaWorkerSelection({ leadSessionId: 'lead-1' }),
      { wrapper },
    );

    await act(async () => {
      await result.current.handleCreateWorker({
        role: 'tester',
        agent: 'codex',
        model: 'gpt-5.4',
        providerId: null,
        initialTask: '',
      });
    });

    expect(mocks.createWorker.mock.calls.map(([input]) => input.label)).toEqual([
      'tester',
      'tester-2',
    ]);
  });

  it('does not create a suffixed worker while the same label is still being created', async () => {
    mocks.workers = [];
    mocks.createWorker.mockRejectedValueOnce(
      new Error('[WORKER_CREATION_IN_PROGRESS] label is currently being created'),
    );
    const { result } = renderHook(
      () => useOrcaWorkerSelection({ leadSessionId: 'lead-1' }),
      { wrapper },
    );

    await act(async () => {
      await result.current.handleCreateWorker({
        role: 'tester',
        agent: 'codex',
        model: 'gpt-5.4',
        providerId: null,
        initialTask: 'run once',
      });
    });

    expect(mocks.createWorker).toHaveBeenCalledTimes(1);
    expect(mocks.createWorker).toHaveBeenCalledWith(expect.objectContaining({ label: 'tester' }));
  });

  it('keeps a missing focusWorkerSessionId pending until the worker list refreshes', async () => {
    mocks.workers = [makeWorker('worker-a', 'session-a', true)];
    let resolveRefresh!: (value: unknown) => void;
    mocks.refresh.mockReset().mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const consumed = vi.fn();
    const { result, rerender } = renderHook(
      ({ focusWorkerSessionId, focusWorkerHintRevision }) =>
        useOrcaWorkerSelection({
          leadSessionId: 'lead-1',
          focusWorkerSessionId,
          focusWorkerHintRevision,
          onFocusWorkerSessionIdConsumed: consumed,
        }),
      {
        initialProps: {
          focusWorkerSessionId: 'session-b' as string | null,
          focusWorkerHintRevision: 1,
        },
        wrapper,
      },
    );

    expect(result.current.workerSessionId).toBeNull();

    await waitFor(() => {
      expect(consumed).toHaveBeenCalledTimes(1);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);

    rerender({ focusWorkerSessionId: null, focusWorkerHintRevision: 1 });
    expect(result.current.workerSessionId).toBeNull();

    mocks.workers = [makeWorker('worker-a', 'session-a', true)];
    rerender({ focusWorkerSessionId: null, focusWorkerHintRevision: 1 });

    expect(result.current.workerSessionId).toBeNull();

    await act(async () => {
      resolveRefresh({
        leadSessionId: 'lead-1',
        requestId: 2,
        status: 'applied',
        workers: mocks.workers,
      });
    });

    expect(result.current.workerSessionId).toBe('session-a');

    mocks.workers = [
      makeWorker('worker-a', 'session-a', true),
      makeWorker('worker-b', 'session-b'),
    ];
    rerender({ focusWorkerSessionId: null, focusWorkerHintRevision: 1 });
    expect(result.current.workerSessionId).toBe('session-a');
  });

  it('distinguishes consumed clear from a newer external null clear', async () => {
    const consumed = vi.fn();
    const { result, rerender } = renderHook(
      ({ focusWorkerSessionId, focusWorkerHintRevision }) =>
        useOrcaWorkerSelection({
          leadSessionId: 'lead-1',
          focusWorkerSessionId,
          focusWorkerHintRevision,
          onFocusWorkerSessionIdConsumed: consumed,
        }),
      {
        initialProps: {
          focusWorkerSessionId: 'session-b' as string | null,
          focusWorkerHintRevision: 4,
        },
        wrapper,
      },
    );

    expect(result.current.workerSessionId).toBe('session-b');
    rerender({ focusWorkerSessionId: null, focusWorkerHintRevision: 4 });
    expect(result.current.workerSessionId).toBe('session-b');

    rerender({ focusWorkerSessionId: null, focusWorkerHintRevision: 5 });
    expect(result.current.workerSessionId).toBe('session-a');
  });

  it('keeps the explicit target pending until it appears in a refreshed worker list', async () => {
    mocks.workers = [makeWorker('worker-a', 'session-a', true)];
    let resolveRefresh!: (value: unknown) => void;
    mocks.refresh.mockReset().mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const { result, rerender } = renderHook(
      ({ revision }) =>
        useOrcaWorkerSelection({
          leadSessionId: 'lead-1',
          focusWorkerSessionId: 'session-b',
          focusWorkerHintRevision: revision,
        }),
      { initialProps: { revision: 1 }, wrapper },
    );
    expect(result.current.workerSessionId).toBeNull();

    mocks.workers = [
      makeWorker('worker-a', 'session-a', true),
      makeWorker('worker-b', 'session-b'),
    ];
    rerender({ revision: 1 });
    expect(result.current.workerSessionId).toBe('session-b');

    await act(async () => {
      resolveRefresh({
        leadSessionId: 'lead-1',
        requestId: 2,
        status: 'applied',
        workers: mocks.workers,
      });
    });
    expect(result.current.workerSessionId).toBe('session-b');
  });

  it('invalidates a deferred hint refresh when the user switches workers', async () => {
    mocks.workers = [makeWorker('worker-a', 'session-a', true)];
    let resolveRefresh!: (value: unknown) => void;
    mocks.refresh.mockReset().mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const consumed = vi.fn();
    const cleared = vi.fn();
    const { result, rerender } = renderHook(
      ({ focusWorkerSessionId }) =>
        useOrcaWorkerSelection({
          leadSessionId: 'lead-1',
          focusWorkerSessionId,
          focusWorkerHintRevision: 7,
          onFocusWorkerSessionIdConsumed: consumed,
          onSelectionIntentCleared: cleared,
        }),
      {
        initialProps: { focusWorkerSessionId: 'session-b' as string | null },
        wrapper,
      },
    );
    await waitFor(() => expect(consumed).toHaveBeenCalledWith(7));
    rerender({ focusWorkerSessionId: null });

    act(() => result.current.handleSwitchFocus('worker-a'));
    expect(cleared).toHaveBeenCalledWith(7);
    expect(result.current.workerSessionId).toBe('session-a');

    mocks.workers = [
      makeWorker('worker-a', 'session-a', true),
      makeWorker('worker-b', 'session-b'),
    ];
    rerender({ focusWorkerSessionId: null });
    await act(async () => {
      resolveRefresh({
        leadSessionId: 'lead-1',
        requestId: 2,
        status: 'applied',
        workers: mocks.workers,
      });
    });

    expect(result.current.workerSessionId).toBe('session-a');
  });

  it('invalidates a deferred hint refresh when the Lead changes', async () => {
    mocks.workers = [makeWorker('worker-a', 'session-a', true)];
    let resolveRefresh!: (value: unknown) => void;
    mocks.refresh.mockReset().mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const { result, rerender } = renderHook(
      ({ leadSessionId, focusWorkerSessionId }) =>
        useOrcaWorkerSelection({
          leadSessionId,
          focusWorkerSessionId,
          focusWorkerHintRevision: 1,
        }),
      {
        initialProps: { leadSessionId: 'lead-1', focusWorkerSessionId: 'session-b' },
        wrapper,
      },
    );
    expect(result.current.workerSessionId).toBeNull();

    mocks.workers = [makeWorker('worker-c', 'session-c', true)];
    rerender({ leadSessionId: 'lead-2', focusWorkerSessionId: 'session-c' });
    expect(result.current.workerSessionId).toBe('session-c');

    await act(async () => {
      resolveRefresh({
        leadSessionId: 'lead-1',
        requestId: 2,
        status: 'applied',
        workers: [makeWorker('worker-b', 'session-b', true)],
      });
    });
    expect(result.current.workerSessionId).toBe('session-c');
  });

  it('does not start a pending timeout when the hinted worker is already cached', () => {
    vi.useFakeTimers();
    mocks.refresh.mockReset().mockReturnValue(new Promise(() => undefined));
    const { result, unmount } = renderHook(
      () =>
        useOrcaWorkerSelection({
          leadSessionId: 'lead-1',
          focusWorkerSessionId: 'session-b',
          focusWorkerHintRevision: 1,
        }),
      { wrapper },
    );

    expect(result.current.workerSessionId).toBe('session-b');
    expect(mocks.refresh).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.workerSessionId).toBe('session-b');
    unmount();
    vi.useRealTimers();
  });

  it('cancels the fallback timeout as soon as a pending worker appears', () => {
    vi.useFakeTimers();
    mocks.workers = [makeWorker('worker-a', 'session-a', true)];
    mocks.refresh.mockReset().mockReturnValue(new Promise(() => undefined));
    const { rerender, unmount } = renderHook(
      ({ revision }) =>
        useOrcaWorkerSelection({
          leadSessionId: 'lead-1',
          focusWorkerSessionId: 'session-b',
          focusWorkerHintRevision: revision,
        }),
      { initialProps: { revision: 1 }, wrapper },
    );
    expect(vi.getTimerCount()).toBe(1);

    mocks.workers = [
      makeWorker('worker-a', 'session-a', true),
      makeWorker('worker-b', 'session-b'),
    ];
    rerender({ revision: 1 });
    expect(vi.getTimerCount()).toBe(0);

    unmount();
    vi.useRealTimers();
  });

  it('clears a slow search jump when the user leaves its worker', async () => {
    const cleared = vi.fn();
    const jump = {
      kind: 'conversation-search' as const,
      sessionId: 'session-b',
      messageId: 'message-b',
      messageIdKind: 'clientId' as const,
      messageClientId: 'message-b',
    };
    const { result, rerender } = renderHook(
      ({ focusWorkerSessionId, searchJump }) =>
        useOrcaWorkerSelection({
          leadSessionId: 'lead-1',
          focusWorkerSessionId,
          focusWorkerHintRevision: 3,
          searchJump,
          onSelectionIntentCleared: cleared,
        }),
      {
        initialProps: {
          focusWorkerSessionId: 'session-b' as string | null,
          searchJump: jump as typeof jump | null,
        },
        wrapper,
      },
    );

    expect(result.current.workerSessionId).toBe('session-b');
    rerender({ focusWorkerSessionId: null, searchJump: jump });
    expect(result.current.workerSessionId).toBe('session-b');

    act(() => result.current.handleSwitchFocus('worker-a'));
    expect(cleared).toHaveBeenCalledWith(3);
    rerender({ focusWorkerSessionId: null, searchJump: null });
    expect(result.current.workerSessionId).toBe('session-a');

    act(() => result.current.handleSwitchFocus('worker-b'));
    expect(cleared).toHaveBeenCalledTimes(2);
    mocks.workers = [
      makeWorker('worker-a', 'session-a'),
      makeWorker('worker-b', 'session-b', true),
    ];
    rerender({ focusWorkerSessionId: null, searchJump: null });
    expect(result.current.workerSessionId).toBe('session-b');
  });

  it('falls back after a bounded wait when the latest refresh never settles', () => {
    vi.useFakeTimers();
    mocks.workers = [makeWorker('worker-a', 'session-a', true)];
    mocks.refresh.mockReset().mockReturnValue(new Promise(() => undefined));
    const { result, unmount } = renderHook(
      () =>
        useOrcaWorkerSelection({
          leadSessionId: 'lead-1',
          focusWorkerSessionId: 'session-b',
          focusWorkerHintRevision: 1,
        }),
      { wrapper },
    );
    expect(result.current.workerSessionId).toBeNull();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.workerSessionId).toBe('session-a');
    unmount();
    vi.useRealTimers();
  });
});

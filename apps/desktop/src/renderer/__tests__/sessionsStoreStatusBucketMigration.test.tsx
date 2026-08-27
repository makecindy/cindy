// @vitest-environment jsdom

/**
 * sessionsStore 跨桶迁移（patch.status）不变量
 * ---------------------------------------------------------------------------
 * 状态变化必须优先复用已加载桶里的完整 Session 行，同步修正 active / archived /
 * all。完全找不到行时才保留当前快照并定向补查目标桶；同桶连续补查只允许一个
 * 在途请求和一次尾刷，避免连续归档放大成列表查询风暴。
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';

const mocks = vi.hoisted(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {},
  });
  return { list: vi.fn() };
});

vi.mock('@/lib/sessionService', () => ({
  list: mocks.list,
  create: vi.fn(),
}));

import { useCCSessions } from '@/hooks/useCCSessions';
import { sessionsStore } from '@/lib/sessionsStore';
import type { ListStatusFilter } from '@/lib/sessionService';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function session(id: string, status: Session['status'] = 'active'): Session {
  return {
    id,
    status,
    title: `title-${id}`,
    workingDir: `C:\\projects\\${id}`,
    updatedAt: '2026-08-27T00:00:00.000Z',
  } as Session;
}

/** 本次 list mock 收到的 filter 参数（sessionService.list(limit, filter)）。 */
function requestedFilters(): ListStatusFilter[] {
  return mocks.list.mock.calls.map((call) => call[1] as ListStatusFilter);
}

describe('sessionsStore status bucket migration', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    sessionsStore.reset();
  });

  afterEach(() => {
    cleanup();
    sessionsStore.reset();
  });

  it('moves a complete row from active into archived and updates all without querying', async () => {
    mocks.list
      .mockResolvedValueOnce([session('archive-me'), session('keep-active')])
      .mockResolvedValueOnce([session('already-archived', 'archived')])
      .mockResolvedValueOnce([session('archive-me'), session('keep-active')]);
    await sessionsStore.ensureByFilter('active');
    await sessionsStore.ensureByFilter('archived');
    await sessionsStore.ensureByFilter('all');
    mocks.list.mockReset();

    act(() => sessionsStore.patchLocal('archive-me', { status: 'archived', pinnedAt: null }));

    expect(sessionsStore.getByFilter('active')?.map(({ id }) => id)).toEqual(['keep-active']);
    expect(sessionsStore.getByFilter('archived')?.[0]).toEqual(
      expect.objectContaining({
        id: 'archive-me',
        status: 'archived',
        title: 'title-archive-me',
        workingDir: 'C:\\projects\\archive-me',
        pinnedAt: null,
      }),
    );
    expect(sessionsStore.getByFilter('all')?.[0]).toEqual(
      expect.objectContaining({ id: 'archive-me', status: 'archived', pinnedAt: null }),
    );
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('removes the archived row from a mounted active list synchronously', async () => {
    mocks.list.mockResolvedValueOnce([session('archive-me'), session('keep')]);
    await sessionsStore.ensureByFilter('active');
    mocks.list.mockReset();
    mocks.list.mockImplementation(() => deferred<Session[]>().promise);

    const view = renderHook(() => useCCSessions());
    expect(view.result.current.sessions.map(({ id }) => id)).toEqual(['archive-me', 'keep']);

    act(() => sessionsStore.patchLocal('archive-me', { status: 'archived', pinnedAt: null }));

    expect(view.result.current.sessions.map(({ id }) => id)).toEqual(['keep']);
    expect(view.result.current.isLoading).toBe(false);
  });

  it('moves a complete row from archived into active without querying', async () => {
    mocks.list
      .mockResolvedValueOnce([session('stay-active')])
      .mockResolvedValueOnce([session('restore-me', 'archived')])
      .mockResolvedValueOnce([session('restore-me', 'archived')]);
    await sessionsStore.ensureByFilter('active');
    await sessionsStore.ensureByFilter('archived');
    await sessionsStore.ensureByFilter('all');
    mocks.list.mockReset();

    act(() => sessionsStore.patchLocal('restore-me', { status: 'active' }));

    expect(sessionsStore.getByFilter('active')?.[0]).toEqual(
      expect.objectContaining({
        id: 'restore-me',
        status: 'active',
        title: 'title-restore-me',
      }),
    );
    expect(sessionsStore.getByFilter('archived')).toEqual([]);
    expect(sessionsStore.getByFilter('all')?.[0]).toEqual(
      expect.objectContaining({ id: 'restore-me', status: 'active' }),
    );
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('removes a deleted row from every loaded bucket without querying', async () => {
    mocks.list
      .mockResolvedValueOnce([session('delete-me'), session('keep-active')])
      .mockResolvedValueOnce([session('delete-me', 'archived'), session('keep-archived', 'archived')])
      .mockResolvedValueOnce([session('delete-me'), session('keep-all')]);
    await sessionsStore.ensureByFilter('active');
    await sessionsStore.ensureByFilter('archived');
    await sessionsStore.ensureByFilter('all');
    mocks.list.mockReset();

    act(() => sessionsStore.patchLocal('delete-me', { status: 'deleted' }));

    expect(sessionsStore.getByFilter('active')?.map(({ id }) => id)).toEqual(['keep-active']);
    expect(sessionsStore.getByFilter('archived')?.map(({ id }) => id)).toEqual([
      'keep-archived',
    ]);
    expect(sessionsStore.getByFilter('all')?.map(({ id }) => id)).toEqual(['keep-all']);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('keeps loaded snapshots and refetches only a missing target bucket', async () => {
    mocks.list
      .mockResolvedValueOnce([session('keep-active')])
      .mockResolvedValueOnce([session('already-archived', 'archived')]);
    await sessionsStore.ensureByFilter('active');
    await sessionsStore.ensureByFilter('archived');
    mocks.list.mockReset();

    const backfill = deferred<Session[]>();
    mocks.list.mockImplementationOnce(() => backfill.promise);
    act(() => sessionsStore.patchLocal('not-cached', { status: 'archived' }));

    expect(requestedFilters()).toEqual(['archived']);
    expect(sessionsStore.getByFilter('active')?.map(({ id }) => id)).toEqual(['keep-active']);
    expect(sessionsStore.getByFilter('archived')?.map(({ id }) => id)).toEqual([
      'already-archived',
    ]);

    backfill.resolve([
      session('not-cached', 'archived'),
      session('already-archived', 'archived'),
    ]);
    await waitFor(() => {
      expect(sessionsStore.getByFilter('archived')?.map(({ id }) => id)).toEqual([
        'not-cached',
        'already-archived',
      ]);
    });
  });

  it('coalesces consecutive backfills for one bucket into one request plus one trailing refresh', async () => {
    mocks.list.mockResolvedValueOnce([]);
    await sessionsStore.ensureByFilter('archived');
    mocks.list.mockReset();

    const firstBackfill = deferred<Session[]>();
    const trailingBackfill = deferred<Session[]>();
    mocks.list
      .mockImplementationOnce(() => firstBackfill.promise)
      .mockImplementationOnce(() => trailingBackfill.promise);

    act(() => {
      sessionsStore.patchLocal('missing-1', { status: 'archived' });
      sessionsStore.patchLocal('missing-2', { status: 'archived' });
      sessionsStore.patchLocal('missing-3', { status: 'archived' });
    });
    expect(requestedFilters()).toEqual(['archived']);

    firstBackfill.resolve([]);
    await waitFor(() => expect(requestedFilters()).toEqual(['archived', 'archived']));

    trailingBackfill.resolve([
      session('missing-1', 'archived'),
      session('missing-2', 'archived'),
      session('missing-3', 'archived'),
    ]);
    await waitFor(() => {
      expect(sessionsStore.getByFilter('archived')?.map(({ id }) => id)).toEqual([
        'missing-1',
        'missing-2',
        'missing-3',
      ]);
    });
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('does not let a list request started before archiving write the row back', async () => {
    const staleRequest = deferred<Session[]>();
    mocks.list.mockImplementationOnce(() => staleRequest.promise);

    const staleLoad = sessionsStore.ensureByFilter('active');
    act(() => sessionsStore.patchLocal('archive-me', { status: 'archived' }));

    expect(requestedFilters()).toEqual(['active']);
    staleRequest.resolve([session('archive-me'), session('keep')]);
    await staleLoad;

    expect(sessionsStore.getByFilter('active')?.map(({ id }) => id)).toEqual(['keep']);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('uses a cached source row to repair a target bucket request that started earlier', async () => {
    mocks.list.mockResolvedValueOnce([session('archive-me')]);
    await sessionsStore.ensureByFilter('active');

    const staleArchivedRequest = deferred<Session[]>();
    mocks.list.mockImplementationOnce(() => staleArchivedRequest.promise);
    const staleLoad = sessionsStore.ensureByFilter('archived');

    act(() => sessionsStore.patchLocal('archive-me', { status: 'archived' }));
    staleArchivedRequest.resolve([session('already-archived', 'archived')]);
    await staleLoad;

    expect(sessionsStore.getByFilter('archived')?.map(({ id }) => id)).toEqual([
      'archive-me',
      'already-archived',
    ]);
    expect(requestedFilters()).toEqual(['active', 'archived']);
  });

  it('does not let an older archived response overwrite a later deleted status', async () => {
    mocks.list.mockResolvedValueOnce([session('archive-me')]);
    await sessionsStore.ensureByFilter('active');

    const staleArchivedRequest = deferred<Session[]>();
    mocks.list.mockImplementationOnce(() => staleArchivedRequest.promise);
    const staleLoad = sessionsStore.ensureByFilter('archived');

    act(() => {
      sessionsStore.patchLocal('archive-me', { status: 'archived' });
      sessionsStore.patchLocal('archive-me', { status: 'deleted' });
    });
    staleArchivedRequest.resolve([session('archive-me', 'archived')]);
    await staleLoad;

    expect(sessionsStore.getByFilter('active')).toEqual([]);
    expect(sessionsStore.getByFilter('archived')).toEqual([]);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });
});

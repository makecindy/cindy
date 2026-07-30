// @vitest-environment jsdom

/**
 * sessionsStore 跨桶迁移（patch.status）不变量
 * ---------------------------------------------------------------------------
 * 回归的是「点归档后对话过半秒才消失」：早期 patchLocal 对任何桶归属不一致都
 * drop + 重拉，当前可见桶变 null 后 useCCSessions 的 `next !== null` 守卫会跳过
 * setState，列表停在**仍含被归档行**的陈旧快照，直到重拉的 sessions:list（LEFT
 * JOIN messages + GROUP BY 的重查询）回来才更新，把调用方的乐观更新整段抵消。
 *
 * 现在的口径是不对称的：该移出的桶就地移除（本地即可定论，桶保持非 null），
 * 只有该补进却缺 row 的桶才 drop 重拉。下面每条测试都钉这个不对称。
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
  return { id, status } as Session;
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

  it('archiving removes the row from the active bucket in place, without dropping or refetching it', async () => {
    mocks.list.mockResolvedValueOnce([session('archive-me'), session('keep')]);
    await sessionsStore.ensureByFilter('active');
    mocks.list.mockReset();

    act(() => sessionsStore.patchLocal('archive-me', { status: 'archived', pinnedAt: null }));

    // 桶必须仍是数组（非 null）—— null 才是订阅者跳过 setState 的根因。
    expect(sessionsStore.getByFilter('active')?.map(({ id }) => id)).toEqual(['keep']);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('drops the archived row from a mounted list synchronously, before any IPC resolves', async () => {
    mocks.list.mockResolvedValueOnce([session('archive-me'), session('keep')]);
    await sessionsStore.ensureByFilter('active');
    // 归档后若有任何重拉，让它永远悬着：断言必须在没有 IPC 回包的前提下成立。
    mocks.list.mockReset();
    mocks.list.mockImplementation(() => deferred<Session[]>().promise);

    const view = renderHook(() => useCCSessions());
    expect(view.result.current.sessions.map(({ id }) => id)).toEqual(['archive-me', 'keep']);

    act(() => sessionsStore.patchLocal('archive-me', { status: 'archived', pinnedAt: null }));

    expect(view.result.current.sessions.map(({ id }) => id)).toEqual(['keep']);
    expect(view.result.current.isLoading).toBe(false);
  });

  it('refetches only the bucket that is missing the row after archiving', async () => {
    mocks.list
      .mockResolvedValueOnce([session('archive-me'), session('keep-active')])
      .mockResolvedValueOnce([session('already-archived', 'archived')]);
    await sessionsStore.ensureByFilter('active');
    await sessionsStore.ensureByFilter('archived');
    mocks.list.mockReset();
    mocks.list.mockResolvedValue([
      session('archive-me', 'archived'),
      session('already-archived', 'archived'),
    ]);

    act(() => sessionsStore.patchLocal('archive-me', { status: 'archived' }));

    // active 桶就地移除，不重拉；archived 桶缺这一条 row，只能问 DB。
    expect(sessionsStore.getByFilter('active')?.map(({ id }) => id)).toEqual(['keep-active']);
    expect(requestedFilters()).toEqual(['archived']);
    await waitFor(() => {
      expect(sessionsStore.getByFilter('archived')?.map(({ id }) => id)).toEqual([
        'archive-me',
        'already-archived',
      ]);
    });
  });

  it('keeps the row in the all bucket with the new status', async () => {
    mocks.list.mockResolvedValueOnce([session('archive-me'), session('keep')]);
    await sessionsStore.ensureByFilter('all');
    mocks.list.mockReset();

    act(() => sessionsStore.patchLocal('archive-me', { status: 'archived' }));

    expect(sessionsStore.getByFilter('all')).toEqual([
      expect.objectContaining({ id: 'archive-me', status: 'archived' }),
      expect.objectContaining({ id: 'keep' }),
    ]);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('unarchiving removes the row from the archived bucket in place', async () => {
    mocks.list.mockResolvedValueOnce([
      session('restore-me', 'archived'),
      session('stay-archived', 'archived'),
    ]);
    await sessionsStore.ensureByFilter('archived');
    mocks.list.mockReset();

    act(() => sessionsStore.patchLocal('restore-me', { status: 'active' }));

    expect(sessionsStore.getByFilter('archived')?.map(({ id }) => id)).toEqual(['stay-archived']);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('does not let a list request started before the archive write the row back', async () => {
    const staleRequest = deferred<Session[]>();
    const replacementRequest = deferred<Session[]>();
    mocks.list
      .mockImplementationOnce(() => staleRequest.promise)
      .mockImplementationOnce(() => replacementRequest.promise);

    // 请求在途、桶还没进 cache 时归档：旧响应整桶 cache.set 会把被归档行带回来。
    const staleLoad = sessionsStore.ensureByFilter('active');
    act(() => sessionsStore.patchLocal('archive-me', { status: 'archived' }));

    expect(requestedFilters()).toEqual(['active', 'active']);
    replacementRequest.resolve([session('keep')]);
    await waitFor(() => {
      expect(sessionsStore.getByFilter('active')?.map(({ id }) => id)).toEqual(['keep']);
    });

    staleRequest.resolve([session('archive-me'), session('keep')]);
    await staleLoad;

    expect(sessionsStore.getByFilter('active')?.map(({ id }) => id)).toEqual(['keep']);
  });
});

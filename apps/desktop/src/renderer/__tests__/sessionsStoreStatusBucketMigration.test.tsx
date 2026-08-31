// @vitest-environment jsdom

/**
 * sessionsStore 跨桶迁移（patch.status）不变量
 * ---------------------------------------------------------------------------
 * 状态变化必须优先复用已加载桶里的完整 Session 行，同步修正 active / archived /
 * all。完全找不到行，或 status-only 广播缺少 DB 已更新的 updatedAt 时，才保留即时
 * 迁移并定向补查目标桶；同桶连续补查只允许一个在途请求和一次尾刷，避免连续归档
 * 放大成列表查询风暴。
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_DRAFT_SESSION_TITLE } from '@cindy/maker-shared/session-title';

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
import { emitAutoTitlePreview } from '@/lib/sessionsBus';
import { sessionsStore } from '@/lib/sessionsStore';
import type { ListStatusFilter } from '@/lib/sessionService';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function session(
  id: string,
  status: Session['status'] = 'active',
  updatedAt = '2026-08-27T00:00:00.000Z',
): Session {
  return {
    id,
    status,
    title: `title-${id}`,
    workingDir: `C:\\projects\\${id}`,
    updatedAt,
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

  it('moves a row with an authoritative timestamp into archived and all without querying', async () => {
    const target = session('archive-me', 'active', '2026-08-27T00:00:00.000Z');
    const keepActive = session('keep-active', 'active', '2026-08-27T00:30:00.000Z');
    mocks.list
      .mockResolvedValueOnce([keepActive, target])
      .mockResolvedValueOnce([session('already-archived', 'archived')])
      .mockResolvedValueOnce([keepActive, target]);
    await sessionsStore.ensureByFilter('active');
    await sessionsStore.ensureByFilter('archived');
    await sessionsStore.ensureByFilter('all');
    mocks.list.mockReset();

    act(() =>
      sessionsStore.patchLocal('archive-me', {
        status: 'archived',
        pinnedAt: null,
        updatedAt: '2026-08-27T01:00:00.000Z',
      }),
    );

    expect(sessionsStore.getByFilter('active')?.map(({ id }) => id)).toEqual(['keep-active']);
    expect(
      sessionsStore.getByFilter('archived')?.find(({ id }) => id === 'archive-me'),
    ).toEqual(
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

  it('backfills archived and all ordering when a status-only archive lacks updatedAt', async () => {
    const target = session('archive-me', 'active', '2026-08-27T01:00:00.000Z');
    const previousNewest = session(
      'previous-newest',
      'archived',
      '2026-08-27T02:00:00.000Z',
    );
    mocks.list
      .mockResolvedValueOnce([target])
      .mockResolvedValueOnce([previousNewest])
      .mockResolvedValueOnce([previousNewest, target]);
    await sessionsStore.ensureByFilter('active');
    await sessionsStore.ensureByFilter('archived');
    await sessionsStore.ensureByFilter('all');
    mocks.list.mockReset();

    const persisted = {
      ...target,
      status: 'archived',
      updatedAt: '2026-08-27T03:00:00.000Z',
    } as Session;
    mocks.list.mockImplementation((_limit, filter) =>
      Promise.resolve(filter === 'archived' || filter === 'all' ? [persisted, previousNewest] : []),
    );

    act(() => sessionsStore.patchLocal('archive-me', { status: 'archived' }));

    expect(requestedFilters()).toEqual(['archived', 'all']);
    await waitFor(() => {
      expect(sessionsStore.getByFilter('archived')?.map(({ id }) => id)).toEqual([
        'archive-me',
        'previous-newest',
      ]);
      expect(sessionsStore.getByFilter('all')?.map(({ id }) => id)).toEqual([
        'archive-me',
        'previous-newest',
      ]);
    });
    expect(sessionsStore.getByFilter('archived')?.[0]?.updatedAt).toBe(persisted.updatedAt);
    expect(sessionsStore.getByFilter('all')?.[0]?.updatedAt).toBe(persisted.updatedAt);
  });

  it('keeps an optimistic archive applied to list requests started before the DB write completes', async () => {
    const target = session('archive-me', 'active', '2026-08-27T02:00:00.000Z');
    const keep = session('keep', 'active', '2026-08-27T01:00:00.000Z');
    const alreadyArchived = session(
      'already-archived',
      'archived',
      '2026-08-27T01:30:00.000Z',
    );
    mocks.list
      .mockResolvedValueOnce([target, keep])
      .mockResolvedValueOnce([alreadyArchived])
      .mockResolvedValueOnce([target, keep]);
    await sessionsStore.ensureByFilter('active');
    await sessionsStore.ensureByFilter('archived');
    await sessionsStore.ensureByFilter('all');

    const transition = sessionsStore.beginStatusTransition('archive-me', {
      status: 'archived',
      pinnedAt: null,
    });
    expect(transition).not.toBeNull();
    mocks.list.mockReset();
    // 三个请求都在乐观 patch 之后、数据库提交之前启动，返回的仍是旧 DB 快照。
    mocks.list
      .mockResolvedValueOnce([target, keep])
      .mockResolvedValueOnce([alreadyArchived])
      .mockResolvedValueOnce([target, keep]);

    await Promise.all([
      sessionsStore.forceRefresh('active'),
      sessionsStore.forceRefresh('archived'),
      sessionsStore.forceRefresh('all'),
    ]);

    expect(sessionsStore.getByFilter('active')?.map(({ id }) => id)).toEqual(['keep']);
    expect(sessionsStore.getByFilter('archived')).toEqual([
      expect.objectContaining({ id: 'archive-me', status: 'archived' }),
      expect.objectContaining({ id: 'already-archived' }),
    ]);
    expect(sessionsStore.getByFilter('all')?.find(({ id }) => id === 'archive-me')).toEqual(
      expect.objectContaining({ status: 'archived' }),
    );
  });

  it('defers a missing-row backfill until the status write returns the complete row', async () => {
    mocks.list.mockResolvedValueOnce([]);
    await sessionsStore.ensureByFilter('archived');
    mocks.list.mockReset();

    const transition = sessionsStore.beginStatusTransition('not-cached', {
      status: 'archived',
      pinnedAt: null,
    });

    expect(mocks.list).not.toHaveBeenCalled();
    expect(sessionsStore.getByFilter('archived')).toEqual([]);

    const persisted = session(
      'not-cached',
      'archived',
      '2026-08-27T03:00:00.000Z',
    );
    expect(sessionsStore.completeStatusTransition(transition!, persisted)).toBe(true);
    expect(sessionsStore.getByFilter('archived')).toEqual([
      expect.objectContaining({
        id: 'not-cached',
        status: 'archived',
        updatedAt: '2026-08-27T03:00:00.000Z',
      }),
    ]);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('uses the persisted row to refresh updatedAt and reorder loaded target buckets', async () => {
    const target = session('archive-me', 'active', '2026-08-27T01:00:00.000Z');
    const newer = session('newer', 'archived', '2026-08-27T02:00:00.000Z');
    mocks.list
      .mockResolvedValueOnce([target])
      .mockResolvedValueOnce([newer])
      .mockResolvedValueOnce([newer, target]);
    await sessionsStore.ensureByFilter('active');
    await sessionsStore.ensureByFilter('archived');
    await sessionsStore.ensureByFilter('all');

    const transition = sessionsStore.beginStatusTransition('archive-me', {
      status: 'archived',
      pinnedAt: null,
    });
    expect(sessionsStore.getByFilter('archived')?.map(({ id }) => id)).toEqual([
      'newer',
      'archive-me',
    ]);

    const persisted = {
      ...target,
      status: 'archived' as const,
      pinnedAt: null,
      updatedAt: '2026-08-27T03:00:00.000Z',
    };
    expect(sessionsStore.completeStatusTransition(transition!, persisted)).toBe(true);

    expect(sessionsStore.getByFilter('archived')?.map(({ id }) => id)).toEqual([
      'archive-me',
      'newer',
    ]);
    expect(sessionsStore.getByFilter('all')?.map(({ id }) => id)).toEqual([
      'archive-me',
      'newer',
    ]);
    expect(sessionsStore.getByFilter('all')?.[0].updatedAt).toBe(
      '2026-08-27T03:00:00.000Z',
    );
  });

  it('replays the persisted row onto a stale list response that finishes after the DB write', async () => {
    const target = session('archive-me', 'active', '2026-08-27T01:00:00.000Z');
    const previousNewest = session('previous-newest', 'archived', '2026-08-27T02:00:00.000Z');
    mocks.list
      .mockResolvedValueOnce([target])
      .mockResolvedValueOnce([previousNewest, target]);
    await sessionsStore.ensureByFilter('active');
    await sessionsStore.ensureByFilter('all');

    const transition = sessionsStore.beginStatusTransition('archive-me', {
      status: 'archived',
      pinnedAt: null,
    });
    const staleAllRequest = deferred<Session[]>();
    mocks.list.mockImplementationOnce(() => staleAllRequest.promise);
    const staleRefresh = sessionsStore.forceRefresh('all');

    expect(
      sessionsStore.completeStatusTransition(transition!, {
        ...target,
        status: 'archived',
        pinnedAt: null,
        updatedAt: '2026-08-27T03:00:00.000Z',
      }),
    ).toBe(true);
    staleAllRequest.resolve([previousNewest, target]);
    await staleRefresh;

    expect(sessionsStore.getByFilter('all')?.map(({ id }) => id)).toEqual([
      'archive-me',
      'previous-newest',
    ]);
    expect(sessionsStore.getByFilter('all')?.[0]).toEqual(
      expect.objectContaining({
        status: 'archived',
        updatedAt: '2026-08-27T03:00:00.000Z',
      }),
    );
  });

  it('replays newer title and spend fields after a complete status override', async () => {
    const target = {
      ...session('archive-me', 'active', '2026-08-27T01:00:00.000Z'),
      totalCostUsd: 1,
    } as Session;
    mocks.list.mockResolvedValueOnce([target]);
    await sessionsStore.ensureByFilter('all');

    const transition = sessionsStore.beginStatusTransition('archive-me', {
      status: 'archived',
      pinnedAt: null,
    });
    expect(
      sessionsStore.completeStatusTransition(transition!, {
        ...target,
        status: 'archived',
        pinnedAt: null,
        updatedAt: '2026-08-27T03:00:00.000Z',
      }),
    ).toBe(true);
    const staleRequest = deferred<Session[]>();
    mocks.list.mockImplementationOnce(() => staleRequest.promise);
    const staleRefresh = sessionsStore.forceRefresh('all');

    sessionsStore.patchLocal('archive-me', {
      title: 'new authoritative title',
      totalCostUsd: 42,
    });
    staleRequest.resolve([target]);
    await staleRefresh;

    expect(sessionsStore.getByFilter('all')?.[0]).toEqual(
      expect.objectContaining({
        status: 'archived',
        title: 'new authoritative title',
        totalCostUsd: 42,
      }),
    );
  });

  it('keeps concurrent settings updates when the persisted status row has the same updatedAt', async () => {
    const target = {
      ...session('archive-me', 'active', '2026-08-27T01:00:00.000Z'),
      model: 'old-model',
      effort: 'medium',
      permissionMode: 'ask',
      fastMode: false,
      providerId: null,
    } as Session;
    mocks.list.mockResolvedValueOnce([target]);
    await sessionsStore.ensureByFilter('all');

    const transition = sessionsStore.beginStatusTransition('archive-me', {
      status: 'archived',
      pinnedAt: null,
    });
    sessionsStore.patchLocal('archive-me', {
      model: 'new-model',
      effort: 'high',
      permissionMode: 'auto',
      fastMode: true,
      providerId: 'new-provider',
    });

    expect(
      sessionsStore.completeStatusTransition(transition!, {
        ...target,
        status: 'archived',
        pinnedAt: null,
      }),
    ).toBe(true);
    expect(sessionsStore.getByFilter('all')?.[0]).toEqual(
      expect.objectContaining({
        status: 'archived',
        model: 'new-model',
        effort: 'high',
        permissionMode: 'auto',
        fastMode: true,
        providerId: 'new-provider',
      }),
    );
  });

  it('keeps concurrent settings after optimistic archive removes the last cached row', async () => {
    const target = {
      ...session('archive-me', 'active', '2026-08-27T01:00:00.000Z'),
      model: 'old-model',
      effort: 'medium',
      permissionMode: 'ask',
      fastMode: false,
      providerId: null,
    } as Session;
    mocks.list.mockResolvedValueOnce([target]);
    await sessionsStore.ensureByFilter('active');

    const transition = sessionsStore.beginStatusTransition('archive-me', {
      status: 'archived',
      pinnedAt: null,
    });
    expect(sessionsStore.findById('archive-me')).toBeNull();
    sessionsStore.patchLocal('archive-me', {
      model: 'new-model',
      effort: 'high',
      permissionMode: 'auto',
      fastMode: true,
      providerId: 'new-provider',
    });

    const archivedRequest = deferred<Session[]>();
    mocks.list.mockImplementationOnce(() => archivedRequest.promise);
    const archivedLoad = sessionsStore.ensureByFilter('archived');
    expect(
      sessionsStore.completeStatusTransition(transition!, {
        ...target,
        status: 'archived',
        pinnedAt: null,
        updatedAt: '2026-08-27T03:00:00.000Z',
      }),
    ).toBe(true);
    archivedRequest.resolve([]);
    await archivedLoad;

    expect(sessionsStore.getByFilter('archived')?.[0]).toEqual(
      expect.objectContaining({
        status: 'archived',
        updatedAt: '2026-08-27T03:00:00.000Z',
        model: 'new-model',
        effort: 'high',
        permissionMode: 'auto',
        fastMode: true,
        providerId: 'new-provider',
      }),
    );
  });

  it('keeps concurrent settings when a pending transition started without a cached source row', async () => {
    mocks.list.mockResolvedValueOnce([]);
    await sessionsStore.ensureByFilter('archived');
    const transition = sessionsStore.beginStatusTransition('not-cached', {
      status: 'archived',
      pinnedAt: null,
    });
    sessionsStore.patchLocal('not-cached', {
      model: 'new-model',
      effort: 'high',
      permissionMode: 'auto',
    });

    expect(
      sessionsStore.completeStatusTransition(transition!, {
        ...session('not-cached', 'active', '2026-08-27T01:00:00.000Z'),
        status: 'archived',
        pinnedAt: null,
        model: 'old-model',
        effort: 'medium',
        permissionMode: 'ask',
        updatedAt: '2026-08-27T03:00:00.000Z',
      } as Session),
    ).toBe(true);

    expect(sessionsStore.getByFilter('archived')?.[0]).toEqual(
      expect.objectContaining({
        id: 'not-cached',
        status: 'archived',
        updatedAt: '2026-08-27T03:00:00.000Z',
        model: 'new-model',
        effort: 'high',
        permissionMode: 'auto',
      }),
    );
  });

  it('replays settings fields that arrive after a complete status override', async () => {
    const target = {
      ...session('archive-me', 'active', '2026-08-27T01:00:00.000Z'),
      model: 'old-model',
      effort: 'medium',
      permissionMode: 'ask',
      fastMode: false,
      providerId: null,
    } as Session;
    mocks.list.mockResolvedValueOnce([target]);
    await sessionsStore.ensureByFilter('all');

    const transition = sessionsStore.beginStatusTransition('archive-me', {
      status: 'archived',
      pinnedAt: null,
    });
    const staleRequest = deferred<Session[]>();
    mocks.list.mockImplementationOnce(() => staleRequest.promise);
    const staleRefresh = sessionsStore.forceRefresh('all');

    expect(
      sessionsStore.completeStatusTransition(transition!, {
        ...target,
        status: 'archived',
        pinnedAt: null,
        updatedAt: '2026-08-27T03:00:00.000Z',
      }),
    ).toBe(true);
    sessionsStore.patchLocal('archive-me', {
      model: 'new-model',
      effort: 'high',
      permissionMode: 'auto',
      fastMode: true,
      providerId: 'new-provider',
    });
    staleRequest.resolve([target]);
    await staleRefresh;

    expect(sessionsStore.getByFilter('all')?.[0]).toEqual(
      expect.objectContaining({
        status: 'archived',
        model: 'new-model',
        effort: 'high',
        permissionMode: 'auto',
        fastMode: true,
        providerId: 'new-provider',
      }),
    );
  });

  it('keeps later settings fields when a pending status write rolls back', async () => {
    const target = {
      ...session('archive-me', 'active', '2026-08-27T01:00:00.000Z'),
      model: 'old-model',
      effort: 'medium',
      permissionMode: 'ask',
    } as Session;
    mocks.list.mockResolvedValueOnce([target]);
    await sessionsStore.ensureByFilter('all');

    const transition = sessionsStore.beginStatusTransition('archive-me', {
      status: 'archived',
      pinnedAt: null,
    });
    sessionsStore.patchLocal('archive-me', {
      model: 'new-model',
      effort: 'high',
      permissionMode: 'auto',
    });

    expect(sessionsStore.rollbackStatusTransition(transition!)).toBe(true);
    expect(sessionsStore.getByFilter('all')?.[0]).toEqual(
      expect.objectContaining({
        status: 'active',
        model: 'new-model',
        effort: 'high',
        permissionMode: 'auto',
      }),
    );
  });

  it('applies a newer auto-title preview after a complete status override', async () => {
    const target = {
      ...session('archive-me', 'active', '2026-08-27T01:00:00.000Z'),
      title: DEFAULT_DRAFT_SESSION_TITLE,
    } as Session;
    mocks.list.mockResolvedValueOnce([target]);
    await sessionsStore.ensureByFilter('all');

    const transition = sessionsStore.beginStatusTransition('archive-me', {
      status: 'archived',
      pinnedAt: null,
    });
    const staleRequest = deferred<Session[]>();
    mocks.list.mockImplementationOnce(() => staleRequest.promise);
    const staleRefresh = sessionsStore.forceRefresh('all');

    expect(
      sessionsStore.completeStatusTransition(transition!, {
        ...target,
        status: 'archived',
        pinnedAt: null,
        updatedAt: '2026-08-27T03:00:00.000Z',
      }),
    ).toBe(true);
    emitAutoTitlePreview('archive-me', 'new optimistic title');
    staleRequest.resolve([target]);
    await staleRefresh;

    expect(sessionsStore.getByFilter('all')?.[0]).toEqual(
      expect.objectContaining({
        status: 'archived',
        title: 'new optimistic title',
      }),
    );
  });

  it('keeps the newest 1000 rows when a persisted archive enters a full target bucket', async () => {
    const archived = Array.from({ length: 1000 }, (_, index) =>
      session(
        `archived-${index}`,
        'archived',
        new Date(2_000_000 - index * 1_000).toISOString(),
      ),
    );
    const target = session('archive-me', 'active', new Date(500_000).toISOString());
    mocks.list.mockResolvedValueOnce([target]).mockResolvedValueOnce(archived);
    await sessionsStore.ensureByFilter('active');
    await sessionsStore.ensureByFilter('archived');

    const transition = sessionsStore.beginStatusTransition('archive-me', {
      status: 'archived',
      pinnedAt: null,
    });
    // 旧 updatedAt 排在 1000 条之外，乐观阶段不能无条件挤掉尾项。
    expect(sessionsStore.getByFilter('archived')?.map(({ id }) => id)).toEqual(
      archived.map(({ id }) => id),
    );

    expect(
      sessionsStore.completeStatusTransition(transition!, {
        ...target,
        status: 'archived',
        pinnedAt: null,
        updatedAt: new Date(3_000_000).toISOString(),
      }),
    ).toBe(true);
    const finalArchived = sessionsStore.getByFilter('archived') ?? [];
    expect(finalArchived).toHaveLength(1000);
    expect(finalArchived[0]?.id).toBe('archive-me');
    expect(finalArchived.some(({ id }) => id === 'archived-999')).toBe(false);
  });

  it('backfills a full active bucket when a status-only restore lacks updatedAt', async () => {
    const active = Array.from({ length: 1000 }, (_, index) =>
      session(`active-${index}`, 'active', new Date(2_000_000 - index * 1_000).toISOString()),
    );
    const target = session('restore-me', 'archived', new Date(500_000).toISOString());
    mocks.list.mockResolvedValueOnce(active).mockResolvedValueOnce([target]);
    await sessionsStore.ensureByFilter('active');
    await sessionsStore.ensureByFilter('archived');
    mocks.list.mockReset();

    const persisted = {
      ...target,
      status: 'active',
      updatedAt: new Date(3_000_000).toISOString(),
    } as Session;
    mocks.list.mockResolvedValueOnce([persisted, ...active.slice(0, 999)]);

    act(() => sessionsStore.patchLocal('restore-me', { status: 'active' }));

    expect(requestedFilters()).toEqual(['active']);
    await waitFor(() => expect(sessionsStore.getByFilter('active')?.[0]?.id).toBe('restore-me'));
    const finalActive = sessionsStore.getByFilter('active') ?? [];
    expect(finalActive).toHaveLength(1000);
    expect(finalActive[0]?.updatedAt).toBe(persisted.updatedAt);
    expect(finalActive.some(({ id }) => id === 'active-999')).toBe(false);
  });

  it('restores ordering, pin state and an evicted tail row when an archive write fails', async () => {
    const archived = Array.from({ length: 1000 }, (_, index) =>
      session(
        `archived-${index}`,
        'archived',
        new Date(2_000_000 - index * 1_000).toISOString(),
      ),
    );
    const target = {
      ...session('archive-me', 'active', new Date(1_500_500).toISOString()),
      pinnedAt: '2026-08-27T00:00:00.000Z',
    };
    const active = [
      session('active-newer', 'active', new Date(2_500_000).toISOString()),
      target,
      session('active-older', 'active', new Date(500_000).toISOString()),
    ];
    mocks.list.mockResolvedValueOnce(active).mockResolvedValueOnce(archived);
    await sessionsStore.ensureByFilter('active');
    await sessionsStore.ensureByFilter('archived');

    const transition = sessionsStore.beginStatusTransition('archive-me', {
      status: 'archived',
      pinnedAt: null,
    });
    expect(sessionsStore.getByFilter('archived')).toHaveLength(1000);
    expect(sessionsStore.getByFilter('archived')?.some(({ id }) => id === 'archive-me')).toBe(true);
    expect(
      sessionsStore.getByFilter('archived')?.some(({ id }) => id === 'archived-999'),
    ).toBe(false);

    expect(sessionsStore.rollbackStatusTransition(transition!)).toBe(true);

    expect(sessionsStore.getByFilter('active')?.map(({ id }) => id)).toEqual(
      active.map(({ id }) => id),
    );
    expect(sessionsStore.getByFilter('active')?.[1]).toEqual(
      expect.objectContaining({
        id: 'archive-me',
        status: 'active',
        pinnedAt: '2026-08-27T00:00:00.000Z',
      }),
    );
    expect(sessionsStore.getByFilter('archived')?.map(({ id }) => id)).toEqual(
      archived.map(({ id }) => id),
    );
  });

  it('restores the 1000th row when a full target bucket loads during a pending archive', async () => {
    const archived = Array.from({ length: 1000 }, (_, index) =>
      session(
        `archived-${index}`,
        'archived',
        new Date(2_000_000 - index * 1_000).toISOString(),
      ),
    );
    const target = session('archive-me', 'active', new Date(1_500_500).toISOString());
    mocks.list.mockResolvedValueOnce([target]);
    await sessionsStore.ensureByFilter('active');

    const transition = sessionsStore.beginStatusTransition('archive-me', {
      status: 'archived',
      pinnedAt: null,
    });
    mocks.list.mockResolvedValueOnce(archived);
    await sessionsStore.ensureByFilter('archived');

    expect(sessionsStore.getByFilter('archived')).toHaveLength(1000);
    expect(sessionsStore.getByFilter('archived')?.some(({ id }) => id === 'archive-me')).toBe(true);
    expect(
      sessionsStore.getByFilter('archived')?.some(({ id }) => id === 'archived-999'),
    ).toBe(false);

    expect(sessionsStore.rollbackStatusTransition(transition!)).toBe(true);
    expect(sessionsStore.getByFilter('archived')?.map(({ id }) => id)).toEqual(
      archived.map(({ id }) => id),
    );
  });

  it('backfills the 1001st archived row after restoring from a full bucket', async () => {
    const target = session('restore-me', 'archived', new Date(2_001_000).toISOString());
    const archived = [
      target,
      ...Array.from({ length: 999 }, (_, index) =>
        session(
          `archived-${index}`,
          'archived',
          new Date(2_000_000 - index * 1_000).toISOString(),
        ),
      ),
    ];
    const replacement = session('archived-1000', 'archived', new Date(1_000_000).toISOString());
    mocks.list.mockResolvedValueOnce(archived).mockResolvedValueOnce([]);
    await sessionsStore.ensureByFilter('archived');
    await sessionsStore.ensureByFilter('active');
    mocks.list.mockReset();
    mocks.list.mockResolvedValueOnce([...archived.slice(1), replacement]);

    const transition = sessionsStore.beginStatusTransition('restore-me', { status: 'active' });

    expect(sessionsStore.getByFilter('archived')).toHaveLength(999);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(
      sessionsStore.completeStatusTransition(transition!, {
        ...target,
        status: 'active',
        updatedAt: new Date(3_000_000).toISOString(),
      }),
    ).toBe(true);

    await waitFor(() => expect(sessionsStore.getByFilter('archived')).toHaveLength(1000));
    expect(requestedFilters()).toEqual(['archived']);
    expect(sessionsStore.getByFilter('archived')?.at(-1)?.id).toBe('archived-1000');
  });

  it('backfills only full active and all buckets after deleting a row', async () => {
    const target = session('delete-me', 'active', new Date(2_001_000).toISOString());
    const active = [
      target,
      ...Array.from({ length: 999 }, (_, index) =>
        session(
          `active-${index}`,
          'active',
          new Date(2_000_000 - index * 1_000).toISOString(),
        ),
      ),
    ];
    const replacement = session('active-1000', 'active', new Date(1_000_000).toISOString());
    const refilled = [...active.slice(1), replacement];
    mocks.list.mockResolvedValueOnce(active).mockResolvedValueOnce(active);
    await sessionsStore.ensureByFilter('active');
    await sessionsStore.ensureByFilter('all');
    mocks.list.mockReset();
    mocks.list.mockImplementation((_limit, filter) =>
      Promise.resolve(filter === 'active' || filter === 'all' ? refilled : []),
    );

    act(() => sessionsStore.patchLocal('delete-me', { status: 'deleted' }));

    await waitFor(() => {
      expect(sessionsStore.getByFilter('active')).toHaveLength(1000);
      expect(sessionsStore.getByFilter('all')).toHaveLength(1000);
    });
    expect(requestedFilters()).toEqual(['active', 'all']);
    expect(sessionsStore.getByFilter('active')?.at(-1)?.id).toBe('active-1000');
    expect(sessionsStore.getByFilter('all')?.at(-1)?.id).toBe('active-1000');
  });

  it('keeps the full-bucket backfill when the first of two concurrent migrations rolls back', async () => {
    const first = session('archive-first', 'active', new Date(2_002_000).toISOString());
    const second = session('archive-second', 'active', new Date(2_001_000).toISOString());
    const active = [
      first,
      second,
      ...Array.from({ length: 998 }, (_, index) =>
        session(
          `active-${index}`,
          'active',
          new Date(2_000_000 - index * 1_000).toISOString(),
        ),
      ),
    ];
    const replacement = session('active-1000', 'active', new Date(1_000_000).toISOString());
    mocks.list.mockResolvedValueOnce(active);
    await sessionsStore.ensureByFilter('active');
    mocks.list.mockReset();
    mocks.list.mockResolvedValueOnce([first, ...active.slice(2), replacement]);

    const firstTransition = sessionsStore.beginStatusTransition('archive-first', {
      status: 'archived',
      pinnedAt: null,
    });
    const secondTransition = sessionsStore.beginStatusTransition('archive-second', {
      status: 'archived',
      pinnedAt: null,
    });
    expect(sessionsStore.getByFilter('active')).toHaveLength(998);

    expect(sessionsStore.rollbackStatusTransition(firstTransition!)).toBe(true);
    expect(sessionsStore.getByFilter('active')).toHaveLength(999);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(
      sessionsStore.completeStatusTransition(secondTransition!, {
        ...second,
        status: 'archived',
        pinnedAt: null,
        updatedAt: new Date(3_000_000).toISOString(),
      }),
    ).toBe(true);

    await waitFor(() => expect(sessionsStore.getByFilter('active')).toHaveLength(1000));
    expect(requestedFilters()).toEqual(['active']);
    expect(sessionsStore.getByFilter('active')?.at(-1)?.id).toBe('active-1000');
  });

  it('waits for all overlapping archive writes before rolling back their shared optimistic state', async () => {
    const archived = Array.from({ length: 1000 }, (_, index) =>
      session(
        `archived-${index}`,
        'archived',
        new Date(2_000_000 - index * 1_000).toISOString(),
      ),
    );
    const target = session('archive-me', 'active', new Date(1_500_500).toISOString());
    mocks.list.mockResolvedValueOnce([target]).mockResolvedValueOnce(archived);
    await sessionsStore.ensureByFilter('active');
    await sessionsStore.ensureByFilter('archived');

    const first = sessionsStore.beginStatusTransition('archive-me', {
      status: 'archived',
      pinnedAt: null,
    });
    const second = sessionsStore.beginStatusTransition('archive-me', {
      status: 'archived',
      pinnedAt: null,
    });

    expect(sessionsStore.rollbackStatusTransition(first!)).toBe(true);
    expect(sessionsStore.getByFilter('archived')?.some(({ id }) => id === 'archive-me')).toBe(true);
    expect(sessionsStore.rollbackStatusTransition(second!)).toBe(true);
    expect(sessionsStore.getByFilter('active')?.map(({ id }) => id)).toEqual(['archive-me']);
    expect(sessionsStore.getByFilter('archived')?.map(({ id }) => id)).toEqual(
      archived.map(({ id }) => id),
    );
  });

  it.each(['active', 'deleted'] as const)(
    'keeps a later %s status and restores the full archived bucket before an old archive response returns',
    async (laterStatus) => {
      const archived = Array.from({ length: 1000 }, (_, index) =>
        session(
          `archived-${index}`,
          'archived',
          new Date(2_000_000 - index * 1_000).toISOString(),
        ),
      );
      const target = session('archive-me', 'active', new Date(1_500_500).toISOString());
      mocks.list.mockResolvedValueOnce([target]).mockResolvedValueOnce(archived);
      await sessionsStore.ensureByFilter('active');
      await sessionsStore.ensureByFilter('archived');

      const transition = sessionsStore.beginStatusTransition('archive-me', {
        status: 'archived',
        pinnedAt: null,
      });
      sessionsStore.patchLocal('archive-me', { status: laterStatus });

      expect(sessionsStore.getByFilter('archived')?.map(({ id }) => id)).toEqual(
        archived.map(({ id }) => id),
      );
      expect(
        sessionsStore.completeStatusTransition(transition!, {
          ...target,
          status: 'archived',
          pinnedAt: null,
          updatedAt: new Date(3_000_000).toISOString(),
        }),
      ).toBe(false);
      expect(sessionsStore.getByFilter('active')?.some(({ id }) => id === 'archive-me')).toBe(
        laterStatus === 'active',
      );
      expect(sessionsStore.getByFilter('archived')?.some(({ id }) => id === 'archive-me')).toBe(
        false,
      );
    },
  );

  it('waits for an archive to settle before restoring and rolls a failed restore back to its full row', async () => {
    const target = session('archive-me', 'active', '2026-08-27T01:00:00.000Z');
    const previousNewest = session(
      'previous-newest',
      'archived',
      '2026-08-27T02:00:00.000Z',
    );
    mocks.list
      .mockResolvedValueOnce([target])
      .mockResolvedValueOnce([previousNewest])
      .mockResolvedValueOnce([previousNewest, target]);
    await sessionsStore.ensureByFilter('active');
    await sessionsStore.ensureByFilter('archived');
    await sessionsStore.ensureByFilter('all');

    const archive = sessionsStore.beginStatusTransition('archive-me', {
      status: 'archived',
      pinnedAt: null,
    });
    let restoreStarted = false;
    const restorePromise = sessionsStore
      .waitForStatusTransition('archive-me')
      .then((canContinue) => {
        restoreStarted = true;
        return canContinue
          ? sessionsStore.beginStatusTransition('archive-me', { status: 'active' })
          : null;
      });
    await Promise.resolve();
    expect(restoreStarted).toBe(false);

    expect(
      sessionsStore.completeStatusTransition(archive!, {
        ...target,
        status: 'archived',
        pinnedAt: null,
        updatedAt: '2026-08-27T03:00:00.000Z',
      }),
    ).toBe(true);
    const restore = await restorePromise;
    expect(restoreStarted).toBe(true);
    expect(sessionsStore.getByFilter('active')?.map(({ id }) => id)).toEqual(['archive-me']);
    expect(sessionsStore.getByFilter('archived')?.map(({ id }) => id)).toEqual([
      'previous-newest',
    ]);

    expect(sessionsStore.rollbackStatusTransition(restore!)).toBe(true);
    expect(sessionsStore.getByFilter('active')).toEqual([]);
    expect(sessionsStore.getByFilter('archived')?.map(({ id }) => id)).toEqual([
      'archive-me',
      'previous-newest',
    ]);
    expect(sessionsStore.getByFilter('all')?.map(({ id, status }) => [id, status])).toEqual([
      ['archive-me', 'archived'],
      ['previous-newest', 'archived'],
    ]);
    expect(sessionsStore.getByFilter('all')?.[0].updatedAt).toBe(
      '2026-08-27T03:00:00.000Z',
    );
  });

  it('begins queued status actions one at a time so opposite transitions cannot replace each other', async () => {
    const target = session('archive-me', 'active', '2026-08-27T01:00:00.000Z');
    mocks.list.mockResolvedValueOnce([target]);
    await sessionsStore.ensureByFilter('all');

    const initialArchive = sessionsStore.beginStatusTransition('archive-me', {
      status: 'archived',
      pinnedAt: null,
    });
    let laterArchiveStarted = false;
    const queuedRestore = sessionsStore.beginStatusTransitionWhenReady('archive-me', {
      status: 'active',
    });
    const queuedArchive = sessionsStore
      .beginStatusTransitionWhenReady('archive-me', {
        status: 'archived',
        pinnedAt: null,
      })
      .then((transition) => {
        laterArchiveStarted = true;
        return transition;
      });

    expect(
      sessionsStore.completeStatusTransition(initialArchive!, {
        ...target,
        status: 'archived',
        pinnedAt: null,
      }),
    ).toBe(true);
    const restore = await queuedRestore;
    expect(restore).not.toBeNull();
    expect(laterArchiveStarted).toBe(false);

    expect(
      sessionsStore.completeStatusTransition(restore!, {
        ...target,
        status: 'active',
        pinnedAt: null,
      }),
    ).toBe(true);
    const laterArchive = await queuedArchive;
    expect(laterArchive).not.toBeNull();
    expect(laterArchiveStarted).toBe(true);
    expect(
      sessionsStore.completeStatusTransition(laterArchive!, {
        ...target,
        status: 'archived',
        pinnedAt: null,
      }),
    ).toBe(true);
    expect(sessionsStore.hasPendingStatusTransition('archive-me')).toBe(false);
    expect(sessionsStore.getByFilter('all')?.[0].status).toBe('archived');
  });

  it('stops queued waits and atomic begins when the store resets', async () => {
    mocks.list.mockResolvedValueOnce([session('archive-me')]);
    await sessionsStore.ensureByFilter('active');
    sessionsStore.beginStatusTransition('archive-me', {
      status: 'archived',
      pinnedAt: null,
    });
    const queued = sessionsStore.waitForStatusTransition('archive-me');
    const queuedBegin = sessionsStore.beginStatusTransitionWhenReady('archive-me', {
      status: 'active',
    });

    sessionsStore.reset();

    await expect(queued).resolves.toBe(false);
    await expect(queuedBegin).resolves.toBeNull();
    expect(sessionsStore.getByFilter('active')).toBeNull();
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

  it('moves a row with an authoritative timestamp from archived into active without querying', async () => {
    mocks.list
      .mockResolvedValueOnce([session('stay-active')])
      .mockResolvedValueOnce([session('restore-me', 'archived')])
      .mockResolvedValueOnce([session('restore-me', 'archived')]);
    await sessionsStore.ensureByFilter('active');
    await sessionsStore.ensureByFilter('archived');
    await sessionsStore.ensureByFilter('all');
    mocks.list.mockReset();

    act(() =>
      sessionsStore.patchLocal('restore-me', {
        status: 'active',
        updatedAt: '2026-08-27T01:00:00.000Z',
      }),
    );

    expect(sessionsStore.getByFilter('active')?.find(({ id }) => id === 'restore-me')).toEqual(
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

  it('trails a stale full-bucket response only after the pending status write settles', async () => {
    const target = session('archive-me', 'active', new Date(2_001_000).toISOString());
    const active = [
      target,
      ...Array.from({ length: 999 }, (_, index) =>
        session(
          `active-${index}`,
          'active',
          new Date(2_000_000 - index * 1_000).toISOString(),
        ),
      ),
    ];
    const replacement = session('active-1000', 'active', new Date(1_000_000).toISOString());
    const staleRequest = deferred<Session[]>();
    const trailingRequest = deferred<Session[]>();
    mocks.list
      .mockImplementationOnce(() => staleRequest.promise)
      .mockImplementationOnce(() => trailingRequest.promise);

    const staleLoad = sessionsStore.ensureByFilter('active');
    const transition = sessionsStore.beginStatusTransition('archive-me', {
      status: 'archived',
      pinnedAt: null,
    });
    staleRequest.resolve(active);
    await staleLoad;

    expect(sessionsStore.getByFilter('active')).toHaveLength(999);
    expect(requestedFilters()).toEqual(['active']);

    expect(
      sessionsStore.completeStatusTransition(transition!, {
        ...target,
        status: 'archived',
        pinnedAt: null,
        updatedAt: new Date(3_000_000).toISOString(),
      }),
    ).toBe(true);
    await waitFor(() => expect(requestedFilters()).toEqual(['active', 'active']));

    trailingRequest.resolve([...active.slice(1), replacement]);
    await waitFor(() => expect(sessionsStore.getByFilter('active')).toHaveLength(1000));
    expect(sessionsStore.getByFilter('active')?.at(-1)?.id).toBe('active-1000');
  });

  it('trails a target request when its cached status migration lacks updatedAt', async () => {
    mocks.list.mockResolvedValueOnce([session('archive-me')]);
    await sessionsStore.ensureByFilter('active');

    const staleArchivedRequest = deferred<Session[]>();
    const trailingArchivedRequest = deferred<Session[]>();
    mocks.list
      .mockImplementationOnce(() => staleArchivedRequest.promise)
      .mockImplementationOnce(() => trailingArchivedRequest.promise);
    const staleLoad = sessionsStore.ensureByFilter('archived');

    act(() => sessionsStore.patchLocal('archive-me', { status: 'archived' }));
    staleArchivedRequest.resolve([session('already-archived', 'archived')]);
    await staleLoad;

    expect(sessionsStore.getByFilter('archived')?.map(({ id }) => id)).toEqual([
      'already-archived',
      'archive-me',
    ]);
    await waitFor(() => expect(requestedFilters()).toEqual(['active', 'archived', 'archived']));

    trailingArchivedRequest.resolve([
      session('archive-me', 'archived', '2026-08-27T03:00:00.000Z'),
      session('already-archived', 'archived'),
    ]);
    await waitFor(() => {
      expect(sessionsStore.getByFilter('archived')?.map(({ id }) => id)).toEqual([
        'archive-me',
        'already-archived',
      ]);
    });
    expect(sessionsStore.getByFilter('archived')?.map(({ id }) => id)).toEqual([
      'archive-me',
      'already-archived',
    ]);
    expect(sessionsStore.getByFilter('archived')?.[0]?.updatedAt).toBe(
      '2026-08-27T03:00:00.000Z',
    );
  });

  it('does not let an older archived response overwrite a later deleted status', async () => {
    mocks.list.mockResolvedValueOnce([session('archive-me')]);
    await sessionsStore.ensureByFilter('active');

    const staleArchivedRequest = deferred<Session[]>();
    mocks.list.mockImplementationOnce(() => staleArchivedRequest.promise);
    const staleLoad = sessionsStore.ensureByFilter('archived');

    act(() => {
      sessionsStore.patchLocal('archive-me', {
        status: 'archived',
        updatedAt: '2026-08-27T01:00:00.000Z',
      });
      sessionsStore.patchLocal('archive-me', { status: 'deleted' });
    });
    staleArchivedRequest.resolve([session('archive-me', 'archived')]);
    await staleLoad;

    expect(sessionsStore.getByFilter('active')).toEqual([]);
    expect(sessionsStore.getByFilter('archived')).toEqual([]);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });
});

import type { Session } from '@/lib/ccAgent.types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * sessionsStore 置顶字段防旧快照竞态（issue #7664）。
 *
 * 测试价值
 * - 生产入口与可观察结果：sessionsStore.patchLocal（取消置顶成功广播
 *   `{ pinnedAt: null, summary: null }` 不带 status）+ ensureByFilter/forceRefresh
 *   的列表回填；用户可观察结果是任务菜单在「置顶 / 取消置顶」之间跳变、摘要清空被回滚。
 * - Bug／规则依据：issue #7664（含维护者确认：pinnedAt/summary 缺少独立版本保护，
 *   且 sessionStatusOverrides 单一 rowRevision 会把过期 pinnedAt 随摘要更新重放）。
 * - 现有覆盖缺口：sessionTitleOverrides / sessionSpendOverrides 各有竞态文件，
 *   置顶字段此前没有任何防旧快照覆盖，也无与状态覆盖记录交错的探针。
 * - 最小失败输入：列表请求在途时 patchLocal 取消置顶广播，放行旧列表快照
 *   （用例 1）；置顶带 status 建立状态覆盖后，取消置顶、新请求在途期间仅到摘要
 *   更新，再放行携带重新置顶时间戳的响应（用例 2）。
 * - tier：unit —— 纯 renderer store 模块级状态，node 环境可控 Promise 排序。
 */

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('@/lib/sessionService', () => ({
  list: mocks.list,
  create: vi.fn(),
}));

import { sessionsStore } from '@/lib/sessionsStore';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function session(id: string, partial: Partial<Session> = {}): Session {
  return { id, status: 'active', updatedAt: '2026-10-27T00:00:00.000Z', ...partial } as Session;
}

describe('sessionsStore pin override race', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    sessionsStore.reset();
  });

  afterEach(() => {
    sessionsStore.reset();
  });

  it('keeps an unpinned session unpinned when a stale list response lands after the unpin broadcast', async () => {
    const initial = deferred<Session[]>();
    const refresh = deferred<Session[]>();
    mocks.list
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => refresh.promise);

    const firstLoad = sessionsStore.ensureByFilter('active');
    initial.resolve([session('s1', { pinnedAt: '2026-10-26T00:00:00.000Z', summary: 'old' })]);
    await firstLoad;

    const reload = sessionsStore.forceRefresh('active');
    // 取消置顶成功广播:不带 status,数据库与广播均已落定。
    sessionsStore.patchLocal('s1', { pinnedAt: null, summary: null });
    refresh.resolve([session('s1', { pinnedAt: '2026-10-26T00:00:00.000Z', summary: 'old' })]);
    await reload;

    const row = sessionsStore.getByFilter('active')?.[0];
    expect(row?.pinnedAt).toBeNull();
    expect(row?.summary).toBeNull();
  });

  it('does not resurface a stale pinnedAt when a later summary event bumps the status override', async () => {
    const initial = deferred<Session[]>();
    const refresh = deferred<Session[]>();
    // 带 status 的广播缺 updatedAt 会触发定向补拉:第 2 次调用留给它,
    // 受控旧快照必须落在第 3 次(forceRefresh)上。
    mocks.list
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => Promise.resolve([]))
      .mockImplementationOnce(() => refresh.promise)
      .mockImplementation(() => Promise.resolve([]));
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    const firstLoad = sessionsStore.ensureByFilter('active');
    initial.resolve([session('s1', { pinnedAt: '2026-10-26T00:00:00.000Z' })]);
    await firstLoad;

    // 置顶成功广播带 status,建立状态覆盖记录。
    sessionsStore.patchLocal('s1', { pinnedAt: '2026-10-26T01:00:00.000Z', status: 'active' });
    // 取消置顶成功广播不带 status,合入既有状态覆盖记录。
    sessionsStore.patchLocal('s1', { pinnedAt: null, summary: null });
    await flush();

    // 新列表请求起飞:数据库已有重新置顶后的时间戳,对应置顶广播尚未到达。
    const reload = sessionsStore.forceRefresh('active');
    // 请求期间只收到摘要更新。
    sessionsStore.patchLocal('s1', { summary: 'fresh summary' });
    refresh.resolve([session('s1', { pinnedAt: '2026-10-26T02:00:00.000Z' })]);
    await reload;

    const row = sessionsStore.getByFilter('active')?.[0];
    // 重新置顶的数据库值不能被状态覆盖记录里过期的 pinnedAt: null 冲掉。
    expect(row?.pinnedAt).toBe('2026-10-26T02:00:00.000Z');
    expect(row?.summary).toBe('fresh summary');
  });

  it('does not replay a removed session pin override onto a recreated row', async () => {
    const initial = deferred<Session[]>();
    const refresh = deferred<Session[]>();
    mocks.list
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => refresh.promise);

    const firstLoad = sessionsStore.ensureByFilter('active');
    initial.resolve([session('s1', { pinnedAt: null })]);
    await firstLoad;

    // 新建页未发送任务删除后,同一个 id 仍可能重建(removeLocal 语义)。
    const reload = sessionsStore.forceRefresh('active');
    sessionsStore.patchLocal('s1', { pinnedAt: null, summary: null });
    sessionsStore.removeLocal('s1');
    // 重建后的行带全新置顶时间戳。
    refresh.resolve([session('s1', { pinnedAt: '2026-10-26T03:00:00.000Z', summary: 'new' })]);
    await reload;

    const row = sessionsStore.getByFilter('active')?.[0];
    expect(row?.pinnedAt).toBe('2026-10-26T03:00:00.000Z');
    expect(row?.summary).toBe('new');
  });

  it('keeps the rolled-back pin values when a stale list response lands after a failed unpin', async () => {
    const initial = deferred<Session[]>();
    const refresh = deferred<Session[]>();
    mocks.list
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => refresh.promise);

    const firstLoad = sessionsStore.ensureByFilter('active');
    initial.resolve([session('s1', { pinnedAt: '2026-10-26T00:00:00.000Z', summary: 'old' })]);
    await firstLoad;

    const reload = sessionsStore.forceRefresh('active');
    // 乐观取消置顶后 patchMeta 失败,CCAgentSidebarUpper 提交回滚字段。
    sessionsStore.patchLocal('s1', { pinnedAt: null, summary: null });
    sessionsStore.patchLocal('s1', {
      pinnedAt: '2026-10-26T00:00:00.000Z',
      summary: 'old',
    });
    refresh.resolve([session('s1', { pinnedAt: '2026-10-26T00:00:00.000Z', summary: 'old' })]);
    await reload;

    const row = sessionsStore.getByFilter('active')?.[0];
    expect(row?.pinnedAt).toBe('2026-10-26T00:00:00.000Z');
    expect(row?.summary).toBe('old');
  });
});

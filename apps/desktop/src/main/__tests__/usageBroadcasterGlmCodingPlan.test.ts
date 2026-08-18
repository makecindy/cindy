/**
 * usageBroadcaster 的 GLM Coding Plan 快照段单测 —— per-provider 隔离与冷缓存语义:
 *   - 首笔快照不因 owner 首次初始化被世代复查误丢
 *   - 不同 provider 的快照互不串扰(读写按 provider_id 隔离)
 *   - clear 抢先于 in-flight hydration 时, 读回的旧行不得复活
 *   - record 按新快照全量替换(单数据源, 无 merge)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const shared = {
    queryOne: vi.fn(),
    exec: vi.fn(async () => undefined),
  };
  const clientQueue: Array<{ queryOne: unknown; exec: unknown; drizzle: {} }> = [];
  return {
    queryOne: shared.queryOne,
    exec: shared.exec,
    getCurrentUserId: vi.fn(() => 'user-1'),
    /** 逐次派发的 client 队列(八轮 PTB/Paw 用;空时回落共享 mock,旧用例零影响)。 */
    clientQueue,
    takeClient: () => clientQueue.shift()
      ?? { queryOne: shared.queryOne, exec: shared.exec, drizzle: {} as const },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../localDb/dailySpend', () => ({
  incrementDailySpend: vi.fn(),
  getTodaySpend: vi.fn(async () => 0),
  localDayKey: () => '2026-08-14',
}));
vi.mock('../localDb/dailyModelUsage', () => ({
  incrementDailyModelUsage: vi.fn(),
}));
vi.mock('../localDb/client/current', () => ({
  getDbClient: () => mocks.takeClient(),
}));
vi.mock('../localDb/index', () => ({
  getCurrentUserId: mocks.getCurrentUserId,
}));

function snapshotOf(utilization: number) {
  return {
    fiveHour: { utilization, resetsAt: null },
    platform: 'zhipu' as const,
    source: 'monitor-endpoint',
    updatedAt: utilization,
    keyFingerprint: 'fp-a',
  };
}

describe('glm coding plan snapshot store (per-provider)', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.queryOne.mockReset();
    mocks.exec.mockReset().mockResolvedValue(undefined);
    mocks.getCurrentUserId.mockReturnValue('user-1');
    mocks.clientQueue.length = 0;
  });

  it('does not drop the very first snapshot after main start', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue(null);

    await broadcaster.recordGlmCodingPlanUsageSnapshot('p1', snapshotOf(10));

    const current = await broadcaster.readGlmCodingPlanUsageSnapshot('p1');
    expect(current?.fiveHour?.utilization).toBe(10);
    expect(mocks.exec).toHaveBeenCalled();
  });

  it('keeps snapshots of different providers isolated', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue(null);

    await broadcaster.recordGlmCodingPlanUsageSnapshot('p1', snapshotOf(10));
    await broadcaster.recordGlmCodingPlanUsageSnapshot('p2', snapshotOf(80));

    expect((await broadcaster.readGlmCodingPlanUsageSnapshot('p1'))?.fiveHour?.utilization)
      .toBe(10);
    expect((await broadcaster.readGlmCodingPlanUsageSnapshot('p2'))?.fiveHour?.utilization)
      .toBe(80);
  });

  it('clearing one provider does not resurrect it from a stale hydration read', async () => {
    const broadcaster = await import('../usageBroadcaster');
    // 冷缓存: hydration 读挂起,期间 clear 已把快照置 null
    let resolveRead!: (value: { snapshot: string } | null) => void;
    mocks.queryOne.mockReturnValue(new Promise<{ snapshot: string } | null>((res) => {
      resolveRead = res;
    }));

    const readPromise = broadcaster.readGlmCodingPlanUsageSnapshot('p1');
    await broadcaster.clearGlmCodingPlanUsageSnapshot('p1');
    // 挂起的读现在返回旧行 —— 世代已 bump, 不得复活
    resolveRead({ snapshot: JSON.stringify(snapshotOf(99)) });
    await readPromise;

    // clear 之后的 read 视缓存为已知(hydrated), 不再回库
    mocks.queryOne.mockClear();
    await expect(broadcaster.readGlmCodingPlanUsageSnapshot('p1')).resolves.toBeNull();
  });

  it('clearing one provider does not invalidate another provider in-flight hydration (#2768 二轮 r3788460233)', async () => {
    const broadcaster = await import('../usageBroadcaster');
    // p1 的 hydration 挂起中;期间无关的 p2 被 clear —— 旧全局世代实现会把 p1
    // 的在飞读一并作废(误丢后一个 180s 节流窗内无法恢复)。
    let resolveP1!: (value: { snapshot: string } | null) => void;
    const p1Read = new Promise<{ snapshot: string } | null>((res) => { resolveP1 = res; });
    mocks.queryOne.mockImplementation(async (_sql: string, params: unknown[]) =>
      (params[0] === 'p1' ? p1Read : null) as { snapshot: string } | null);

    const readPromise = broadcaster.readGlmCodingPlanUsageSnapshot('p1');
    await broadcaster.clearGlmCodingPlanUsageSnapshot('p2');
    resolveP1({ snapshot: JSON.stringify(snapshotOf(42)) });
    await readPromise;

    // p2 的 clear 不影响 p1 —— 42 正常落到缓存(后续 read 已 hydrated,不再回库)
    mocks.queryOne.mockClear();
    const current = await broadcaster.readGlmCodingPlanUsageSnapshot('p1');
    expect(current?.fiveHour?.utilization).toBe(42);
  });

  it('discards a hydration row when the owner switches mid-read with no entry to bump the epoch (七轮 ③)', async () => {
    const broadcaster = await import('../usageBroadcaster');
    // 冷缓存:hydration 读挂起;期间账号切换,但**没有任何 GLM 入口被调用** ——
    // ownerEpoch 是懒检测,不前进,单靠世代比对发现不了切号。A 账号的行不得
    // 落进 B 账号的内存(否则 B 的 chip seed A 的余量)。
    let resolveRead!: (value: { snapshot: string } | null) => void;
    mocks.queryOne.mockReturnValue(new Promise<{ snapshot: string } | null>((res) => {
      resolveRead = res;
    }));
    const readPromise = broadcaster.readGlmCodingPlanUsageSnapshot('p1');
    mocks.getCurrentUserId.mockReturnValue('user-2'); // 挂起期间切号(无人 reset)
    resolveRead({ snapshot: JSON.stringify(snapshotOf(77)) }); // A 的行迟到
    await expect(readPromise).resolves.toBeNull();

    // 自愈:下一次入口的 reset 检出切号,按新 owner 重新回库水合。
    mocks.queryOne.mockReset();
    mocks.queryOne.mockResolvedValue({ snapshot: JSON.stringify(snapshotOf(31)) });
    await expect(broadcaster.readGlmCodingPlanUsageSnapshot('p1')).resolves.toMatchObject({
      fiveHour: { utilization: 31 },
    });
    expect(mocks.queryOne).toHaveBeenCalled();
  });

  it('八轮 PTB: 补偿删除复用 INSERT 时捕获的 client,owner 切换后不碰新连接', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue(null);
    const aJson = JSON.stringify(snapshotOf(10));
    // 队列按 getDbClient 调用序派发:①hydration 读 ②record 的 try 捕获 ③「切换后
    // 的新连接」——若补偿重新 getDbClient() 就会拿到它(代表新账号的 DB 切片)。
    let resolveInsert!: () => void;
    const capturedExec = vi.fn(async () => undefined);
    capturedExec.mockImplementationOnce(
      () => new Promise<undefined>((res) => { resolveInsert = () => res(undefined); }),
    );
    const postSwitch = { queryOne: vi.fn(), exec: vi.fn(async () => undefined), drizzle: {} };
    mocks.clientQueue.push(
      { queryOne: mocks.queryOne, exec: mocks.exec, drizzle: {} },
      { queryOne: vi.fn(async () => null), exec: capturedExec, drizzle: {} },
      postSwitch,
    );
    const token = broadcaster.beginGlmCodingPlanUsageWrite('p1');
    const rec = broadcaster.recordGlmCodingPlanUsageSnapshot('p1', snapshotOf(10), token);
    await vi.waitFor(() => expect(capturedExec).toHaveBeenCalledTimes(1));
    // INSERT 挂起期间切号;beginWrite 只做同步 reset(推进 ownerEpoch),不碰 DB。
    mocks.getCurrentUserId.mockReturnValue('user-2');
    broadcaster.beginGlmCodingPlanUsageWrite('p1');
    resolveInsert();
    await rec;
    // 补偿 DELETE 走捕获的同一 client(且带内容匹配);「新连接」零调用。
    expect(capturedExec).toHaveBeenCalledTimes(2);
    expect(String((capturedExec.mock.calls[1] as unknown[])[0])).toContain('AND snapshot =');
    expect((capturedExec.mock.calls[1] as unknown[])[1]).toEqual(['p1', aJson]);
    expect(postSwitch.exec).not.toHaveBeenCalled();
    expect(postSwitch.queryOne).not.toHaveBeenCalled();
  });

  it('八轮 Paw: 补偿删除带内容匹配,不误删新世代已落库的快照', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue(null);
    const aJson = JSON.stringify(snapshotOf(10));
    const bJson = JSON.stringify(snapshotOf(60));
    // 模拟行语义:INSERT upsert 覆盖行;DELETE 带内容参数时仅当行内容等于该参数
    // 才删(新代码形态),单参数 DELETE 无条件删(旧形态,留给回归对照)。
    let row: string | null = null;
    const gates: Array<(v?: void) => void> = [];
    const capturedExec = vi.fn((sql: string, params: unknown[]) => {
      if (sql.includes('INSERT')) {
        return new Promise<void>((res) => { gates.push(() => { row = params[1] as string; res(); }); });
      }
      return new Promise<void>((res) => {
        gates.push(() => {
          if (params.length > 1) { if (row === params[1]) row = null; }
          else row = null;
          res();
        });
      });
    });
    const newGenExec = vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT')) row = params[1] as string;
      return undefined;
    });
    mocks.clientQueue.push(
      { queryOne: mocks.queryOne, exec: mocks.exec, drizzle: {} },
      { queryOne: vi.fn(async () => null), exec: capturedExec, drizzle: {} },
      { queryOne: vi.fn(async () => null), exec: newGenExec, drizzle: {} },
    );
    // A 的 record:INSERT 挂起
    const tokenA = broadcaster.beginGlmCodingPlanUsageWrite('p1');
    const recA = broadcaster.recordGlmCodingPlanUsageSnapshot('p1', snapshotOf(10), tokenA);
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    // 世代前进(CRUD 作废,不删快照)
    broadcaster.invalidateGlmCodingPlanUsageWrites('p1');
    gates[0](); // A 的 INSERT 落库(row=A),续体判定过期 → 发出补偿 DELETE(挂起)
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    // 新世代补刷在补偿 DELETE 挂起期间落库(row=B)
    const tokenB = broadcaster.beginGlmCodingPlanUsageWrite('p1');
    const recB = broadcaster.recordGlmCodingPlanUsageSnapshot('p1', snapshotOf(60), tokenB);
    await vi.waitFor(() => expect(newGenExec).toHaveBeenCalledTimes(1));
    gates[1](); // A 的补偿 DELETE 恢复 —— 行内容已不是 A 写的那笔
    await Promise.all([recA, recB]);
    expect(row).toBe(bJson); // B 的快照存活(旧形态按 provider_id 裸删会把它抹掉)
    expect((capturedExec.mock.calls[1] as unknown[])[1]).toEqual(['p1', aJson]);
  });

  it('replaces the snapshot wholesale on record (single source, no merge)', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue(null);

    await broadcaster.recordGlmCodingPlanUsageSnapshot('p1', snapshotOf(40));
    await broadcaster.recordGlmCodingPlanUsageSnapshot('p1', {
      ...snapshotOf(60),
      fiveHour: null,
      monthlyMcp: { utilization: 7, resetsAt: null },
    });

    const current = await broadcaster.readGlmCodingPlanUsageSnapshot('p1');
    expect(current?.fiveHour).toBeNull();
    expect(current?.monthlyMcp?.utilization).toBe(7);
  });

  it('ignores non-object snapshots', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue(null);
    await broadcaster.recordGlmCodingPlanUsageSnapshot('p1', 'garbage');
    await broadcaster.recordGlmCodingPlanUsageSnapshot('p1', null);
    await expect(broadcaster.readGlmCodingPlanUsageSnapshot('p1')).resolves.toBeNull();
  });

  it('rejects a tokened write whose generation was bumped mid-flight (store-level T2)', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue(null);
    const token = broadcaster.beginGlmCodingPlanUsageWrite('p1');
    await broadcaster.clearGlmCodingPlanUsageSnapshot('p1'); // CRUD 强制清 → 世代 bump
    await broadcaster.recordGlmCodingPlanUsageSnapshot('p1', snapshotOf(50), token);
    // 提交被拒:内存无快照、不落库(exec 只剩 clear 的 DELETE)
    await expect(broadcaster.readGlmCodingPlanUsageSnapshot('p1')).resolves.toBeNull();
    expect(mocks.exec.mock.calls.filter((call) => String((call as unknown[])[0]).includes('INSERT'))).toHaveLength(0);
  });

  it('rejects a tokened write across an owner-epoch advance (store-level T3)', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue(null);
    const token = broadcaster.beginGlmCodingPlanUsageWrite('p1');
    mocks.getCurrentUserId.mockReturnValue('user-2'); // owner 切换
    await broadcaster.recordGlmCodingPlanUsageSnapshot('p1', snapshotOf(50), token);
    await expect(broadcaster.readGlmCodingPlanUsageSnapshot('p1')).resolves.toBeNull();
  });

  it('accepts a tokened write with a current token; skips a stale tokened clear', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue(null);
    const token = broadcaster.beginGlmCodingPlanUsageWrite('p1');
    await broadcaster.recordGlmCodingPlanUsageSnapshot('p1', snapshotOf(42), token);
    expect((await broadcaster.readGlmCodingPlanUsageSnapshot('p1'))?.fiveHour?.utilization).toBe(42);
    // 令牌失效后的条件清 → 静默跳过(不 bump、不广播删除)
    const staleToken = broadcaster.beginGlmCodingPlanUsageWrite('p1');
    await broadcaster.clearGlmCodingPlanUsageSnapshot('p1');
    await broadcaster.clearGlmCodingPlanUsageSnapshot('p1', staleToken);
    // staleToken 在第二次 clear 后失效,但快照已被第一次(强制)清掉 → null
    await expect(broadcaster.readGlmCodingPlanUsageSnapshot('p1')).resolves.toBeNull();
  });
});

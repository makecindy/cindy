/**
 * device-link 单持有者仲裁测试:
 *  - DeviceLinkOwnershipArbiter 状态机(注入内存 store + 手动 tick / 假时钟)
 *  - createDbClientOwnershipStore 的 CAS 语义(真 better-sqlite3 :memory:,
 *    经 OwnershipDbAccess 适配器模拟 DbClient 的 async 接口)
 *  - 双实例竞争的端到端不变量:任意时刻至多一个持有者
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  DeviceLinkOwnershipArbiter,
  createDbClientOwnershipStore,
  type OwnershipDbAccess,
  type OwnershipIdentity,
  type OwnershipRow,
  type OwnershipStore,
} from '../ownership';

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const DDL = `CREATE TABLE device_link_ownership (
  id integer PRIMARY KEY NOT NULL,
  owner_id text NOT NULL,
  owner_pid integer NOT NULL,
  owner_label text,
  heartbeat_at integer NOT NULL
);`;

function identity(id: string, pid = 100): OwnershipIdentity {
  return { ownerId: id, ownerPid: pid, ownerLabel: 'test' };
}

/** 与 SQLite 实现同语义的内存 store(单进程测试用) */
function memoryStore(): OwnershipStore & {
  row: () => OwnershipRow | null;
  set(r: OwnershipRow | null): void;
} {
  let row: (OwnershipRow & { ownerLabel: string | null }) | null = null;
  return {
    row: () => row,
    set(r) {
      row = r ? { ...r, ownerLabel: null } : null;
    },
    read: async () =>
      row ? { ownerId: row.ownerId, ownerPid: row.ownerPid, heartbeatAt: row.heartbeatAt } : null,
    async tryInsert(id, now) {
      if (row) return false;
      row = {
        ownerId: id.ownerId,
        ownerPid: id.ownerPid,
        ownerLabel: id.ownerLabel,
        heartbeatAt: now,
      };
      return true;
    },
    async tryTakeover(expected, id, now) {
      if (!row || row.ownerId !== expected.ownerId || row.heartbeatAt !== expected.heartbeatAt) {
        return false;
      }
      row = {
        ownerId: id.ownerId,
        ownerPid: id.ownerPid,
        ownerLabel: id.ownerLabel,
        heartbeatAt: now,
      };
      return true;
    },
    async renew(ownerId, now) {
      if (!row || row.ownerId !== ownerId) return false;
      row = { ...row, heartbeatAt: now };
      return true;
    },
    async release(ownerId) {
      if (row?.ownerId === ownerId) row = null;
    },
  };
}

function makeArbiter(opts: { store: OwnershipStore | null; id?: string; now: () => number }) {
  const onAcquire = vi.fn();
  const onDemote = vi.fn();
  const onStandbyChanged = vi.fn();
  const arbiter = new DeviceLinkOwnershipArbiter({
    getStore: () => opts.store,
    instance: { ownerPid: 100, ownerLabel: 'test' },
    newOwnerId: () => opts.id ?? 'self',
    onAcquire,
    onDemote,
    onStandbyChanged,
    heartbeatMs: 5_000,
    staleMs: 15_000,
    now: opts.now,
  });
  // 测试直接手动驱动 tick,不调 start()(避免 start 的后台首 tick 与手动 tick 竞争防重入锁)
  return { arbiter, onAcquire, onDemote, onStandbyChanged };
}

describe('DeviceLinkOwnershipArbiter', () => {
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    clock = 1_000_000;
  });

  it('空表 → 认领成功并回调 onAcquire', async () => {
    const store = memoryStore();
    const { arbiter, onAcquire } = makeArbiter({ store, now });
    await arbiter.tick();
    expect(arbiter.isOwner()).toBe(true);
    expect(onAcquire).toHaveBeenCalledTimes(1);
    expect(store.row()?.ownerId).toBe('self');
  });

  it('外部持有者心跳新鲜 → 保持被动不抢', async () => {
    const store = memoryStore();
    store.set({ ownerId: 'other', ownerPid: 200, heartbeatAt: clock - 5_000 });
    const { arbiter, onAcquire } = makeArbiter({ store, now });
    await arbiter.tick();
    expect(arbiter.isOwner()).toBe(false);
    expect(onAcquire).not.toHaveBeenCalled();
    expect(store.row()?.ownerId).toBe('other');
  });

  it('外部持有者心跳过期 → CAS 接管', async () => {
    const store = memoryStore();
    store.set({ ownerId: 'other', ownerPid: 200, heartbeatAt: clock - 16_000 });
    const { arbiter, onAcquire } = makeArbiter({ store, now });
    await arbiter.tick();
    expect(arbiter.isOwner()).toBe(true);
    expect(onAcquire).toHaveBeenCalledTimes(1);
    expect(store.row()?.ownerId).toBe('self');
  });

  it('持有者续期正常 → 心跳被刷新且不重复回调', async () => {
    const store = memoryStore();
    const { arbiter, onAcquire } = makeArbiter({ store, now });
    await arbiter.tick();
    expect(onAcquire).toHaveBeenCalledTimes(1);
    clock += 5_000;
    await arbiter.tick();
    expect(store.row()?.heartbeatAt).toBe(clock);
    expect(onAcquire).toHaveBeenCalledTimes(1);
  });

  it('续期失败(行被接管)→ onDemote 且不抢回', async () => {
    const store = memoryStore();
    const { arbiter, onDemote } = makeArbiter({ store, now });
    await arbiter.tick();
    // 模拟睡眠期间被另一实例接管
    store.set({ ownerId: 'usurper', ownerPid: 300, heartbeatAt: clock });
    clock += 5_000;
    await arbiter.tick();
    expect(arbiter.isOwner()).toBe(false);
    expect(onDemote).toHaveBeenCalledTimes(1);
    // 对方心跳新鲜,后续 tick 保持被动
    await arbiter.tick();
    expect(arbiter.isOwner()).toBe(false);
    expect(store.row()?.ownerId).toBe('usurper');
  });

  it('stop() → 释放行 + onDemote;幸存实例可立即接管', async () => {
    const store = memoryStore();
    const a = makeArbiter({ store, id: 'a', now });
    await a.arbiter.tick();
    a.arbiter.stop();
    expect(a.onDemote).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(store.row()).toBeNull()); // release 是 fire-and-forget

    const b = makeArbiter({ store, id: 'b', now });
    await b.arbiter.tick();
    expect(b.arbiter.isOwner()).toBe(true);
  });

  it('store 未就绪(null / getStore 抛错)→ 跳过不崩;就绪后下一轮认领', async () => {
    let store: OwnershipStore | null = null;
    const onAcquire = vi.fn();
    const arbiter = new DeviceLinkOwnershipArbiter({
      getStore: () => {
        if (!store) throw new Error('DbClient not ready');
        return store;
      },
      instance: { ownerPid: 100, ownerLabel: 'test' },
      newOwnerId: () => 'self',
      onAcquire,
      onDemote: vi.fn(),
      heartbeatMs: 5_000,
      staleMs: 15_000,
      now,
    });
    await arbiter.tick();
    expect(onAcquire).not.toHaveBeenCalled();
    store = memoryStore();
    await arbiter.tick();
    expect(onAcquire).toHaveBeenCalledTimes(1);
  });

  it('store 操作抛错 → 本轮吞掉,下一轮自愈', async () => {
    const store = memoryStore();
    const broken: OwnershipStore = {
      ...store,
      read: async () => {
        throw new Error('no such table: device_link_ownership');
      },
    };
    let current: OwnershipStore = broken;
    const onAcquire = vi.fn();
    const arbiter = new DeviceLinkOwnershipArbiter({
      getStore: () => current,
      instance: { ownerPid: 100, ownerLabel: 'test' },
      newOwnerId: () => 'self',
      onAcquire,
      onDemote: vi.fn(),
      heartbeatMs: 5_000,
      staleMs: 15_000,
      now,
    });
    await expect(arbiter.tick()).resolves.toBeUndefined();
    current = store;
    await arbiter.tick();
    expect(onAcquire).toHaveBeenCalledTimes(1);
  });

  it('store 未就绪时亚秒级快速重试,就绪后立即认领(不等下一整拍)', async () => {
    vi.useFakeTimers();
    try {
      let store: OwnershipStore | null = null;
      const onAcquire = vi.fn();
      const arbiter = new DeviceLinkOwnershipArbiter({
        getStore: () => store,
        instance: { ownerPid: 100, ownerLabel: 'test' },
        newOwnerId: () => 'self',
        onAcquire,
        onDemote: vi.fn(),
        heartbeatMs: 5_000,
        staleMs: 15_000,
        storeRetryMs: 500,
        now,
      });
      arbiter.start();
      expect(onAcquire).not.toHaveBeenCalled();
      // DbClient 就绪(冷启动 auth 先到、DB takeover 后完成的时序)
      store = memoryStore();
      await vi.advanceTimersByTimeAsync(500);
      expect(onAcquire).toHaveBeenCalledTimes(1);
      arbiter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('认领窗口内被 stop() → 刚写入的行被补释放,不留新鲜孤儿行', async () => {
    const store = memoryStore();
    let unblockInsert!: () => void;
    const gate = new Promise<void>((r) => {
      unblockInsert = r;
    });
    const slow: OwnershipStore = {
      ...store,
      async tryInsert(id, at) {
        const ok = await store.tryInsert(id, at);
        await gate; // 模拟慢 RPC:写入已落库,但结果尚未返回
        return ok;
      },
    };
    const { arbiter, onAcquire } = makeArbiter({ store: slow, now });
    const inflight = arbiter.tick();
    await new Promise((r) => setImmediate(r)); // 推进到 tryInsert 挂起点(行已写入)
    expect(store.row()?.ownerId).toBe('self');
    arbiter.stop(); // 此刻 owner 仍为 false,stop() 不会释放这条行
    unblockInsert();
    await inflight;
    expect(onAcquire).not.toHaveBeenCalled();
    // 取消的认领必须被补释放,否则幸存实例只能等 staleMs 过期
    await vi.waitFor(() => expect(store.row()).toBeNull());
  });

  it('stop() 的 release 迟到时不会误删重启后新认领的行(ownerId 每次 start 轮换)', async () => {
    const store = memoryStore();
    let seq = 0;
    const pendingReleases: Array<() => Promise<void>> = [];
    const slowRelease: OwnershipStore = {
      ...store,
      release: (ownerId) =>
        new Promise<void>((resolve) => {
          pendingReleases.push(async () => {
            await store.release(ownerId);
            resolve();
          });
        }),
    };
    const arbiter = new DeviceLinkOwnershipArbiter({
      getStore: () => slowRelease,
      instance: { ownerPid: 100, ownerLabel: 'test' },
      newOwnerId: () => `id-${++seq}`,
      onAcquire: vi.fn(),
      onDemote: vi.fn(),
      heartbeatMs: 5_000,
      staleMs: 15_000,
      now,
    });
    await arbiter.tick(); // id-1 认领
    expect(store.row()?.ownerId).toBe('id-1');
    arbiter.stop(); // release(id-1) 被挂起(模拟登出时 RPC 迟迟未落盘)
    arbiter.start(); // 轮换为 id-2
    await new Promise((r) => setImmediate(r)); // 后台首 tick:旧行仍在且心跳新鲜 → 被动
    expect(arbiter.isOwner()).toBe(false);
    clock += 16_000; // 旧行心跳过期
    await arbiter.tick(); // id-2 接管
    expect(arbiter.isOwner()).toBe(true);
    expect(store.row()?.ownerId).toBe('id-2');
    // 迟到的 stale release 此刻才落盘:按旧 ownerId(id-1)删,不得误删 id-2 的行
    // (若 ownerId 不轮换,这里 DELETE WHERE owner_id=self 会把新认领的行删掉)
    await pendingReleases[0]();
    expect(store.row()?.ownerId).toBe('id-2');
    arbiter.stop();
  });

  it('持有者续期持续不可达(store 长期 null)→ 在同伴判过期前自我降级停 client', async () => {
    let store: OwnershipStore | null = memoryStore();
    const onDemote = vi.fn();
    const arbiter = new DeviceLinkOwnershipArbiter({
      getStore: () => store,
      instance: { ownerPid: 100, ownerLabel: 'test' },
      newOwnerId: () => 'self',
      onAcquire: vi.fn(),
      onDemote,
      heartbeatMs: 5_000,
      staleMs: 15_000,
      now,
    });
    await arbiter.tick();
    expect(arbiter.isOwner()).toBe(true);
    // DbClient 崩溃:store 不可用,续期停摆
    store = null;
    clock += 5_000;
    await arbiter.tick(); // 距上次续期成功 5s,未过自我降级期限(10s),保持持有
    expect(arbiter.isOwner()).toBe(true);
    clock += 6_000; // 距上次续期成功 11s > staleMs - heartbeatMs = 10s
    await arbiter.tick();
    expect(arbiter.isOwner()).toBe(false);
    expect(onDemote).toHaveBeenCalledTimes(1);
  });

  it('renew RPC 挂起(传输层超时 30s > staleMs)→ 独立降级检查仍按期停 client', async () => {
    vi.useFakeTimers();
    try {
      const base = memoryStore();
      const hung: OwnershipStore = {
        ...base,
        renew: () => new Promise<boolean>(() => {}), // 永不返回,模拟 worker 挂起
      };
      const onDemote = vi.fn();
      const arbiter = new DeviceLinkOwnershipArbiter({
        getStore: () => hung,
        instance: { ownerPid: 100, ownerLabel: 'test' },
        newOwnerId: () => 'self',
        onAcquire: vi.fn(),
        onDemote,
        heartbeatMs: 5_000,
        staleMs: 15_000,
        now, // 与假时钟同步推进
      });
      arbiter.start();
      await vi.advanceTimersByTimeAsync(0); // 首 tick:tryInsert 即时成功 → 持有
      expect(arbiter.isOwner()).toBe(true);
      // 三拍内 renew 全部挂起:第 5s / 10s 的独立检查未越限保持,15s 检查越限(>10s)降级
      for (const step of [5_000, 5_000, 5_000]) {
        clock += step;
        await vi.advanceTimersByTimeAsync(step);
      }
      expect(arbiter.isOwner()).toBe(false);
      expect(onDemote).toHaveBeenCalledTimes(1);
      arbiter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() 在认领 CAS 已提交但 tick 未返回时,返回值涵盖取消认领的补释放', async () => {
    const store = memoryStore();
    let resolveInsert: (ok: boolean) => void = () => {};
    const gated: OwnershipStore = {
      ...store,
      tryInsert: (id, at) =>
        new Promise<boolean>((resolve) => {
          resolveInsert = (ok) => {
            // 模拟 CAS 已在 DB 落盘、RPC 返回慢:先真实写入,再放行返回值
            void store.tryInsert(id, at).then(() => resolve(ok));
          };
        }),
    };
    const arbiter = new DeviceLinkOwnershipArbiter({
      getStore: () => gated,
      instance: { ownerPid: 100, ownerLabel: 'test' },
      newOwnerId: () => 'self',
      onAcquire: vi.fn(),
      onDemote: vi.fn(),
      heartbeatMs: 5_000,
      staleMs: 15_000,
      now,
    });
    const tickPromise = arbiter.tick(); // 停在 tryInsert await
    await Promise.resolve(); // 让 tick 推进到 tryInsert
    const stopPromise = arbiter.stop(); // 此刻 owner 仍为 false,常规 release 不触发
    resolveInsert(true); // CAS 提交完成,tick 恢复后发现已取消 → 补释放
    await stopPromise; // stop 的返回值必须等到补释放落盘
    await tickPromise;
    expect(store.row()).toBeNull();
  });

  it('认领 CAS 本地超时后晚落盘,stop() 仍能补释放该行(不滞留到 staleMs)', async () => {
    vi.useFakeTimers();
    try {
      const base = memoryStore();
      let resolveInsert: (ok: boolean) => void = () => {};
      const gated: OwnershipStore = {
        ...base,
        tryInsert: (id, at) =>
          new Promise<boolean>((resolve) => {
            resolveInsert = (ok) => void base.tryInsert(id, at).then(() => resolve(ok));
          }),
      };
      const arbiter = new DeviceLinkOwnershipArbiter({
        getStore: () => gated,
        instance: { ownerPid: 100, ownerLabel: 'test' },
        newOwnerId: () => 'self',
        onAcquire: vi.fn(),
        onDemote: vi.fn(),
        heartbeatMs: 5_000,
        staleMs: 15_000,
        now,
      });
      const tickPromise = arbiter.tick();
      await vi.advanceTimersByTimeAsync(5_000); // tryInsert 本地超时 → trackLateClaim 登记
      await tickPromise;
      expect(arbiter.isOwner()).toBe(false);
      const stopPromise = arbiter.stop();
      resolveInsert(true); // CAS 在 stop 之后才落盘
      await stopPromise; // stop 返回值等 late-claim settle 并补释放
      expect(base.row()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('staleMs 配置过小直接拒绝', () => {
    expect(
      () =>
        new DeviceLinkOwnershipArbiter({
          getStore: () => null,
          instance: { ownerPid: 100, ownerLabel: 'test' },
          onAcquire: () => {},
          onDemote: () => {},
          heartbeatMs: 5_000,
          staleMs: 10_000,
          now,
        }),
    ).toThrow(/staleMs/);
  });

  describe('待命状态通知(onStandbyChanged)', () => {
    it('外部持有者心跳新鲜 → 通知待命并去重', async () => {
      const store = memoryStore();
      store.set({ ownerId: 'other', ownerPid: 200, heartbeatAt: clock - 5_000 });
      const { arbiter, onStandbyChanged } = makeArbiter({ store, now });
      await arbiter.tick();
      expect(arbiter.isStandby()).toBe(true);
      expect(onStandbyChanged).toHaveBeenCalledWith(true);
      store.set({ ownerId: 'other', ownerPid: 200, heartbeatAt: clock });
      await arbiter.tick();
      expect(onStandbyChanged).toHaveBeenCalledTimes(1);
    });

    it('过期持有者直接接管,不先闪一次待命', async () => {
      const store = memoryStore();
      store.set({ ownerId: 'other', ownerPid: 200, heartbeatAt: clock - 16_000 });
      const { arbiter, onStandbyChanged } = makeArbiter({ store, now });
      await arbiter.tick();
      expect(arbiter.isOwner()).toBe(true);
      expect(arbiter.isStandby()).toBe(false);
      expect(onStandbyChanged).not.toHaveBeenCalled();
    });

    it('失去持有权、接管和 stop 都会翻转待命状态', async () => {
      const store = memoryStore();
      const { arbiter, onStandbyChanged } = makeArbiter({ store, now });
      await arbiter.tick();
      store.set({ ownerId: 'usurper', ownerPid: 300, heartbeatAt: clock });
      clock += 5_000;
      await arbiter.tick();
      expect(arbiter.isStandby()).toBe(true);
      expect(onStandbyChanged).toHaveBeenLastCalledWith(true);
      clock += 16_000;
      await arbiter.tick();
      expect(arbiter.isOwner()).toBe(true);
      expect(onStandbyChanged).toHaveBeenLastCalledWith(false);
      await arbiter.stop();
      expect(arbiter.isStandby()).toBe(false);
    });

    it('ownership store 短暂不可用时保留最近一次已确认的待命状态', async () => {
      const base = memoryStore();
      base.set({ ownerId: 'other', ownerPid: 200, heartbeatAt: clock - 5_000 });
      let store: OwnershipStore | null = base;
      const onStandbyChanged = vi.fn();
      const arbiter = new DeviceLinkOwnershipArbiter({
        getStore: () => store,
        instance: { ownerPid: 100, ownerLabel: 'test' },
        newOwnerId: () => 'self',
        onAcquire: vi.fn(),
        onDemote: vi.fn(),
        onStandbyChanged,
        heartbeatMs: 5_000,
        staleMs: 15_000,
        now,
      });

      await arbiter.tick();
      expect(arbiter.isStandby()).toBe(true);

      store = {
        ...base,
        read: async () => {
          throw new Error('temporary ownership store failure');
        },
      };
      await arbiter.tick();
      expect(arbiter.isStandby()).toBe(true);

      store = null;
      await arbiter.tick();
      expect(arbiter.isStandby()).toBe(true);
      expect(onStandbyChanged).toHaveBeenCalledTimes(1);
    });

    it('ownership read 本地超时时保留待命,直到明确结果推进状态', async () => {
      vi.useFakeTimers();
      try {
        const base = memoryStore();
        base.set({ ownerId: 'other', ownerPid: 200, heartbeatAt: clock - 5_000 });
        let readHangs = false;
        const store: OwnershipStore = {
          ...base,
          read: () => (readHangs ? new Promise<never>(() => {}) : base.read()),
        };
        const onStandbyChanged = vi.fn();
        const arbiter = new DeviceLinkOwnershipArbiter({
          getStore: () => store,
          instance: { ownerPid: 100, ownerLabel: 'test' },
          newOwnerId: () => 'self',
          onAcquire: vi.fn(),
          onDemote: vi.fn(),
          onStandbyChanged,
          heartbeatMs: 5_000,
          staleMs: 15_000,
          opTimeoutMs: 100,
          now,
        });

        await arbiter.tick();
        expect(arbiter.isStandby()).toBe(true);

        readHangs = true;
        const timedOutTick = arbiter.tick();
        await vi.advanceTimersByTimeAsync(100);
        await timedOutTick;
        expect(arbiter.isStandby()).toBe(true);
        expect(onStandbyChanged).toHaveBeenCalledTimes(1);

        readHangs = false;
        base.set(null);
        await arbiter.tick();
        expect(arbiter.isOwner()).toBe(true);
        expect(arbiter.isStandby()).toBe(false);
        expect(onStandbyChanged).toHaveBeenLastCalledWith(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('createDbClientOwnershipStore(真 SQLite CAS 语义,DbClient 接口适配)', () => {
  /** 用 better-sqlite3 :memory: 模拟 DbClient 的 queryOne/exec 异步接口 */
  function dbAccess(db: InstanceType<typeof Database>): OwnershipDbAccess {
    return {
      queryOne: async <T>(sql: string, params: unknown[] = []) =>
        db.prepare(sql).get(...params) as T | undefined,
      exec: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
    };
  }

  function freshStore(): OwnershipStore {
    const db = new Database(':memory:');
    db.exec(DDL);
    return createDbClientOwnershipStore(dbAccess(db));
  }

  it('tryInsert:空表成功,已有行失败(ON CONFLICT DO NOTHING)', async () => {
    const store = freshStore();
    expect(await store.tryInsert(identity('a'), 1000)).toBe(true);
    expect(await store.tryInsert(identity('b'), 2000)).toBe(false);
    expect((await store.read())?.ownerId).toBe('a');
  });

  it('tryTakeover:期望值匹配才成功;心跳已被续期则失败', async () => {
    const store = freshStore();
    await store.tryInsert(identity('a'), 1000);
    expect(await store.renew('a', 1500)).toBe(true);
    // 期望的 heartbeatAt 不匹配(a 刚续期)→ 失败
    expect(await store.tryTakeover({ ownerId: 'a', heartbeatAt: 1000 }, identity('b'), 2000)).toBe(
      false,
    );
    // 匹配当前值 → 成功
    expect(await store.tryTakeover({ ownerId: 'a', heartbeatAt: 1500 }, identity('b'), 2000)).toBe(
      true,
    );
    expect(await store.read()).toMatchObject({ ownerId: 'b', heartbeatAt: 2000 });
  });

  it('renew:非持有者续期失败', async () => {
    const store = freshStore();
    await store.tryInsert(identity('a'), 1000);
    expect(await store.renew('b', 2000)).toBe(false);
    expect((await store.read())?.heartbeatAt).toBe(1000);
  });

  it('release:只删自己的行,不误删他人', async () => {
    const store = freshStore();
    await store.tryInsert(identity('a'), 1000);
    await store.release('b');
    expect((await store.read())?.ownerId).toBe('a');
    await store.release('a');
    expect(await store.read()).toBeNull();
  });

  it('双仲裁器共享同一 DB:任意时刻至多一个持有者,持有者死后另一个接管', async () => {
    const db = new Database(':memory:');
    db.exec(DDL);
    const access = dbAccess(db);
    let clock = 1_000_000;
    const now = () => clock;
    const mk = (id: string) => {
      const onAcquire = vi.fn();
      const onDemote = vi.fn();
      const arbiter = new DeviceLinkOwnershipArbiter({
        getStore: () => createDbClientOwnershipStore(access),
        instance: { ownerPid: 100, ownerLabel: 'test' },
        newOwnerId: () => id,
        onAcquire,
        onDemote,
        heartbeatMs: 5_000,
        staleMs: 15_000,
        now,
      });
      return { arbiter, onAcquire, onDemote };
    };
    const a = mk('a');
    const b = mk('b');

    // a 先启动 → 持有;b 后启动 → 被动
    await a.arbiter.tick();
    await b.arbiter.tick();
    expect(a.arbiter.isOwner()).toBe(true);
    expect(b.arbiter.isOwner()).toBe(false);

    // 双方按节奏 tick 两轮:持有权稳定,不互抢
    for (let i = 0; i < 2; i++) {
      clock += 5_000;
      await a.arbiter.tick();
      await b.arbiter.tick();
    }
    expect(a.arbiter.isOwner()).toBe(true);
    expect(b.arbiter.isOwner()).toBe(false);

    // a 卡死(不再 tick),时间推进超过 staleMs → b 接管
    clock += 16_000;
    await b.arbiter.tick();
    expect(b.arbiter.isOwner()).toBe(true);

    // a 苏醒后续期失败 → 降级,且不会抢回
    clock += 1_000;
    await a.arbiter.tick();
    expect(a.arbiter.isOwner()).toBe(false);
    expect(a.onDemote).toHaveBeenCalledTimes(1);
    clock += 5_000;
    await a.arbiter.tick();
    await b.arbiter.tick();
    expect(a.arbiter.isOwner()).toBe(false);
    expect(b.arbiter.isOwner()).toBe(true);
  });
});

/**
 * recentWorkdirsLru.test.ts — upsertRecentWorkdir 的 LRU 驱逐回归。
 *
 * 背景:驱逐原先写成 `getDbClient().drizzle.run(sql`...`)`。main 侧拿到的 drizzle 是
 * createDrizzleProxy 的代理,只把 **query builder** 的终结方法转发给 worker RPC;直接在
 * db 对象上跑 raw SQL 不经过 builder,会落进代理内部只会抛错的 fakeSqliteClient.prepare(),
 * 再被 drizzle 包成 "Failed to run the query '...'",最后被 fire-and-forget 的 catch 吞成
 * 一条 warn —— 驱逐 100% 静默失败,表一直涨过上限(线上实测 18 行 > 上限 10)。
 *
 * 所以 harness 必须用**代理**建,不能用真实 `drizzle(sqlite)`:同样的用例在真实 drizzle 上
 * 会假绿,这正是 bug 当初溜过去的原因(见 recentWorkdirsDelete.test.ts 的 harness)。
 */
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbTransport } from '../../client/DbTransport.js';

/** 与 recentWorkdirs.ts 的模块私有常量对齐(未 export,这里跟随其语义硬编码)。 */
const MAX_RECENT_WORKDIRS = 10;

const h = vi.hoisted(() => ({
  sqlite: null as InstanceType<typeof import('better-sqlite3')> | null,
  client: null as { drizzle: unknown; exec: unknown } | null,
  warns: [] as unknown[],
  /** 本次 upsert 实际发给 backend 的 SQL,用于断言驱逐没退化成 SELECT + DELETE 两步。 */
  statements: [] as string[],
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => {
      h.warns.push(args);
    },
    error: vi.fn(),
  }),
}));
vi.mock('../../client/current', () => ({
  getDbClient: () => h.client,
}));

import { createDrizzleProxy } from '../../client/drizzleProxy';
import { upsertRecentWorkdir } from '../recentWorkdirs';

/**
 * 假 transport:按 worker/dispatcher.ts 的 op 语义把 SQL 转发给真实 in-memory SQLite。
 * 逐条对齐 worker/opHandlers:query → stmt.all / queryOne → stmt.get /
 * run|exec → stmt.run / rawAll → stmt.raw().all / rawGet → stmt.raw().get
 * (raw* 返回数组而非对象,见 opHandlers/rawAll.ts、rawGet.ts)。
 */
function createTransport(): DbTransport {
  return {
    send: async (op: string, args?: unknown) => {
      const { sql: text, params = [] } = (args ?? {}) as { sql: string; params?: unknown[] };
      h.statements.push(text.replace(/\s+/g, ' ').trim());
      const stmt = h.sqlite!.prepare(text);
      if (op === 'query') return stmt.all(...(params as never[]));
      if (op === 'queryOne') return stmt.get(...(params as never[]));
      if (op === 'rawAll') return stmt.raw().all(...(params as never[]));
      if (op === 'rawGet') return stmt.raw().get(...(params as never[]));
      if (op === 'run' || op === 'exec') return stmt.run(...(params as never[]));
      throw new Error(`unexpected op: ${op}`);
    },
    on: () => {},
    onTerminated: () => {},
    close: async () => {},
  } as unknown as DbTransport;
}

function rows(): Array<{ path: string; last_used_at: number }> {
  return h.sqlite!
    .prepare('SELECT path, last_used_at FROM recent_workdirs ORDER BY last_used_at DESC')
    .all() as Array<{ path: string; last_used_at: number }>;
}

beforeEach(() => {
  h.sqlite?.close();
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE recent_workdirs (
      path TEXT PRIMARY KEY NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE INDEX idx_recent_workdirs_last_used_at ON recent_workdirs(last_used_at);
  `);
  h.sqlite = sqlite;
  h.warns = [];
  h.statements = [];

  const transport = createTransport();
  h.client = {
    drizzle: createDrizzleProxy(() => transport),
    // upsert 与驱逐必须全程留在上面这个**已捕获**的 drizzle handle 上。走 client.exec
    // 会在 in-proc fallback 下于调用时再解析一次模块全局 getRawDb() —— insert 之后若发生
    // 账号切换,驱逐就会打到新账号的库。这里故意让 exec 抛错:实现一旦回退去用它,
    // 下面的用例立刻变红。
    exec: () => {
      throw new Error(
        'client.exec must not be used: eviction has to stay on the pinned drizzle handle',
      );
    },
  };
});

describe('upsertRecentWorkdir LRU 驱逐', () => {
  it('超过上限时删掉最旧的,只保留 MAX_RECENT_WORKDIRS 条', async () => {
    const total = MAX_RECENT_WORKDIRS + 4;
    for (let i = 0; i < total; i++) {
      await upsertRecentWorkdir(`/Users/dash/Code/proj-${i}`, 1_700_000_000_000 + i * 1_000);
    }

    const kept = rows();
    expect(kept).toHaveLength(MAX_RECENT_WORKDIRS);
    // 保留的必须是 lastUsedAt 最新的那批,最旧的 4 条被驱逐。
    expect(kept.map((r) => r.path)).toEqual(
      Array.from({ length: MAX_RECENT_WORKDIRS }, (_, k) => `/Users/dash/Code/proj-${total - 1 - k}`),
    );
    // 驱逐路径不得再走 fire-and-forget 的 catch —— 一条 warn 都不该有。
    expect(h.warns).toEqual([]);
  });

  it('存量已远超上限时,一次 upsert 就收敛到上限(不是每次只删 1 行)', async () => {
    // 模拟修复前留下的脏数据:驱逐长期静默失败,表涨到 18 行(线上实测值)。
    for (let i = 0; i < 18; i++) {
      h.sqlite!
        .prepare('INSERT INTO recent_workdirs (path, last_used_at) VALUES (?, ?)')
        .run(`/Users/dash/Code/stale-${i}`, 1_600_000_000_000 + i * 1_000);
    }
    expect(rows()).toHaveLength(18);

    await upsertRecentWorkdir('/Users/dash/Code/fresh', 1_700_000_000_000);

    // 子查询里的 `LIMIT -1 OFFSET n` 选中第 n+1 行起的全部行 → 一条 DELETE 一次到位。
    const kept = rows();
    expect(kept).toHaveLength(MAX_RECENT_WORKDIRS);
    expect(kept[0]?.path).toBe('/Users/dash/Code/fresh');
    expect(h.warns).toEqual([]);
  });

  it('驱逐是单条 DELETE(子查询挑待删行),不退化成 SELECT 快照 + DELETE 两步', async () => {
    // 分两步时,fire-and-forget 的并发 upsert 会在 SELECT 与 DELETE 之间刷新被选中的行,
    // 前一个调用仍按旧快照把「刚用过的目录」删掉。单语句由 SQLite 原子求值,没有这个窗口。
    for (let i = 0; i < MAX_RECENT_WORKDIRS + 2; i++) {
      await upsertRecentWorkdir(`/Users/dash/Code/proj-${i}`, 1_700_000_000_000 + i * 1_000);
    }

    const sent = h.statements.map((s) => s.toLowerCase());
    // 驱逐不得单独发 SELECT 去取快照。
    expect(sent.filter((s) => s.startsWith('select'))).toEqual([]);
    const deletes = sent.filter((s) => s.startsWith('delete'));
    expect(deletes.length).toBeGreaterThan(0);
    // 每条 DELETE 都必须自带子查询,而不是 `in (?, ?, …)` 这种按快照展开的形式。
    for (const stmt of deletes) expect(stmt).toMatch(/in \(select /);
    expect(h.warns).toEqual([]);
  });

  it('未超上限时不删任何行', async () => {
    for (let i = 0; i < 3; i++) {
      await upsertRecentWorkdir(`/Users/dash/Code/proj-${i}`, 1_700_000_000_000 + i * 1_000);
    }
    expect(rows()).toHaveLength(3);
    expect(h.warns).toEqual([]);
  });

  it('重复 upsert 同一目录只刷新时间戳,不新增行也不触发驱逐', async () => {
    await upsertRecentWorkdir('/Users/dash/Code/proj-a', 1_700_000_000_000);
    await upsertRecentWorkdir('/Users/dash/Code/proj-a', 1_700_000_009_000);

    const kept = rows();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ path: '/Users/dash/Code/proj-a', last_used_at: 1_700_000_009_000 });
    expect(h.warns).toEqual([]);
  });
});

describe('drizzleProxy 契约', () => {
  it('db 级 raw SQL(db.run(sql`...`))不被代理支持 —— 驱逐不能依赖这条路径', () => {
    const proxy = h.client!.drizzle as { run: (q: unknown) => unknown };
    // 这就是修复前的写法。注意它是**同步** throw(drizzle better-sqlite3 的 db.run 是
    // 同步 API),不是 rejected promise —— 所以原代码 `await db.run(...)` 的错误是靠外层
    // try/catch 兜住的。哪天代理开始支持 db 级 raw SQL,这条会变红,提醒回头更新
    // recentWorkdirs.ts 里那段注释。
    let caught: unknown;
    try {
      proxy.run(sql`DELETE FROM recent_workdirs WHERE path = 'nope'`);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error | undefined)?.message).toMatch(/Failed to run the query/);
    // 根因只在 cause 里 —— upsertRecentWorkdir 的 warn 因此必须带上 cause,否则日志
    // 只剩一条无因果的 SQL。
    expect((caught as Error).cause).toMatchObject({
      message: expect.stringContaining('worker RPC'),
    });
  });
});

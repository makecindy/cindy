/**
 * groupWindowRetentionProxy.test.ts — 群历史回收在 **worker RPC 代理**下的回归。
 *
 * 背景: main 侧拿到的 drizzle 是 createDrizzleProxy 的代理, 它只把 **query builder**
 * 的终结方法转发给 worker RPC。回收的边界查询原先写成 `db.all(sql`...`)`, 不经过
 * builder, 会落进代理内部只会抛错的 fakeSqliteClient.prepare() —— 也就是回收在
 * 生产上 100% 失败, 1 GiB / 500 万行上限完全不生效。
 *
 * 所以 harness 必须用**代理**建, 不能用真实 `drizzle(sqlite)`: 同样的用例在真实
 * drizzle 上会假绿, 这正是 bug 当初溜过去的原因(与 recentWorkdirs 的 LRU 驱逐
 * 同一类踩坑, 见 localDb/ipc/__tests__/recentWorkdirsLru.test.ts)。
 */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import type { DbTransport } from '../../../localDb/client/DbTransport.js';

const h = vi.hoisted(() => ({
  sqlite: null as InstanceType<typeof import('better-sqlite3')> | null,
  client: null as { drizzle: unknown } | null,
}));

vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  maskPath: (p: string) => p,
}));
vi.mock('../../../localDb/client/current', () => ({
  getDbClient: () => h.client,
  tryGetDbClient: () => h.client,
}));

import { createDrizzleProxy } from '../../../localDb/client/drizzleProxy';
import { recordGroupWindowEntry } from '../groupWindowCore';

const PROVIDER = 'telegram-personal:proxy-bot';

/** 按 worker/dispatcher.ts 的 op 语义把 SQL 转发给真实 in-memory SQLite。 */
function createTransport(): DbTransport {
  return {
    send: async (op: string, args?: unknown) => {
      const { sql: text, params = [] } = (args ?? {}) as { sql: string; params?: unknown[] };
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

function migrationSql(): string {
  const dir = path.resolve(__dirname, '../../../../../drizzle');
  return ['0083_', '0086_', '0087_', '0088_']
    .map((prefix) => {
      const file = fs.readdirSync(dir).find((name) => name.startsWith(prefix));
      if (!file) throw new Error(`${prefix} migration not found`);
      return fs.readFileSync(path.join(dir, file), 'utf8');
    })
    .join('\n')
    .replaceAll('--> statement-breakpoint', ';');
}

function stats(): { b: number; n: number } {
  const row = h.sqlite!
    .prepare(
      'SELECT text_bytes AS b, row_count AS n FROM hook_group_message_stats WHERE provider = ?',
    )
    .get(PROVIDER) as { b: number; n: number } | undefined;
  return row ?? { b: 0, n: 0 };
}

beforeEach(() => {
  h.sqlite?.close();
  const sqlite = new Database(':memory:');
  sqlite.exec(migrationSql());
  h.sqlite = sqlite;
  const transport = createTransport();
  h.client = { drizzle: createDrizzleProxy(() => transport) };
});

afterEach(() => {
  h.sqlite?.close();
  h.sqlite = null;
});

describe('群历史回收(worker RPC 代理下)', () => {
  it('回收真的执行了 —— 边界查询整条走 query builder, 不是 raw SQL', async () => {
    // 上限 2000 字节, 低水位 1800。第 21 条 100 字节的消息把总量顶到 2100,
    // 正好落在触发点上。raw SQL 那版会在这里抛 "should execute through worker RPC"。
    const retention = { maxTextBytesPerNamespace: 2_000, maxRowsPerNamespace: 5_000_000 };
    const body = 'x'.repeat(100);
    for (let i = 0; i < 21; i += 1) {
      await recordGroupWindowEntry(
        {
          provider: PROVIDER,
          chatId: '-900',
          threadId: '',
          messageId: `p${i}`,
          author: { name: '@u' },
          text: body,
          sentAt: 1,
        },
        retention,
      );
    }

    const after = stats();
    expect(after.b).toBeLessThanOrEqual(1_800); // 收敛到低水位, 不是压线
    expect(after.b).toBeGreaterThan(1_700); // 也没删过头
    expect(
      h.sqlite!
        .prepare('SELECT 1 FROM hook_group_messages WHERE provider = ? AND message_id = ?')
        .get(PROVIDER, 'p0'),
    ).toBeUndefined(); // 删的是最旧的
    expect(
      h.sqlite!
        .prepare('SELECT 1 FROM hook_group_messages WHERE provider = ? AND message_id = ?')
        .get(PROVIDER, 'p20'),
    ).toBeDefined(); // 最新的还在
  });
});

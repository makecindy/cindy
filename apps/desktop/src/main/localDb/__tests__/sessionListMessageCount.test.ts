/**
 * sessions:list 的 messageCount 必须用 `count(messages.session_id)` 数，不能用
 * `count(messages.id)`，也不能用 `count(*)`。三者在这条 LEFT JOIN 查询里各有一处会咬人：
 *
 *   - `count(*)`             语义错：LEFT JOIN 对零消息会话也产出一行，数出 1 而非 0，
 *                            会把 sidebar 的「单空 New Maker 草稿」判定打歪。
 *   - `count(messages.id)`   语义对但**回表**：id 不在任何覆盖索引里，SQLite 为取它要逐行
 *                            读 messages 主表。而这条查询的 LIMIT 在 GROUP BY 之后才生效，
 *                            削不掉扫描量 —— 于是成本正比于 messages 表总体积。4.7GB /
 *                            111 万条消息的真实库上冷缓存实测 10.2s，两个桶就是 20s 起。
 *   - `count(messages.session_id)`  语义对且走覆盖索引：session_id 是
 *                            idx_messages_session_created 的首列。同库同数据冷缓存 1.25s。
 *
 * list 查询另外还是**两段式**的（CTE 先取 id，主查询只对这批行算 count 与 preview），所以
 * 这里同时钉「两段式与一段式逐行等价」——把 LIMIT 提到 CTE 里是最容易写歪的地方。
 *
 * 用例分工不同，别混淆：
 *   - 前三个跑**自己构造的** SQL，是事实依据：证明「空会话语义」「覆盖索引 vs 回表」「两段式
 *     等价」这三条性质在真 schema 上确实如注释所述。它们不引用生产代码，所以生产代码改回
 *     messages.id 时**不会**失败。
 *   - 最后一个静态断言生产源码，是真正的回归门禁。
 *
 * 之所以两者都要：光有门禁，后人看不出为什么必须是 session_id，改回去只会觉得测试无理取闹；
 * 光有事实依据，则拦不住任何回归。
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { runMigrationReplay } from '../migrationRunner';

// 随包 sqlite-vec 只为 macOS / Windows 提供二进制，与 migrationReplay 测试同一守卫。
const canReplayMigrations = process.platform === 'win32' || process.platform === 'darwin';

function desktopRoot(): string {
  return path.resolve(__dirname, '../../../..');
}

/** migration 链里有 vec0 虚表，回放前必须挂上随包的 sqlite-vec（同 migrationReplay 测试）。 */
function loadSqliteVec(db: Database.Database): void {
  const filename = process.platform === 'win32' ? 'vec0.dll' : 'vec0.dylib';
  db.loadExtension(
    path.join(
      desktopRoot(),
      'native',
      'sqlite-vec',
      `${process.platform}-${process.arch}`,
      filename,
    ),
  );
}

/** 真实 migration 链建出的库——索引定义必须来自 drizzle/，手抄 CREATE INDEX 就测不到
 *  「有人改了索引定义」这种回归。 */
function createMigratedDb(): { db: Database.Database; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cindy-session-list-count-'));
  const db = createBetterSqliteDatabase(path.join(dir, 'list.db'));
  loadSqliteVec(db);
  runMigrationReplay(db, { drizzleDir: path.join(desktopRoot(), 'drizzle') });
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function insertSession(db: Database.Database, id: string, updatedAt: number): void {
  db.prepare(
    `INSERT INTO sessions (id, title, status, source, agent_kind, created_at, updated_at)
     VALUES (?, ?, 'active', 'desktop', 'cc', ?, ?)`,
  ).run(id, id, updatedAt, updatedAt);
}

function insertMessage(db: Database.Database, sessionId: string, seq: number): void {
  db.prepare(
    `INSERT INTO messages (id, client_id, session_id, role, content, created_at)
     VALUES (?, ?, ?, 'user', '"hi"', ?)`,
  ).run(`${sessionId}-m${seq}`, `${sessionId}-c${seq}`, sessionId, seq);
}

/** 一段式（历史形状）：LEFT JOIN + GROUP BY + ORDER BY + LIMIT，只换 count 的目标列。 */
function listSql(countExpr: string, limit = 1000): string {
  return `
    SELECT s.id AS id, count(${countExpr}) AS message_count
    FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
    WHERE s.status != 'deleted'
    GROUP BY s.id
    ORDER BY s.updated_at DESC
    LIMIT ${limit}
  `;
}

/** 两段式（当前生产形状）：CTE 先取 id，主查询只对这批行算标量 count。 */
function twoPhaseSql(limit = 1000): string {
  return `
    WITH picked AS (
      SELECT id FROM sessions
      WHERE status != 'deleted'
      ORDER BY updated_at DESC
      LIMIT ${limit}
    )
    SELECT s.id AS id,
           (SELECT count(*) FROM messages m WHERE m.session_id = s.id) AS message_count
    FROM sessions s INNER JOIN picked p ON p.id = s.id
    ORDER BY s.updated_at DESC
  `;
}

function queryPlan(db: Database.Database, sql: string): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[];
  return rows.map((row) => row.detail).join('\n');
}

// 真库用例需要 migration 回放；纯源码断言不需要，单独放在下面那个 describe 里。
const describeWithDb = canReplayMigrations ? describe : describe.skip;

describeWithDb('sessions:list messageCount', () => {
  it('counts 0 for a session with no messages, and rejects the count(*) shape', () => {
    const { db, cleanup } = createMigratedDb();
    try {
      insertSession(db, 'empty-session', 100);
      insertSession(db, 'chatty-session', 200);
      insertMessage(db, 'chatty-session', 1);
      insertMessage(db, 'chatty-session', 2);
      insertMessage(db, 'chatty-session', 3);

      const counts = (sql: string): Record<string, number> => {
        const rows = db.prepare(sql).all() as { id: string; message_count: number }[];
        return Object.fromEntries(rows.map((row) => [row.id, row.message_count]));
      };

      // 生产写法：空会话 0，有消息的会话数准。
      expect(counts(listSql('m.session_id'))).toEqual({
        'empty-session': 0,
        'chatty-session': 3,
      });

      // count(*) 会把空会话数成 1 —— 这正是不能拿它换性能的原因。
      expect(counts(listSql('*'))['empty-session']).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('two-phase CTE returns the same rows and counts as the one-phase shape', () => {
    const { db, cleanup } = createMigratedDb();
    try {
      // 排序、截断、空会话、被 LIMIT 挡在窗口外的行 —— 一次性覆盖。
      insertSession(db, 'newest', 500);
      insertSession(db, 'middle-empty', 400);
      insertSession(db, 'oldest', 300);
      insertSession(db, 'out-of-window', 200);
      for (let i = 1; i <= 4; i += 1) insertMessage(db, 'newest', i);
      insertMessage(db, 'oldest', 1);
      insertMessage(db, 'out-of-window', 1);

      const rows = (sql: string): unknown[] => db.prepare(sql).all();

      // 不截断时两种形状必须逐行等价（含顺序）。
      expect(rows(twoPhaseSql())).toEqual(rows(listSql('m.session_id')));

      // 截断时也必须等价 —— 两段式把 LIMIT 提到了 CTE 里，这是最容易写歪的地方。
      expect(rows(twoPhaseSql(3))).toEqual(rows(listSql('m.session_id', 3)));

      // 并且截断确实生效、窗口内容如预期（防止两边一起错成空集）。
      expect(rows(twoPhaseSql(3))).toEqual([
        { id: 'newest', message_count: 4 },
        { id: 'middle-empty', message_count: 0 },
        { id: 'oldest', message_count: 1 },
      ]);
    } finally {
      cleanup();
    }
  });

  it('uses a covering index for the count, unlike the count(messages.id) shape', () => {
    const { db, cleanup } = createMigratedDb();
    try {
      insertSession(db, 's1', 100);
      insertMessage(db, 's1', 1);
      // plan 与数据量无关，但空表可能让 SQLite 选别的路径，所以先落一条真实数据。
      db.exec('ANALYZE');

      const plan = queryPlan(db, listSql('m.session_id'));
      expect(plan).toMatch(/COVERING INDEX idx_messages_session_created/);

      // 对照：换回 messages.id 就掉出覆盖索引，SQLite 必须读到 messages 主表。
      // 只断言「没有 COVERING」而不断言它改走哪条路径 —— 小库上 SQLite 会直接选全表扫，
      // 具体路径随数据量和 ANALYZE 统计变化，回表与否才是这条测试要钉的性质。
      expect(queryPlan(db, listSql('m.id'))).not.toMatch(/COVERING INDEX/);
    } finally {
      cleanup();
    }
  });

});

describe('sessions:list messageCount source', () => {
  it('keeps the production query pinned to the covering-index column', () => {
    const source = readFileSync(path.join(__dirname, '..', 'ipc', 'sessions.ts'), 'utf-8');

    // list / get / update 都走同一条标量子查询，不再 LEFT JOIN 该会话全部消息。
    expect(source).toMatch(/messageCount: SESSION_MESSAGE_COUNT_SQL,/);
    expect(source).not.toMatch(/leftJoin\(messages/);
    expect(source).not.toMatch(/MESSAGE_COUNT_COL/);
    // 标量子查询里必须是 count(*)（无 LEFT JOIN 补行，空会话得 0），且限定 session_id。
    expect(source).toMatch(
      /SESSION_MESSAGE_COUNT_SQL = sql<number>`\(\s*SELECT count\(\*\) FROM messages m WHERE m\.session_id = \$\{sessions\.id\}/,
    );
    expect(source).toMatch(/ORDER BY m\.created_at DESC, m\.rowid DESC LIMIT 1/);

    // 回表写法在任何路径都不允许。锚定的是 select 字段的**代码形态**（`messageCount:`
    // 紧跟内联的 messages 列），而不是裸的 `count(messages.id)` 字符串——后者会把
    // "解释为什么不能这么写"的注释也一起判红（本测试与 sessions.ts 的注释都要举这个
    // 反例），于是正确的文档反而成了失败原因。
    expect(source).not.toMatch(/messageCount: count\(messages\./);
  });
});

/**
 * localOwnerDataImport.test — local → 账号 行级导入的语义单测。
 *
 * 用真实 better-sqlite3 临时库(源库 = local-v1,目标库 = 账号),因为被测逻辑本身
 * 就是 SQL 语义:ATTACH、pragma 取列、INSERT OR IGNORE、事务原子性,用假体测等于
 * 什么都没测。schema 只建被测表的最小列集,导入逻辑不依赖真实 schema 形状。
 */

import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Table, getTableName, is } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/sqlite-core';

import {
  IMPORTED_TABLES,
  SKIPPED_TABLES,
  importLocalOwnerData,
} from '../localDb/localOwnerDataImport';
import * as schema from '../localDb/schema';

let tmpDir: string;
let localDbPath: string;
let accountDbPath: string;
let accountDb: Database.Database;

/** 目标库(账号库)建表:被测清单里的代表性表 + 一张排除表。 */
const ACCOUNT_SCHEMA = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New Maker',
    working_dir TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL
  );
  CREATE TABLE custom_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE daily_spend (day TEXT PRIMARY KEY, amount REAL NOT NULL DEFAULT 0);
  CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    -- 无 REFERENCES 声明:靠已知列名清单命中。
    target_session_id TEXT,
    -- 有 REFERENCES 声明:靠动态读外键命中。
    skip_log_session_id TEXT REFERENCES sessions(id)
  );
  CREATE TABLE session_goals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    goal TEXT NOT NULL
  );
`;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cindy-adopt-import-'));
  localDbPath = path.join(tmpDir, 'cindy-local-v1.db');
  accountDbPath = path.join(tmpDir, 'cindy-user-1.db');
  accountDb = new Database(accountDbPath);
  accountDb.pragma('foreign_keys = ON');
  accountDb.exec(ACCOUNT_SCHEMA);
});

afterEach(async () => {
  accountDb.close();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

/** 建 local 源库并写入行;sql 省略时用与账号库同构的 schema。 */
function seedLocalDb(rows: (db: Database.Database) => void, sql = ACCOUNT_SCHEMA): void {
  const db = new Database(localDbPath);
  db.pragma('foreign_keys = ON');
  db.exec(sql);
  rows(db);
  db.close();
}

/**
 * schema.ts 里所有 drizzle 表的 SQL 表名。Object.values 的联合类型过宽(每张表都是
 * 自己的字面量类型),先降到 unknown 再用 drizzle 的 is() 收窄;getTableName 的签名
 * 要求具体表类型,这里按 unknown 入参重新标注。
 */
const sqlTableName = getTableName as unknown as (table: unknown) => string;

function schemaTableNames(): string[] {
  const names: string[] = [];
  for (const value of Object.values(schema) as unknown[]) {
    if (is(value, Table)) names.push(sqlTableName(value));
  }
  return names;
}

const countRows = (table: string): number =>
  (accountDb.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

describe('importLocalOwnerData 基本导入', () => {
  it('把 local 库的会话与消息并入空账号库', () => {
    seedLocalDb((db) => {
      db.prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)').run('s1', '本机会话', 1);
      db.prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)').run('s2', '另一个', 2);
      db.prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?,?,?,?)').run(
        'm1', 's1', 'user', '{}',
      );
    });

    const result = importLocalOwnerData(accountDb, localDbPath);

    expect(countRows('sessions')).toBe(2);
    expect(countRows('messages')).toBe(1);
    expect(result.inserted).toBe(3);
    expect(result.perTable).toMatchObject({ sessions: 2, messages: 1 });
  });

  it('账号库已有会话时两边共存(合并语义,这是行级导入存在的理由)', () => {
    accountDb
      .prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)')
      .run('acc-1', '账号已有会话', 10);
    seedLocalDb((db) => {
      db.prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)').run('s1', '本机会话', 1);
    });

    importLocalOwnerData(accountDb, localDbPath);

    const titles = accountDb
      .prepare('SELECT title FROM sessions ORDER BY created_at')
      .all()
      .map((row) => (row as { title: string }).title);
    expect(titles).toEqual(['本机会话', '账号已有会话']);
  });

  it('重复导入是 no-op(幂等,失败重试安全)', () => {
    seedLocalDb((db) => {
      db.prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)').run('s1', 'a', 1);
      db.prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?,?,?,?)').run(
        'm1', 's1', 'user', '{}',
      );
    });

    const first = importLocalOwnerData(accountDb, localDbPath);
    const second = importLocalOwnerData(accountDb, localDbPath);

    expect(first.inserted).toBe(2);
    expect(second.inserted).toBe(0);
    expect(countRows('sessions')).toBe(1);
    expect(countRows('messages')).toBe(1);
  });

  it('主键撞车时保留账号库已有内容(OR IGNORE 跳过整行)', () => {
    accountDb.prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)').run('dup', '账号版', 9);
    seedLocalDb((db) => {
      db.prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)').run('dup', '本机版', 1);
    });

    const result = importLocalOwnerData(accountDb, localDbPath);

    expect(result.perTable.sessions).toBeUndefined();
    expect(
      (accountDb.prepare('SELECT title FROM sessions WHERE id = ?').get('dup') as { title: string }).title,
    ).toBe('账号版');
  });

  it('按日期聚合的统计表撞同一天时保留账号侧(与产品取舍一致)', () => {
    accountDb.prepare('INSERT INTO daily_spend (day, amount) VALUES (?,?)').run('2026-07-24', 5);
    seedLocalDb((db) => {
      db.prepare('INSERT INTO daily_spend (day, amount) VALUES (?,?)').run('2026-07-24', 99);
      db.prepare('INSERT INTO daily_spend (day, amount) VALUES (?,?)').run('2026-07-25', 7);
    });

    importLocalOwnerData(accountDb, localDbPath);

    const rows = accountDb.prepare('SELECT day, amount FROM daily_spend ORDER BY day').all();
    expect(rows).toEqual([
      { day: '2026-07-24', amount: 5 },
      { day: '2026-07-25', amount: 7 },
    ]);
  });
});

describe('importLocalOwnerData schema 差异容忍', () => {
  it('local 库缺列(旧客户端建的库)时按列交集导入,缺的列取账号 schema 默认值', () => {
    seedLocalDb(
      (db) => {
        db.prepare('INSERT INTO sessions (id, title) VALUES (?,?)').run('s1', '老库会话');
      },
      `CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL);`,
    );

    const result = importLocalOwnerData(accountDb, localDbPath);

    expect(result.inserted).toBe(1);
    const row = accountDb.prepare('SELECT * FROM sessions').get() as Record<string, unknown>;
    // status/created_at 是账号 schema 才有的列 → 走默认值,不是 null。
    expect(row).toMatchObject({ id: 's1', title: '老库会话', status: 'active', created_at: 0 });
  });

  it('local 库多出的列被丢弃,不影响导入', () => {
    seedLocalDb(
      (db) => {
        db.prepare('INSERT INTO sessions (id, title, legacy_flag) VALUES (?,?,?)').run('s1', 'x', 1);
      },
      `CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, legacy_flag INTEGER);`,
    );

    expect(importLocalOwnerData(accountDb, localDbPath).inserted).toBe(1);
    expect(countRows('sessions')).toBe(1);
  });

  it('local 库缺表时记入 missingInSource,其余表照常导入', () => {
    seedLocalDb(
      (db) => {
        db.prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)').run('s1', 'x', 1);
      },
      `CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0);`,
    );

    const result = importLocalOwnerData(accountDb, localDbPath);

    expect(result.perTable).toEqual({ sessions: 1 });
    expect(result.missingInSource).toContain('messages');
    expect(result.missingInSource).toContain('custom_providers');
  });
});

describe('importLocalOwnerData 边界与原子性', () => {
  it('排除清单里的表不导入(migration_meta 会污染账号库迁移状态)', () => {
    accountDb.prepare('INSERT INTO migration_meta (key, value) VALUES (?,?)').run('schema', 'account');
    seedLocalDb((db) => {
      db.prepare('INSERT INTO migration_meta (key, value) VALUES (?,?)').run('other', 'local');
      db.prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)').run('s1', 'x', 1);
    });

    importLocalOwnerData(accountDb, localDbPath);

    expect(countRows('migration_meta')).toBe(1);
  });

  it('约束违规的行被 OR IGNORE 丢掉时,droppedRows 如实上报(不静默吞行)', () => {
    seedLocalDb(
      (db) => {
        db.prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)').run('s1', 'ok', 1);
        // role 在账号库是 NOT NULL;OR IGNORE 会静默跳过这行,核验必须发现它。
        db.prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?,?,?,?)').run(
          'm1', 's1', null, '{}',
        );
      },
      `CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0);
       CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT, content TEXT NOT NULL);`,
    );

    const result = importLocalOwnerData(accountDb, localDbPath);

    expect(countRows('sessions')).toBe(1);
    expect(countRows('messages')).toBe(0);
    expect(result.droppedRows).toEqual({ messages: 1 });
  });

  it('正常路径 droppedRows 为空;主键撞车不算丢行', () => {
    accountDb.prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)').run('dup', 'acc', 9);
    seedLocalDb((db) => {
      db.prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)').run('dup', 'local', 1);
      db.prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)').run('s2', 'new', 2);
    });

    expect(importLocalOwnerData(accountDb, localDbPath).droppedRows).toEqual({});
  });

  it('账号库缺表时整表跳过并记入 unimportableTables(不静默)', () => {
    accountDb.exec('DROP TABLE custom_providers');
    seedLocalDb((db) => {
      db.prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)').run('s1', 'x', 1);
      db.prepare('INSERT INTO custom_providers (id, name) VALUES (?,?)').run('p1', 'p');
    });

    const result = importLocalOwnerData(accountDb, localDbPath);

    expect(result.unimportableTables).toContain('custom_providers');
    expect(countRows('sessions')).toBe(1);
  });

  it('中途抛错时整体回滚,账号库零写入(单事务提交点)', () => {
    // BEFORE INSERT 触发器 RAISE(ABORT):OR IGNORE 不吞 ABORT,能真正抛出。
    accountDb.exec(
      `CREATE TRIGGER boom BEFORE INSERT ON custom_providers
         BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );
    seedLocalDb((db) => {
      db.prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)').run('s1', 'x', 1);
      db.prepare('INSERT INTO custom_providers (id, name) VALUES (?,?)').run('p1', 'p');
    });

    expect(() => importLocalOwnerData(accountDb, localDbPath)).toThrow(/boom/);
    // sessions 那一批先插成功了,事务回滚必须把它一起撤掉。
    expect(countRows('sessions')).toBe(0);
  });

  it('导入后源库自动 DETACH,同一连接可以再次导入', () => {
    seedLocalDb((db) => {
      db.prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)').run('s1', 'x', 1);
    });

    importLocalOwnerData(accountDb, localDbPath);
    // 未 DETACH 会撞 "database adopt_src is already in use"。
    expect(() => importLocalOwnerData(accountDb, localDbPath)).not.toThrow();
    const attached = (accountDb.pragma('database_list') as Array<{ name: string }>).map((r) => r.name);
    expect(attached).not.toContain('adopt_src');
  });

  it('导入失败后同样完成 DETACH(不把残留 attach 留给下一次)', () => {
    accountDb.exec(
      `CREATE TRIGGER boom BEFORE INSERT ON custom_providers
         BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );
    seedLocalDb((db) => {
      db.prepare('INSERT INTO custom_providers (id, name) VALUES (?,?)').run('p1', 'p');
    });

    expect(() => importLocalOwnerData(accountDb, localDbPath)).toThrow();
    const attached = (accountDb.pragma('database_list') as Array<{ name: string }>).map((r) => r.name);
    expect(attached).not.toContain('adopt_src');
  });
});

describe('importLocalOwnerData 同 id 会话冲突', () => {
  it('冲突会话的子行整批跳过,不挂到账号库那条同 id 会话上', () => {
    accountDb
      .prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)')
      .run('shared-id', '账号侧的会话', 10);
    accountDb
      .prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?,?,?,?)')
      .run('acc-m1', 'shared-id', 'user', '"账号侧消息"');
    seedLocalDb((db) => {
      // 同 id、不同内容:local 侧这条会话及其子行都必须整批跳过。
      db.prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)').run('shared-id', '本机的会话', 1);
      db.prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?,?,?,?)').run(
        'local-m1', 'shared-id', 'user', '"本机消息"',
      );
      db.prepare('INSERT INTO session_goals (id, session_id, goal) VALUES (?,?,?)').run(
        'g1', 'shared-id', '本机目标',
      );
      // 不冲突的会话照常并入。
      db.prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)').run('fresh', '本机新会话', 2);
      db.prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?,?,?,?)').run(
        'local-m2', 'fresh', 'user', '"ok"',
      );
    });

    const result = importLocalOwnerData(accountDb, localDbPath);

    expect(result.conflictedSessions).toBe(1);
    expect(result.skippedByConflict).toMatchObject({ messages: 1, session_goals: 1 });
    // 账号侧那条会话的历史一个字都没被污染。
    const accMessages = accountDb
      .prepare('SELECT id FROM messages WHERE session_id = ? ORDER BY id')
      .all('shared-id')
      .map((r) => (r as { id: string }).id);
    expect(accMessages).toEqual(['acc-m1']);
    expect(countRows('session_goals')).toBe(0);
    // 不冲突的那条照常并入。
    expect(
      accountDb.prepare('SELECT title FROM sessions WHERE id = ?').get('fresh'),
    ).toEqual({ title: '本机新会话' });
    // 被故意跳过的子行不算成 schema 不兼容的丢行。
    expect(result.droppedRows.messages).toBeUndefined();
  });

  it('多个会话引用列全覆盖(声明了外键的与只在名单里的),NULL 引用照常导入', () => {
    accountDb
      .prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)')
      .run('shared-id', '账号侧', 10);
    seedLocalDb((db) => {
      // 制造一个冲突会话,让冲突过滤生效。
      db.prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)').run('shared-id', '本机', 1);
      // 两个引用列都为 NULL:不关联任何会话,必须照常并入。
      db.prepare(
        "INSERT INTO schedules (id, name, status, target_session_id, skip_log_session_id)" +
          " VALUES (?,?,'active',NULL,NULL)",
      ).run('sch-null', '不关联会话的任务');
      // 冲突会话出现在**无外键声明**的列上(靠已知列名清单命中),应被跳过。
      db.prepare(
        "INSERT INTO schedules (id, name, status, target_session_id, skip_log_session_id)" +
          " VALUES (?,?,'active',?,NULL)",
      ).run('sch-conflict-target', '关联冲突会话(target)', 'shared-id');
      // 冲突会话出现在**有外键声明**的列上(靠动态读外键命中),也应被跳过。
      db.prepare(
        "INSERT INTO schedules (id, name, status, target_session_id, skip_log_session_id)" +
          " VALUES (?,?,'active',NULL,?)",
      ).run('sch-conflict-skiplog', '关联冲突会话(skip_log)', 'shared-id');
    });

    const result = importLocalOwnerData(accountDb, localDbPath);

    const ids = accountDb
      .prepare('SELECT id FROM schedules ORDER BY id')
      .all()
      .map((r) => (r as { id: string }).id);
    expect(ids).toEqual(['sch-null']);
    expect(result.skippedByConflict.schedules).toBe(2);
    // NULL 那条是正常并入的,不该被算成丢行。
    expect(result.droppedRows.schedules).toBeUndefined();
  });

  it('无冲突时不建过滤临时表、不误伤任何子行', () => {
    seedLocalDb((db) => {
      db.prepare('INSERT INTO sessions (id, title, created_at) VALUES (?,?,?)').run('s1', 'x', 1);
      db.prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?,?,?,?)').run(
        'm1', 's1', 'user', '{}',
      );
    });

    const result = importLocalOwnerData(accountDb, localDbPath);

    expect(result.conflictedSessions).toBe(0);
    expect(result.skippedByConflict).toEqual({});
    expect(countRows('messages')).toBe(1);
  });
});

describe('importLocalOwnerData 定时任务导入即暂停', () => {
  it('导入的 schedules 一律置为 paused(用户只裁决了对话归属)', () => {
    seedLocalDb((db) => {
      db.prepare("INSERT INTO schedules (id, name, status) VALUES (?,?,'active')").run('sch1', '每日巡检');
      db.prepare("INSERT INTO schedules (id, name, status) VALUES (?,?,'paused')").run('sch2', '已暂停的');
    });

    const result = importLocalOwnerData(accountDb, localDbPath);

    expect(result.pausedSchedules).toBe(1);
    const rows = accountDb.prepare('SELECT id, status FROM schedules ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'sch1', status: 'paused' },
      { id: 'sch2', status: 'paused' },
    ]);
  });

  it('不动账号库原有的 active 定时任务', () => {
    accountDb.prepare("INSERT INTO schedules (id, name, status) VALUES (?,?,'active')").run('acc-sch', '账号的');
    seedLocalDb((db) => {
      db.prepare("INSERT INTO schedules (id, name, status) VALUES (?,?,'active')").run('sch1', '本机的');
    });

    importLocalOwnerData(accountDb, localDbPath);

    expect(accountDb.prepare('SELECT status FROM schedules WHERE id = ?').get('acc-sch')).toEqual({
      status: 'active',
    });
  });
});

describe('导入表清单的完整性(防腐)', () => {
  it('schema 里的每张表都被显式归类为「导入」或「不导入」', () => {
    const schemaTables = schemaTableNames();
    const classified = new Set([...IMPORTED_TABLES, ...SKIPPED_TABLES]);

    // 新增表未归类 → 这里失败。请在 localOwnerDataImport.ts 里决定它是否随认领
    // 带走(带走则加进 IMPORTED_TABLES 的**外键父→子**正确位置),别改这个断言。
    const unclassified = schemaTables.filter((name) => !classified.has(name));
    expect(unclassified).toEqual([]);
  });

  it('清单里没有 schema 之外的幽灵表名,且两个清单不重叠', () => {
    const schemaTables = new Set<string>(schemaTableNames());
    expect([...IMPORTED_TABLES, ...SKIPPED_TABLES].filter((n) => !schemaTables.has(n))).toEqual([]);
    expect(IMPORTED_TABLES.filter((n) => SKIPPED_TABLES.includes(n))).toEqual([]);
  });

  it('每张导入表在 schema 上都有主键(否则丢行核验无从下手,unverifiedTables 会常态非空)', () => {
    const byName = new Map<string, unknown>();
    for (const value of Object.values(schema) as unknown[]) {
      if (is(value, Table)) byName.set(sqlTableName(value), value);
    }
    const noPk = IMPORTED_TABLES.filter((name) => {
      const table = byName.get(name);
      if (table == null) return true;
      const cfg = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
      return !cfg.columns.some((col) => col.primary) && cfg.primaryKeys.length === 0;
    });
    // 有主键才能核验「这一行到底有没有并过来」。新增的导入表若没有主键,要么补
    // 主键、要么移进 SKIPPED_TABLES——不能让「无法核验」变成常态(那会导致认领
    // 永远按不完整处理、local 库永不归档)。
    expect(noPk).toEqual([]);
  });

  it('sessions 排在 messages 之前(外键父表先插)', () => {
    expect(IMPORTED_TABLES.indexOf('sessions')).toBeLessThan(IMPORTED_TABLES.indexOf('messages'));
    expect(IMPORTED_TABLES.indexOf('media_blobs')).toBeLessThan(
      IMPORTED_TABLES.indexOf('media_refs'),
    );
  });
});

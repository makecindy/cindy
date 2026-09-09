/**
 * libraryDbCore / librarySqlService 单测:语句门攻击矩阵(ATTACH/VACUUM/
 * PRAGMA/事务语句/注释伪装)、exec/batch 事务原子性、migrate 幂等与冲突、
 * backup+quick_check、结果集上限、参数校验。进程内直连 core(与 worker 共用
 * 同一份执行体);os.tmpdir 建库,零 Electron。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import {
  createLibraryDbCore,
  gateSqlStatement,
  LIBRARY_DB_MAX_ROWS,
  LIBRARY_DB_MAX_RESULT_BYTES,
  type SqliteDatabaseConstructor,
} from '../libraryDbCore.js';
import { LibrarySqlService } from '../librarySqlService.js';

const Ctor = Database as unknown as SqliteDatabaseConstructor;

describe('gateSqlStatement(语句门攻击矩阵)', () => {
  const allowed = [
    'SELECT 1',
    'select * from t',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'INSERT INTO t VALUES (?)',
    'REPLACE INTO t VALUES (?)',
    'UPDATE t SET a = ?',
    'DELETE FROM t',
    'CREATE TABLE t (a INTEGER)',
    'DROP TABLE t',
    'ALTER TABLE t ADD COLUMN b TEXT',
    'REINDEX t',
    'ANALYZE',
    '\n\n-- leading comment\nSELECT 1',
    '/* block */ SELECT 1',
  ];
  const rejected = [
    'ATTACH DATABASE \'x.db\' AS x',
    'DETACH DATABASE x',
    'PRAGMA journal_mode = wal',
    'VACUUM',
    'VACUUM INTO \'/tmp/evil.db\'',
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    'SAVEPOINT sp',
    'EXPLAIN SELECT 1',
    '-- comment hiding ATTACH\nATTACH DATABASE \'x\' AS y',
    '/*x*/ PRAGMA foreign_keys = off',
    '',
    '   ',
    42 as unknown,
  ];
  it.each(allowed.map((s) => [s]))('放行:%s', (s) => {
    expect(gateSqlStatement(s).ok).toBe(true);
  });
  it.each(rejected.map((s) => [s]))('拒绝:%s', (s) => {
    expect(gateSqlStatement(s).ok).toBe(false);
  });
  it('未闭合块注释拒绝', () => {
    expect(gateSqlStatement('/* unterminated SELECT 1').ok).toBe(false);
  });
});

describe('libraryDbCore', () => {
  let tmp: string;
  let dbPath: string;
  let core: ReturnType<typeof createLibraryDbCore>;

  beforeEach(async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-library-db-'));
    dbPath = path.join(tmp, 'canvases', 'c1', 'canvas.sqlite');
    await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });
    core = createLibraryDbCore({ DatabaseCtor: Ctor });
    const open = await core.openDatabase(dbPath);
    expect(open.ok).toBe(true);
  });

  afterEach(async () => {
    core.closeAll();
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  it('建表/插入/参数化查询往返;读语句回行,写语句回 changes', () => {
    const create = core.execStatement(dbPath, 'CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT)', undefined);
    expect(create.ok).toBe(true);
    const ins = core.execStatement(dbPath, 'INSERT INTO nodes VALUES (?, ?)', ['n1', '画布节点']);
    if (!ins.ok) throw new Error(JSON.stringify(ins));
    expect(ins.changes).toBe(1);
    const sel = core.execStatement(dbPath, 'SELECT id, name FROM nodes WHERE id = ?', ['n1']);
    if (!sel.ok) throw new Error(JSON.stringify(sel));
    expect(sel.rows).toEqual([{ id: 'n1', name: '画布节点' }]);
    const named = core.execStatement(dbPath, 'SELECT :id AS id', { id: 'x' });
    expect(named.ok).toBe(true);
    if (named.ok) expect(named.rows).toEqual([{ id: 'x' }]);
  });

  it('exec 拒 ATTACH/PRAGMA/多语句;参数类型校验(boolean 拒)', () => {
    const attach = core.execStatement(dbPath, "ATTACH DATABASE '/etc/passwd' AS p", undefined);
    expect(attach.ok).toBe(false);
    if (!attach.ok) expect(attach.code).toBe('DB_STATEMENT_REJECTED');
    const pragma = core.execStatement(dbPath, 'PRAGMA journal_mode = delete', undefined);
    expect(pragma.ok).toBe(false);
    const multi = core.execStatement(dbPath, 'SELECT 1; SELECT 2', undefined);
    expect(multi.ok).toBe(false); // better-sqlite3 prepare 拒多语句
    if (!multi.ok) expect(multi.code).toBe('DB_ERROR');
    const bool = core.execStatement(dbPath, 'SELECT ?', [true]);
    expect(bool.ok).toBe(false);
    if (!bool.ok) expect(bool.code).toBe('DB_PARAMS_INVALID');
  });

  it('batch 整批原子:中途失败全回滚', () => {
    core.execStatement(dbPath, 'CREATE TABLE t (a INTEGER)', undefined);
    const ok = core.batch(dbPath, [
      { sql: 'INSERT INTO t VALUES (1)' },
      { sql: 'INSERT INTO t VALUES (2)' },
    ]);
    if (!ok.ok) throw new Error(JSON.stringify(ok));
    expect(ok.applied).toBe(2);
    const bad = core.batch(dbPath, [
      { sql: 'INSERT INTO t VALUES (3)' },
      { sql: 'INSERT INTO nonexistent VALUES (4)' },
    ]);
    expect(bad.ok).toBe(false);
    const count = core.execStatement(dbPath, 'SELECT COUNT(*) AS n FROM t', undefined);
    if (count.ok) expect((count.rows as Array<{ n: number }>)[0].n).toBe(2);
  });

  it('migrate:逐步应用 + user_version 推进 + 幂等续跑 + 高版本冲突', () => {
    const steps = [
      { toVersion: 1, sql: ['CREATE TABLE v1 (a TEXT)'] },
      { toVersion: 2, sql: ['CREATE TABLE v2 (a TEXT)', 'INSERT INTO v1 VALUES (\'x\')'] },
    ];
    const m1 = core.migrate(dbPath, 2, steps);
    if (!m1.ok) throw new Error(JSON.stringify(m1));
    expect(m1.toVersion).toBe(2);
    expect(core.readUserVersion(dbPath)).toBe(2);
    // 幂等:已应用的步跳过。
    const m2 = core.migrate(dbPath, 2, steps);
    if (m2.ok) expect(m2.toVersion).toBe(2);
    // 数据还在。
    const rows = core.execStatement(dbPath, 'SELECT a FROM v1', undefined);
    if (rows.ok) expect(rows.rows).toEqual([{ a: 'x' }]);
    // 库版本高于目标 → 冲突。
    const m3 = core.migrate(dbPath, 1, steps);
    expect(m3.ok).toBe(false);
    if (!m3.ok) expect(m3.code).toBe('DB_MIGRATION_CONFLICT');
    // 步进跳档拒绝(current=2,单步直接跳 4)。
    const gap = core.migrate(dbPath, 4, [{ toVersion: 4, sql: ['CREATE TABLE v4 (a TEXT)'] }]);
    expect(gap.ok).toBe(false);
    if (!gap.ok) expect(gap.code).toBe('DB_PARAMS_INVALID');
    // 迁移语句里的追加语句(";ATTACH…")借 prepare 单语句防线拦下——首词
    // CREATE 过门也执行不到第二个语句(review 回归)。
    const smuggle = core.migrate(dbPath, 3, [
      { toVersion: 3, sql: ["CREATE TABLE v3 (a TEXT); ATTACH DATABASE '/tmp/evil.db' AS evil"] },
    ]);
    expect(smuggle.ok).toBe(false);
    expect(core.readUserVersion(dbPath)).toBe(2); // 事务回滚,版本停在 2
  });

  it('backup 产出可打开的副本;quick_check ok', async () => {
    core.execStatement(dbPath, 'CREATE TABLE t (a TEXT)', undefined);
    core.execStatement(dbPath, 'INSERT INTO t VALUES (?)', ['hello']);
    const dest = path.join(tmp, 'backup.sqlite');
    const bak = await core.backupDatabase(dbPath, dest);
    expect(bak.ok).toBe(true);
    const reopen = new Database(dest) as unknown as { prepare: (s: string) => { get: () => unknown }; close: () => void };
    const row = reopen.prepare('SELECT a FROM t').get() as { a: string };
    expect(row.a).toBe('hello');
    reopen.close();
    const check = core.checkDatabase(dbPath);
    if (!check.ok) throw new Error(JSON.stringify(check));
    expect(check.ok_check).toBe(true);
  });

  it('多字节 UTF-8 单行按真实字节闸(中文不能借 UTF-16 length 绕过 16MiB)', () => {
    // 约 5.6M 个中文字:JS length≈5.6M,UTF-8≈16.8M(加 JSON 外壳后必超)。
    const chinese = '中'.repeat(Math.floor(LIBRARY_DB_MAX_RESULT_BYTES / 3) + 1);
    expect(chinese.length).toBeLessThan(LIBRARY_DB_MAX_RESULT_BYTES);
    expect(Buffer.byteLength(chinese, 'utf8')).toBeGreaterThan(LIBRARY_DB_MAX_RESULT_BYTES);
    const res = core.execStatement(dbPath, 'SELECT ? AS value', [chinese]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('DB_ROW_LIMIT');
  });

  it('结果集行数超限 → DB_ROW_LIMIT', () => {
    core.execStatement(dbPath, 'CREATE TABLE t (a INTEGER)', undefined);
    const rows: Array<{ sql: string; params: unknown[] }> = [];
    for (let i = 0; i < LIBRARY_DB_MAX_ROWS + 1; i += 1) {
      rows.push({ sql: 'INSERT INTO t VALUES (?)', params: [i] });
    }
    core.batch(dbPath, rows.slice(0, 200));
    // 分批插入到超限(每批 ≤200)。
    for (let i = 200; i < rows.length; i += 200) {
      core.batch(dbPath, rows.slice(i, i + 200));
    }
    const sel = core.execStatement(dbPath, 'SELECT a FROM t', undefined);
    expect(sel.ok).toBe(false);
    if (!sel.ok) expect(sel.code).toBe('DB_ROW_LIMIT');
    const limited = core.execStatement(dbPath, 'SELECT a FROM t LIMIT 10', undefined);
    expect(limited.ok).toBe(true);
  });

  it('未打开的 dbPath → DB_NOT_OPEN', () => {
    const res = core.execStatement(path.join(tmp, 'other.sqlite'), 'SELECT 1', undefined);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('DB_NOT_OPEN');
  });
});

describe('LibrarySqlService(进程内模式)', () => {
  let tmp: string;
  let dbPath: string;
  let service: LibrarySqlService;

  beforeEach(async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-library-svc-'));
    dbPath = path.join(tmp, 'library.sqlite');
    service = new LibrarySqlService({
      workerScriptPath: () => path.join(tmp, 'unused.js'),
      betterSqliteModulePath: () => 'better-sqlite3',
      createCore: (ctor) => createLibraryDbCore({ DatabaseCtor: ctor }),
      inProcessCtor: Ctor,
    });
  });

  afterEach(async () => {
    await service.dispose();
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  it('open/exec/batch/dispose 全链路;pre-gate 拦 ATTACH', async () => {
    await service.open(dbPath);
    const create = await service.exec(dbPath, 'CREATE TABLE t (a TEXT)');
    expect(create.ok).toBe(true);
    const ins = await service.batch(dbPath, [{ sql: 'INSERT INTO t VALUES (?)', params: ['v'] }]);
    expect(ins.ok).toBe(true);
    const sel = await service.exec(dbPath, 'SELECT a FROM t');
    if (!sel.ok) throw new Error(JSON.stringify(sel));
    expect(sel.rows).toEqual([{ a: 'v' }]);
    const attach = await service.exec(dbPath, "ATTACH DATABASE 'x' AS y");
    expect(attach.ok).toBe(false);
    if (!attach.ok) expect(attach.code).toBe('DB_STATEMENT_REJECTED');
    await service.dispose();
    const after = await service.exec(dbPath, 'SELECT 1');
    expect(after.ok).toBe(false);
  });
});

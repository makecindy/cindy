/**
 * libraryDbCore.ts — 插件 Library 的受控 SQLite 核心(2026-08-20 定案,方案 B)。
 * ---------------------------------------------------------------------------
 * 插件永远拿不到 Database 对象:它只能提交**参数化语句**,经语句门过滤后由
 * 宿主在专属 worker 里执行(better-sqlite3 没有 sqlite3_set_authorizer,
 * 结构化允许清单是唯一可靠防线,deny-by-default 而非黑名单):
 *
 *   1. 单语句:prepare() 本身拒绝多语句(better-sqlite3 行为);
 *   2. 首词白名单 {SELECT,WITH,INSERT,REPLACE,UPDATE,DELETE,CREATE,DROP,
 *      ALTER,REINDEX,ANALYZE}——SQLite 语句类型由首词决定;ATTACH/VACUUM
 *      INTO/PRAGMA 无法嵌进 SELECT/触发器/视图内部(触发器体只允许 DML),
 *      因此首词判据是可靠的;
 *   3. 事务由宿主管理(db.batch 整批原子),插件不能发 BEGIN/COMMIT;
 *   4. loadExtension 是宿主侧 API,插件不可达;SQL 函数 load_extension()
 *      在 better-sqlite3 默认关闭;
 *   5. 结果集行数/字节上限,防一次查询撑爆管道;
 *   6. 真实执行隔离在 worker(main 侧仅语句门与 RPC 组包),恶意慢查询
 *      只能饿死自己那个 worker,宿主可 terminate(WAL 保证 terminate 安全)。
 *
 * 本模块同时是 worker 内的执行体与单测的进程内执行体:Database 构造器一律
 * 注入,worker 用 betterSqliteModulePath require,测试直接传 require 结果。
 */

/** better-sqlite3 的结构化子集(避免整包类型耦合;真实实例结构性兼容)。 */
export interface SqlitePreparedStatement {
  readonly reader: boolean;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  /** 惰性迭代(better-sqlite3 同名 API;行上限的提前停止靠它)。 */
  iterate(...params: unknown[]): Iterable<unknown>;
}
export interface SqliteDatabase {
  prepare(sql: string): SqlitePreparedStatement;
  pragma(source: string): unknown;
  exec(sql: string): void;
  close(): void;
  backup(destination: string): Promise<void>;
  transaction<T>(fn: () => T): () => T;
}
export type SqliteDatabaseConstructor = new (path: string, options?: { readonly?: boolean }) => SqliteDatabase;

/** 语句门白名单(见文件头第 2 条论证)。 */
const ALLOWED_FIRST_WORDS = new Set([
  'SELECT', 'WITH', 'INSERT', 'REPLACE', 'UPDATE', 'DELETE',
  'CREATE', 'DROP', 'ALTER', 'REINDEX', 'ANALYZE',
]);

/** 结果集上限(行数/序列化字节)。 */
export const LIBRARY_DB_MAX_ROWS = 2000;
export const LIBRARY_DB_MAX_RESULT_BYTES = 16 * 1024 * 1024;

/**
 * 语句门:剥离前导空白与注释后取首个关键词,必须命中白名单。
 * 事务语句(BEGIN/COMMIT/SAVEPOINT)、ATTACH/DETACH、PRAGMA、VACUUM、
 * EXPLAIN 一律拒绝;多语句由 better-sqlite3 的 prepare 兜底拒绝。
 */
export function gateSqlStatement(sql: unknown): { ok: true } | { ok: false; reason: string } {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { ok: false, reason: 'sql 必须是非空字符串' };
  }
  const s = sql;
  let i = 0;
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i += 1;
    if (s.startsWith('--', i)) {
      while (i < s.length && s[i] !== '\n') i += 1;
      continue;
    }
    if (s.startsWith('/*', i)) {
      const end = s.indexOf('*/', i + 2);
      if (end === -1) return { ok: false, reason: '未闭合的块注释' };
      i = end + 2;
      continue;
    }
    break;
  }
  const word = /^[A-Za-z_]+/.exec(s.slice(i))?.[0]?.toUpperCase();
  if (!word) return { ok: false, reason: '无法识别语句首词' };
  if (!ALLOWED_FIRST_WORDS.has(word)) {
    return {
      ok: false,
      reason: `不允许的语句类型:${word}(仅 DML/DDL 白名单;ATTACH/PRAGMA/VACUUM/事务语句一律拒绝)`,
    };
  }
  return { ok: true };
}

/** bind 参数合法性(better-sqlite3 可绑定的值域;对象键须以 :/@/$ 开头)。 */
function validateParams(params: unknown): { ok: true; args: unknown[] | [Record<string, unknown>] } | { ok: false; reason: string } {
  if (params === undefined || params === null) return { ok: true, args: [] };
  if (Array.isArray(params)) {
    for (const v of params) {
      if (!isBindable(v)) return { ok: false, reason: `参数类型不可绑定:${typeof v}` };
    }
    return { ok: true, args: params };
  }
  if (typeof params === 'object') {
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      // better-sqlite3 命名参数键为**裸标识符**(:id → { id });带前缀键会抛
      // Missing named parameter,这里提前拒并说明正确形态。
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        return { ok: false, reason: `命名参数键非法:${k}(SQL 里写 :id,参数键写 id)` };
      }
      if (!isBindable(v)) return { ok: false, reason: `参数类型不可绑定:${typeof v}` };
    }
    return { ok: true, args: [params] };
  }
  return { ok: false, reason: 'params 只接受数组或命名参数对象' };
}

function isBindable(v: unknown): boolean {
  // better-sqlite3 可绑定值域;boolean 不可绑(调用方自行转 0/1),显式拒。
  return (
    v === null ||
    typeof v === 'number' ||
    typeof v === 'bigint' ||
    typeof v === 'string' ||
    v instanceof Uint8Array
  );
}

/** 打开的库句柄池(dbPath → db)。 */
interface OpenDatabases {
  [dbPath: string]: SqliteDatabase;
}

export type LibraryDbFailureCode =
  | 'DB_STATEMENT_REJECTED'
  | 'DB_PARAMS_INVALID'
  | 'DB_ROW_LIMIT'
  | 'DB_NOT_OPEN'
  | 'DB_ERROR'
  | 'DB_MIGRATION_CONFLICT';

export type LibraryDbResult<T> = { ok: true } & T | { ok: false; code: LibraryDbFailureCode; message: string };

/**
 * createLibraryDbCore — 库句柄池 + 五个受控操作(exec/batch/migrate/backup/check)。
 * worker 与单测共用;线程模型由调用方决定(worker 天然串行,进程内调用方自律)。
 */
export function createLibraryDbCore(opts: {
  DatabaseCtor: SqliteDatabaseConstructor;
  onLog?: (msg: string, meta?: Record<string, unknown>) => void;
}) {
  const open: OpenDatabases = {};

  function requireOpen(dbPath: string): SqliteDatabase | null {
    return open[dbPath] ?? null;
  }

  async function openDatabase(dbPath: string): Promise<LibraryDbResult<{ opened: true }>> {
    if (open[dbPath]) return { ok: true, opened: true };
    const db = new opts.DatabaseCtor(dbPath);
    // 与主库同水位的关键 pragma;cache/mmap 收小(per-plugin 多库并存)。
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('temp_store = MEMORY');
    db.pragma('cache_size = -16384'); // 16 MiB(主库 64 MiB)
    db.pragma('mmap_size = 0'); // per-plugin 连接不占 mmap 预算
    open[dbPath] = db;
    return { ok: true, opened: true };
  }

  function closeDatabase(dbPath: string): boolean {
    const db = open[dbPath];
    if (!db) return false;
    delete open[dbPath];
    try {
      db.close();
    } catch {
      /* 已损坏的连接,句柄丢弃即可 */
    }
    return true;
  }

  function closeAll(): void {
    for (const p of Object.keys(open)) closeDatabase(p);
  }

  /** 执行单条受控语句(读回行 / 写回 changes)。 */
  function execStatement(dbPath: string, sql: string, params: unknown): LibraryDbResult<{
    rows?: unknown[];
    changes?: number;
    lastInsertRowid?: string | number;
  }> {
    const gate = gateSqlStatement(sql);
    if (!gate.ok) return { ok: false, code: 'DB_STATEMENT_REJECTED', message: gate.reason };
    const p = validateParams(params);
    if (!p.ok) return { ok: false, code: 'DB_PARAMS_INVALID', message: p.reason };
    const db = requireOpen(dbPath);
    if (!db) return { ok: false, code: 'DB_NOT_OPEN', message: '数据库未打开(先 db.open)' };
    let stmt: SqlitePreparedStatement;
    try {
      stmt = db.prepare(sql); // 多语句/语法错在此抛出(better-sqlite3 拒绝多语句)
    } catch (err) {
      return { ok: false, code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) };
    }
    // 读/写分流:靠 better-sqlite3 的语句只读标记,而非重析 SQL。
    if (stmt.reader) {
      // 惰性取行(iterate):上限+1 处提前停止,**不先物化整个结果集**;行数与
      // **累计字节**都在循环内闸——2000 行 × 各自略低于上限的 BLOB 也不许
      // 把内存吃满(review:总字节限制后置)。
      const rows: unknown[] = [];
      let totalBytes = 0;
      try {
        for (const row of stmt.iterate(...(p.args as unknown[]))) {
          if (rows.length >= LIBRARY_DB_MAX_ROWS) {
            return { ok: false, code: 'DB_ROW_LIMIT', message: `结果集超行数上限(${LIBRARY_DB_MAX_ROWS});请加 LIMIT` };
          }
          const rowJson = JSON.stringify(row) ?? '';
          // **真实 UTF-8 字节数**,不是 JS UTF-16 码元 length——中文等内容
          // 1 码元≈3 UTF-8 字节,用 length 会把 16MiB 闸放大约 3 倍
          // (Greptile:多字节查询结果绕过 IPC 负载上限)。
          const rowBytes = Buffer.byteLength(rowJson, 'utf8');
          if (rowBytes > LIBRARY_DB_MAX_RESULT_BYTES) {
            return { ok: false, code: 'DB_ROW_LIMIT', message: '单行结果超字节上限;请缩小查询列/分页' };
          }
          totalBytes += rowBytes;
          if (totalBytes > LIBRARY_DB_MAX_RESULT_BYTES) {
            return { ok: false, code: 'DB_ROW_LIMIT', message: '结果集超字节上限;请加 LIMIT 或分页' };
          }
          rows.push(row);
        }
      } catch (err) {
        return { ok: false, code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) };
      }
      return { ok: true, rows };
    }
    try {
      const out = stmt.run(...(p.args as unknown[]));
      return {
        ok: true,
        changes: out.changes,
        lastInsertRowid: typeof out.lastInsertRowid === 'bigint' ? out.lastInsertRowid.toString() : out.lastInsertRowid,
      };
    } catch (err) {
      return { ok: false, code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 整批一个事务:任一失败全部回滚(宿主管理事务,插件不发 BEGIN/COMMIT)。 */
  function batch(dbPath: string, statements: Array<{ sql: string; params?: unknown }>): LibraryDbResult<{ applied: number }> {
    if (!Array.isArray(statements) || statements.length === 0) {
      return { ok: false, code: 'DB_PARAMS_INVALID', message: 'statements 必须是非空数组' };
    }
    if (statements.length > 200) {
      return { ok: false, code: 'DB_PARAMS_INVALID', message: '单批最多 200 条语句' };
    }
    const db = requireOpen(dbPath);
    if (!db) return { ok: false, code: 'DB_NOT_OPEN', message: '数据库未打开(先 db.open)' };
    // 先整体过门+参数校验,再进事务:拒绝时不留半开事务。
    for (const st of statements) {
      const gate = gateSqlStatement(st.sql);
      if (!gate.ok) return { ok: false, code: 'DB_STATEMENT_REJECTED', message: gate.reason };
      const p = validateParams(st.params);
      if (!p.ok) return { ok: false, code: 'DB_PARAMS_INVALID', message: p.reason };
    }
    let applied = 0;
    try {
      const tx = db.transaction(() => {
        for (const st of statements) {
          const gate = gateSqlStatement(st.sql); // 门复读(防御性,成本低)
          if (!gate.ok) throw new Error(gate.reason);
          db.prepare(st.sql).run(...(normalizeArgs(st.params) as unknown[]));
          applied += 1;
        }
      });
      tx();
    } catch (err) {
      return { ok: false, code: 'DB_ERROR', message: `批事务已回滚:${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, applied };
  }

  /** user_version 迁移:按 steps 逐步执行,每步一个事务;调用方负责先 backup。 */
  function migrate(
    dbPath: string,
    targetVersion: number,
    steps: Array<{ toVersion: number; sql: string[] }>,
  ): LibraryDbResult<{ fromVersion: number; toVersion: number }> {
    if (!Number.isInteger(targetVersion) || targetVersion < 0) {
      return { ok: false, code: 'DB_PARAMS_INVALID', message: 'targetVersion 必须是非负整数' };
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      return { ok: false, code: 'DB_PARAMS_INVALID', message: 'steps 必须是非空数组' };
    }
    const db = requireOpen(dbPath);
    if (!db) return { ok: false, code: 'DB_NOT_OPEN', message: '数据库未打开(先 db.open)' };
    for (const step of steps) {
      if (!Number.isInteger(step.toVersion) || step.toVersion <= 0 || !Array.isArray(step.sql)) {
        return { ok: false, code: 'DB_PARAMS_INVALID', message: 'step 形态非法(toVersion/sql[])' };
      }
      for (const sql of step.sql) {
        const gate = gateSqlStatement(sql);
        if (!gate.ok) return { ok: false, code: 'DB_STATEMENT_REJECTED', message: gate.reason };
      }
    }
    // 步进连续性:steps 必须从 1(或从任意起点)严格递增到 targetVersion。
    for (let i = 1; i < steps.length; i += 1) {
      if (steps[i].toVersion !== steps[i - 1].toVersion + 1) {
        return { ok: false, code: 'DB_PARAMS_INVALID', message: 'steps 的 toVersion 必须连续递增' };
      }
    }
    const current = readUserVersion(db);
    if (current > targetVersion) {
      return {
        ok: false,
        code: 'DB_MIGRATION_CONFLICT',
        message: `数据库版本(${current})高于目标(${targetVersion});插件版本过旧`,
      };
    }
    let last = current;
    for (const step of steps) {
      if (step.toVersion <= current) continue; // 已应用的步跳过(幂等续跑)
      if (step.toVersion !== last + 1) {
        return { ok: false, code: 'DB_PARAMS_INVALID', message: `steps 缺少版本 ${last + 1}` };
      }
      try {
        const tx = db.transaction(() => {
          for (const sql of step.sql) {
            // prepare 单语句(better-sqlite3 拒多语句):迁移语句与 exec 路径
            // 同一防线——首词过门后串里追加 ";ATTACH…" 在这里会被 prepare 拒,
            // 不能借 db.exec 绕过(review:迁移 SQL 绕过单语句防线)。
            db.prepare(sql).run();
          }
          db.pragma(`user_version = ${step.toVersion}`);
        });
        tx();
      } catch (err) {
        return {
          ok: false,
          code: 'DB_ERROR',
          message: `迁移到 v${step.toVersion} 失败(已回滚,停留在 v${last}):${err instanceof Error ? err.message : String(err)}`,
        };
      }
      last = step.toVersion;
    }
    return { ok: true, fromVersion: current, toVersion: last };
  }

  function readUserVersion(db: SqliteDatabase): number {
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    return Number(row?.user_version ?? 0);
  }

  /** 在线备份(better-sqlite3 backup API;WAL 下安全,勿用 copyFile)。 */
  async function backupDatabase(dbPath: string, destAbs: string): Promise<LibraryDbResult<{ backedUp: true }>> {
    const db = requireOpen(dbPath);
    if (!db) return { ok: false, code: 'DB_NOT_OPEN', message: '数据库未打开(先 db.open)' };
    try {
      await db.backup(destAbs);
      return { ok: true, backedUp: true };
    } catch (err) {
      return { ok: false, code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 完整性检查(PRAGMA quick_check;宿主代码,不走插件语句门)。 */
  function checkDatabase(dbPath: string): LibraryDbResult<{ ok_check: boolean; detail: string }> {
    const db = requireOpen(dbPath);
    if (!db) return { ok: false, code: 'DB_NOT_OPEN', message: '数据库未打开(先 db.open)' };
    try {
      const rows = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check?: string }>;
      const first = rows[0]?.quick_check ?? 'unknown';
      return { ok: true, ok_check: first === 'ok', detail: String(first) };
    } catch (err) {
      return { ok: false, code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) };
    }
  }

  return {
    openDatabase,
    closeDatabase,
    closeAll,
    execStatement,
    batch,
    migrate,
    backupDatabase,
    checkDatabase,
    readUserVersion: (dbPath: string) => {
      const db = requireOpen(dbPath);
      return db ? readUserVersion(db) : null;
    },
  };
}

function normalizeArgs(params: unknown): unknown[] {
  if (params === undefined || params === null) return [];
  if (Array.isArray(params)) return params;
  return [params];
}

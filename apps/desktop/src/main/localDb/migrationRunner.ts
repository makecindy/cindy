/**
 * Electron 无关的 SQLite migration runner。
 *
 * 生产入口负责解析 drizzle 目录与备份；这里只维护迁移回放语义，
 * 让 main 进程和测试共享同一套执行规则。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

export interface MigrationFile {
  /** 文件名前 4 位转数字。0000 → 0。 */
  seq: number;
  fileName: string;
  sqlPath: string;
  /** drizzle/scripts/{NNNN_xxx}.ts 若存在则在事务内执行。 */
  tsScriptPath?: string;
}

export interface MigrationReplayResult {
  currentVersion: number;
  finalVersion: number;
  applied: MigrationFile[];
}

export interface MigrationHistoryWriteFailure {
  seq: number;
  fileName: string;
  contentHash: string;
  error: unknown;
}

export interface MigrationRuntimeIdentity {
  seq: number;
  fileName: string;
  sqlHash: string;
  scriptHash: string | null;
}

export interface MigrationRuntimeManifest {
  version: 1;
  /** 首次引入 sidecar 时由当前 primary 明确认领的 legacy schema 上界。 */
  legacyBaselineVersion: number;
  migrations: MigrationRuntimeIdentity[];
}

export type MigrationCompatibilityIssue =
  | {
      kind: 'schema-version-behind' | 'schema-version-ahead';
      databaseVersion: number;
      checkoutVersion: number;
    }
  | { kind: 'history-unavailable'; error: string }
  | { kind: 'manifest-unavailable'; error: string }
  | { kind: 'runtime-manifest-unavailable'; error: string }
  | { kind: 'runtime-manifest-mismatch' }
  | { kind: 'history-entry-missing'; seq: number; fileName: string }
  | { kind: 'history-entry-unexpected'; seq: number; fileName: string }
  | {
      kind: 'history-entry-mismatch';
      seq: number;
      expectedFileName: string;
      actualFileName: string;
      hashMatches: boolean;
    };

export interface MigrationCompatibilityReport {
  compatible: boolean;
  databaseVersion: number;
  checkoutVersion: number;
  issues: MigrationCompatibilityIssue[];
}

export interface RunMigrationReplayOptions {
  drizzleDir: string;
  currentVersion?: number;
  scriptLoader?: (scriptPath: string) => unknown;
  onMigrationStart?: (migration: MigrationFile) => void;
  onMigrationApplied?: (migration: MigrationFile, durationMs: number) => void;
  onMigrationHistoryWriteFailed?: (failure: MigrationHistoryWriteFailure) => void;
}

/**
 * 计算 migration sql 文件指纹。normalize 行尾消除 Windows CRLF 与 Unix LF 差异。
 */
export function hashMigrationFile(filePath: string): string {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const normalized = raw.replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * 生成 migration 实际执行面的完整指纹：SQL 与可选 companion TS 缺一不可。
 *
 * `migration_history` 是既有数据库契约，只记录 SQL hash；runtime manifest 作为
 * userData 内的并行启动旁路元数据补齐 TS 身份，无需篡改历史 migration 或 schema。
 */
export function createMigrationRuntimeManifest(drizzleDir: string): MigrationRuntimeManifest {
  return {
    version: 1,
    legacyBaselineVersion: -1,
    migrations: listMigrations(drizzleDir).map((migration) => ({
      seq: migration.seq,
      fileName: migration.fileName,
      sqlHash: hashMigrationFile(migration.sqlPath),
      scriptHash: migration.tsScriptPath ? hashMigrationFile(migration.tsScriptPath) : null,
    })),
  };
}

export function migrationRuntimeManifestPath(dbFilePath: string): string {
  return `${dbFilePath}.migration-runtime.json`;
}

function writeMigrationRuntimeManifestFile(
  dbFilePath: string,
  manifest: MigrationRuntimeManifest,
): void {
  const targetPath = migrationRuntimeManifestPath(dbFilePath);
  const tempPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(manifest)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    fs.renameSync(tempPath, targetPath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* rename 成功或清理失败都不影响目标文件。 */
    }
  }
}

function sameRuntimeIdentity(
  left: MigrationRuntimeIdentity,
  right: MigrationRuntimeIdentity,
): boolean {
  return (
    left.seq === right.seq &&
    left.fileName === right.fileName &&
    left.sqlHash === right.sqlHash &&
    left.scriptHash === right.scriptHash
  );
}

/**
 * 0062 的 companion 曾在已发布版本中只改动了一处注释，产生了短暂的错误指纹。
 * 这里只允许该错误指纹单向收敛回最初发布的 canonical 指纹；其它 identity 变化仍失败关闭。
 */
function isKnownRuntimeIdentityRepair(
  applied: MigrationRuntimeIdentity,
  canonical: MigrationRuntimeIdentity,
): boolean {
  return (
    applied.seq === 62 &&
    applied.fileName === '0062_flaky_mimic.sql' &&
    applied.sqlHash === '77b8741ac31c159eb422746c0165d102ad65693236c80d0ff055fd70cd43fe68' &&
    applied.scriptHash === '0ea82003cac0419a4a483b0afc1743d6fdba0b50085104720d5b2561e721072d' &&
    canonical.seq === applied.seq &&
    canonical.fileName === applied.fileName &&
    canonical.sqlHash === applied.sqlHash &&
    canonical.scriptHash === '0a72ba2d89237b4b7322ffbbeb644c94e01be7d159851e220f51c03edfa80b78'
  );
}

function runtimeIdentityMatches(
  applied: MigrationRuntimeIdentity,
  canonical: MigrationRuntimeIdentity,
): boolean {
  return (
    sameRuntimeIdentity(applied, canonical) || isKnownRuntimeIdentityRepair(applied, canonical)
  );
}

/**
 * 已发布分支在合入主干时按主干 migration 链重新生成序号，同一份 schema 意图换到了新的 seq
 * / 文件名。这里登记这种「重编号」：applied 是旧 checkout 已落库的旧身份，canonical 是当前
 * checkout 的同内容身份。
 *
 * 只在两侧内容指纹完全一致时允许，且必须逐条登记；未登记的重编号、或同 seq 但内容不同的
 * 改写（比如另一条 `_loose_puppet_master` 的 SQL）一律继续失败关闭。
 */
const KNOWN_RENUMBERED_APPLIED_MIGRATIONS: ReadonlyArray<{
  applied: MigrationRuntimeIdentity;
  canonical: MigrationRuntimeIdentity;
}> = [
  {
    // 0108_loose_puppet_master.sql（context_window_budget，PR #4598 分支身份）→
    // 主干重新生成后落在 0110_green_unus.sql。
    applied: {
      seq: 108,
      fileName: '0108_loose_puppet_master.sql',
      sqlHash: 'dd2c6cd26bdd7420d17046c67a0043cae099ded9b3bf01d68c453c46bf8cc40b',
      scriptHash: null,
    },
    canonical: {
      seq: 110,
      fileName: '0110_green_unus.sql',
      sqlHash: 'dd2c6cd26bdd7420d17046c67a0043cae099ded9b3bf01d68c453c46bf8cc40b',
      scriptHash: null,
    },
  },
];

function sameRuntimeSignature(
  left: MigrationRuntimeIdentity,
  right: MigrationRuntimeIdentity,
): boolean {
  return (
    left.sqlHash === right.sqlHash &&
    left.scriptHash === right.scriptHash &&
    (left.scriptHash === null || left.fileName === right.fileName)
  );
}

/**
 * 把已落库的旧身份解析成它等价于哪个 canonical migration。
 *
 * 同 seq 且 runtime identity 相同 → 它自己；命中登记在册的重编号且内容指纹一致 → 新身份。
 * 返回 null 表示这是未登记的身份漂移，调用方必须失败关闭。
 */
function resolveCanonicalAppliedIdentity(
  applied: MigrationRuntimeIdentity,
  expectedBySeq: ReadonlyMap<number, MigrationRuntimeIdentity>,
): { canonical: MigrationRuntimeIdentity; vacatedSeqs: number[] } | null {
  const sameSeq = expectedBySeq.get(applied.seq);
  if (sameSeq && runtimeIdentityMatches(applied, sameSeq)) {
    return { canonical: sameSeq, vacatedSeqs: [] };
  }
  for (const renumbered of KNOWN_RENUMBERED_APPLIED_MIGRATIONS) {
    // 只接受「向更大 seq 重编号」；canonical seq 不大于旧 seq 时一律当未登记漂移。
    if (renumbered.canonical.seq <= applied.seq) continue;
    if (!sameRuntimeSignature(applied, renumbered.applied)) continue;
    const canonical = expectedBySeq.get(renumbered.canonical.seq);
    if (canonical && sameRuntimeIdentity(canonical, renumbered.canonical)) {
      // 重编号把同一条 migration 换了序号，它腾出的旧序号在 canonical 链上不存在。
      const vacatedSeqs: number[] = [];
      for (let seq = applied.seq; seq < canonical.seq; seq += 1) vacatedSeqs.push(seq);
      return { canonical, vacatedSeqs };
    }
  }
  return null;
}

function runtimeIdentityListsMatch(
  applied: MigrationRuntimeIdentity[],
  canonical: MigrationRuntimeIdentity[],
): boolean {
  return (
    applied.length === canonical.length &&
    applied.every((identity, index) => {
      const expected = canonical[index];
      return expected !== undefined && runtimeIdentityMatches(identity, expected);
    })
  );
}

function readMigrationRuntimeManifest(dbFilePath: string): MigrationRuntimeManifest | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(migrationRuntimeManifestPath(dbFilePath), 'utf8'),
    ) as MigrationRuntimeManifest;
    if (
      parsed.version !== 1 ||
      !Number.isSafeInteger(parsed.legacyBaselineVersion) ||
      !Array.isArray(parsed.migrations)
    ) {
      throw new Error('invalid migration runtime manifest');
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * primary 在执行 migration 前准备 runtime identity intent。
 *
 * 已经落入 `schema_version` 的 identity 永远不可被另一 checkout 覆盖；只有尚未执行的
 * pending 部分可以随当前 checkout 重写。sidecar 首次出现时，无法追溯旧版本 companion
 * TS 的历史 hash，因此由持有 writer lease 的 primary 一次性认领 legacy baseline，之后
 * 同一 seq 的身份永久冻结。intent 先于 DB 事务写入；若进程中途退出，下一次启动依据
 * 实际 schema_version 只冻结已提交部分，未执行部分仍可安全替换。
 */
export function prepareMigrationRuntimeManifest(
  dbFilePath: string,
  drizzleDir: string,
  databaseVersion: number,
): { bootstrappedLegacyBaseline: boolean } {
  if (!Number.isSafeInteger(databaseVersion) || databaseVersion < -1) {
    throw new Error(`invalid database schema_version for runtime manifest: ${databaseVersion}`);
  }
  const expected = createMigrationRuntimeManifest(drizzleDir);
  const existing = readMigrationRuntimeManifest(dbFilePath);
  if (existing) {
    const expectedBySeq = new Map(expected.migrations.map((identity) => [identity.seq, identity]));
    // 已落库身份解析到 canonical 后，同时从「未登记漂移」与「canonical 未执行」两侧销账。
    // 重编号会让已落库前缀里的旧 seq 在 canonical 链上不存在（旧 0108 重编号后 canonical 只有
    // 0110），所以「缺条目」只查到已落库前缀为止，且重编号腾出的序号不算缺。
    const resolvedCanonicalSeqs = new Set<number>();
    let appliedThroughSeq = -1;
    for (const identity of existing.migrations) {
      if (identity.seq > databaseVersion) continue;
      const resolved = resolveCanonicalAppliedIdentity(identity, expectedBySeq);
      if (!resolved) {
        throw new Error(
          `applied migration runtime identity changed at seq ${identity.seq} (${identity.fileName})`,
        );
      }
      resolvedCanonicalSeqs.add(resolved.canonical.seq);
      for (const seq of resolved.vacatedSeqs) resolvedCanonicalSeqs.add(seq);
      appliedThroughSeq = Math.max(appliedThroughSeq, identity.seq);
    }
    for (const identity of expected.migrations) {
      if (identity.seq > appliedThroughSeq) continue;
      if (!resolvedCanonicalSeqs.has(identity.seq)) {
        throw new Error(`applied migration runtime identity missing at seq ${identity.seq}`);
      }
    }
  }

  const next: MigrationRuntimeManifest = {
    version: 1,
    legacyBaselineVersion: existing?.legacyBaselineVersion ?? databaseVersion,
    migrations: expected.migrations,
  };
  if (!existing || JSON.stringify(existing) !== JSON.stringify(next)) {
    writeMigrationRuntimeManifestFile(dbFilePath, next);
  }
  return { bootstrappedLegacyBaseline: existing === null };
}

export function listMigrations(drizzleDir: string): MigrationFile[] {
  const files = fs
    .readdirSync(drizzleDir)
    .filter((fileName) => /^\d{4}_.*\.sql$/.test(fileName))
    .sort();

  return files.map<MigrationFile>((fileName) => {
    const seq = parseInt(fileName.slice(0, 4), 10);
    const sqlPath = path.join(drizzleDir, fileName);
    const tsBaseName = fileName.replace(/\.sql$/, '.ts');
    const tsScriptPath = path.join(drizzleDir, 'scripts', tsBaseName);
    return {
      seq,
      fileName,
      sqlPath,
      tsScriptPath: fs.existsSync(tsScriptPath) ? tsScriptPath : undefined,
    };
  });
}

export function readSchemaVersion(db: Database.Database): number {
  try {
    const row = db.prepare(`SELECT value FROM migration_meta WHERE key='schema_version'`).get() as
      { value: string } | undefined;
    return row ? parseInt(row.value, 10) : -1;
  } catch {
    return -1;
  }
}

function readSchemaVersionStrict(db: Database.Database): number | null {
  try {
    const row = db.prepare(`SELECT value FROM migration_meta WHERE key='schema_version'`).get() as
      { value: unknown } | undefined;
    if (!row || typeof row.value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(row.value)) {
      return null;
    }
    const version = Number(row.value);
    return Number.isSafeInteger(version) ? version : null;
  } catch {
    return null;
  }
}

export function listPendingMigrations(drizzleDir: string, currentVersion: number): MigrationFile[] {
  return listMigrations(drizzleDir).filter((migration) => migration.seq > currentVersion);
}

/**
 * 只读核对数据库 migration 状态是否与当前 checkout 完全一致。
 *
 * 该检查专门守住共享 userData 的 passive dev：它既不能把旧 primary 正在使用的库
 * 升级，也不能用旧代码打开已被新 checkout 升级过的库。除 schema_version 必须相等
 * 外，migration_history 的 seq / 文件名 / 内容 hash 也必须逐条完全匹配；任何不可读
 * 状态都 fail closed。函数不写数据库，调用方可在通过后直接跳过 migration。
 */
export function checkMigrationCompatibility(
  db: Database.Database,
  drizzleDir: string,
  dbFilePath?: string,
): MigrationCompatibilityReport {
  const strictDatabaseVersion = readSchemaVersionStrict(db);
  const databaseVersion = strictDatabaseVersion ?? -1;
  let migrations: MigrationFile[];
  let expectedHashes: Map<number, string>;
  try {
    migrations = listMigrations(drizzleDir);
    expectedHashes = new Map(
      migrations.map((migration) => [migration.seq, hashMigrationFile(migration.sqlPath)]),
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      compatible: false,
      databaseVersion,
      checkoutVersion: -1,
      issues: [{ kind: 'manifest-unavailable', error }],
    };
  }

  const checkoutVersion = migrations.at(-1)?.seq ?? -1;
  const issues: MigrationCompatibilityIssue[] = [];
  if (strictDatabaseVersion === null) {
    issues.push({
      kind: 'history-unavailable',
      error: 'migration_meta.schema_version is missing or invalid',
    });
  }
  if (databaseVersion < checkoutVersion) {
    issues.push({ kind: 'schema-version-behind', databaseVersion, checkoutVersion });
  } else if (databaseVersion > checkoutVersion) {
    issues.push({ kind: 'schema-version-ahead', databaseVersion, checkoutVersion });
  }

  let historyRows: Array<{ seq: number; file_name: string; content_hash: string }>;
  try {
    historyRows = db
      .prepare(
        `SELECT seq, file_name, content_hash
         FROM migration_history
         ORDER BY seq`,
      )
      .all() as Array<{ seq: number; file_name: string; content_hash: string }>;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    issues.push({ kind: 'history-unavailable', error });
    return { compatible: false, databaseVersion, checkoutVersion, issues };
  }

  const expectedBySeq = new Map(migrations.map((migration) => [migration.seq, migration]));
  const actualBySeq = new Map(historyRows.map((row) => [Number(row.seq), row]));
  for (const migration of migrations) {
    const actual = actualBySeq.get(migration.seq);
    if (!actual) {
      issues.push({
        kind: 'history-entry-missing',
        seq: migration.seq,
        fileName: migration.fileName,
      });
      continue;
    }
    const expectedHash = expectedHashes.get(migration.seq);
    const hashMatches = expectedHash !== undefined && actual.content_hash === expectedHash;
    if (actual.file_name !== migration.fileName || !hashMatches) {
      issues.push({
        kind: 'history-entry-mismatch',
        seq: migration.seq,
        expectedFileName: migration.fileName,
        actualFileName: actual.file_name,
        hashMatches,
      });
    }
  }
  for (const row of historyRows) {
    const seq = Number(row.seq);
    if (!expectedBySeq.has(seq)) {
      issues.push({
        kind: 'history-entry-unexpected',
        seq,
        fileName: row.file_name,
      });
    }
  }

  if (dbFilePath) {
    try {
      const raw = fs.readFileSync(migrationRuntimeManifestPath(dbFilePath), 'utf8');
      const actual = JSON.parse(raw) as MigrationRuntimeManifest;
      const expected = createMigrationRuntimeManifest(drizzleDir);
      if (
        actual.version !== 1 ||
        !Array.isArray(actual.migrations) ||
        !runtimeIdentityListsMatch(actual.migrations, expected.migrations)
      ) {
        issues.push({ kind: 'runtime-manifest-mismatch' });
      }
    } catch (err) {
      issues.push({
        kind: 'runtime-manifest-unavailable',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    compatible: issues.length === 0,
    databaseVersion,
    checkoutVersion,
    issues,
  };
}

/**
 * 0084 落地时违背了「ALTER TABLE ADD COLUMN 不能直接写进 migration SQL」的可重放
 * 惯例(SQLite 无 IF NOT EXISTS 列语义;正确形态见 0075/0076:SQL 置空 + companion
 * 用 PRAGMA table_info 守卫),而文件本体已随 main 永久冻结、不可回改。这里在
 * runner 侧补等效守卫:目标列已存在时按已生效处理,跳过 SQL 本体,schema_version
 * 与 migration history 照常推进。只允许命中登记在册的冻结缺陷,不为后续 migration
 * 提供任何通用容错——新迁移必须自带守卫。
 *
 * 0108_lowly_scarlet_witch 的 guard 是 KNOWN_RENUMBERED_APPLIED_MIGRATIONS 的另一半：
 * 只服务「旧 checkout 把 context_window_budget 落在 0108、bot 私聊表由更早分支创建」的
 * 重编号血统——它已具备 0108 的后续改动(bridge_session_id/索引),但缺 sender_name /
 * recipient_name。裸跑 0108 会索引重名失败,不跑则运行时 select 到不存在的列。
 * 这里把该表收敛回 0108 执行后的等价结构(列顺序/索引与 canonical 一致),仅限这张表、
 * 仅限检测到 bridge_session_id 这个重编号标志的库;其余库一律走原 SQL。
 */
const BOT_DIRECT_MESSAGES_RENUMBER_MARKER = 'bridge_session_id';
/** 0108 迁移执行后的 canonical 列定义（顺序即 drizzle snapshot 的顺序）。 */
const BOT_DIRECT_MESSAGES_CANONICAL_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['id', 'text PRIMARY KEY NOT NULL'],
  ['thread_id', 'text NOT NULL'],
  ['sequence', 'integer NOT NULL'],
  ['sender_bot_id', 'text NOT NULL'],
  ['recipient_bot_id', 'text NOT NULL'],
  ['sender_session_id', 'text'],
  ['recipient_session_id', 'text'],
  ['delivery_status', `text DEFAULT 'pending' NOT NULL`],
  ['sender_name', 'text'],
  ['recipient_name', 'text'],
  ['content', 'text NOT NULL'],
  ['created_at', 'integer NOT NULL'],
];

const BOT_DIRECT_MESSAGES_FOREIGN_KEYS: ReadonlyArray<string> = [
  'FOREIGN KEY (`thread_id`) REFERENCES `bot_direct_message_threads`(`id`) ON UPDATE no action ON DELETE cascade',
  'FOREIGN KEY (`sender_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null',
  'FOREIGN KEY (`recipient_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null',
];

const BOT_DIRECT_MESSAGES_INDEXES: ReadonlyArray<string> = [
  'CREATE UNIQUE INDEX `uniq_bot_direct_messages_thread_sequence` ON `bot_direct_messages` (`thread_id`,`sequence`)',
  'CREATE INDEX `idx_bot_direct_messages_thread_created` ON `bot_direct_messages` (`thread_id`,`created_at`)',
];

function tableColumnNames(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function tableIndexNames(db: Database.Database, table: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`,
    )
    .all(table) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function tableColumnNamesOfAll(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/**
 * 把重编号血统的 bot_direct_messages 收敛成 0108 执行后的等价结构。
 *
 * `carryBridgeColumn`：库已经应用过 0109（bridge_session_id）时，重建目标按「0108 列 + 0109 补的列」
 * 构造并搬运原值；0108 重放路径（0109 还没跑）传 false，保持那一刻的形状。
 *
 * 不自己开事务：调用方（replay）已在本条 migration 的事务内，且事务中执行
 * `PRAGMA foreign_keys` 会被 SQLite 静默忽略（no-op），不能依赖它关外键检查。
 * 安全前提在函数内自查：无任何其他表外键引用本表时才允许重建。
 */
function repairRenumberedBotDirectMessages(
  db: Database.Database,
  options: { carryBridgeColumn?: boolean } = {},
): boolean {
  const existing = tableColumnNames(db, 'bot_direct_messages');
  const canonical = BOT_DIRECT_MESSAGES_CANONICAL_COLUMNS.map(([name]) => name);
  const target = options.carryBridgeColumn
    ? [...canonical, BOT_DIRECT_MESSAGES_RENUMBER_MARKER]
    : canonical;
  const missing = canonical.filter((name) => !existing.includes(name));
  if (missing.length === 0) return false;
  const expectedMissing = ['sender_name', 'recipient_name'];
  if (missing.length !== expectedMissing.length || missing.some((name) => !expectedMissing.includes(name))) {
    throw new Error(
      `bot_direct_messages 重编号修复只支持缺 sender_name/recipient_name,实际缺:[${missing.join(', ')}]`,
    );
  }
  // 重建会 DROP + RENAME；先确认没有别的表还引用着它（sqlite_rename_table 会维护引用，
  // 但被引用的表被删时重建语句会报错）。用逐表 PRAGMA 检查，避开表值函数在旧 SQLite
  // 版本上的兼容差异。
  const referencing: string[] = [];
  for (const table of tableColumnNamesOfAll(db)) {
    if (table === 'bot_direct_messages') continue;
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list('${table}')`).all() as Array<{ table: string }>;
    if (foreignKeys.some((fk) => fk.table === 'bot_direct_messages')) referencing.push(table);
  }
  if (referencing.length > 0) {
    throw new Error(
      `bot_direct_messages 重编号修复遇到外部外键引用(重建会报错):${referencing.join(', ')}`,
    );
  }

  // 只搬运目标表确实存在的列：旧 0108 血统在执行本条时还没有 bridge_session_id（由 0109 补），
  // 而重放 0108 之后重建出来的表也必须保持那一刻的形状，不能提前长出该列。
  const carriedColumns = target.filter((name) => existing.includes(name));
  const insertList = carriedColumns.map((name) => `\`${name}\``).join(', ');
  const selectList = carriedColumns.map((name) => `\`${name}\``).join(', ');
  const createSql =
    'CREATE TABLE `__renumber_bot_direct_messages` (\n' +
    [
      ...BOT_DIRECT_MESSAGES_CANONICAL_COLUMNS.map(([name, type]) => `\t\`${name}\` ${type}`),
      ...(options.carryBridgeColumn
        ? [`\t\`${BOT_DIRECT_MESSAGES_RENUMBER_MARKER}\` text`]
        : []),
      ...BOT_DIRECT_MESSAGES_FOREIGN_KEYS.map((clause) => `\t${clause}`),
    ].join(',\n') +
    '\n)';
  db.prepare(createSql).run();
  db.prepare(
    `INSERT INTO \`__renumber_bot_direct_messages\` (${insertList}) SELECT ${selectList} FROM \`bot_direct_messages\``,
  ).run();
  db.prepare('DROP TABLE `bot_direct_messages`').run();
  db.prepare('ALTER TABLE `__renumber_bot_direct_messages` RENAME TO `bot_direct_messages`').run();
  for (const statement of BOT_DIRECT_MESSAGES_INDEXES) {
    const indexName = /INDEX `([^`]+)`/.exec(statement)?.[1];
    if (indexName && !tableIndexNames(db, 'bot_direct_messages').has(indexName)) {
      db.prepare(statement).run();
    }
  }

  const repaired = tableColumnNames(db, 'bot_direct_messages');
  if (repaired.join('\u0000') !== target.join('\u0000')) {
    throw new Error(
      `bot_direct_messages 重编号修复后列序/列集仍未对齐:${repaired.join(', ')}`,
    );
  }
  const indexes = tableIndexNames(db, 'bot_direct_messages');
  for (const statement of BOT_DIRECT_MESSAGES_INDEXES) {
    const indexName = /INDEX `([^`]+)`/.exec(statement)?.[1];
    if (indexName && !indexes.has(indexName)) {
      throw new Error(`bot_direct_messages 重编号修复未完成,缺索引 ${indexName}`);
    }
  }
  return true;
}

/**
 * 「已发布分支的 migration 在合入主干时被重编号」会在库里留下一种固定形态：
 * 旧 seq 的 applied identity 对应不到 canonical 链，且被重编号的那条 migration 的
 * 等效 schema 从来没真正执行过。runtime manifest 侧由
 * KNOWN_RENUMBERED_APPLIED_MIGRATIONS 收敛；这里收敛它残留的 schema 缺口。
 *
 * 只处理已登记的 0108_lowly_scarlet_witch 重编号（0108 执行后的 bot 私聊表结构）。
 * 正常库/新库全部条件不命中，直接返回；不报错、不写库、不产生备份。
 * 返回是否实际做了修复，供调用方记日志。
 */
export function reconcileRenumberedAppliedSchema(
  db: Database.Database,
  onWarning?: (event: Record<string, unknown>) => void,
): boolean {
  const columns = tableColumnNames(db, 'bot_direct_messages');
  // 表都不在：不是这条血统（正常 pre-0108 库还没有这张表）。
  if (columns.length === 0) return false;
  // 0109 已应用（含被首版修复修过的 live 库）：重建目标必须带上 0109 补的 bridge_session_id，
  // 否则运行时按 schema.ts 取全列（drizzle 不带字段的 select()）会 no such column。
  const carryBridgeColumn = readSchemaVersion(db) >= 109;
  // 重编号标志：旧分支已经在 0109 落过 bridge_session_id（正常 pre-0108 库没有这张表/这列）。
  let repaired = false;
  if (
    columns.includes(BOT_DIRECT_MESSAGES_RENUMBER_MARKER) &&
    !(columns.includes('sender_name') && columns.includes('recipient_name'))
  ) {
    repaired = repairRenumberedBotDirectMessages(db, { carryBridgeColumn });
  }
  // 首版修复重建时丢掉了 0109 的列且无人在此补回：这种库已经是 0108 形状（列值无法恢复），
  // 补一列空值至少让运行时不再报缺列。
  if (
    carryBridgeColumn &&
    !tableColumnNames(db, 'bot_direct_messages').includes(BOT_DIRECT_MESSAGES_RENUMBER_MARKER)
  ) {
    db.prepare('ALTER TABLE `bot_direct_messages` ADD `bridge_session_id` text').run();
    repaired = true;
  }
  if (repaired) {
    onWarning?.({ event: 'localDb.migrate.renumberedSchemaConverged', table: 'bot_direct_messages' });
  }
  return repaired;
}

const FROZEN_REPLAY_DEFECT_GUARDS: Record<string, (db: Database.Database) => boolean> = {
  '0110_green_unus.sql': (db) => {
    // 与 KNOWN_RENUMBERED_APPLIED_MIGRATIONS 的 0108_loose_puppet_master 是同一次重编号的
    // 两半：旧 checkout 已在 0108 落过同一列，这里再裸 ALTER 必然 duplicate column name。
    // 目标列已存在 → 按已生效处理；列不存在（正常库）仍执行 SQL，缺陷不会外溢到新库。
    const columns = db.prepare(`PRAGMA table_info('sessions')`).all() as Array<{ name: string }>;
    return columns.some((column) => column.name === 'context_window_budget');
  },
  '0084_small_gwen_stacy.sql': (db) => {
    const columns = db
      .prepare(`PRAGMA table_info('schedules')`)
      .all() as Array<{ name: string }>;
    // 表不存在(仅合成/残缺库;真实库自 0010 起必有)时裸 ALTER 必然报错,
    // 与其中断整条迁移链不如按 no-op 跳过;列已存在则为重放,同样跳过。
    if (columns.length === 0) return true;
    return columns.some((column) => column.name === 'notify_wecom_group');
  },
};

export function runMigrationReplay(
  db: Database.Database,
  options: RunMigrationReplayOptions,
): MigrationReplayResult {
  const currentVersion = options.currentVersion ?? readSchemaVersion(db);
  const pending = listPendingMigrations(options.drizzleDir, currentVersion);
  const scriptLoader = options.scriptLoader ?? loadScriptWithRequire;

  for (const migration of pending) {
    options.onMigrationStart?.(migration);
    const startedAt = Date.now();
    const sql = fs.readFileSync(migration.sqlPath, 'utf-8');
    const contentHash = hashMigrationFile(migration.sqlPath);
    const tx = db.transaction(() => {
      if (!FROZEN_REPLAY_DEFECT_GUARDS[migration.fileName]?.(db)) {
        db.exec(sql);
      }
      if (migration.tsScriptPath) {
        const script = scriptLoader(migration.tsScriptPath) as {
          run?: (db: Database.Database) => void;
        };
        if (typeof script?.run !== 'function') {
          throw new Error(`${migration.fileName} 同名 TS 脚本未导出 run()`);
        }
        script.run(db);
      }
      writeSchemaVersion(db, migration.seq);
      writeMigrationHistory(
        db,
        migration.seq,
        migration.fileName,
        contentHash,
        options.onMigrationHistoryWriteFailed,
      );
    });
    tx();
    options.onMigrationApplied?.(migration, Date.now() - startedAt);
  }

  return {
    currentVersion,
    finalVersion: pending.at(-1)?.seq ?? currentVersion,
    applied: pending,
  };
}

function loadScriptWithRequire(scriptPath: string): unknown {
  // require 而非 import：生产 Electron 以 CommonJS 加载 raw TS 配套脚本。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(scriptPath);
}

function writeSchemaVersion(db: Database.Database, seq: number): void {
  db.prepare(
    `INSERT INTO migration_meta (key, value)
     VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(String(seq));
}

function writeMigrationHistory(
  db: Database.Database,
  seq: number,
  fileName: string,
  contentHash: string,
  onFailure?: (failure: MigrationHistoryWriteFailure) => void,
): void {
  try {
    db.prepare(
      `INSERT OR REPLACE INTO migration_history (seq, file_name, content_hash, applied_at)
       VALUES (?, ?, ?, ?)`,
    ).run(seq, fileName, contentHash, Date.now());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/no such table/i.test(msg)) {
      onFailure?.({ seq, fileName, contentHash, error: err });
    }
  }
}

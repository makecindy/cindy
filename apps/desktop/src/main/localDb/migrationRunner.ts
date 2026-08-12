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
    const existingBySeq = new Map(existing.migrations.map((identity) => [identity.seq, identity]));
    for (const identity of existing.migrations) {
      if (identity.seq > databaseVersion) continue;
      const current = expectedBySeq.get(identity.seq);
      if (!current || !runtimeIdentityMatches(identity, current)) {
        throw new Error(
          `applied migration runtime identity changed at seq ${identity.seq} (${identity.fileName})`,
        );
      }
    }
    for (const identity of expected.migrations) {
      if (identity.seq > databaseVersion) continue;
      const applied = existingBySeq.get(identity.seq);
      if (!applied || !runtimeIdentityMatches(applied, identity)) {
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

// 0084 落地时违背了「ALTER TABLE ADD COLUMN 不能直接写进 migration SQL」的可重放
// 惯例(SQLite 无 IF NOT EXISTS 列语义;正确形态见 0075/0076:SQL 置空 + companion
// 用 PRAGMA table_info 守卫),而文件本体已随 main 永久冻结、不可回改。这里在
// runner 侧补等效守卫:目标列已存在时按已生效处理,跳过 SQL 本体,schema_version
// 与 migration history 照常推进。只允许命中登记在册的冻结缺陷,不为后续 migration
// 提供任何通用容错——新迁移必须自带守卫。
const FROZEN_REPLAY_DEFECT_GUARDS: Record<string, (db: Database.Database) => boolean> = {
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

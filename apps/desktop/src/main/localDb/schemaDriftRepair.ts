/**
 * Schema-drift repair (#37) —— 反射 schema.ts vs 物理 PRAGMA,幂等补缺。
 *
 * 适用场景:dev 端在 schemaDriftDetector 报 drift 后调用,自动把缺的列/表/索引补齐。
 *
 * 原则(跟之前 reverted 那版相同,但触发条件严格了):
 *   - 只加不删:对照 schema.ts 声明,补缺列/缺表/缺索引;**绝不**删除多余列。
 *   - 单项 try/catch:某条修复失败不阻断其余修复。
 *   - 顶层 try/catch:整个 repair 崩了也不阻塞启动,只 log.error。
 *   - 修不掉的(改类型、删列、改 NOT NULL 约束、复合 FK)只能丢到 residual 让调用方决策。
 *
 * 返回 `{ repaired, residual }`:
 *   - `repaired`: 实际跑成功的 DDL 列表(给日志看)
 *   - `residual`: 跑完后仍存在的 schema mismatch 列表(留给 ensureReady 决定是否弹 nuke 对话框)
 *
 * 注意:本模块用 drizzle 的内部 column 属性(`.notNull` / `.hasDefault` / `.default`),
 * drizzle 升级时可能需要重新校准。所有 cast 集中在 `asColumnMeta` 一个 helper 里,
 * 升级时只改这一处。
 */

import type Database from 'better-sqlite3';
import { getTableColumns, getTableName, is, isTable, SQL } from 'drizzle-orm';
import type { Column } from 'drizzle-orm';
import { getTableConfig, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import type { SQLiteTableWithColumns, TableConfig } from 'drizzle-orm/sqlite-core';

import * as schema from './schema';
import { createLogger } from '../logger';
import { repairMessagesFtsRows } from './messagesFtsRowsRepair';

const log = createLogger('schema-drift-repair');

/** drizzle SQL → 文本序列化器,用于把 partial index 的 WHERE 子句还原成 DDL。无状态,单例复用。 */
const sqliteDialect = new SQLiteSyncDialect();

type ManagedSchemaTable = SQLiteTableWithColumns<TableConfig>;

interface ColumnMeta {
  name: string;
  notNull: boolean;
  hasDefault: boolean;
  default: unknown;
  primary: boolean;
  getSQLType(): string;
}

function asColumnMeta(col: Column): ColumnMeta {
  return col as unknown as ColumnMeta;
}

/**
 * 受管理的表清单从 schema.ts 的 drizzle table export 自动派生。
 * 新增 sqliteTable export 会自动进入 drift repair，避免手写清单随多人改动漂移。
 *
 * 不在 schema.ts export 里的虚拟表:`messages_fts`(FTS5)与 `chat_messages_vec_v1`
 * (vec0)不能用反射建表，由对应 migration 自己负责，drift 修复路径不管。
 */
const SCHEMA_TABLES: ManagedSchemaTable[] = (Object.values(schema) as unknown[])
  .filter((value): value is ManagedSchemaTable => isTable(value))
  .sort((a, b) => getTableName(a).localeCompare(getTableName(b)));

export function getManagedSchemaTableNames(): string[] {
  return SCHEMA_TABLES.map((table) => getTableName(table));
}

export interface ResidualMismatch {
  table: string;
  kind:
    | 'missing-index'
    | 'missing-not-null-column'
    | 'missing-partial-index'
    | 'missing-table-fatal'
    | 'unknown';
  detail: string;
}

export interface RepairReport {
  repaired: string[];
  residual: ResidualMismatch[];
}

/** 一条经只读反射确认需要执行的 schema 修复动作。 */
export interface SchemaDriftRepairAction {
  table: string;
  kind: 'add-column' | 'create-index' | 'create-table' | 'repair-messages-fts-rows';
  ddl: string;
  failureKind: ResidualMismatch['kind'];
  failureDetail: string;
}

/**
 * schema drift 的只读修复计划。调用方可先看 actions 是否为空，再决定是否值得做
 * 与 DB 体积线性相关的在线备份。
 */
export interface SchemaDriftRepairPlan {
  actions: SchemaDriftRepairAction[];
  residual: ResidualMismatch[];
}

export interface GuardedSchemaDriftRepairOptions {
  /** 真正写 schema 前执行；生产调用方在这里做备份配额清理与磁盘预检。 */
  beforeBackup?: () => void;
  /** 返回 null 表示备份失败，此时绝不执行 plan。 */
  backup: () => Promise<string | 'NO_DB_TO_BACKUP' | null>;
  /** backup await 期间连接可能因切账号被替换；false 时放弃本轮写入。 */
  isConnectionCurrent?: () => boolean;
  /** apply 完成后的备份配额轮转。 */
  afterApply?: () => void;
}

export interface GuardedSchemaDriftRepairResult {
  outcome: 'no-op' | 'applied' | 'backup-failed' | 'connection-changed';
  plan: SchemaDriftRepairPlan;
  report?: RepairReport;
  backupResult?: string | 'NO_DB_TO_BACKUP';
}

// ── helpers ────────────────────────────────────────────────────────────────

function tableExists(db: Database.Database, name: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
}

function existingColumnNames(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as {
    name: string;
  }[];
  return new Set(rows.map((r) => r.name));
}

function existingIndexNames(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA index_list('${table}')`).all() as {
    name: string;
  }[];
  return new Set(rows.map((r) => r.name));
}

/**
 * JS default value → SQL literal(用于 ALTER TABLE ADD COLUMN ... DEFAULT xxx)。
 * 返回 null = 无法转换(调用方跳过 DEFAULT 子句)。
 */
function defaultToSQL(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return null;
}

// ── column repair ──────────────────────────────────────────────────────────

function planColumnRepairs(
  db: Database.Database,
  tableName: string,
  drizzleTable: ManagedSchemaTable,
  residual: ResidualMismatch[],
): SchemaDriftRepairAction[] {
  const existing = existingColumnNames(db, tableName);
  const expected = getTableColumns(drizzleTable);
  const actions: SchemaDriftRepairAction[] = [];

  for (const rawCol of Object.values(expected)) {
    const col = asColumnMeta(rawCol as Column);
    if (existing.has(col.name)) continue;

    const sqlType = col.getSQLType();
    const def = col.hasDefault ? defaultToSQL(col.default) : null;

    // SQLite 限制:ALTER TABLE ADD COLUMN ... NOT NULL 必须带 DEFAULT。
    // 这类列只能在 CREATE TABLE 时一次到位 —— 表已存在却缺这列,属于无法用反射修复的情况,
    // 丢到 residual 让 ensureReady 决定弹 nuke 对话框。
    if (col.notNull && def === null) {
      residual.push({
        table: tableName,
        kind: 'missing-not-null-column',
        detail: `${tableName}.${col.name} (${sqlType}, NOT NULL, no default)`,
      });
      log.warn(
        JSON.stringify({
          event: 'schema-drift-repair.skip-not-null-no-default',
          table: tableName,
          column: col.name,
        }),
      );
      continue;
    }

    let ddl = `ALTER TABLE \`${tableName}\` ADD COLUMN \`${col.name}\` ${sqlType}`;
    if (def !== null) ddl += ` DEFAULT ${def}`;
    if (col.notNull) ddl += ' NOT NULL';

    actions.push({
      table: tableName,
      kind: 'add-column',
      ddl,
      failureKind: 'unknown',
      failureDetail: `add column ${col.name} failed`,
    });
  }

  return actions;
}

// ── index repair ───────────────────────────────────────────────────────────

function planIndexRepairs(
  db: Database.Database,
  tableName: string,
  drizzleTable: ManagedSchemaTable,
  residual: ResidualMismatch[],
): SchemaDriftRepairAction[] {
  const existing = existingIndexNames(db, tableName);
  const { indexes } = getTableConfig(drizzleTable);
  const actions: SchemaDriftRepairAction[] = [];

  for (const idx of indexes) {
    const idxName: string = idx.config.name;
    if (existing.has(idxName)) continue;

    const serializedColumns: string[] = [];
    let unsupportedExpression = false;
    for (const columnOrExpression of idx.config.columns) {
      if (!is(columnOrExpression, SQL)) {
        serializedColumns.push(`\`${columnOrExpression.name}\``);
        continue;
      }

      const q = sqliteDialect.sqlToQuery(columnOrExpression);
      if (q.params.length > 0) {
        residual.push({
          table: tableName,
          kind: 'missing-index',
          detail: `${idxName} skipped because indexed expression contains bound parameters`,
        });
        unsupportedExpression = true;
        break;
      }

      // SQLite 的 CREATE INDEX 表达式禁止带表限定符；Drizzle 会把
      // sql`lower(${table.column})` 序列化成 lower("table"."column")。
      const tableQualifier = `${sqliteDialect.escapeName(tableName)}.`;
      serializedColumns.push(q.sql.replaceAll(tableQualifier, ''));
    }
    if (unsupportedExpression) continue;
    const cols = serializedColumns.join(', ');
    const unique = idx.config.unique ? 'UNIQUE ' : '';

    // partial index 必须带回 WHERE 子句,否则会被错建成全表索引。
    // 反例(F-COLLAB):uniq_orca_workflows_active_lead_session_id 丢了
    // `WHERE status='active'` 就退化成全表 unique,等价于已废弃的
    // uniq_orca_workflows_lead_session_id,会让同一 lead 的协同 toggle 复开失败。
    const where = idx.config.where as SQL | undefined;
    let whereClause = '';
    if (where) {
      const q = sqliteDialect.sqlToQuery(where);
      // db.exec 不能绑定参数;带参 WHERE 无法内联成 DDL。与其建出错误的全表索引,
      // 不如跳过,留给正式 migration 处理(当前 schema 内的 partial index 均无参)。
      if (q.params.length > 0) {
        log.warn(
          JSON.stringify({
            event: 'schema-drift-repair.skip-parametrized-partial-index',
            table: tableName,
            index: idxName,
          }),
        );
        residual.push({
          table: tableName,
          kind: 'missing-partial-index',
          detail: `${idxName} skipped because WHERE contains bound parameters`,
        });
        continue;
      }
      whereClause = ` WHERE ${q.sql}`;
    }
    const ddl = `CREATE ${unique}INDEX IF NOT EXISTS \`${idxName}\` ON \`${tableName}\` (${cols})${whereClause}`;

    actions.push({
      table: tableName,
      kind: 'create-index',
      ddl,
      failureKind: where ? 'missing-partial-index' : 'missing-index',
      failureDetail: `${idxName} create failed`,
    });
  }

  return actions;
}

// ── missing table repair ───────────────────────────────────────────────────

/**
 * 整表缺失 → CREATE TABLE IF NOT EXISTS。
 *
 * 处理细节:
 * - 单列 PK 用 `\`col\` ... PRIMARY KEY` 内联
 * - 复合 PK(如 im_bindings 的 (channel, bot_context_id, user_id))在末尾追加
 *   `PRIMARY KEY (col1, col2, col3)` 子句
 * - 不补 FK —— 表都丢了大概率有更深的问题,FK 留给后续 schemaDriftRepair 再跑
 *   (但目前没实现 FK 反射;调用方应该已经走 nuke 路径)
 */
function planMissingTableRepair(
  tableName: string,
  drizzleTable: ManagedSchemaTable,
): SchemaDriftRepairAction {
  const expected = getTableColumns(drizzleTable);
  const config = getTableConfig(drizzleTable);
  const compositePks = config.primaryKeys;

  const hasCompositePk = compositePks.length > 0;
  const colDefs: string[] = [];

  for (const rawCol of Object.values(expected)) {
    const col = asColumnMeta(rawCol as Column);
    const sqlType = col.getSQLType();
    let def = `\`${col.name}\` ${sqlType}`;
    // 复合 PK 时不要在列上写 PRIMARY KEY,会跟末尾的 PRIMARY KEY (...) 子句冲突
    if (col.primary && !hasCompositePk) def += ' PRIMARY KEY';
    if (col.notNull && !(col.primary && !hasCompositePk)) def += ' NOT NULL';
    if (col.hasDefault) {
      const sqlDefault = defaultToSQL(col.default);
      if (sqlDefault !== null) def += ` DEFAULT ${sqlDefault}`;
    }
    colDefs.push(def);
  }

  if (hasCompositePk) {
    const pkCols = compositePks
      .flatMap((pk) => pk.columns.map((c) => `\`${(c as unknown as { name: string }).name}\``))
      .join(', ');
    colDefs.push(`PRIMARY KEY (${pkCols})`);
  }

  return {
    table: tableName,
    kind: 'create-table',
    ddl: `CREATE TABLE IF NOT EXISTS \`${tableName}\` (\n  ${colDefs.join(',\n  ')}\n)`,
    failureKind: 'missing-table-fatal',
    failureDetail: 'create table failed',
  };
}

// ── entry point ────────────────────────────────────────────────────────────

export function planSchemaDriftRepair(db: Database.Database): SchemaDriftRepairPlan {
  const actions: SchemaDriftRepairAction[] = [];
  const residual: ResidualMismatch[] = [];

  // 防御:db 为空或连接已关闭时直接返回空报告(绝不产出 residual)。
  // residual 被上层 handleSchemaDrift 用来决定是否弹 nuke 对话框,而"连接没开 / 句柄为 null"
  // 属于基础设施错误,不是 schema 结构不一致 —— 决不能让它升级成"删库重建"提示。
  // (2026-06-22 事故根因之一:并发 ensureReady 在 await backupDb 期间把 _db 置空,
  //  旧路径仍把 null 传进来,每张表 db.prepare 抛错被误判成 21 个 residual → 触发 nuke。)
  const handle = db as Database.Database | null | undefined;
  if (!handle || !handle.open) {
    log.error(
      JSON.stringify({
        event: 'schema-drift-repair.skip-no-open-db',
        hasDb: !!handle,
        open: handle ? handle.open : false,
      }),
    );
    return { actions, residual };
  }

  try {
    for (const drizzleTable of SCHEMA_TABLES) {
      const tableName = getTableName(drizzleTable);
      try {
        if (!tableExists(db, tableName)) {
          if (tableName === 'messages_fts_rows') {
            actions.push({
              ...planMissingTableRepair(tableName, drizzleTable),
              kind: 'repair-messages-fts-rows',
            });
            continue;
          }
          // CREATE TABLE 已包含全部列；只需额外计划 schema.ts 声明的索引。
          actions.push(planMissingTableRepair(tableName, drizzleTable));
          actions.push(...planIndexRepairs(db, tableName, drizzleTable, residual));
          continue;
        }
        actions.push(...planColumnRepairs(db, tableName, drizzleTable, residual));
        actions.push(...planIndexRepairs(db, tableName, drizzleTable, residual));
      } catch (err) {
        log.error(
          JSON.stringify({
            event: 'schema-drift-repair.per-table-failed',
            table: tableName,
            error: String(err),
          }),
        );
        residual.push({
          table: tableName,
          kind: 'unknown',
          detail: `per-table repair threw: ${String(err)}`,
        });
      }
    }
  } catch (err) {
    // 顶层兜底:plan 自己崩了也不能阻塞启动
    log.error(
      JSON.stringify({
        event: 'schema-drift-repair.plan-fatal',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return { actions, residual };
}

/** 执行一份已经生成的修复计划；单项失败不阻断后续动作。 */
export function applySchemaDriftRepair(
  db: Database.Database,
  plan: SchemaDriftRepairPlan,
): RepairReport {
  const repaired: string[] = [];
  const residual = [...plan.residual];

  for (const action of plan.actions) {
    // CREATE TABLE 失败后，同表的索引动作没有执行意义，也不应制造一串重复 residual。
    if (
      action.kind !== 'create-table' &&
      action.kind !== 'repair-messages-fts-rows' &&
      !tableExists(db, action.table)
    ) {
      continue;
    }
    try {
      if (action.kind === 'repair-messages-fts-rows') repairMessagesFtsRows(db);
      else db.exec(action.ddl);
      repaired.push(action.ddl);
    } catch (err) {
      log.error(
        JSON.stringify({
          event: 'schema-drift-repair.action-failed',
          table: action.table,
          kind: action.kind,
          ddl: action.ddl,
          error: String(err),
        }),
      );
      residual.push({
        table: action.table,
        kind: action.failureKind,
        detail: `${action.failureDetail}: ${String(err)}`,
      });
    }
  }

  if (repaired.length > 0) {
    log.warn(
      JSON.stringify({
        event: 'schema-drift-repair.applied',
        repairedCount: repaired.length,
        residualCount: residual.length,
        repaired,
      }),
    );
  } else {
    log.info(
      JSON.stringify({
        event: 'schema-drift-repair.no-op',
        residualCount: residual.length,
      }),
    );
  }

  return { repaired, residual };
}

/**
 * 只在 plan 确认存在实际 DDL 时才备份；备份失败或连接切换时绝不写 schema。
 * 这把“是否需要备份”绑定到真实修复动作，而不是 migration history 的元数据 drift。
 */
export async function repairSchemaDriftWithBackup(
  db: Database.Database,
  options: GuardedSchemaDriftRepairOptions,
): Promise<GuardedSchemaDriftRepairResult> {
  const plan = planSchemaDriftRepair(db);
  if (plan.actions.length === 0) {
    return { outcome: 'no-op', plan, report: applySchemaDriftRepair(db, plan) };
  }

  options.beforeBackup?.();
  const backupResult = await options.backup();
  if (backupResult === null) return { outcome: 'backup-failed', plan };
  if (options.isConnectionCurrent && !options.isConnectionCurrent()) {
    return { outcome: 'connection-changed', plan, backupResult };
  }

  // 在线备份可能持续数分钟；共库的另一实例期间可能已经补过部分 schema。
  // apply 前重新只读规划，避免执行过时 DDL，也能覆盖“原先缺表、期间被建成残表”的竞态。
  const applyPlan = planSchemaDriftRepair(db);
  const report = applySchemaDriftRepair(db, applyPlan);
  options.afterApply?.();
  return { outcome: 'applied', plan, report, backupResult };
}

/** 向后兼容同步调用方与既有测试；生产启动路径使用带备份门禁的版本。 */
export function repairSchemaDrift(db: Database.Database): RepairReport {
  return applySchemaDriftRepair(db, planSchemaDriftRepair(db));
}

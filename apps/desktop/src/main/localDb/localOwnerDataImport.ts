/**
 * localOwnerDataImport — 把 local 模式(local-v1)库里的数据行导入当前账号库。
 *
 * local 模式的会话存在 `<userData>/<prefix>-local-v1.db`,账号会话存在
 * `<userData>/<prefix>-<userId>.db`。登录后 UI 只读账号库,local 期间的会话
 * 在盘上完好却不可见。本模块是「认领」的提交点:ATTACH 只读 local 库,在**一次
 * 事务**里把业务行 `INSERT OR IGNORE` 进账号库。
 *
 * 为什么是行级导入而不是把 local 库文件改名成账号库:
 *  - 账号库可能已经有会话(此前登录过 / mToc 迁入过),文件改名会覆盖它们;行级
 *    导入让两边会话并存,这是用户拍板的合并语义。
 *  - 只写账号库、只读 local 库 → 单库事务,提交天然原子。中途崩溃要么全进要么
 *    全不进,local 库始终没被动过一个字节,「登录把会话弄丢了」在物理上不可能。
 *  - 幂等:主键冲突整行跳过,同一个 local 库重复导入是 no-op,失败后重试安全。
 *
 * 表清单显式二分(IMPORTED_TABLES / SKIPPED_TABLES),并由单测断言两者之和等于
 * schema 里的全部表——schema 新增表时若没有归类,测试直接失败,不靠默认行为。
 *
 * 列按「目标库 ∩ 源库」取交集:local 库可能是旧客户端建的(schema 落后),缺的列
 * 走目标 schema 默认值,多出来的列丢弃,因此无需为了导入去迁移 local 库。
 *
 * 两条与「行搬过去就完事」不同的特殊处理:
 *  - **同 id 会话冲突**:账号库已有同 id 会话时,源会话的 sessions 行被 OR IGNORE
 *    跳过,它名下的子行(消息/目标/绑定/tab…)必须**一并跳过**,否则外键会指向账号
 *    库那条同名会话,把别人的历史搅乱。正常恒不发生(会话 id 是 UUID)。
 *  - **定时任务导入即暂停**:确认窗只裁决会话归属,没征求「让 local 模式的自动化
 *    在新账号下跑起来」;认领后 scheduler 立刻启动,到点任务会带着刚搬过去的凭证
 *    自动执行。因此导入的 schedules 一律置 status='paused',用户自行决定启用哪条。
 */

import type Database from 'better-sqlite3';

/** ATTACH 时给 local 库的 schema 名(仅存活于本次导入事务)。 */
const SOURCE_SCHEMA = 'adopt_src';

/**
 * 子表指向 sessions 的外键列名(本仓 schema 里只有这三种拼法)。用于把「账号库
 * 已有同 id 会话」的那些会话的子行整批排除,避免它们挂到别人的会话上。
 */
const SESSION_REF_COLUMNS = ['session_id', 'target_session_id', 'lead_session_id'] as const;

/** 冲突会话 id 的临时表名(事务内建、用完即弃;避免 IN 子句撞变量数上限)。 */
const CONFLICT_TEMP_TABLE = 'adopt_conflicted_sessions';

/**
 * 随认领导入的表,**按外键父→子排序**(sessions 先于 messages,media_blobs 先于
 * media_refs)。清单即语义:local 模式产生的、属于这个人的东西。
 */
export const IMPORTED_TABLES: readonly string[] = [
  // 会话本体与消息。
  'sessions',
  'messages',
  'session_pr_refs',
  'session_goals',
  // Orca 协同(团队/worker 挂在会话上)。
  'orca_teams',
  'orca_workers',
  // 定时任务及其运行记录。
  'schedules',
  'schedule_runs',
  // 工作区偏好。
  'recent_workdirs',
  'project_aliases',
  'project_automation_consents',
  'right_sidebar_tabs',
  'agent_input_queue_snapshots',
  // 用户自建的接入配置(对应的加密凭证由认领流程按 owner 前缀改名)。
  'custom_providers',
  'custom_mcp_servers',
  'im_bindings',
  // 附件:媒体总仓 cindy-media 在 userData 根、跨 owner 共享,只需搬引用行。
  'media_blobs',
  'media_refs',
  // 插件卡片与用量统计(统计行按日期聚合,撞同一天时保留账号侧,见 SKIPPED 说明)。
  'ghost_cards',
  'daily_spend',
  'daily_model_usage',
  'skill_usage_sources',
  'skill_usage_exposures',
];

/**
 * 明确**不**导入的表及理由。
 *  - migration_meta / migration_history:schema 簿记,账号库有自己的一份,导入会
 *    污染迁移状态判定。
 *  - account_usage_snapshots:Cindy 账号额度快照,local 模式没有账号,无意义。
 *  - device_link_ownership:设备级单持有者仲裁行,按账号重新仲裁。
 *  - embedding_meta / vec_table_meta:向量基建簿记,由账号库自己建立。
 *  - embedding_jobs:派生任务队列,指向的 vec0 虚表是账号库自己的;导入会引用错
 *    对象,而重建成本只是重跑一次嵌入。
 *  - orca_worker_creation_reservations:进程内短命预留,跨进程无意义。
 */
export const SKIPPED_TABLES: readonly string[] = [
  'migration_meta',
  'migration_history',
  'account_usage_snapshots',
  'device_link_ownership',
  'embedding_meta',
  'vec_table_meta',
  'embedding_jobs',
  'orca_worker_creation_reservations',
];

export interface LocalOwnerImportResult {
  /** 实际写入账号库的总行数(冲突跳过的不计)。 */
  inserted: number;
  /** 逐表写入行数,只含真正写过行的表(日志用)。 */
  perTable: Record<string, number>;
  /** 源库里不存在的表(local 库 schema 落后于当前版本时的正常情况)。 */
  missingInSource: string[];
  /**
   * 逐表「主键在账号库里也找不到」的源行数 = 真正被 OR IGNORE 丢掉的行(约束
   * 违规,通常意味着两库 schema 不兼容)。正常路径恒为空:主键撞车的行虽然也被
   * 跳过,但它的主键在账号库里存在,不计入。非空表示确有数据没能并过来,调用方
   * 必须 warn 出来——静默吞行就是用户口中的「登录把会话弄丢了」。
   */
  droppedRows: Record<string, number>;
  /** 无主键、无法做上面那项核验的表(结构异常的库才会出现)。 */
  unverifiedTables: string[];
  /** 账号库缺表或列完全不重叠、整表没能导入的表(schema 异常信号)。 */
  unimportableTables: string[];
  /**
   * 两库存在同 id 会话的条数。这类会话的 sessions 行被 OR IGNORE 跳过,它名下的
   * 消息/目标/绑定等子行**也一并跳过**——否则子行的外键会指向账号库里那条同 id
   * 会话,把别人的历史搅乱。正常恒为 0(会话 id 是 UUID);非 0 说明两库同源
   * (例如都来自同一次 mToc 复制),调用方按「数据没全带过来」处理。
   */
  conflictedSessions: number;
  /** 因所属会话冲突而跳过的子行数(逐表)。 */
  skippedByConflict: Record<string, number>;
  /** 导入后被置为 paused 的定时任务数(不让它们在新账号下自动跑起来)。 */
  pausedSchedules: number;
}

/** 双引号转义的标识符(表名/列名全部来自本模块常量与 pragma,无外部输入)。 */
function quoteId(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function tableColumns(db: Database.Database, schema: string, table: string): Set<string> {
  const rows = db.pragma(`${schema}.table_info(${quoteId(table)})`) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/** 主键列(复合主键按 pk 序号排);无主键返回空数组。 */
function primaryKeyColumns(db: Database.Database, table: string): string[] {
  const rows = db.pragma(`main.table_info(${quoteId(table)})`) as Array<{
    name: string;
    pk: number;
  }>;
  return rows
    .filter((row) => row.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((row) => row.name);
}

function sourceTableNames(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM ${SOURCE_SCHEMA}.sqlite_master WHERE type = 'table'`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/**
 * 把 `localDbPath` 里 IMPORTED_TABLES 的行导入 `db`(当前账号库连接)。
 *
 * 调用方必须保证 `localDbPath` 指向的库已关闭(否则读到的可能不是已 checkpoint
 * 的最新状态)。抛错即导入未发生(事务已回滚),账号库与 local 库都未改变。
 */
export function importLocalOwnerData(
  db: Database.Database,
  localDbPath: string,
): LocalOwnerImportResult {
  // ATTACH / DETACH 不能在事务内执行,因此包在事务外。worker 的连接是长驻的,
  // 上一次导入若在 DETACH 前被打断会留下同名 attach,先自愈掉再 ATTACH。
  detachSourceQuietly(db);
  db.prepare(`ATTACH DATABASE ? AS ${SOURCE_SCHEMA}`).run(localDbPath);
  try {
    const sourceTables = sourceTableNames(db);
    const perTable: Record<string, number> = {};
    const missingInSource: string[] = [];
    const droppedRows: Record<string, number> = {};
    const unverifiedTables: string[] = [];
    const unimportableTables: string[] = [];
    let inserted = 0;

    const skippedByConflict: Record<string, number> = {};
    let conflictedSessions = 0;
    let pausedSchedules = 0;

    const run = db.transaction(() => {
      // 外键在 localDb 连接上是 ON。逐表插入时子表可能先于父表看到中间态
      // (同表内的自引用、以及未来新增的表间引用),延迟到 COMMIT 统一校验。
      db.pragma('defer_foreign_keys = ON');

      // 先算「两库同 id 会话」:这类源会话的 sessions 行会被 OR IGNORE 跳过,
      // 它名下的子行必须一并跳过,否则外键会指到账号库那条同名会话上、把别人的
      // 历史搅乱(codex review)。必须在插 sessions 之前算,插完就都存在了。
      // 用临时表而非 IN 参数列表:冲突集理论上可以很大,IN 会撞变量数上限。
      db.prepare(`DROP TABLE IF EXISTS temp.${quoteId(CONFLICT_TEMP_TABLE)}`).run();
      if (sourceTables.has('sessions')) {
        db.prepare(
          `CREATE TEMP TABLE ${quoteId(CONFLICT_TEMP_TABLE)} (id TEXT PRIMARY KEY)`,
        ).run();
        conflictedSessions = Number(
          db
            .prepare(
              `INSERT INTO temp.${quoteId(CONFLICT_TEMP_TABLE)} (id)
                 SELECT s.id FROM ${SOURCE_SCHEMA}.sessions s
                  WHERE EXISTS (SELECT 1 FROM main.sessions m WHERE m.id = s.id)`,
            )
            .run().changes,
        );
      }

      for (const table of IMPORTED_TABLES) {
        if (!sourceTables.has(table)) {
          missingInSource.push(table);
          continue;
        }
        const targetCols = tableColumns(db, 'main', table);
        const sharedCols = [...tableColumns(db, SOURCE_SCHEMA, table)].filter((col) =>
          targetCols.has(col),
        );
        // 账号库缺这张表、或两库同名表列完全不重叠(账号库 schema 不完整 / 手工
        // 改过库)。跳过比乱插安全,但绝不静默:记下来让调用方 warn。
        if (sharedCols.length === 0) {
          unimportableTables.push(table);
          continue;
        }
        const colList = sharedCols.map(quoteId).join(', ');
        // 冲突会话的子行整批排除(见上面临时表的理由)。sessions 自身不需要过滤:
        // 它的冲突行本来就被 OR IGNORE 跳过。
        const refCol =
          conflictedSessions > 0 && table !== 'sessions'
            ? SESSION_REF_COLUMNS.find((col) => sharedCols.includes(col))
            : undefined;
        // NULL-safe:`col NOT IN (...)` 在 col 为 NULL 时结果是 NULL(被 WHERE 当假),
        // 而 target_session_id / lead_session_id 都是可空列——不显式放行 NULL 的话,
        // 只要出现一个冲突会话,所有「不关联任何会话」的行都会被误跳过
        // (Copilot review)。
        const conflictFilter = refCol
          ? ` WHERE (${quoteId(refCol)} IS NULL OR ${quoteId(refCol)} NOT IN` +
            ` (SELECT id FROM temp.${quoteId(CONFLICT_TEMP_TABLE)}))`
          : '';
        if (refCol) {
          const skipped = Number(
            (
              db
                .prepare(
                  `SELECT COUNT(*) AS c FROM ${SOURCE_SCHEMA}.${quoteId(table)}
                     WHERE ${quoteId(refCol)} IN (SELECT id FROM temp.${quoteId(CONFLICT_TEMP_TABLE)})`,
                )
                .get() as { c: number | bigint }
            ).c ?? 0,
          );
          if (skipped > 0) skippedByConflict[table] = skipped;
        }
        // OR IGNORE:主键/唯一约束冲突整行跳过。业务 id 都是 UUID,真正会撞的
        // 只有按日期聚合的统计表——撞同一天时保留账号库已有的那条(与用户确认
        // 的取舍一致:local 模式不产生 Cindy AI 花费,统计不并入无影响)。
        const result = db
          .prepare(
            `INSERT OR IGNORE INTO main.${quoteId(table)} (${colList})
               SELECT ${colList} FROM ${SOURCE_SCHEMA}.${quoteId(table)}${conflictFilter}`,
          )
          .run();
        const changes = Number(result.changes);
        if (changes > 0) {
          perTable[table] = changes;
          inserted += changes;
        }
        // OR IGNORE 对**所有**约束违规都是跳过(不只主键撞车:NOT NULL、CHECK、
        // 外键同样静默丢行)。所以插完立刻核验一次:源库里主键在账号库也不存在
        // 的行,就是真正没能并过来的数据。数在事务内取,读到的是本次插入后的态。
        const pkCols = primaryKeyColumns(db, table);
        // 主键列必须在两库都有,否则核验 SQL 自己就会报错、把整批导入拖崩。
        if (pkCols.length === 0 || !pkCols.every((col) => sharedCols.includes(col))) {
          unverifiedTables.push(table);
          continue;
        }
        const pkMatch = pkCols
          .map((col) => `t.${quoteId(col)} IS s.${quoteId(col)}`)
          .join(' AND ');
        // 核验时排除「因会话冲突而故意跳过」的行——它们没进来是设计使然,
        // 已单独记在 skippedByConflict 里,不该再算成 schema 不兼容的丢行。
        const conflictExclusion = refCol
          ? ` AND (s.${quoteId(refCol)} IS NULL OR s.${quoteId(refCol)} NOT IN` +
            ` (SELECT id FROM temp.${quoteId(CONFLICT_TEMP_TABLE)}))`
          : '';
        const dropped = db
          .prepare(
            `SELECT COUNT(*) AS c FROM ${SOURCE_SCHEMA}.${quoteId(table)} s
               WHERE NOT EXISTS (
                 SELECT 1 FROM main.${quoteId(table)} t WHERE ${pkMatch}
               )${conflictExclusion}`,
          )
          .get() as { c: number | bigint };
        const droppedCount = Number(dropped.c ?? 0);
        if (droppedCount > 0) droppedRows[table] = droppedCount;
      }

      // 定时任务导入后一律置为 paused。确认窗只让用户裁决「会话归属」,没有征求
      // 「把 local 模式的自动化任务在新账号下跑起来」——认领后 bootstrap 紧接着
      // 启动 scheduler,到点的任务会带着刚搬过去的凭证自动执行 agent / 脚本
      // (codex review)。导入即暂停,用户想要哪条自己去开。
      if (sourceTables.has('schedules') && tableColumns(db, 'main', 'schedules').has('status')) {
        pausedSchedules = Number(
          db
            .prepare(
              `UPDATE main.schedules SET status = 'paused'
                 WHERE status <> 'paused'
                   AND id IN (SELECT id FROM ${SOURCE_SCHEMA}.schedules)`,
            )
            .run().changes,
        );
      }

      db.prepare(`DROP TABLE IF EXISTS temp.${quoteId(CONFLICT_TEMP_TABLE)}`).run();
    });
    run();

    return {
      inserted,
      perTable,
      missingInSource,
      droppedRows,
      unverifiedTables,
      unimportableTables,
      conflictedSessions,
      skippedByConflict,
      pausedSchedules,
    };
  } finally {
    // finally 里抛错会覆盖导入本身的错误(诊断价值更高),因此 DETACH 只做
    // best-effort;残留 attach 由下一次导入进场时的自愈 DETACH 兜掉。
    detachSourceQuietly(db);
  }
}

function detachSourceQuietly(db: Database.Database): void {
  try {
    db.prepare(`DETACH DATABASE ${SOURCE_SCHEMA}`).run();
  } catch {
    /* 未 attach 时报错属正常路径 */
  }
}

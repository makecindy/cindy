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
 *  - **同 id 会话冲突 = 整体中止**:两库对同一个会话 id 有不同内容时,任何形式的
 *    部分导入都会搅乱某类引用(子行挂错会话、fork 的 parent 指向账号无关会话、
 *    定时任务的 target/skip_log 指错)。因此直接抛
 *    `LOCAL_OWNER_SESSION_ID_CONFLICT`、零写入,让调用方推迟并 warn——local 数据
 *    分毫未动。会话 id 是 UUID,正常永不发生。判定比的是**内容**不是 id:续跑时
 *    账号库里已有上一批已提交的同 id 同内容会话,只比 id 会把它们全判成冲突。
 *  - **定时任务导入即暂停**:确认窗只裁决对话归属,没征求「让 local 模式的自动化
 *    在新账号下跑起来」;认领后 scheduler 立刻启动,到点任务会带着刚搬过去的凭证
 *    自动执行。因此**本次新插入的** schedules 一律置 status='paused'(账号库原有
 *    的任务不动),用户自行决定启用哪条。
 */

import fs from 'node:fs';

import type Database from 'better-sqlite3';

/** ATTACH 时给 local 库的 schema 名(仅存活于本次导入事务)。 */
const SOURCE_SCHEMA = 'adopt_src';

/** 会话表名(冲突集与外键探测都以它为锚)。 */
const SESSIONS_TABLE = 'sessions';

/** 定时任务表名(导入后要把本次新增的那些置 paused)。 */
const SCHEDULES_TABLE = 'schedules';

/** 导入前账号库已有的 schedule id(事务内建、用完即弃;避免 IN 撞变量数上限)。 */
const PRE_EXISTING_SCHEDULES_TABLE = 'adopt_preexisting_schedules';

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
  // 个人微信可靠入站的运行态:binding epoch 世代号、待派发/待投递队列及其附件。
  // 都绑定在「某次微信绑定」上(凭证不入库,epoch 一换即失效),跨 owner 搬过去
  // 既接不上绑定,还会让 local 期间残留的待派发任务在新账号下被 pump 出去
  // ——与 schedules 同类的风险,而队列没有 paused 态可用,只能不导入。
  'wechat_sync_state',
  'wechat_inbox',
  'wechat_outbox',
  'wechat_file_attachments',
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
   * 恒为 0。同 id 但内容不同的会话会让导入**整体中止**(抛
   * `LOCAL_OWNER_SESSION_ID_CONFLICT`,零写入),所以能拿到结果就说明没有冲突。
   * 字段保留是为了让调用方的日志/类型保持稳定。
   */
  conflictedSessions: number;
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
  // 「绝不触碰 local 库」这条契约有两半,都要落到实现:
  //  - **不创建**:`ATTACH` 打开的是 read-write 句柄,路径不存在时 SQLite 会直接
  //    建一个空库(实测确认)。因此先显式验存,不存在即抛错——否则一个路径错误
  //    就会在 userData 里凭空造出个空的 local 库(Copilot review)。
  //    read-only URI(`file:...?mode=ro`)在本仓的 better-sqlite3 上不可用
  //    (未启用 URI 处理,实测 `unable to open database`),所以只读那一半靠
  //    SQL 层保证:本模块对 `adopt_src` 只出现 SELECT,从不 INSERT/UPDATE/DELETE。
  //  - **不写入**:见上一条的 SQL 层约束,加上导入事务只写 `main.*`。
  if (!fs.existsSync(localDbPath)) {
    throw Object.assign(new Error(`local db not found: ${localDbPath}`), {
      code: 'LOCAL_DB_MISSING',
    });
  }
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

    let conflictedSessions = 0;
    let pausedSchedules = 0;

    const run = db.transaction(() => {
      // 外键在 localDb 连接上是 ON。逐表插入时子表可能先于父表看到中间态
      // (同表内的自引用、以及未来新增的表间引用),延迟到 COMMIT 统一校验。
      db.pragma('defer_foreign_keys = ON');

      // ── 同 id 会话冲突:检测到就整体中止,不做部分导入 ──────────────────
      // 「同 id 但内容不同的会话」意味着两个库对同一个 id 有不同的事实。此时无论
      // 怎么部分跳过,都会有一类引用被搅乱:子行挂到账号那条会话上、fork 的
      // parent_session_id 指向账号的无关会话、定时任务的 target/skip_log 指错
      // ——这些坑逐个补了三轮还在冒新的。改为**整体抛错、零写入**:local 数据
      // 分毫未动、账号库不变,调用方按失败推迟并 warn,用户数据零损失。
      // 会话 id 是 UUID,正常永不发生;真发生了(手工改库、两库同源分叉)就该
      // 停下来让人看一眼,而不是让工具去猜哪些行该保留。
      //
      // 关键:比较**内容**而非只比 id。续跑场景里账号库已经有上一次已提交的
      // 那批会话(同 id 同内容),只比 id 会把它们全判成冲突、导致收尾永远完不成
      // (codex review)。逐列 `IS NOT` 是 null-safe 的不等比较。
      if (sourceTables.has(SESSIONS_TABLE)) {
        const sessionCols = [...tableColumns(db, SOURCE_SCHEMA, SESSIONS_TABLE)].filter((col) =>
          tableColumns(db, 'main', SESSIONS_TABLE).has(col),
        );
        if (sessionCols.length > 0) {
          const differs = sessionCols
            .map((col) => `s.${quoteId(col)} IS NOT m.${quoteId(col)}`)
            .join(' OR ');
          conflictedSessions = Number(
            (
              db
                .prepare(
                  `SELECT COUNT(*) AS c
                     FROM ${SOURCE_SCHEMA}.${quoteId(SESSIONS_TABLE)} s
                     JOIN main.${quoteId(SESSIONS_TABLE)} m ON m.id = s.id
                    WHERE ${differs}`,
                )
                .get() as { c: number | bigint }
            ).c ?? 0,
          );
        }
      }
      if (conflictedSessions > 0) {
        throw Object.assign(
          new Error(
            `${conflictedSessions} local session(s) share an id with a different account session; import aborted without writing anything`,
          ),
          { code: 'LOCAL_OWNER_SESSION_ID_CONFLICT', conflictedSessions },
        );
      }

      // 定时任务导入后要置 paused,但**只能动本次插入的那些**。先记下账号库里
      // 已经存在的 schedule id:同 id 撞车时 OR IGNORE 保留的是账号那行,若按
      // 「源库有这个 id」去 UPDATE,就会把用户账号里原本在跑的任务也停掉
      // (codex review)。临时表而非 IN 参数列表,避免撞变量数上限。
      db.prepare(`DROP TABLE IF EXISTS temp.${quoteId(PRE_EXISTING_SCHEDULES_TABLE)}`).run();
      const canPauseSchedules =
        sourceTables.has(SCHEDULES_TABLE) &&
        tableColumns(db, 'main', SCHEDULES_TABLE).has('status');
      if (canPauseSchedules) {
        db.prepare(
          `CREATE TEMP TABLE ${quoteId(PRE_EXISTING_SCHEDULES_TABLE)} (id TEXT PRIMARY KEY)`,
        ).run();
        db.prepare(
          `INSERT INTO temp.${quoteId(PRE_EXISTING_SCHEDULES_TABLE)} (id)
             SELECT id FROM main.${quoteId(SCHEDULES_TABLE)}`,
        ).run();
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
        // OR IGNORE:主键/唯一约束冲突整行跳过。会话 id 冲突已在上面整体拦死,
        // 这里真正会撞的只有按日期聚合的统计表——撞同一天时保留账号库已有的那条
        // (与用户确认的取舍一致:local 模式不产生 Cindy AI 花费,统计不并入无影响)。
        const result = db
          .prepare(
            `INSERT OR IGNORE INTO main.${quoteId(table)} (${colList})
               SELECT ${colList} FROM ${SOURCE_SCHEMA}.${quoteId(table)}`,
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
        const dropped = db
          .prepare(
            `SELECT COUNT(*) AS c FROM ${SOURCE_SCHEMA}.${quoteId(table)} s
               WHERE NOT EXISTS (
                 SELECT 1 FROM main.${quoteId(table)} t WHERE ${pkMatch}
               )`,
          )
          .get() as { c: number | bigint };
        const droppedCount = Number(dropped.c ?? 0);
        if (droppedCount > 0) droppedRows[table] = droppedCount;
      }

      // 确认窗只让用户裁决「对话归属」,没有征求「把 local 模式的自动化任务在新
      // 账号下跑起来」——认领后 bootstrap 紧接着启动 scheduler,到点的任务会带着
      // 刚搬过去的凭证自动执行 agent / 脚本(codex review)。导入即暂停,用户想要
      // 哪条自己去开;账号库原有的任务(上面记进临时表的那些)一律不动。
      if (canPauseSchedules) {
        pausedSchedules = Number(
          db
            .prepare(
              `UPDATE main.${quoteId(SCHEDULES_TABLE)} SET status = 'paused'
                 WHERE status <> 'paused'
                   AND id IN (SELECT id FROM ${SOURCE_SCHEMA}.${quoteId(SCHEDULES_TABLE)})
                   AND id NOT IN (SELECT id FROM temp.${quoteId(PRE_EXISTING_SCHEDULES_TABLE)})`,
            )
            .run().changes,
        );
      }

      db.prepare(`DROP TABLE IF EXISTS temp.${quoteId(PRE_EXISTING_SCHEDULES_TABLE)}`).run();
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

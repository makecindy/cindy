/**
 * Schema-drift detector (#37) —— 只检测不修复。
 *
 * 工作原理:对 `migration_history` 表里每条 already-applied 的 migration,
 * 重算磁盘上 `NNNN_xxx.sql` 文件的 sha256,跟记录的 hash 比对。
 *
 * 三种顶层状态:
 *   - `clean`     全部 hash 匹配,没漂
 *   - `drifted`   某条已 applied 的 migration sql 文件内容跟当时不一样
 *                 (典型:多人协作分支冲突后被 main 重排,本地 schema_version 已推进
 *                  但物理表实际没跑过新版本 sql)
 *   - `unknown`   migration_history 缺失或检测过程失败,无法确认是否 clean
 *
 * `missing` 是 drifted entries 的 kind,表示某条已 applied 的 migration sql
 * 文件在磁盘上找不到了(典型:branch reset / 用户手动删了文件)。
 *
 * 调用方:`ensureReady` 在 `runMigrations` 之后调用,先收敛已确认等价的历史 hash。
 * Dev 对剩余 drift 跑 `schemaDriftRepair`;release 对剩余 drift 只 log + toast。
 *
 * 本模块不会修任何东西、不会写 DB、不依赖 drizzle schema —— 纯只读检测。
 * 任何抛错都被 catch 住,降级返回 `unknown`(让启动流程继续,但日志不能伪装成 clean)。
 */

import type Database from 'better-sqlite3';
import type { DbLogger } from './logging.js';

import {
  type DriftEntry,
  type DriftReport,
  type DriftStatus,
  detectSchemaDriftInDir,
} from './schemaDriftCore';



export type { DriftEntry, DriftReport, DriftStatus };


export function createSchemaDriftDetector(getDrizzleDir: () => string, log: DbLogger) {
function detectSchemaDrift(db: Database.Database): DriftReport {
  let drizzleDir: string;
  try {
    drizzleDir = getDrizzleDir();
  } catch (err) {
    log.warn(
      JSON.stringify({
        event: 'schema-drift-detector.resolveDirFailed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { status: 'unknown', entries: [] };
  }

  return detectSchemaDriftInDir(db, drizzleDir, (warning) => {
    if (warning.kind === 'queryFailed') {
      log.warn(
        JSON.stringify({
          event: 'schema-drift-detector.queryFailed',
          error: warning.error instanceof Error ? warning.error.message : String(warning.error),
        }),
      );
      return;
    }
    log.warn(
      JSON.stringify({
        event: 'schema-drift-detector.hashFailed',
        fileName: warning.fileName,
        error: warning.error instanceof Error ? warning.error.message : String(warning.error),
      }),
    );
  });
}

return { detectSchemaDrift };
}

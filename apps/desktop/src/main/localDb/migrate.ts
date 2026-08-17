/**
 * chat-data-localization F3：本地 db schema 迁移协调（drizzle-kit 自动生成 SQL）。
 *
 * 流程：
 *   1. 读 `migration_meta.schema_version` 当前版本
 *   2. 扫描 drizzle 目录中的 `NNNN_xxx.sql`，过滤出待 apply 的（seq > current）
 *   3. apply 前先做磁盘准备（腾旧备份预算 + 剩余空间预检，见 `prepareBackupDiskSpace`），
 *      再用 `backupDb` 在线备份 → `.bak.{ISO}`（失败 throw 阻断，报错带磁盘状况）
 *   4. 单事务内：执行 SQL → 可选执行同名 TS 脚本（必须导出 `run(db)` 且幂等）→ 写新 `schema_version`
 *   5. 任一 migration apply 失败 → 关闭当前 db 连接 + 用本次 apply 前的 `.bak.{ISO}`
 *      覆盖回主 db 文件，再 throw（让上层 `ensureReady` 弹对话框）—— 对多条 migration
 *      扩展后的中间版本状态同样生效
 *   6. 全部 apply 完后调用 `pruneIsoBackupsToBudget` 清理 `.bak.{ISO}`——"份数 +
 *      总体积"双上限，大库自动少留份数（不触碰 `.bak.clean`，ADR-FE9）
 */

import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { app } from 'electron';
import { createLogger } from '../logger';
import {
  backupDb,
  estimateDbSizeBytes,
  getFreeDiskBytes,
  isoBackupTotalBudgetBytes,
  pruneIsoBackupsToBudget,
} from './backup';
import {
  hashMigrationFile,
  listPendingMigrations,
  readSchemaVersion,
  runMigrationReplay,
} from './migrationRunner';
import {
  officialProfileWriterMigrationMessage,
  shouldRefuseOfficialProfileWriterMigration,
} from './officialProfileMigrationPolicy';

const log = createLogger('migrate');

export { hashMigrationFile };

export function getDrizzleDir(): string {
  return resolveDrizzleDir();
}

const MAX_ISO_BACKUPS = 3;

/**
 * 解析 drizzle 目录路径：
 *   - packaged：`process.resourcesPath/drizzle`（forge.config.ts extraResource 配置）
 *   - dev：源码工作目录 `<projectRoot>/apps/desktop/drizzle`
 *
 * vite 把 main 入口产物输出到 `<workspace>/.vite/build/index.js`，运行时 `__dirname`
 * 指向该目录；从那里向上回退到工作根目录再加 `drizzle/`。
 */
function resolveDrizzleDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'drizzle');
  }
  // dev：__dirname = <repo>/apps/desktop/.vite/build → ../../drizzle
  return path.resolve(__dirname, '../../drizzle');
}

export async function runMigrations(
  db: Database.Database,
  dbFilePath: string,
): Promise<void> {
  const drizzleDir = resolveDrizzleDir();
  log.info(
    JSON.stringify({
      event: 'localDb.migrate.start',
      drizzleDir,
      isPackaged: app.isPackaged,
      dbFilePath,
    }),
  );
  if (!fs.existsSync(drizzleDir)) {
    throw new Error(`drizzle 目录不存在：${drizzleDir}`);
  }

  const currentVersion = readSchemaVersion(db);
  const pending = listPendingMigrations(drizzleDir, currentVersion);
  log.info(
    JSON.stringify({
      event: 'localDb.migrate.scan',
      currentVersion,
      pendingCount: pending.length,
      pending: pending.map((m) => ({ seq: m.seq, fileName: m.fileName, hasTsScript: !!m.tsScriptPath })),
    }),
  );
  if (pending.length === 0) {
    log.info(
      JSON.stringify({ event: 'localDb.migrate.upToDate', currentVersion }),
    );
    return;
  }
  if (
    shouldRefuseOfficialProfileWriterMigration({
      isPackaged: app.isPackaged,
      officialSharedProfile: process.env.XDT_OFFICIAL_SHARED_PROFILE === '1',
      pendingCount: pending.length,
    })
  ) {
    throw new Error(
      officialProfileWriterMigrationMessage(pending.map((migration) => migration.fileName)),
    );
  }

  // 备份前先做磁盘侧准备：腾旧备份预算 + 剩余空间预检。
  // 背景（2026-07 用户现场）：旧流程只在迁移成功后清理旧备份——一旦备份把磁盘
  // 吃满，下次启动"备份失败 → 阻断启动"，而能清理的代码永远走不到，死锁只能
  // 靠用户手动删文件解开。现在每次备份前先清理，失败路径也能自愈。
  const diskHint = prepareBackupDiskSpace(dbFilePath);

  // 备份失败 → throw 阻断启动（开战前的备份步骤失败，不进入后续任何 apply）
  const backupResult = await backupDb(db, dbFilePath);
  if (backupResult === null) {
    throw new Error(`schema migration 前的备份失败，阻断启动${diskHint}`);
  }
  // 'NO_DB_TO_BACKUP' 表示首次启动 db 文件不存在 —— 没有数据可丢，继续。
  // 此时 backupResult 不是 string，无法回滚——但也无需回滚，因为没有旧数据。
  const backupPath = typeof backupResult === 'string' ? backupResult : null;
  log.info(
    JSON.stringify({
      event: 'localDb.migrate.backup',
      backupPath: backupPath ?? '<no-db-to-backup>',
    }),
  );

  try {
    runMigrationReplay(db, {
      drizzleDir,
      currentVersion,
      onMigrationStart: (m) => {
        log.info(
          JSON.stringify({
            event: 'localDb.migrate.apply.begin',
            seq: m.seq,
            fileName: m.fileName,
            hasTsScript: !!m.tsScriptPath,
          }),
        );
      },
      onMigrationApplied: (m, durationMs) => {
        log.info(
          JSON.stringify({
            event: 'localDb.migrate.apply.ok',
            seq: m.seq,
            fileName: m.fileName,
            durationMs,
          }),
        );
      },
      onMigrationHistoryWriteFailed: (failure) => {
        log.warn(
          JSON.stringify({
            event: 'localDb.migrate.history.writeFailed',
            seq: failure.seq,
            fileName: failure.fileName,
            error: failure.error instanceof Error ? failure.error.message : String(failure.error),
          }),
        );
      },
    });
  } catch (err) {
    log.error(
      JSON.stringify({
        event: 'localDb.migrate.apply.failed',
        message: err instanceof Error ? err.message : String(err),
        backupPath,
      }),
    );
    // F3 验收条件：apply 失败 → 自动用本次 apply 前的备份回滚 db 文件。
    // 事务 DDL rollback 只保证单次 SQL 级别；物理 db 文件若中途被破坏
    // （以及多条 migration 扩展后的中间版本状态）仍需 fallback 到备份文件。
    if (backupPath) {
      restoreDbFromBackup(db, dbFilePath, backupPath, err);
    }
    throw err;
  }

  // F3 V0.4：仅清理 .bak.{ISO}，.bak.clean 配额完全独立
  pruneMigrationBackupsToBudget(dbFilePath);
  log.info(
    JSON.stringify({
      event: 'localDb.migrate.done',
      finalVersion: pending[pending.length - 1].seq,
      applied: pending.length,
    }),
  );
}

/** 磁盘预检时在 db 本体之外额外要求的余量（WAL 增长 / 迁移临时空间）。 */
const BACKUP_DISK_MARGIN_BYTES = 256 * 1024 * 1024; // 256MB

function formatGB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}

/**
 * 迁移备份前的磁盘准备（自愈路径，绝不 throw）：
 *   1. 先按"体积预算 - 即将新增的一份"裁剪旧 `.bak.{ISO}`（份数上限也减 1）
 *   2. 剩余空间仍不足"db 大小 + 余量"→ 把旧 ISO 备份全部清掉再检查
 *   3. 依旧不足也不在这里拦——继续交给 backupDb 实际尝试（statfs 可能不准），
 *      只把磁盘状况拼成 hint 字符串，供备份失败时的报错带上，用户能看懂原因
 *
 * @returns 空串（空间充足/未知）或形如"（磁盘剩余 X，备份约需 Y…）"的报错附注
 */
export function prepareBackupDiskSpace(dbFilePath: string): string {
  const dbSize = estimateDbSizeBytes(dbFilePath);
  if (dbSize === 0) return ''; // 首次启动无库可备份
  const budget = isoBackupTotalBudgetBytes(dbSize);

  // 即将写入一份 ≈ dbSize 的新备份：老备份的可用预算 = 总预算 - 新份额
  // keepNewest: true 确保至少保留最新一份作为 SQLITE_CORRUPT 恢复防线
  pruneIsoBackupsToBudget(dbFilePath, {
    maxCount: MAX_ISO_BACKUPS - 1,
    maxTotalBytes: Math.max(budget - dbSize, 0),
    keepNewest: true,
  });

  const needed = dbSize + BACKUP_DISK_MARGIN_BYTES;
  const dir = path.dirname(dbFilePath);
  let free = getFreeDiskBytes(dir);
  if (free !== null && free < needed) {
    // 空间不够 → 旧 ISO 备份让位，但保留最新一份作为 SQLITE_CORRUPT 恢复防线
    const removed = pruneIsoBackupsToBudget(dbFilePath, {
      maxCount: 0,
      maxTotalBytes: 0,
      keepNewest: true,
    });
    free = getFreeDiskBytes(dir) ?? free;
    log.warn(
      JSON.stringify({
        event: 'localDb.migrate.diskLow',
        neededBytes: needed,
        freeBytes: free,
        removedOldBackups: removed.length,
      }),
    );
  }
  if (free !== null && free < needed) {
    return `（磁盘空间不足：剩余 ${formatGB(free)}，备份约需 ${formatGB(needed)}；已自动清理旧备份仍不足，请清理磁盘后重新启动。数据目录：${dir}）`;
  }
  return '';
}

/** migration / schema repair 完成后共用的 ISO 备份配额轮转。 */
export function pruneMigrationBackupsToBudget(dbFilePath: string): string[] {
  return pruneIsoBackupsToBudget(dbFilePath, {
    maxCount: MAX_ISO_BACKUPS,
    maxTotalBytes: isoBackupTotalBudgetBytes(estimateDbSizeBytes(dbFilePath)),
  });
}

/**
 * migration apply 失败后的 db 文件回滚：
 *   1. 关闭当前已半迁移/损坏的 db 连接（避免持锁阻止 copy）
 *   2. 用 apply 前的备份覆盖回主 db 文件
 *   3. 若 copy back 再次失败，也 throw——不要静默吞错
 *
 * 注意：调用方（`runMigrations` catch 分支）会在本函数返回后重新 throw 原始
 * migration 错误，由上层 `ensureReady` catch 弹对话框；即便本函数抛出新的
 * restore 错误，也会取代原错误冒泡到 `ensureReady`——都会走到 MIGRATE_FAILED
 * 对话框路径。
 */
function restoreDbFromBackup(
  db: Database.Database,
  dbFilePath: string,
  backupPath: string,
  originalErr: unknown,
): void {
  try {
    db.close();
  } catch (closeErr) {
    // close 失败不影响后续 copy——better-sqlite3 close 幂等，记录即可
    log.warn('[localDb] migrate rollback: db.close() failed', closeErr);
  }
  try {
    fs.copyFileSync(backupPath, dbFilePath);
    log.warn(
      JSON.stringify({
        event: 'migrate_rollback.ok',
        backupPath,
        dbFilePath,
        originalErr: String(originalErr),
      }),
    );
  } catch (copyErr) {
    // 备份覆盖回主文件失败——此时 db 文件可能处于半迁移损坏状态、
    // 但备份文件本身仍在磁盘上，SQLITE_CORRUPT 回落路径下次启动时还能兜住。
    log.error(
      JSON.stringify({
        event: 'error.migrate_rollback_copy_failed',
        backupPath,
        dbFilePath,
        originalErr: String(originalErr),
        copyErr: String(copyErr),
      }),
    );
    throw new Error(
      `schema migration 失败后的备份回滚也失败：${String(copyErr)}（原始错误：${String(originalErr)}）`,
    );
  }
}

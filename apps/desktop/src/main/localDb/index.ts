/**
 * chat-data-localization F1/F5：本地 SQLite 引擎入口（main 进程独占）。
 *
 * 职责：
 *   - 按 userId 切换 db 文件（`<dbFilePrefix>-{userId}.db` 在 userData 目录下）
 *   - SQLITE_CORRUPT 自动回落（向后兼容旧 `.bak.clean` → `.bak.{ISO}`,详见下）
 *   - 跑 schema migration（`migrate.ts`）
 *   - 暴露 `closeDb()` 供 main/index.ts 通过 lifecycle 注册到退出流程
 *   - 暴露 `getDrizzle()` / `getRawDb()` 给 IPC handlers
 *
 * 切账号语义：`logout` / 切到不同 userId 时调用 `closeDb()`，下次 `ensureReady` 重开新 db；不能跨账号串库。
 *
 * ── ADR-FE7 修订（cleanExitSnapshot 移除）─────────────────────────────────────
 * 原 ADR-FE7 在 before-quit 时跑 `runCleanExitSnapshot`（db.backup → .bak.clean）,
 * 现已移除。理由（参考 commit history + codex desktop 对照）:
 *   - db.backup 是 SQLite 页级 IO,耗时跟 db 体积线性相关（347MB → ~3.7s）,
 *     是退出体感慢的最大物理瓶颈,且会随 db 膨胀持续恶化
 *   - 容灾改由 SQLite WAL crash recovery 兜底（WAL 模式下进程任何方式退出,
 *     已 commit 事务都能在下次启动 recover）—— 业界主流方案（VSCode/Slack/codex 同款）
 *
 * SQLITE_CORRUPT 时仍走 `tryRestoreWithFallback`: 已存在的 `.bak.clean` 文件（来自
 * 老版本退出）仍作为 Step 1 兜底;新版本不再 refresh 它,只回落到 `.bak.{ISO}`
 * （schema migration 时生成,较陈旧）作为最后保障。
 */

import type Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { app, dialog, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';

import { createBetterSqliteDatabase } from './betterSqliteFactory';
import { ensureCjkFtsTempTriggersInstalled } from './registerCjkSeg';
import {
  getDrizzleDir,
  prepareBackupDiskSpace,
  pruneMigrationBackupsToBudget,
  runMigrations,
} from './migrate';
import { tryRestoreWithFallback, backupDb, restrictLegacyBackupPermissions } from './backup';
import { detectSchemaDrift } from './schemaDriftDetector';
import { repairSchemaDriftWithBackup } from './schemaDriftRepair';
import { reconcileKnownEquivalentMigrationHashes } from './schemaDriftCompatibility';
import { cleanupStaleOrcaLeadIndex, hasStaleOrcaLeadIndex } from './orcaStaleIndexCleanup';
import { reconcileStrandedOrcaLeads } from './orcaStrandedLeadReconcile';
import { initializeCodexHistoryPromptState } from './codexHistoryPromptInit';
import { dialogueWorkspaceRootDir } from './dialogueWorkspace';
import { repairManagedDialogueWorkspaceSessions } from './managedDialogueWorkspaceRepair';
import * as schema from './schema';
import { loadSqliteVec, resetSqliteVecState } from './sqliteVecLoader';
import {
  checkMigrationCompatibility,
  prepareMigrationRuntimeManifest,
  readSchemaVersion,
} from './migrationRunner';
import {
  acquireSchemaStartupLease,
  SchemaMigrationReaderLeaseLifecycle,
  type SchemaMigrationLease,
} from './schemaMigrationLease';
import { runSchemaStartupPolicy } from './schemaStartupPolicy';
import {
  buildPackagedReadOnlyCompatibilityMessage,
  buildSharedDbCompatibilityMessage,
} from './sharedDbCompatibilityMessage';
import { shouldShowNativeFatalDialog, type EnsureReadyErrorCode } from './fatalDialogPolicy';
import { runPendingDbSlimmingAtStartup } from './dbSlimmingStartup';
import { deferReleaseUntilDbSlimmingWorkerTermination } from './dbSlimmingWorkerClient';

import { createLogger } from '../logger';
import { recordDesktopDevLocalDbStartupResult } from '../devStartupStatus';
import { t } from '../i18n';

const log = createLogger('localDb');

let _db: Database.Database | null = null;
let _drizzle: BetterSQLite3Database<typeof schema> | null = null;
let _currentUserId: string | null = null;
let _currentDbPath: string | null = null;
let _optimizeTimer: NodeJS.Timeout | null = null;
const schemaMigrationReaderLeaseLifecycle = new SchemaMigrationReaderLeaseLifecycle();

// PRAGMA optimize 周期 (SQLite 官方对长连接的推荐: 启动一次 + 周期一次 + 关闭前一次)
const OPTIMIZE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function getDrizzle(): BetterSQLite3Database<typeof schema> {
  if (!_drizzle) {
    throw new Error('localDb not ready: call ensureReady(userId) first');
  }
  return _drizzle;
}

export function getRawDb(): Database.Database {
  if (!_db) {
    throw new Error('localDb not ready');
  }
  return _db;
}

export function getCurrentDbPath(): string | null {
  return _currentDbPath;
}

export function getCurrentUserId(): string | null {
  return _currentUserId;
}

function dbPath(userId: string): string {
  return path.join(app.getPath('userData'), `${BRAND_IDENTITY.dbFilePrefix}-${userId}.db`);
}

export function getDbPathForUser(userId: string): string {
  return dbPath(userId);
}

export type EnsureReadyResult =
  | { ready: true }
  | {
      ready: false;
      error: {
        code: EnsureReadyErrorCode;
        message: string;
      };
    };

/**
 * 按 userId 准备本地 db。
 *
 * - 同一 userId 已就绪 → 直接 return
 * - 切到不同 userId → 先 closeDb 再开新文件
 * - SQLITE_CORRUPT → 走 `tryRestoreWithFallback` 两级回落；恢复成功后通知所有渲染窗显示 toast
 * - 任何不可恢复故障 → 弹 OS 对话框 + return `{ ready: false, error }`，由 renderer 阻断 navigate
 */
export async function ensureReady(userId: string): Promise<EnsureReadyResult> {
  if (!userId || typeof userId !== 'string') {
    return { ready: false, error: { code: 'DB_INIT_FAILED', message: 'invalid userId' } };
  }

  if (_currentUserId === userId && _db) {
    log.info(
      JSON.stringify({ event: 'localDb.ensureReady.already', userId, dbPath: _currentDbPath }),
    );
    return { ready: true };
  }

  if (_currentUserId && _currentUserId !== userId) {
    log.info(
      JSON.stringify({
        event: 'localDb.ensureReady.switchUser',
        from: _currentUserId,
        to: userId,
      }),
    );
    closeDb();
  }

  const filePath = dbPath(userId);
  const passiveSharedUserData = !app.isPackaged && process.env.XDT_PASSIVE_SHARED_USER_DATA === '1';
  // A packaged release may be launched while a shared passive dev instance is still
  // open.  The passive reader lease must continue to block schema writes, but an
  // already-compatible database does not need any startup DDL; let the release use
  // the existing schema in read-only startup mode instead of failing before opening
  // the database.  If compatibility is not exact, the policy below still fails
  // closed and the user gets the normal update/isolated recovery path.
  let startupWriterLease: SchemaMigrationLease | null = null;
  let readerLeaseAcquiredThisCall = false;

  const startupLease = acquireSchemaStartupLease({
    dbFilePath: filePath,
    packaged: app.isPackaged,
    sharedPassive: passiveSharedUserData,
    readerLifecycle: schemaMigrationReaderLeaseLifecycle,
  });
  if (!startupLease.acquired) {
    const readerHint = startupLease.activeReaderCount
      ? `（当前有 ${startupLease.activeReaderCount} 个 passive 实例）`
      : '';
    const waitingForWriter = startupLease.reason === 'writer-active';
    const message = waitingForWriter
      ? '另一个实例正在执行数据库 schema migration，当前实例无法同时启动维护。请等待迁移完成后重试，或改用 --isolated 启动独立数据。'
      : `当前不能执行数据库 schema 启动维护${readerHint}。` +
        '请先关闭共享该 userData 的 passive dev 后重试，或让这些实例使用 --isolated。';
    showFatalDialog(
      waitingForWriter ? '数据库 schema 正在维护' : '数据库 schema 正被其它实例使用',
      message,
      'MIGRATE_FAILED',
    );
    return { ready: false, error: { code: 'MIGRATE_FAILED', message } };
  }
  const schemaMaintenanceReadOnly = startupLease.kind === 'reader' && !passiveSharedUserData;
  readerLeaseAcquiredThisCall = startupLease.kind === 'reader' && startupLease.newlyAcquired;
  if (startupLease.kind === 'writer') startupWriterLease = startupLease.lease;

  const releaseSchemaLeasesAfterFailure = (error?: unknown): void => {
    if (startupWriterLease) {
      const heldWriterLease = startupWriterLease;
      if (!deferReleaseUntilDbSlimmingWorkerTermination(error, () => heldWriterLease.release())) {
        heldWriterLease.release();
      }
      startupWriterLease = null;
    }
    if (readerLeaseAcquiredThisCall) {
      schemaMigrationReaderLeaseLifecycle.release();
    }
  };
  log.info(
    JSON.stringify({
      event: 'localDb.ensureReady.open',
      userId,
      dbPath: filePath,
      exists: fs.existsSync(filePath),
    }),
  );

  let maintenance: Awaited<ReturnType<typeof runPendingDbSlimmingAtStartup>>;
  try {
    maintenance = await runPendingDbSlimmingAtStartup({
      userDataDir: app.getPath('userData'),
      dbFilePath: filePath,
      ownerId: userId,
      leaseKind: startupLease.kind,
      loadVectorExtension: (maintenanceDb) => loadSqliteVec(maintenanceDb).loaded,
      log,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = t('localDbFatal.databaseCleanup.interruptedDescription');
    log.error('database cleanup startup failed unexpectedly', { detail });
    releaseSchemaLeasesAfterFailure(error);
    showFatalDialog(t('localDbFatal.databaseCleanup.interruptedTitle'), message, 'MIGRATE_FAILED');
    return { ready: false, error: { code: 'MIGRATE_FAILED', message } };
  }
  if (maintenance.handled && startupLease.kind === 'writer') {
    resetSqliteVecState();
  }
  if (!maintenance.originalDatabaseReady) {
    const message = t('localDbFatal.databaseCleanup.recoveryFailedDescription');
    showFatalDialog(
      t('localDbFatal.databaseCleanup.recoveryFailedTitle'),
      message,
      'DB_CORRUPT_NO_BACKUP',
    );
    releaseSchemaLeasesAfterFailure();
    return { ready: false, error: { code: 'DB_CORRUPT_NO_BACKUP', message } };
  }

  try {
    _db = openWithPragmas(filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errCode = (err as { code?: string }).code ?? '';
    if (errCode === 'SQLITE_CORRUPT' || /corrupt/i.test(message)) {
      if (passiveSharedUserData || schemaMaintenanceReadOnly) {
        const readOnlyStartupMessage =
          '共享数据库当前由其它实例使用，Cindy 不会在其运行期间自动恢复或修改 schema。' +
          '请关闭共享该 userData 的 passive 实例后重试，或改用 --isolated。';
        showFatalDialog('共享数据库无法恢复', readOnlyStartupMessage, 'DB_CORRUPT_NO_BACKUP');
        releaseSchemaLeasesAfterFailure();
        return {
          ready: false,
          error: { code: 'DB_CORRUPT_NO_BACKUP', message: readOnlyStartupMessage },
        };
      }
      const restored = tryRestoreWithFallback(filePath);
      if (!restored) {
        showFatalDialog('数据库损坏且无可用备份', message, 'DB_CORRUPT_NO_BACKUP');
        releaseSchemaLeasesAfterFailure();
        return { ready: false, error: { code: 'DB_CORRUPT_NO_BACKUP', message } };
      }
      try {
        _db = openWithPragmas(filePath);
      } catch (reopenErr) {
        const reopenMsg = reopenErr instanceof Error ? reopenErr.message : String(reopenErr);
        showFatalDialog('数据库恢复后仍无法打开', reopenMsg, 'DB_CORRUPT_NO_BACKUP');
        releaseSchemaLeasesAfterFailure();
        return { ready: false, error: { code: 'DB_CORRUPT_NO_BACKUP', message: reopenMsg } };
      }
      // 通知所有渲染窗一次性 toast（M-FE6 useCorruptionRestoredToast 消费）
      const payload = {
        source: restored.source,
        backupMtime: restored.mtime.toISOString(),
      };
      for (const w of BrowserWindow.getAllWindows()) {
        try {
          w.webContents.send('local-db:corruption-restored', payload);
        } catch {
          /* renderer 已销毁等 */
        }
      }
    } else {
      showFatalDialog('无法初始化本地数据库', message, 'DB_INIT_FAILED');
      releaseSchemaLeasesAfterFailure();
      return { ready: false, error: { code: 'DB_INIT_FAILED', message } };
    }
  }

  const db = _db;
  if (!db) {
    const message = 'localDb connection missing after open';
    showFatalDialog('无法初始化本地数据库', message, 'DB_INIT_FAILED');
    releaseSchemaLeasesAfterFailure();
    return { ready: false, error: { code: 'DB_INIT_FAILED', message } };
  }

  _drizzle = drizzle(db, { schema });
  _currentUserId = userId;
  _currentDbPath = filePath;
  // 安全加固：收紧既有备份文件权限（老版本生成的 .bak.* / .bak.clean 可能保持 umask 默认的 0644）
  restrictLegacyBackupPermissions(filePath);

  // sqlite-vec 向量扩展必须先于 migration 加载:
  // 0034_add_chat_embedding_vec.sql 用 `CREATE VIRTUAL TABLE ... USING vec0(...)`,
  // 加载顺序反了会在迁移阶段抛 "no such module: vec0"。
  // 加载本身非 fatal —— 失败只记日志,app 仍可启动(用到 vec0 的 migration / 业务自然会报错)。
  const vecResult = loadSqliteVec(db);
  if (vecResult.loaded) {
    log.info(JSON.stringify({ event: 'localDb.sqliteVec.loaded', version: vecResult.version }));
  } else {
    log.error(
      JSON.stringify({
        event: 'localDb.sqliteVec.failed',
        error: vecResult.error,
        platform: process.platform,
        arch: process.arch,
        expectedPath: vecResult.expectedPath,
      }),
    );
  }

  try {
    const schemaStartup = await runSchemaStartupPolicy({
      sharedPassive: passiveSharedUserData,
      readOnly: schemaMaintenanceReadOnly,
      checkCompatibility: () => checkMigrationCompatibility(db, getDrizzleDir(), filePath),
      checkReadOnlyInvariants: () => ({ compatible: !hasStaleOrcaLeadIndex(db) }),
      prepareRuntimeManifest: () => {
        const prepared = prepareMigrationRuntimeManifest(
          filePath,
          getDrizzleDir(),
          readSchemaVersion(db),
        );
        if (prepared.bootstrappedLegacyBaseline) {
          log.warn(
            JSON.stringify({
              event: 'localDb.migrationRuntimeManifest.legacyBaselineBootstrapped',
              userId,
              dbPath: filePath,
            }),
          );
        }
      },
      runMigrations: () => runMigrations(db, filePath),
      handleSchemaDrift: () => handleSchemaDrift(filePath),
      cleanupSchemaDdl: () => cleanupStaleOrcaLeadIndex(db),
    });
    if (!schemaStartup.ready) {
      const compatibility = schemaStartup.compatibility;
      const message = schemaMaintenanceReadOnly
        ? buildPackagedReadOnlyCompatibilityMessage(compatibility)
        : buildSharedDbCompatibilityMessage(compatibility);
      log.error(
        JSON.stringify({
          event: schemaMaintenanceReadOnly
            ? 'localDb.ensureReady.packagedReadOnlyCompatibilityMismatch'
            : 'localDb.ensureReady.passiveMigrationMismatch',
          userId,
          dbPath: filePath,
          databaseVersion: compatibility.databaseVersion,
          checkoutVersion: compatibility.checkoutVersion,
          issues: compatibility.issues,
        }),
      );
      closeDb({ preserveSchemaMigrationLease: !readerLeaseAcquiredThisCall });
      showFatalDialog(
        schemaMaintenanceReadOnly ? '安装版无法打开本地数据' : '当前开发版与本地数据版本不兼容',
        message,
        'MIGRATE_FAILED',
      );
      return { ready: false, error: { code: 'MIGRATE_FAILED', message } };
    }
    if (schemaStartup.compatibility) {
      log.info(
        JSON.stringify({
          event: schemaMaintenanceReadOnly
            ? 'localDb.ensureReady.packagedReadOnlyCompatible'
            : 'localDb.ensureReady.passiveMigrationCompatible',
          userId,
          dbPath: filePath,
          schemaVersion: schemaStartup.compatibility.databaseVersion,
        }),
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      JSON.stringify({
        event: 'localDb.ensureReady.migrateFailed',
        userId,
        dbPath: filePath,
        message,
      }),
    );
    closeDb({ preserveSchemaMigrationLease: !readerLeaseAcquiredThisCall });
    showFatalDialog('本地数据库 schema 迁移失败', message, 'MIGRATE_FAILED');
    return { ready: false, error: { code: 'MIGRATE_FAILED', message } };
  } finally {
    startupWriterLease?.release();
    startupWriterLease = null;
  }

  try {
    const repaired = repairManagedDialogueWorkspaceSessions(db, dialogueWorkspaceRootDir());
    if (repaired > 0) {
      log.info(
        JSON.stringify({
          event: 'localDb.ensureReady.managedDialogueWorkspaceRepair',
          userId,
          dbPath: filePath,
          repaired,
        }),
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      JSON.stringify({
        event: 'localDb.ensureReady.managedDialogueWorkspaceRepairFailed',
        userId,
        dbPath: filePath,
        message,
      }),
    );
  }

  try {
    initializeCodexHistoryPromptState(db);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      JSON.stringify({
        event: 'localDb.ensureReady.codexHistoryPromptInitFailed',
        userId,
        dbPath: filePath,
        message,
      }),
    );
  }

  // F-COLLAB:每次启动幂等修复「悬空 Lead」——orca_role='lead' 但已无 active team 的会话
  // (上一次关闭协同被中途打断遗留)。不修的话会被永久困在空 split view 且点 X 也关不掉,
  // 见 orcaStrandedLeadReconcile.ts。同样必须在 migration / drift-repair 之后跑(依赖 orca_teams)。
  reconcileStrandedOrcaLeads(db);

  // #3841：openWithPragmas 时三表可能还不存在（全新库），ensure 会早退。
  // migration / drift-repair 建完表后必须再收口一次，否则 in-proc 回退走这条
  // 主连接写 messages 时，持久触发器因 cjk_seg 已注册而跳过、TEMP 又不在，
  // 增量消息继续漏 FTS。已挂则是 no-op。
  ensureCjkFtsTempTriggersInstalled(db);

  // 启动 optimize: 0x10002 mask 会强制对从未 ANALYZE 过的表跑一次,
  // 之后挂 24h 周期任务按需更新统计。详见 runOptimize 注释。
  runOptimize(0x10002);
  startOptimizeSchedule();

  log.info(JSON.stringify({ event: 'localDb.ensureReady.ok', userId, dbPath: filePath }));
  return { ready: true };
}

function openWithPragmas(filePath: string): Database.Database {
  // 顺序硬约束（#3841）：`temp_store` 一旦变更会立即删除连接上所有已存在的 TEMP
  // 对象（SQLite 文档化语义），而工厂内部会注册 cjk_seg 并挂 TEMP 触发器。
  // 理想顺序是「pragma → 工厂」，但工厂承担 native binding 解析与权限收紧，
  // 不宜绕开；故保持「工厂 → pragma」，由 ensureCjkFtsTempTriggersInstalled
  // 在 pragma 清掉刚挂的触发器后重挂收口。新增 pragma 时禁止挪到收口之后。
  const db = createBetterSqliteDatabase(filePath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // 性能/并发相关 (社区生产推荐组合):
    //   synchronous=NORMAL  WAL 下安全; fsync 大幅减少, 仅掉电时可能丢最近一笔事务,
    //                       进程崩溃不丢
    //   temp_store=MEMORY   临时表/排序/中间结果走 RAM
    //   mmap_size=256MB     读热数据零拷贝, 降低系统调用开销
    //   cache_size=-65536   page cache 64MB (负值=KB)
    //   busy_timeout=5000   多 writer 时自动重试而非立刻抛 SQLITE_BUSY
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = MEMORY');
    db.pragma('mmap_size = 268435456');
    db.pragma('cache_size = -65536');
    db.pragma('busy_timeout = 5000');
    // temp_store 切换刚清掉了工厂挂的 TEMP 触发器；收口重挂（#3841）。
    ensureCjkFtsTempTriggersInstalled(db);
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      // 初始化失败后关闭连接是 best-effort，原始错误更重要。
    }
    throw err;
  }
}

/**
 * 跑一次 PRAGMA optimize, 让 query planner 拿到新鲜的索引选择性统计。
 * - mask=0x10002: 启动时强制对从未 ANALYZE 过的表跑一次 (SQLite 官方推荐启动 mask)
 * - mask 缺省:    按需 analyze, 没变化时近乎 no-op
 * 失败仅记日志, 不影响业务。
 */
function runOptimize(mask?: number): void {
  if (!_db) return;
  const t0 = performance.now();
  try {
    _db.pragma(mask !== undefined ? `optimize=${mask}` : 'optimize');
    log.info(
      JSON.stringify({
        event: 'localDb.optimize.ok',
        mask: mask ?? 'default',
        elapsedMs: Math.round(performance.now() - t0),
      }),
    );
  } catch (err) {
    log.error('PRAGMA optimize failed', err);
  }
}

function startOptimizeSchedule(): void {
  if (_optimizeTimer) return;
  _optimizeTimer = setInterval(() => runOptimize(), OPTIMIZE_INTERVAL_MS);
  // 不阻止进程退出
  _optimizeTimer.unref?.();
}

function stopOptimizeSchedule(): void {
  if (_optimizeTimer) {
    clearInterval(_optimizeTimer);
    _optimizeTimer = null;
  }
}

export interface CloseDbOptions {
  /** worker takeover 只关闭 main 连接；schema reader lease 仍由本 app 生命周期持有。 */
  preserveSchemaMigrationLease?: boolean;
}

export function closeDb(options: CloseDbOptions = {}): void {
  // 关连接前再跑一次 optimize, 把会话期内积累的统计变化落盘 (官方推荐)
  stopOptimizeSchedule();
  runOptimize();
  try {
    _db?.close();
  } catch {
    /* noop */
  }
  _db = null;
  _drizzle = null;
  _currentUserId = null;
  _currentDbPath = null;
  if (!options.preserveSchemaMigrationLease) {
    schemaMigrationReaderLeaseLifecycle.closeConnection(false);
  }
  resetSqliteVecState();
}

/**
 * #37 schema-drift 处置流程,在 runMigrations 之后调用。
 *
 * 策略分层:
 *   - 所有环境先收敛已确认 schema 等价的历史 migration hash,只更新 migration_history
 *     校验元数据,不执行 DDL、不触碰业务数据;未知 hash 不收敛。
 *   - release (`app.isPackaged`):仍有未知 drift 时只 log + 推一次性 toast 给 renderer,
 *     不自动改 schema,提示用户升级或联系支持。
 *   - dev (`!app.isPackaged`):
 *       1. 不管 migration history 是否 drift,先只读生成 schema repair plan —— 因为存量
 *          drift(0026 backfill 之前已经偏掉的)hash 检测不出来,仍需靠反射兜底
 *       2. plan 无 DDL → 不备份；plan 有 DDL → 复用 migration 的磁盘预检/配额清理，
 *          在线备份成功后才 apply，完成后再轮转配额
 *       3. repair 报 residual(改类型/删列等反射修不了的)→ 弹 dev-only 对话框让用户选 nuke
 *
 * 整个流程顶层包 try/catch,自己崩了也不阻塞启动 —— drift 处置本就是辅助路径。
 */
async function handleSchemaDrift(filePath: string): Promise<void> {
  // 捕获当前连接到局部变量:下面有 `await backupDb`,期间可能有并发 ensureReady/closeDb
  // (切账号 / 登出)把模块级 `_db` 置 null 或换成另一个连接。旧代码在 await 之后仍读
  // 模块级 `_db` 传给 repairSchemaDrift,拿到 null → 每张表崩 → 误判 residual → nuke
  // (2026-06-22 事故)。全程只认这个开工时的 db 句柄,并在 await 后校验它没被切走。
  const db = _db;
  if (!db) return;
  try {
    let drift = detectSchemaDrift(db);
    if (drift.status === 'unknown') {
      log.warn(
        JSON.stringify({
          event: 'localDb.schemaDrift.unknown',
        }),
      );
    }

    const compatibility = reconcileKnownEquivalentMigrationHashes(db, drift);
    drift = compatibility.report;
    if (compatibility.reconciled.length > 0) {
      log.warn(
        JSON.stringify({
          event: 'localDb.schemaDrift.compatibility.reconciled',
          entries: compatibility.reconciled,
        }),
      );
    }
    for (const failure of compatibility.failures) {
      log.error(
        JSON.stringify({
          event: 'localDb.schemaDrift.compatibility.failed',
          seq: failure.entry.seq,
          fileName: failure.entry.fileName,
          error: failure.error instanceof Error ? failure.error.message : String(failure.error),
        }),
      );
    }

    if (app.isPackaged) {
      if (drift.status === 'drifted') {
        log.warn(
          JSON.stringify({
            event: 'localDb.schemaDrift.release.detected',
            entries: drift.entries.map((e) => ({
              seq: e.seq,
              fileName: e.fileName,
              kind: e.kind,
            })),
          }),
        );
        const payload = {
          driftedFiles: drift.entries.map((e) => e.fileName),
        };
        for (const w of BrowserWindow.getAllWindows()) {
          try {
            w.webContents.send('local-db:schema-drift-warning', payload);
          } catch {
            /* renderer 已销毁 */
          }
        }
      }
      return;
    }

    // ─── dev 路径 ───────────────────────────────────────────────────────
    if (drift.status === 'drifted') {
      log.warn(
        JSON.stringify({
          event: 'localDb.schemaDrift.dev.detected',
          entries: drift.entries.map((e) => ({
            seq: e.seq,
            fileName: e.fileName,
            kind: e.kind,
            recordedHash: e.recordedHash,
            currentHash: e.currentHash,
          })),
        }),
      );
    }

    let diskHint = '';
    const guardedRepair = await repairSchemaDriftWithBackup(db, {
      beforeBackup: () => {
        diskHint = prepareBackupDiskSpace(filePath);
      },
      backup: async () => {
        try {
          const backupResult = await backupDb(db, filePath);
          if (typeof backupResult === 'string') {
            log.warn(
              JSON.stringify({
                event: 'localDb.schemaDrift.dev.backup.ok',
                backupPath: backupResult,
              }),
            );
          }
          return backupResult;
        } catch (err) {
          log.warn(
            JSON.stringify({
              event: 'localDb.schemaDrift.dev.backup.failed',
              error: err instanceof Error ? err.message : String(err),
            }),
          );
          return null;
        }
      },
      isConnectionCurrent: () => _db === db,
      afterApply: () => {
        pruneMigrationBackupsToBudget(filePath);
      },
    });

    if (guardedRepair.outcome === 'backup-failed') {
      log.warn(
        JSON.stringify({
          event: 'localDb.schemaDrift.dev.backup.failed',
          diskHint,
          plannedActions: guardedRepair.plan.actions.length,
        }),
      );
      return;
    }

    // await backupDb 期间若并发 ensureReady/closeDb 切走了连接,旧句柄可能已关闭或属于
    // 别的账号；放弃本轮写入，绝不能把基础设施竞态升级成 nuke 提示。
    if (guardedRepair.outcome === 'connection-changed') {
      log.warn(JSON.stringify({ event: 'localDb.schemaDrift.connectionChangedDuringDrift' }));
      return;
    }

    const repair = guardedRepair.report;

    if (repair && repair.residual.length > 0) {
      log.error(
        JSON.stringify({
          event: 'localDb.schemaDrift.dev.residual',
          residual: repair.residual,
        }),
      );
      // dev-only nuke 对话框 —— 反射修不了的 mismatch(改类型/删列/缺 NOT NULL 列)
      // 让开发者明确决策:接受 nuke 重建 / 自负风险继续。
      promptDevNukeOnResidual(filePath, repair.residual);
    }
  } catch (err) {
    log.error(
      JSON.stringify({
        event: 'localDb.schemaDrift.fatal',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * dev-only:残留 mismatch 时弹对话框让开发者选是否 nuke DB 重建。
 *
 * 同步对话框 — 这是 dev 启动期罕见路径,阻塞几秒可接受。用户选 nuke:
 *   1. 关 db 连接
 *   2. 把 dbFile 重命名为 .bak.nuke-{ISO} (永远保留,不进 .bak.{ISO} 配额)
 *   3. 提示用户重启 app(下次启动 ensureReady 会建空库 + 跑全套 migration)
 *
 * 用户选 ignore:继续启动,大概率撞 SqliteError 在业务层,但是是开发者自己的选择。
 */
function promptDevNukeOnResidual(
  filePath: string,
  residual: { table: string; kind: string; detail: string }[],
): void {
  try {
    const detail = residual
      .slice(0, 10)
      .map((r) => `[${r.table}] ${r.kind} — ${r.detail}`)
      .join('\n');
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: '本地 DB schema 仍有残留不一致',
      message: '反射自愈无法修复以下不一致(改类型 / 删列 / 缺 NOT NULL 列等):',
      detail: `${detail}\n\n选「Nuke 重建」会把当前 DB 文件改名为 .bak.nuke-<时间>(永久保留),下次启动建空库重跑迁移。\n选「忽略继续」会带着不一致启动,业务层大概率会报 SqliteError —— 仅推荐用于排查。`,
      buttons: ['Nuke 重建', '忽略继续'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice !== 0) {
      log.warn(JSON.stringify({ event: 'localDb.schemaDrift.dev.nuke.declined' }));
      return;
    }
    closeDb();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const nukePath = `${filePath}.bak.nuke-${ts}`;
    fs.renameSync(filePath, nukePath);
    // WAL / SHM 边角文件也搬走(避免空库启动时被旧 WAL 串)
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${filePath}${suffix}`;
      if (fs.existsSync(sidecar)) {
        try {
          fs.renameSync(sidecar, `${nukePath}${suffix}`);
        } catch {
          /* noop */
        }
      }
    }
    log.warn(
      JSON.stringify({
        event: 'localDb.schemaDrift.dev.nuke.done',
        nukePath,
      }),
    );
    dialog.showMessageBoxSync({
      type: 'info',
      title: '本地 DB 已 nuke',
      message: `当前 DB 已重命名为:\n${nukePath}\n\n请重启应用,下次启动会建一个空库并跑全套 migration。`,
      buttons: ['好的'],
    });
    // 强制退出 —— 后续模块若继续跑会 getRawDb() 抛 not ready,体验更糟
    app.exit(0);
  } catch (err) {
    log.error(
      JSON.stringify({
        event: 'localDb.schemaDrift.dev.nuke.failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

function showFatalDialog(title: string, detail: string, code: EnsureReadyErrorCode): void {
  // showMessageBoxSync blocks the main process until a person dismisses it. Report
  // first so an agent waiting in `pnpm restart:desktop:*` receives the concrete
  // database failure without depending on UI interaction.
  recordDesktopDevLocalDbStartupResult({
    ready: false,
    error: { code, message: detail },
  });
  // MIGRATE_FAILED 由 renderer 的 LocalDbFatalScreen 全屏接管（可安装已暂存更新），
  // 不再弹阻塞式原生对话框；错误详情随 ensureReady 的 invoke reply 回渲染层。
  if (!shouldShowNativeFatalDialog(code)) {
    log.error(JSON.stringify({ event: 'localDb.fatal.rendererOwned', code, title, detail }));
    return;
  }
  try {
    dialog.showMessageBoxSync({
      type: 'error',
      title,
      message: title,
      detail: `${detail}\n\n请重启应用，或在系统资源管理器中打开数据目录手动处理。`,
      buttons: ['好的'],
      defaultId: 0,
    });
  } catch (err) {
    log.error('showFatalDialog failed', err);
  }
}

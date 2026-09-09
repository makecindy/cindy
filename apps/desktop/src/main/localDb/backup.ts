/**
 * chat-data-localization F1/F3：本地 db 文件备份与恢复（V0.4 修订 + ADR-FE7 移除）。
 *
 * 三类备份文件（互不挤压配额）:
 *   - `.bak.{ISO}` —— schema migration 前的快照，按"份数 + 总体积"双上限轮转
 *     （见 `pruneIsoBackupsToBudget` / `isoBackupTotalBudgetBytes`）。
 *   - `.bak.clean` —— 历史"干净退出快照"。**新版本不再生成**(write 路径
 *     `cleanExitSnapshot` 已移除,详见 localDb/index.ts 文件头 ADR-FE7 修订说明)。
 *     已存在的旧 `.bak.clean` 文件仍作为 SQLITE_CORRUPT 恢复的 Step 1 兜底,
 *     向后兼容老用户。新装用户磁盘上不会有这个文件。
 *   - `.slimming-backup` —— 用户主动数据库瘦身前的最近一份快照，由
 *     `maintenanceStore` 的独立索引轮换；本文件的升级配额和自动损坏恢复不读取它。
 *
 * SQLITE_CORRUPT 兜底：`.bak.clean`（若存在）优先 → `.bak.{ISO}` 回落（ADR-FE8）。
 * 主路径靠 SQLite WAL crash recovery（业界主流方案,VSCode/Slack/codex 同款）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

import { createBetterSqliteDatabase, restrictDbFilePermissions } from './betterSqliteFactory';
import { createLogger } from '../logger';

const log = createLogger('backup');

/** 仅匹配 `.bak.{ISO}`——干净退出快照 `.bak.clean` 不会命中。 */
const ISO_BACKUP_PATTERN = /\.bak\.\d{4}-\d{2}-\d{2}T/;
const CLEAN_BACKUP_SUFFIX = '.bak.clean';
const NUKE_BACKUP_INFIX = '.bak.nuke-';

// ===== .bak.{ISO} 系列（F3 schema migration 备份） =====

/**
 * 在 schema migration 前对 db 文件做在线备份快照。
 *
 * 使用 better-sqlite3 的在线备份 API（`db.backup(dest)`）——与干净退出快照
 * （`cleanExitSnapshot.ts`）保持一致，避免 WAL 模式下直接 `fs.copyFileSync`
 * 可能拷贝到不包含所有已提交 WAL 写入的旧版本文件（规格 F1 理由同此）。
 *
 * @param db 当前已打开的 db 连接（必须）。migration 流程中 db 已由
 *   `ensureReady` 打开，直接传入即可。
 * @param dbFilePath db 文件绝对路径——用于派生备份文件名，以及判断首次启动。
 * @returns
 *   - string  —— 成功，返回备份文件绝对路径
 *   - 'NO_DB_TO_BACKUP' —— 首次启动，db 文件还不存在；不算失败
 *   - null    —— 备份失败（磁盘满 / 权限被回收等）
 */
export async function backupDb(
  db: Database.Database,
  dbFilePath: string,
): Promise<string | 'NO_DB_TO_BACKUP' | null> {
  if (!fs.existsSync(dbFilePath)) return 'NO_DB_TO_BACKUP';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbFilePath}.bak.${ts}`;
  try {
    // 预先以 0o600 建文件,消除 db.backup() 写入期间的 TOCTOU 窗口(同机他人在备份
    // 进行中读取该文件);SQLite 会写入已存在的目标文件并保留其权限位。best-effort:
    // 若预建失败则回落到 db.backup() 自建 + 事后收紧。
    try {
      const fd = fs.openSync(backupPath, 'w', 0o600);
      fs.closeSync(fd);
    } catch {
      /* best-effort */
    }
    await db.backup(backupPath);
    restrictDbFilePermissions(backupPath);
    return backupPath;
  } catch (err) {
    log.error('[localDb] backupDb failed', err);
    // 清理可能残留的半写入文件——不要让失败的备份占着配额
    cleanupFailedBackupArtifacts(backupPath);
    return null;
  }
}

/**
 * 备份失败后的残留清理：半写入的备份文件本体 + better-sqlite3 在线备份产生的
 * `-journal` 文件。历史 bug：只删本体不删 journal，磁盘满时用户反复重试启动，
 * 数据目录里堆一排孤儿 `-journal`（2026-07 实际用户现场）。
 */
export function cleanupFailedBackupArtifacts(backupPath: string): void {
  for (const p of [backupPath, `${backupPath}-journal`, `${backupPath}-wal`, `${backupPath}-shm`]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* noop */
    }
  }
}

/**
 * 列出当前 db 对应的所有 `.bak.{ISO}` 文件，按 ISO 时间戳字典序升序返回。
 * 显式只接受 ISO 命名；`.bak.clean` 和 `.slimming-backup` 均不会进入升级配额。
 */
export function listIsoBackups(dbFilePath: string): string[] {
  const dir = path.dirname(dbFilePath);
  const base = path.basename(dbFilePath);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.startsWith(`${base}.bak.`) && ISO_BACKUP_PATTERN.test(f))
    .map((f) => path.join(dir, f))
    .sort(); // ISO 时间戳天然字典序
}

/** 小库场景下备份总量的保底预算——不至于把 3 份小备份也裁掉。 */
const MIN_TOTAL_BACKUP_BUDGET_BYTES = 3 * 1024 ** 3; // 3GB

/**
 * 安全加固：收紧既有备份文件权限到 0o600。
 *
 * 升级前老版本生成的 `.bak.{ISO}`、`.bak.clean` 及 dev nuke 路径产生的
 * `.bak.nuke-*` 文件可能保持 umask 默认的 0644，在 DB readiness 时一次性
 * 扫描并收紧，消除遗留文件的明文可读窗口。
 */
export function restrictLegacyBackupPermissions(dbFilePath: string): void {
  const cleanPath = getCleanBackupPath(dbFilePath);
  if (fs.existsSync(cleanPath)) {
    restrictDbFilePermissions(cleanPath);
  }
  for (const p of listIsoBackups(dbFilePath)) {
    restrictDbFilePermissions(p);
  }
  for (const p of listNukeBackups(dbFilePath)) {
    restrictDbFilePermissions(p);
  }
}

/** 列出 dev schema-drift nuke 路径生成的 `.bak.nuke-*` 文件。 */
export function listNukeBackups(dbFilePath: string): string[] {
  const dir = path.dirname(dbFilePath);
  const base = path.basename(dbFilePath);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.startsWith(`${base}${NUKE_BACKUP_INFIX}`))
    .map((f) => path.join(dir, f));
}

/**
 * `.bak.{ISO}` 系列的总体积预算：max(1.5 × 当前 db 大小, 3GB)。
 *
 * 背景（2026-07 用户现场）：db 膨胀到 13GB 后，固定"保留 3 份"的策略产生
 * 3-4 份 × 十几 GB 的备份把 C 盘吃满，反过来让下一次迁移备份失败、阻断启动。
 * 按体积设预算后，大库自动少留份数（13GB 库只留最新 1 份），小库维持 3 份不变。
 */
export function isoBackupTotalBudgetBytes(dbSizeBytes: number): number {
  return Math.max(Math.floor(dbSizeBytes * 1.5), MIN_TOTAL_BACKUP_BUDGET_BYTES);
}

/** 估算 db 落盘体积（主文件 + WAL）——备份产物尺寸与磁盘预检都以它为基准。 */
export function estimateDbSizeBytes(dbFilePath: string): number {
  let total = 0;
  for (const p of [dbFilePath, `${dbFilePath}-wal`]) {
    try {
      total += fs.statSync(p).size;
    } catch {
      /* 文件不存在（如无 WAL）→ 记 0 */
    }
  }
  return total;
}

/** 备份目录所在磁盘的剩余空间；平台/运行时不支持 statfs 时返回 null（调用方跳过预检）。 */
export function getFreeDiskBytes(dirPath: string): number | null {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const st = fs.statfsSync(dirPath);
    return st.bsize * st.bavail;
  } catch (err) {
    log.warn('[localDb] getFreeDiskBytes failed', dirPath, err);
    return null;
  }
}

/**
 * F3 V0.4 修订 + 2026-07 体积预算修订：配额清理仅作用于 `.bak.{ISO}`，
 * 不触碰 `.bak.clean`。保留策略为"份数 + 总体积"双上限：
 *   - 从最新往旧累计，超过 `maxCount` 份或累计体积超过 `maxTotalBytes` 的更旧备份删除
 *   - `keepNewest`（默认 true）：最新一份永远保留，即使单份就超预算——它是
 *     SQLITE_CORRUPT 恢复与迁移回滚的最后防线
 *   - `keepNewest: false` 用于"迁移备份前腾预算"场景：马上要写入一份全新备份，
 *     老备份全部纳入预算裁剪（必要时可清空）
 *
 * @returns 实际删除的备份文件路径列表（给日志/测试用）
 */
export function pruneIsoBackupsToBudget(
  dbFilePath: string,
  opts: { maxCount: number; maxTotalBytes: number; keepNewest?: boolean },
): string[] {
  const keepNewest = opts.keepNewest !== false;
  const all = listIsoBackups(dbFilePath); // 升序：最旧在前
  const removed: string[] = [];
  let keptCount = 0;
  let keptBytes = 0;
  // 从最新往旧决定去留
  for (let i = all.length - 1; i >= 0; i--) {
    const p = all[i];
    let size = 0;
    try {
      size = fs.statSync(p).size;
    } catch {
      /* stat 失败按 0 计——宁可多留不误删 */
    }
    const isNewest = i === all.length - 1;
    const withinBudget =
      keptCount < opts.maxCount && keptBytes + size <= opts.maxTotalBytes;
    if ((isNewest && keepNewest) || withinBudget) {
      keptCount += 1;
      keptBytes += size;
      continue;
    }
    try {
      fs.unlinkSync(p);
      removed.push(p);
    } catch (err) {
      log.warn('[localDb] pruneIsoBackupsToBudget failed for', p, err);
    }
  }
  if (removed.length > 0) {
    log.info(
      JSON.stringify({
        event: 'localDb.backup.pruned',
        removedCount: removed.length,
        removed: removed.map((p) => path.basename(p)),
        keptCount,
        keptBytes,
      }),
    );
  }
  return removed;
}

// ===== .bak.clean（F1 V0.4 干净退出快照） =====

export function getCleanBackupPath(dbFilePath: string): string {
  return `${dbFilePath}${CLEAN_BACKUP_SUFFIX}`;
}

// ===== 两级回落恢复 =====

export interface RestoreResult {
  source: 'clean' | 'iso';
  /** 被使用的备份文件 mtime，渲染层 toast 显示用。 */
  mtime: Date;
}

/**
 * V0.4 SQLITE_CORRUPT 两级回落（ADR-FE8）：
 *   Step 1: `.bak.clean` 优先（最近一次干净退出快照，已被 quick_check 把关）
 *   Step 2: 回落到最新 `.bak.{ISO}`
 *   Step 3: 都不可用 → return null（调用方阻断启动 + 弹 OS 对话框）
 *
 * 主动瘦身备份不参与这条自动恢复链，避免把用户选择的历史截面
 * 误当成 schema migration 的可兼容回滚点。
 *
 * 每一级恢复后会用 better-sqlite3 试只读打开 + quick_check 验证；打不开则继续下一级。
 */
export function tryRestoreWithFallback(dbFilePath: string): RestoreResult | null {
  // Step 1: .bak.clean 优先
  const cleanPath = getCleanBackupPath(dbFilePath);
  if (fs.existsSync(cleanPath)) {
    if (tryRestoreFrom(cleanPath, dbFilePath)) {
      return { source: 'clean', mtime: fs.statSync(cleanPath).mtime };
    }
  }

  // Step 2: 回落到最新 .bak.{ISO}（从最新到最旧逐个尝试）
  const isoBackups = listIsoBackups(dbFilePath);
  for (let i = isoBackups.length - 1; i >= 0; i--) {
    const candidate = isoBackups[i];
    if (tryRestoreFrom(candidate, dbFilePath)) {
      return { source: 'iso', mtime: fs.statSync(candidate).mtime };
    }
  }

  return null;
}

function tryRestoreFrom(srcBackup: string, dstDb: string): boolean {
  try {
    fs.copyFileSync(srcBackup, dstDb);
  } catch (err) {
    log.warn('[localDb] tryRestoreFrom copy failed', srcBackup, err);
    return false;
  }
  // 验证可只读打开 + quick_check 通过
  let probe: Database.Database | null = null;
  try {
    probe = createBetterSqliteDatabase(dstDb, { readonly: true });
    const row = probe.prepare('PRAGMA quick_check').get() as
      | { quick_check?: string }
      | undefined;
    const value = row ? Object.values(row)[0] : undefined;
    return value === 'ok';
  } catch (err) {
    log.warn('[localDb] tryRestoreFrom probe failed', srcBackup, err);
    return false;
  } finally {
    try {
      probe?.close();
    } catch {
      /* noop */
    }
  }
}

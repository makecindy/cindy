/**
 * claude-legacy-config-migration —— dev 多实例旧 Claude 配置目录的一次性补拷。
 *
 * 旧版 dev(设了 XDT_USER_DATA_DIR 的非 packaged 实例)把 Claude Code 的配置目录隔离在
 * `<userData>/claude-home`。Claude 订阅改由 CLI 自己登录后,凭证库按配置目录区分,
 * 隔离会让 dev 看不到本机已有的 Claude Code 登录;现在 dev 与正式版一样用默认 ~/.claude。
 *
 * 为了让旧 dev 任务还能 resume,把旧目录里按 sdk session id 存放的转录(projects)与
 * 文件检查点(file-history)补拷到默认目录:
 *   - 只补缺,不覆盖已有文件;不删旧目录(旧 checkout 仍可能用它);
 *   - 先写同目录临时文件再 hard link 到目标,中断不会留下半截 jsonl,也不会覆盖并发
 *     新建的同名文件;保留 mtime(转录归位按 mtime 比较新旧);
 *   - 全部成功后写标记,之后不再扫描;有失败则下次启动重试。标记之后旧 checkout 再写进
 *     旧目录的转录不会补拷(过渡期限制,见 docs/dev-rules/desktop-development.md)。
 * 正式版恒不执行(从未使用 claude-home 存转录)。
 */

import { randomUUID } from 'node:crypto';
import fs, { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';

import { createLogger } from '../logger.js';

const log = createLogger('claude-legacy-config-migration');

const LEGACY_DIR_NAME = 'claude-home';
const MIGRATED_SUBDIRS = ['projects', 'file-history'] as const;
const MARKER_FILE = '.cindy-migrated-to-default-config';
/** 拉起 CLI 前最多等这么久;超时不阻断会话,补拷继续在后台跑。 */
const SPAWN_WAIT_MS = 15_000;

interface CopyStats {
  copied: number;
  skipped: number;
  failed: number;
}

export interface LegacyClaudeConfigMigrationPaths {
  legacyDir: string;
  targetDir: string;
}

/**
 * 硬链接不可用时(部分文件系统 / Windows 权限)退回 COPYFILE_EXCL 直拷:仍绝不覆盖已有文件,
 * 代价是进程中途被杀可能留下半截目标文件(仅此兜底路径)。
 */
const LINK_UNSUPPORTED_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);

let migration: Promise<void> | null = null;
let migrationSettled = false;
/** 首次等待已超时:之后的调用不再等,补拷在后台继续。 */
let spawnWaitExpired = false;

function legacyMigrationPaths(): LegacyClaudeConfigMigrationPaths | null {
  if (!process.env.XDT_USER_DATA_DIR || app.isPackaged) return null;
  return {
    legacyDir: path.join(app.getPath('userData'), LEGACY_DIR_NAME),
    targetDir: path.join(os.homedir(), '.claude'),
  };
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.lstat(target);
    return true;
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false;
    throw err;
  }
}

async function copyFileIfMissing(from: string, to: string, stats: CopyStats): Promise<void> {
  if (await pathExists(to)) {
    stats.skipped += 1;
    return;
  }
  await fsp.mkdir(path.dirname(to), { recursive: true });
  // 临时名不以 .jsonl 结尾,残留也不会被 CLI 或转录扫描当成会话。
  const temp = `${to}.cindy-migrate-${process.pid}-${randomUUID()}.tmp`;
  try {
    await fsp.copyFile(from, temp, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    const source = await fsp.stat(from);
    await fsp.utimes(temp, source.atime, source.mtime);
    try {
      await fsp.link(temp, to);
    } catch (err) {
      if (!LINK_UNSUPPORTED_CODES.has(errorCode(err) ?? '')) throw err;
      await fsp.copyFile(temp, to, fs.constants.COPYFILE_EXCL);
      await fsp.utimes(to, source.atime, source.mtime);
    }
    stats.copied += 1;
  } catch (err) {
    if (errorCode(err) === 'EEXIST') {
      stats.skipped += 1;
      return;
    }
    throw err;
  } finally {
    // 清理失败(如杀软占用)不能盖掉已经成功的落位;残留临时名不会被当成会话。
    await fsp.rm(temp, { force: true }).catch(() => undefined);
  }
}

async function copyTreeIfMissing(from: string, to: string, stats: CopyStats): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(from, { withFileTypes: true });
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    try {
      if (entry.isDirectory()) await copyTreeIfMissing(source, target, stats);
      // 只搬普通文件;符号链接等不跟随,避免把旧目录之外的内容带进来。
      else if (entry.isFile()) await copyFileIfMissing(source, target, stats);
    } catch (err) {
      stats.failed += 1;
      log.debug('legacy claude file copy failed', { code: errorCode(err) });
    }
  }
}

/** 导出供测试直接驱动;生产经 {@link ensureLegacyClaudeConfigMigrated}。 */
export async function migrateLegacyClaudeConfigDir(
  paths: LegacyClaudeConfigMigrationPaths,
): Promise<CopyStats | null> {
  const markerPath = path.join(paths.legacyDir, MARKER_FILE);
  if (await pathExists(markerPath)) return null;
  if (!(await pathExists(paths.legacyDir))) return null;
  const stats: CopyStats = { copied: 0, skipped: 0, failed: 0 };
  for (const subdir of MIGRATED_SUBDIRS) {
    await copyTreeIfMissing(
      path.join(paths.legacyDir, subdir),
      path.join(paths.targetDir, subdir),
      stats,
    );
  }
  if (stats.failed === 0) {
    await fsp.writeFile(
      markerPath,
      `${JSON.stringify({ migratedAt: new Date().toISOString() })}\n`,
      'utf-8',
    );
  }
  return stats;
}

function startMigration(): Promise<void> | null {
  if (migration) return migration;
  let paths: LegacyClaudeConfigMigrationPaths | null;
  try {
    paths = legacyMigrationPaths();
  } catch (err) {
    log.warn('legacy dev claude config paths unavailable', {
      message: err instanceof Error ? err.message : String(err),
    });
    // 记住失败,本次运行不再重试(否则每次拉起 CLI 都重复告警)。
    migration = Promise.resolve();
    migrationSettled = true;
    return migration;
  }
  if (!paths) return null;
  migration = migrateLegacyClaudeConfigDir(paths)
    .then(
      (stats) => {
        if (stats) log.info('migrated legacy dev claude config dir', { ...stats });
      },
      (err: unknown) => {
        log.warn('legacy dev claude config migration failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      },
    )
    .finally(() => {
      migrationSettled = true;
    });
  return migration;
}

/** 启动期后台触发(不等待),让会话移动 / fork 等在首次拉起 CLI 前也能读到补拷结果。 */
export function startLegacyClaudeConfigMigration(): void {
  void startMigration();
}

/**
 * 拉起 Claude CLI 前调用:补拷未完成时最多等待 {@link SPAWN_WAIT_MS}(只等一次,超时后
 * 后续调用不再等,补拷在后台继续)。best-effort,失败只记日志、从不抛出;非 dev 多实例
 * 直接返回。
 */
export async function ensureLegacyClaudeConfigMigrated(waitMs = SPAWN_WAIT_MS): Promise<void> {
  const pending = startMigration();
  if (!pending || migrationSettled || spawnWaitExpired) return;
  let timer: NodeJS.Timeout | undefined;
  const finished = await Promise.race([
    pending.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), waitMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!finished) spawnWaitExpired = true;
}

export function resetLegacyClaudeConfigMigrationForTest(): void {
  migration = null;
  migrationSettled = false;
  spawnWaitExpired = false;
}

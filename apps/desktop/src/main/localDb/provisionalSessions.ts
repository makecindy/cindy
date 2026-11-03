/**
 * 未发送任务（provisional task）：用户在新建任务页开始输入时，任务先建出来并出现在本机
 * 任务列表里（可以提前启动 Agent），清空输入就真正删掉；第一次发送时转为普通任务。
 *
 * 只在本机可见：未发送期间不推给手机 / 其它电脑，延后的创建副作用（项目 git 初始化、
 * 最近项目、插件「已创建」事件、device-link 创建通知）在转正时补做。
 *
 * 登记表在内存里同步可查，并写一份到 userData 下的小文件：进程崩溃或退出时没来得及删的
 * 未发送任务，下次打开后在账号库就绪时清掉（输入框内容不跨重启保留，任务留着没有意义）。
 * 不加数据库列，旧版本打开同一个库只会把残留看成一个普通的未发送任务。
 */

import fs from 'node:fs';
import path from 'node:path';

import { and, count, eq, isNull } from 'drizzle-orm';

import { createLogger } from '../logger.js';
import { getCurrentDbClientSnapshot, getDbClient } from './client/current.js';
import { messages, sessions } from './schema.js';

const log = createLogger('provisional-sessions');

const FILE_NAME = 'provisional-sessions.json';
/** 其它账号库里的残留：本账号库查不到时保留一段时间，等那个账号下次登录再清。 */
const FOREIGN_ENTRY_TTL_MS = 7 * 24 * 60 * 60_000;

interface Entry {
  id: string;
  createdAt: number;
  /** 建任务时 Cindy 为它分配的对话目录；只清理这种目录，不碰调用方指定的路径。 */
  managedDir?: string;
}

let resolveFileDir: (() => string) | null = null;
let onLeftoverSwept: ((sessionId: string) => void) | null = null;
/** 本次运行建出的未发送任务，记下所属账号库(切换账号后不拿它去碰另一个账号的库)。 */
const live = new Map<string, Entry & { owner: object | null }>();
/** 上次运行(或其它账号)留下、尚未清理的登记（按账号库逐个清理）。 */
let leftovers: Entry[] | null = null;
const sweeps = new WeakMap<object, Promise<string[]>>();

/**
 * Host 启动时注入 userData 目录(用到时才解析)；未注入时只用内存登记。
 * `onSwept`：残留被删掉后通知一次(让本机窗口刷新任务列表)。
 */
export function configureProvisionalSessions(
  userDataDir: string | (() => string),
  opts: { onSwept?: (sessionId: string) => void } = {},
): void {
  resolveFileDir = typeof userDataDir === 'string' ? () => userDataDir : userDataDir;
  onLeftoverSwept = opts.onSwept ?? null;
}

function filePath(): string | null {
  try {
    return resolveFileDir ? path.join(resolveFileDir(), FILE_NAME) : null;
  } catch {
    return null;
  }
}

function loadLeftovers(): Entry[] {
  if (leftovers) return leftovers;
  leftovers = [];
  const file = filePath();
  if (!file) return leftovers;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries?: unknown };
    if (Array.isArray(parsed.entries)) {
      for (const item of parsed.entries) {
        const entry = item as Partial<Entry>;
        if (typeof entry.id === 'string' && entry.id && typeof entry.createdAt === 'number') {
          leftovers.push({
            id: entry.id,
            createdAt: entry.createdAt,
            ...(typeof entry.managedDir === 'string' ? { managedDir: entry.managedDir } : {}),
          });
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('provisional session file unreadable', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return leftovers;
}

function persist(): void {
  const file = filePath();
  if (!file) return;
  const entries = [
    ...loadLeftovers(),
    ...[...live.values()].map(({ id, createdAt, managedDir }) => ({
      id,
      createdAt,
      ...(managedDir ? { managedDir } : {}),
    })),
  ];
  try {
    if (entries.length === 0) {
      fs.rmSync(file, { force: true });
      return;
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }));
    fs.renameSync(tmp, file);
  } catch (error) {
    log.warn('provisional session file write failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function markProvisionalSession(
  sessionId: string,
  now = Date.now(),
  managedDir?: string,
): void {
  loadLeftovers();
  live.set(sessionId, {
    id: sessionId,
    createdAt: now,
    owner: getCurrentDbClientSnapshot(),
    ...(managedDir ? { managedDir } : {}),
  });
  persist();
}

/** 建这条未发送任务时 Cindy 分配的对话目录(没有则 undefined)。 */
export function provisionalManagedDir(sessionId: string): string | undefined {
  return live.get(sessionId)?.managedDir;
}

/** 未发送任务(含还没清理掉的残留)：只在本机可见，不推给控制端。 */
export function isProvisionalSession(sessionId: string): boolean {
  return live.has(sessionId) || loadLeftovers().some((entry) => entry.id === sessionId);
}

/**
 * 转正 / 删除前确认这条未发送任务属于当前账号库。属于其它账号(中途切换了账号)时
 * 不碰当前库，把它留作残留，等那个账号下次就绪时清理。
 */
export function claimOwnedProvisionalSession(sessionId: string): 'owned' | 'foreign' | 'none' {
  const entry = live.get(sessionId);
  if (!entry) return 'none';
  if (entry.owner === getCurrentDbClientSnapshot()) return 'owned';
  live.delete(sessionId);
  loadLeftovers().push({
    id: entry.id,
    createdAt: entry.createdAt,
    ...(entry.managedDir ? { managedDir: entry.managedDir } : {}),
  });
  persist();
  return 'foreign';
}

/** Forget the provisional mark (the task was sent, or was deleted). True when it was provisional. */
export function forgetProvisionalSession(sessionId: string): boolean {
  if (!live.delete(sessionId)) return false;
  persist();
  return true;
}

/**
 * Hard-delete a provisional task row, but only while it is still unsent and has no messages.
 * Returns the deleted row's directory facts so the caller can tidy the managed dialogue folder.
 */
export async function deleteUnsentSessionRow(
  sessionId: string,
  db = getDbClient().drizzle,
): Promise<{ workspaceKind: string | null; workingDir: string | null } | null> {
  const [row] = await db
    .select({
      workspaceKind: sessions.workspaceKind,
      workingDir: sessions.workingDir,
      userSendAt: sessions.userSendAt,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row || row.userSendAt != null) return null;
  const [messageCount] = await db
    .select({ n: count() })
    .from(messages)
    .where(eq(messages.sessionId, sessionId));
  if ((messageCount?.n ?? 0) > 0) return null;
  await db.delete(sessions).where(and(eq(sessions.id, sessionId), isNull(sessions.userSendAt)));
  return { workspaceKind: row.workspaceKind ?? null, workingDir: row.workingDir ?? null };
}

/**
 * Remove the dialogue folder Cindy allocated for this task when nothing was written into it.
 * Only the folder recorded at creation is eligible — never a caller-chosen path.
 */
export function removeEmptyDialogueDir(sessionId: string, managedDir: string | undefined): void {
  if (!managedDir || path.basename(managedDir) !== sessionId) return;
  const workingDir = managedDir;
  try {
    fs.rmdirSync(workingDir);
  } catch {
    // Not empty or already gone: leave it, like any other dialogue folder.
  }
}

/**
 * Account database is ready: delete the unsent tasks a previous run left behind in it.
 * Runs once per database owner (callers share the same run and can await it before
 * listing tasks); entries from other accounts wait for that account. Resolves to the
 * ids that were deleted.
 */
export async function sweepLeftoverProvisionalSessions(now = Date.now()): Promise<string[]> {
  const owner = getCurrentDbClientSnapshot();
  if (!owner) return [];
  let run = sweeps.get(owner);
  if (!run) {
    run = sweepOwner(owner, now);
    sweeps.set(owner, run);
  }
  return run;
}

async function sweepOwner(owner: object, now: number): Promise<string[]> {
  const pending = [...loadLeftovers()];
  if (pending.length === 0) return [];
  // The whole sweep stays on this account's database; if the account changes mid-way,
  // the rest is kept for later instead of being checked against another account.
  const db = getDbClient().drizzle;
  const keep: Entry[] = [];
  const removed: string[] = [];
  for (const [index, entry] of pending.entries()) {
    if (getCurrentDbClientSnapshot() !== owner) {
      keep.push(...pending.slice(index));
      break;
    }
    try {
      const [row] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, entry.id))
        .limit(1);
      if (!row) {
        if (now - entry.createdAt < FOREIGN_ENTRY_TTL_MS) keep.push(entry);
        continue;
      }
      if (getCurrentDbClientSnapshot() !== owner) {
        keep.push(...pending.slice(index));
        break;
      }
      const deleted = await deleteUnsentSessionRow(entry.id, db);
      if (deleted) {
        removed.push(entry.id);
        onLeftoverSwept?.(entry.id);
        removeEmptyDialogueDir(entry.id, entry.managedDir);
      }
      log.info('provisional session leftover swept', { sessionId: entry.id, deleted: !!deleted });
    } catch (error) {
      keep.push(entry);
      log.warn('provisional session leftover sweep failed', {
        sessionId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // Entries parked while this sweep ran (account switched mid-way) stay as leftovers too.
  const parked = loadLeftovers().filter((entry) => !pending.includes(entry));
  leftovers = [...keep, ...parked];
  persist();
  return removed;
}

/** Test-only reset. */
export function resetProvisionalSessionsForTest(): void {
  resolveFileDir = null;
  onLeftoverSwept = null;
  live.clear();
  leftovers = null;
}

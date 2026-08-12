/**
 * live-session 引用判定（WorktreePool 与 WorktreeManager 删除路径共用）。
 *
 * 语义：某 worktree 路径若仍被其它会话的 workingDir / worktreePath 指向，就视为"在用"，
 * 删除/淘汰路径必须保留它。显式归档/删除回收可提供运行态观察器：archived/deleted 只在确认
 * 对应 runtime 已关闭后才不再阻挡；其它调用方没有观察器时保守保留 archived，但继续忽略
 * deleted。查询失败时返回 null，消费方按"无法确认 → 视为在用"的保守方向处理。未知或 NULL
 * status 同样按在用处理。
 *
 * 原实现内联在 WorktreePool.ts（MR1），P0 重构把它抽出来给
 * removeWorktreeForSession 的删除守卫复用，并支持排除会话自身
 * （显式删除/归档会话 A 的 worktree 时，A 自己的行不算引用）。
 */

import path from 'node:path';
import { sql } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current';
import { sessions } from '../localDb/schema';
import { createLogger } from '../logger';

import type { WorktreeMeta } from './types';

const log = createLogger('worktreeLiveRefs');

/**
 * 把路径规范化成 live-session 引用集合(Set)成员判断用的 key。
 * win32 上转小写做大小写不敏感匹配，确保 session 记录的 path 与 worktree meta.path
 * 大小写不同也能命中 —— 命中即保留，偏向"不误删在用目录"的安全方向。
 *
 * 注意：这套大小写处理只服务"是否仍被引用"的判断，与 safety.ts 的
 * isManagedWorktreePath 删除安全门(大小写敏感)刻意保持独立——后者大小写不一致时
 * 拒绝删除，同样偏保守。两者方向一致，都倾向保留而非删除，因此当前差异不构成风险。
 */
export function pathKey(p: string | null | undefined): string | null {
  if (!p) return null;
  try {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch {
    return null;
  }
}

export type LiveSessionPathKeys = ReadonlySet<string> | null;

export interface LoadLiveSessionPathKeysOptions {
  /** 日志上下文（定位是哪条 worktree 的检查失败）。 */
  contextPath?: string;
  /**
   * 排除的会话 id：显式删除/归档会话时，该会话自己的 workingDir/worktreePath
   * 不构成"仍在用"；显式回收观察器存在时，其它终态会话仍需运行态证明才能排除。
   */
  excludeSessionId?: string;
  /** 终态会话只有在该观察器明确返回 false 时才不再视为 live。 */
  isSessionRuntimeAlive?: (sessionId: string) => boolean | undefined;
}

export async function loadLiveSessionPathKeys(
  opts: LoadLiveSessionPathKeysOptions = {},
): Promise<LiveSessionPathKeys> {
  try {
    const db = getDbClient().drizzle;
    const rows = await db
      .select({
        id: sessions.id,
        status: sessions.status,
        workingDir: sessions.workingDir,
        worktreePath: sessions.worktreePath,
      })
      .from(sessions)
      .where(
        opts.isSessionRuntimeAlive
          ? sql`${sessions.workingDir} IS NOT NULL OR ${sessions.worktreePath} IS NOT NULL`
          : sql`${sessions.status} != 'deleted' OR ${sessions.status} IS NULL`,
      );

    const keys = new Set<string>();
    for (const row of rows) {
      if (opts.excludeSessionId && row.id === opts.excludeSessionId) continue;
      const isTerminal = row.status === 'archived' || row.status === 'deleted';
      if (!opts.isSessionRuntimeAlive && row.status === 'deleted') {
        continue;
      }
      if (isTerminal && opts.isSessionRuntimeAlive?.(row.id) === false) {
        continue;
      }
      const workingDirKey = pathKey(row.workingDir);
      const worktreePathKey = pathKey(row.worktreePath);
      if (workingDirKey) keys.add(workingDirKey);
      if (worktreePathKey) keys.add(worktreePathKey);
    }
    return keys;
  } catch (err) {
    const suffix = opts.contextPath ? ` for ${opts.contextPath}` : '';
    log.warn(
      `[worktreeLiveRefs] failed to check live session references${suffix}; preserving`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export function hasLiveSessionReference(
  meta: WorktreeMeta,
  liveSessionPathKeys: LiveSessionPathKeys,
): boolean {
  if (!liveSessionPathKeys) return true;
  const targets = [meta.path, meta.quarantinePath]
    .map((value) => pathKey(value))
    .filter((value): value is string => value !== null);
  if (targets.length === 0) return true;
  for (const target of targets) {
    for (const candidate of liveSessionPathKeys) {
      const relative = path.relative(target, candidate);
      if (
        relative === '' ||
        (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      ) {
        return true;
      }
    }
  }
  return false;
}

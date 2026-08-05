/**
 * live-session 引用判定（WorktreePool 与 WorktreeManager 删除路径共用）。
 *
 * 语义：某 worktree 路径若仍被任何**未删除**会话的 workingDir / worktreePath 指向，
 * 就视为"在用"，删除/淘汰路径必须保留它。查询失败时返回 null，消费方按
 * "无法确认 → 视为在用"的保守方向处理——所有分支都倾向保留而非删除。
 *
 * 原实现内联在 WorktreePool.ts（MR1），P0 重构把它抽出来给
 * removeWorktreeForSession 的删除守卫复用，并支持排除会话自身
 * （显式删除/归档会话 A 的 worktree 时，A 自己的行不算引用）。
 */

import path from 'node:path';
import { ne } from 'drizzle-orm';

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
   * 不构成"仍在用"（归档会话 status 仍非 deleted，不排除会永远挡住自己的回收）。
   */
  excludeSessionId?: string;
}

export async function loadLiveSessionPathKeys(
  opts: LoadLiveSessionPathKeysOptions = {},
): Promise<LiveSessionPathKeys> {
  try {
    const db = getDbClient().drizzle;
    const rows = await db
      .select({
        id: sessions.id,
        workingDir: sessions.workingDir,
        worktreePath: sessions.worktreePath,
      })
      .from(sessions)
      .where(ne(sessions.status, 'deleted'));

    const keys = new Set<string>();
    for (const row of rows) {
      // 排除放在 JS 层而非 SQL:语义单测无需解析 drizzle 条件表达式。
      if (opts.excludeSessionId && row.id === opts.excludeSessionId) continue;
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
  const target = pathKey(meta.path);
  if (!target) return true;
  if (!liveSessionPathKeys) return true;
  for (const candidate of liveSessionPathKeys) {
    const relative = path.relative(target, candidate);
    if (
      relative === '' ||
      (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    ) {
      return true;
    }
  }
  return false;
}

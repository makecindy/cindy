/**
 * live-session 引用判定（WorktreePool 与 WorktreeManager 删除路径共用）。
 *
 * 语义：某 worktree 路径若仍被其它会话的 workingDir / worktreePath 指向，就视为"在用"，
 * 删除/淘汰路径必须保留它。引用来自全部本地任务数据库和跨实例运行时租约；
 * archived/deleted 只有在完整租约视图里无占用时才不阻挡，当前实例观察器可额外保留。
 * 任一来源不可读、旧实例不支持租约、未知或 NULL status 均按在用处理。
 *
 * 原实现内联在 WorktreePool.ts（MR1），P0 重构把它抽出来给
 * removeWorktreeForSession 的删除守卫复用，并支持排除会话自身
 * （显式删除/归档会话 A 的 worktree 时，A 自己的行不算引用）。
 */

import path from 'node:path';
import fs from 'node:fs';

import { getDbClient } from '../localDb/client/current';
import { physicalWorktreeKey } from './resourceLock';
import { readWorktreeRuntimePaths } from './runtimeLeases';
import { readPiSubagentWorktreeReferences } from './piSubagentReferences';
import * as store from './worktreeStore';
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
  /** 对当前实例的额外占用证据；跨实例租约始终必须完整可读。 */
  isSessionRuntimeAlive?: (sessionId: string) => boolean | undefined;
}

export async function loadLiveSessionPathKeys(
  opts: LoadLiveSessionPathKeysOptions = {},
): Promise<LiveSessionPathKeys> {
  try {
    const db = getDbClient();
    if (!db.readLocalWorktreeReferences) return null;
    const rows = await db.readLocalWorktreeReferences();
    const runtimePaths = await readWorktreeRuntimePaths();
    if (!runtimePaths) return null;
    const subagentReferences = await readPiSubagentWorktreeReferences();
    if (!subagentReferences) return null;
    const keys = new Set(runtimePaths);
    // Config cwd can refer to an earlier workdir or a child-specific directory,
    // even after the parent row changes or disappears from the task database.
    for (const paths of subagentReferences.values()) {
      for (const value of paths) {
        keys.add(pathKey(value)!);
        keys.add(await physicalWorktreeKey(value));
      }
    }
    const knownSessionIds = new Set(rows.map((row) => row.id));
    for (const meta of store.getAll()) {
      if (subagentReferences.has(meta.sessionId)
        || (meta.sessionId !== opts.excludeSessionId && !knownSessionIds.has(meta.sessionId))) {
        const metaPathKey = pathKey(meta.path);
        if (metaPathKey) keys.add(metaPathKey);
        keys.add(await physicalWorktreeKey(meta.path));
      }
    }
    for (const row of rows) {
      const hasSubagentRuns = subagentReferences.has(row.id);
      // The same id in another database is not the row the caller just closed.
      if (!hasSubagentRuns && row.currentDatabase && opts.excludeSessionId && row.id === opts.excludeSessionId) continue;
      const isTerminal = row.status === 'archived' || row.status === 'deleted';
      if (!hasSubagentRuns && row.source !== 'bot' && isTerminal && (!row.currentDatabase || opts.isSessionRuntimeAlive?.(row.id) !== true)) {
        continue;
      }
      const workingDirKey = pathKey(row.workingDir);
      const worktreePathKey = pathKey(row.worktreePath);
      if (workingDirKey) keys.add(workingDirKey);
      if (worktreePathKey) keys.add(worktreePathKey);
      for (const value of [row.workingDir, row.worktreePath]) {
        if (value) keys.add(await physicalWorktreeKey(value));
      }
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
  meta: Pick<WorktreeMeta, 'path' | 'quarantinePath'>,
  liveSessionPathKeys: LiveSessionPathKeys,
): boolean {
  if (!liveSessionPathKeys) return true;
  const targets = [meta.path, meta.quarantinePath]
    .map((value) => pathKey(value))
    .filter((value): value is string => value !== null);
  for (const value of [...targets]) {
    try {
      const real = pathKey(fs.realpathSync(value));
      if (real && !targets.includes(real)) targets.push(real);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    }
  }
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

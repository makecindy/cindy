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

export function loadLiveSessionPathKeys(
  opts: LoadLiveSessionPathKeysOptions = {},
): Promise<LiveSessionPathKeys> {
  return readLiveSessionPathKeys(opts);
}

interface ReferenceSources {
  pi: Set<string>;
  other: Set<string>;
}

async function readLiveSessionPathKeys(
  opts: LoadLiveSessionPathKeysOptions,
  sources?: ReferenceSources,
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
    if (sources) for (const key of runtimePaths) sources.other.add(key);
    const add = async (value: string, source?: Set<string>): Promise<void> => {
      const key = pathKey(value);
      if (key) {
        keys.add(key);
        source?.add(key);
      }
      const physical = await physicalWorktreeKey(value);
      keys.add(physical);
      source?.add(physical);
    };
    // Config cwd can refer to an earlier workdir or a child-specific directory,
    // even after the parent row changes or disappears from the task database.
    for (const paths of subagentReferences.values()) {
      for (const value of paths) await add(value, sources?.pi);
    }
    const knownSessionIds = new Set(rows.map((row) => row.id));
    for (const meta of store.getAll()) {
      const untrackedRegistration = meta.sessionId !== opts.excludeSessionId && !knownSessionIds.has(meta.sessionId);
      if (subagentReferences.has(meta.sessionId) || untrackedRegistration) {
        await add(meta.path, untrackedRegistration ? sources?.other : sources?.pi);
      }
    }
    for (const row of rows) {
      const hasSubagentRuns = subagentReferences.has(row.id);
      // The same id in another database is not the row the caller just closed.
      const excluded = row.currentDatabase && opts.excludeSessionId && row.id === opts.excludeSessionId;
      const isTerminal = row.status === 'archived' || row.status === 'deleted';
      // Collect independent references only for diagnostics if the Pi record
      // already makes this row a blocker.
      const independentlyReferenced = (!hasSubagentRuns || sources !== undefined) && !excluded
        && !(row.source !== 'bot' && isTerminal
          && (!row.currentDatabase || opts.isSessionRuntimeAlive?.(row.id) !== true));
      if (!hasSubagentRuns && !independentlyReferenced) continue;
      for (const value of [row.workingDir, row.worktreePath]) {
        if (value) await add(value, independentlyReferenced ? sources?.other : sources?.pi);
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

/** Display-only provenance for an otherwise generic retention reason. */
export async function loadWorktreeReferenceDiagnostics() {
  const sources: ReferenceSources = { pi: new Set(), other: new Set() };
  const paths = await readLiveSessionPathKeys({}, sources);
  return {
    paths,
    retentionReason(meta: ReferenceTarget): 'pi-subagent-reference' | undefined {
      if (!paths || sources.pi.size === 0) return;
      const targets = referenceTargets(meta);
      if (targets && matchesReference(targets, sources.pi) && !matchesReference(targets, sources.other)) {
        return 'pi-subagent-reference';
      }
    },
  };
}

type ReferenceTarget = Pick<WorktreeMeta, 'path' | 'quarantinePath'>;

export function hasLiveSessionReference(meta: ReferenceTarget, paths: LiveSessionPathKeys): boolean {
  if (!paths) return true;
  const targets = referenceTargets(meta);
  return !targets || matchesReference(targets, paths);
}

function referenceTargets(meta: ReferenceTarget): string[] | null {
  const targets = [meta.path, meta.quarantinePath]
    .map((value) => pathKey(value))
    .filter((value): value is string => value !== null);
  for (const value of [...targets]) {
    try {
      const real = pathKey(fs.realpathSync(value));
      if (real && !targets.includes(real)) targets.push(real);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
  }
  return targets.length ? targets : null;
}

function matchesReference(targets: readonly string[], paths: ReadonlySet<string>): boolean {
  for (const target of targets) {
    for (const candidate of paths) {
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

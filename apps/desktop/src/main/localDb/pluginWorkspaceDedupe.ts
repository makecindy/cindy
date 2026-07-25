/**
 * workspace 槽判重的纯比较逻辑(零重依赖,单测直测)。
 *
 * 口径 = normalizeWorkingDirForGrouping:与 renderer projectGrouping 的
 * "同一工作区"同源(存储归一化 + worktree 折叠到主仓)。与全仓现状一致,
 * **不做大小写折叠**——大小写不同的路径视为不同工作区;改口径要连
 * projectGrouping 一起改,不在本模块单点偏离。
 */

import { normalizeWorkingDirForGrouping } from '../../shared/workingDir.js';

/** 从候选会话行里挑与目标目录同工作区的最近活跃一条;查无返回 null。 */
export function pickSessionForWorkdir(
  rows: ReadonlyArray<{ id: string; workingDir: string | null; updatedAt: number }>,
  dirAbs: string,
): string | null {
  const targetKey = normalizeWorkingDirForGrouping(dirAbs);
  if (targetKey == null) return null;
  let best: { id: string; updatedAt: number } | null = null;
  for (const row of rows) {
    if (normalizeWorkingDirForGrouping(row.workingDir) !== targetKey) continue;
    if (best === null || row.updatedAt > best.updatedAt) {
      best = { id: row.id, updatedAt: row.updatedAt };
    }
  }
  return best?.id ?? null;
}

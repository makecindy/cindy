import type { Session } from '@/lib/ccAgent.types';

import { normalizeWorkingDir, projectIdentityKeyForSession, type ProjectNode } from './projectGrouping';

/**
 * 构建 session → "项目来源"标签映射,供平铺时标题旁展示。
 *
 * 口径(主列表与置顶视图共用,保持一致):
 * - dialogue → 不注入(独立对话本身不需要再标「对话」);
 * - project → 命中 ProjectNode 就用其 displayName(消歧后可能带父目录段);
 * - orca-lead / 罕见来源找不到 ProjectNode 时 → 回退 workingDir basename;
 * - 都拿不到 → 不注入(map 里无该 session key),标题旁不画来源。
 *
 * 纯函数、无 React 依赖:调用方各自用 useMemo 包裹并传入自己的 session 数组
 * (主列表传散排会话,置顶视图传 visibleSessions),memo 依赖各自维护。
 */
export function buildSessionSourceLabelMap(
  sessions: readonly Session[],
  allKnownProjects: readonly ProjectNode[],
): Map<string, string> {
  const nameByKey = new Map(allKnownProjects.map((p) => [p.projectKey, p.displayName]));
  const map = new Map<string, string>();
  for (const s of sessions) {
    if (s.workspaceKind === 'dialogue') continue;
    const key = projectIdentityKeyForSession(s);
    const name = key ? nameByKey.get(key) : undefined;
    if (name) {
      map.set(s.id, name);
      continue;
    }
    const wd = normalizeWorkingDir(s.workingDir);
    if (!wd) continue;
    const slash = Math.max(wd.lastIndexOf('/'), wd.lastIndexOf('\\'));
    const base = slash < 0 ? wd : wd.slice(slash + 1);
    if (base) map.set(s.id, base);
  }
  return map;
}

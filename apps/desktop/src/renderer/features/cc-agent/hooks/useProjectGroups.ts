/**
 * useProjectGroups — Sidebar 分组数据 hook
 * ---------------------------------------------------------------------------
 * 包 `groupSessions` 纯函数并用 useMemo 锁结果，避免 render 时重复计算。
 *
 * 注：useCCSessions 当前每次 fetch 都返回新数组引用，因此 sessions 引用变化
 * 即触发重算。在 n ≤ 16 的规模下成本可忽略；如需进一步优化，可在
 * useCCSessions 内做 deep-equal 短路（属于上游优化，不在本期范围）。
 */

import { useMemo } from 'react';

import type { Session } from '@/lib/ccAgent.types';
import { useRemoteSshHosts } from '@/hooks/useRemoteSshHosts';
import { groupSessions, type ProjectGroupsResult } from '../lib/projectGrouping';
import { resolveRemoteProjectMachineIdentity } from '../lib/remoteProjectIdentity';

export function useProjectGroups(
  sessions: readonly Session[],
  projectAliases?: ReadonlyMap<string, string>,
  includePinnedInProjects: boolean = false,
): ProjectGroupsResult {
  const sshHosts = useRemoteSshHosts();

  return useMemo(() => {
    const groups = groupSessions(sessions, { projectAliases, includePinnedInProjects });
    return {
      ...groups,
      projects: groups.projects.map((project) => ({
        ...project,
        remoteMachineIdentity: resolveRemoteProjectMachineIdentity(project, sshHosts),
      })),
    };
  }, [sessions, projectAliases, includePinnedInProjects, sshHosts]);
}

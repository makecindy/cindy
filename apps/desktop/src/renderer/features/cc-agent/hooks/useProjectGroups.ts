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
import { buildBotSessionOwners } from '@/features/bots/botSessionOwners';
import { useBotProfiles } from '@/features/bots/botStore';
import { groupSessions, type ProjectGroupsResult } from '../lib/projectGrouping';
import {
  collectAmbiguousDeviceNames,
  resolveRemoteProjectMachineIdentity,
} from '../lib/remoteProjectIdentity';

export function useProjectGroups(
  sessions: readonly Session[],
  projectAliases?: ReadonlyMap<string, string>,
  includePinnedInProjects: boolean = false,
): ProjectGroupsResult {
  const sshHosts = useRemoteSshHosts();
  /*
    伙伴归属表。会话行本身不带 botId,归属只有伙伴档案知道 —— 档案还没加载完的
    那一瞬间这张表是空的,伙伴任务就走原来的分组落到别处,**不会消失**。
  */
  const botProfiles = useBotProfiles();
  const botOwnerBySessionId = useMemo(() => buildBotSessionOwners(botProfiles), [botProfiles]);

  return useMemo(() => {
    const groups = groupSessions(sessions, {
      projectAliases,
      includePinnedInProjects,
      botOwnerBySessionId,
    });
    // 撞名判定要看全量项目(哪些设备名对应了多个 deviceId),所以先扫一遍再逐个富化。
    const ambiguousDeviceNames = collectAmbiguousDeviceNames(groups.projects);
    return {
      ...groups,
      projects: groups.projects.map((project) => ({
        ...project,
        remoteMachineIdentity: resolveRemoteProjectMachineIdentity(project, sshHosts, {
          ambiguousDeviceNames,
        }),
      })),
    };
  }, [sessions, projectAliases, includePinnedInProjects, sshHosts, botOwnerBySessionId]);
}

/**
 * useProjectGroups — Sidebar 分组数据 hook
 * ---------------------------------------------------------------------------
 * 包 `groupSessions` 纯函数并用 useMemo 锁结果，避免 render 时重复计算。
 *
 * Row-only changes reuse grouping and replace just the affected session references.
 */

import { useMemo } from 'react';
import { createProjectGroupsSelector } from '../lib/projectGroupsSelector';

import type { Session } from '@/lib/ccAgent.types';
import { useRemoteSshHosts } from '@/hooks/useRemoteSshHosts';
import { buildBotSessionOwners } from '@/features/bots/botSessionOwners';
import { useBotProfiles } from '@/features/bots/botStore';
import {
  type PersistentLocalProject,
  type ProjectGroupsResult,
  type ProjectNode,
} from '../lib/projectGrouping';
import {
  collectAmbiguousDeviceNames,
  resolveRemoteProjectMachineIdentity,
} from '../lib/remoteProjectIdentity';

export function useProjectGroups(
  sessions: readonly Session[],
  projectAliases?: ReadonlyMap<string, string>,
  includePinnedInProjects: boolean = false,
  persistentLocalProjects?: readonly PersistentLocalProject[],
  localPlatform: string = '',
  /** Result from an earlier call with identical inputs (e.g. no activity filter). */
  equivalentResult?: ProjectGroupsResult,
): ProjectGroupsResult {
  const sshHosts = useRemoteSshHosts();
  const selectGroups = useMemo(() => createProjectGroupsSelector(), []);
  /*
    伙伴归属表。会话行本身不带 botId,归属只有伙伴档案知道 —— 档案还没加载完的
    那一瞬间这张表是空的,伙伴任务就走原来的分组落到别处,**不会消失**。
  */
  const botProfiles = useBotProfiles();
  const botOwnerBySessionId = useMemo(() => buildBotSessionOwners(botProfiles), [botProfiles]);

  const groups = useMemo(() => {
    if (equivalentResult) return equivalentResult;
    const groups = selectGroups(sessions, {
      projectAliases,
      includePinnedInProjects,
      botOwnerBySessionId,
      persistentLocalProjects,
      localPlatform,
    });
    return groups;
  }, [
    equivalentResult,
    selectGroups,
    sessions,
    projectAliases,
    includePinnedInProjects,
    persistentLocalProjects,
    localPlatform,
    sshHosts,
    botOwnerBySessionId,
  ]);
  const ambiguousDeviceNames = useMemo(
    () => collectAmbiguousDeviceNames(groups.projects),
    [groups.projects],
  );
  const ambiguityKey = JSON.stringify([...ambiguousDeviceNames].sort());
  // Preserve untouched project props as well as session props. Weak keys do not
  // retain old grouping generations; machine-directory changes invalidate all.
  const enrichedProjects = useMemo(
    () => new WeakMap<ProjectNode, ProjectNode>(),
    [sshHosts, ambiguityKey],
  );
  return useMemo(() => {
    if (equivalentResult) return equivalentResult;
    return {
      ...groups,
      projects: groups.projects.map((project) => {
        const cached = enrichedProjects.get(project);
        if (cached) return cached;
        const enriched = {
          ...project,
          remoteMachineIdentity: resolveRemoteProjectMachineIdentity(project, sshHosts, {
            ambiguousDeviceNames,
          }),
        };
        enrichedProjects.set(project, enriched);
        return enriched;
      }),
    };
  }, [groups, equivalentResult, enrichedProjects, sshHosts, ambiguousDeviceNames]);
}

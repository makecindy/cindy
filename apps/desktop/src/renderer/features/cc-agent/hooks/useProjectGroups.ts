/**
 * useProjectGroups — Sidebar 分组数据 hook
 * ---------------------------------------------------------------------------
 * 包 `groupSessions` 纯函数并用 useMemo 锁结果，避免 render 时重复计算。
 *
 * Row-only patches reuse membership and ordering, keeping unrelated nodes stable.
 */

import { useMemo, useSyncExternalStore } from 'react';
import { useStableTranslation } from '@/hooks/useStableTranslation';
import { createProjectGroupsSelector } from '../lib/projectGroupsSelector';
import { useProvisionalDraftProjectTaskId } from './useProvisionalDraftProjectTaskId';

import type { Session } from '@/lib/ccAgent.types';
import { useRemoteSshHosts } from '@/hooks/useRemoteSshHosts';
import { remoteProjectAliases } from '@/features/device-link/remoteProjectAliases';
import {
  type PersistentLocalProject,
  type ProjectGroupsResult,
  type ProjectNode,
} from '../lib/projectGrouping';
import {
  collectProjectDevices,
  resolveRemoteProjectMachineIdentity,
} from '../lib/remoteProjectIdentity';

export function useProjectGroups(
  sessions: readonly Session[],
  projectAliases?: ReadonlyMap<string, string>,
  includePinnedInProjects: boolean = false,
  persistentLocalProjects?: readonly PersistentLocalProject[],
  localPlatform: string = '',
  /** Reuse an earlier call when the activity filter did not change its inputs. */
  equivalentResult?: ProjectGroupsResult,
  projectAliasMembers?: readonly Session[],
): ProjectGroupsResult {
  const { i18n } = useStableTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const sshHosts = useRemoteSshHosts();
  const hostProjectAliases = useSyncExternalStore(remoteProjectAliases.subscribe, remoteProjectAliases.getSnapshot);
  const selectGroups = useMemo(() => createProjectGroupsSelector(), []);
  const provisionalDraftTaskId = useProvisionalDraftProjectTaskId();

  const groups = useMemo(() => {
    if (equivalentResult) return equivalentResult;
    return selectGroups(sessions, {
      projectAliases,
      remoteProjectAliases: hostProjectAliases,
      projectAliasMembers,
      includePinnedInProjects,
      persistentLocalProjects,
      localPlatform,
      provisionalDraftTaskId,
    });
  }, [
    equivalentResult,
    selectGroups,
    sessions,
    projectAliases,
    hostProjectAliases,
    projectAliasMembers,
    includePinnedInProjects,
    persistentLocalProjects,
    localPlatform,
    provisionalDraftTaskId,
  ]);
  const projectDevices = useMemo(
    () => collectProjectDevices(groups.projects),
    [groups.projects],
  );
  const ambiguityKey = JSON.stringify(projectDevices);
  // Weak keys keep only live grouping nodes. Registry/collision/language changes must
  // re-enrich even unchanged nodes so remote labels never retain stale names.
  const enrichedProjects = useMemo(
    () => new WeakMap<ProjectNode, ProjectNode>(),
    [sshHosts, ambiguityKey, language],
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
            devices: projectDevices,
          }),
        };
        enrichedProjects.set(project, enriched);
        return enriched;
      }),
    };
  }, [groups, equivalentResult, enrichedProjects, sshHosts, projectDevices, language]);
}

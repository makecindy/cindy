/**
 * useProjectsForPicker — 为 InstallTargetPicker 提供项目列表。
 *
 * 从 cc-agent 的 sessions 派生，按最近活跃倒序排列，与 SkillhubFeatureLayout
 * 共用同一 groupSessions 函数（不合并——职责不同：Layout 给 scanner 用，
 * 本 hook 给 picker 用）。
 *
 * 不持久化，每次 picker 打开重新派生（成本可忽略）。
 */

import { useMemo } from 'react';
import { isTeammateProjectPath } from '@cindy/maker-shared/teammate-project';

import { useCCSessions } from '@/hooks/useCCSessions';
import { groupSkillhubSessions } from '../lib/groupSkillhubSessions';
import { useProvisionalDraftProjectTaskId } from '@/features/cc-agent/hooks/useProvisionalDraftProjectTaskId';
import { useSkillhubTarget } from '../SkillhubTargetContext';

export interface PickerProject {
  projectRoot: string;
  displayName: string;
}

export function useProjectsForPicker(): { projects: PickerProject[]; loading: boolean } {
  const target = useSkillhubTarget();
  const { sessions, isLoading } = useCCSessions();
  const provisionalDraftTaskId = useProvisionalDraftProjectTaskId();
  const localPlatform = window.electronAPI?.platform ?? '';

  const projects = useMemo<PickerProject[]>(() => {
    if (isLoading) return [];
    const { projects: grouped } = groupSkillhubSessions(sessions, { provisionalDraftTaskId, localPlatform });
    return grouped.map((p) => ({
      projectRoot: p.workingDir,
      displayName: p.displayName,
    }));
  }, [sessions, isLoading, provisionalDraftTaskId, localPlatform]);

  const source = target ? target.projects : projects;
  // A teammate's own skills are managed from the teammate, not installed here.
  const pickable = useMemo(() => source.filter((p) => !isTeammateProjectPath(p.projectRoot)), [source]);
  return { projects: pickable, loading: target ? !target.state.bootstrapped : isLoading };
}

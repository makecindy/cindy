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

import { useCCSessions } from '@/hooks/useCCSessions';
import { useRemoteSshHosts } from '@/hooks/useRemoteSshHosts';
import { groupSessions } from '@/features/cc-agent/lib/projectGrouping';

export interface PickerProject {
  projectRoot: string;
  displayName: string;
}

export function useProjectsForPicker(): { projects: PickerProject[]; loading: boolean } {
  const { sessions, isLoading } = useCCSessions();
  const sshHosts = useRemoteSshHosts();

  const projects = useMemo<PickerProject[]>(() => {
    if (isLoading) return [];
    const { projects: grouped } = groupSessions(sessions, {
      remoteHostCandidates: sshHosts.map((host) => ({
        id: host.config.id,
        alias: host.config.alias,
        source: host.config.source,
      })),
    });
    return grouped.map((p) => ({
      projectRoot: p.workingDir,
      displayName: p.displayName,
    }));
  }, [sessions, isLoading, sshHosts]);

  return { projects, loading: isLoading };
}

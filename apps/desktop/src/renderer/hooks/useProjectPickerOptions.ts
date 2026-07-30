import { useMemo } from 'react';

import type { FolderPickerOption } from '@/components/new-chat/FolderPickerPopover';
import { extractDisplayName } from '@/features/cc-agent/lib/projectGrouping';
import { useRecentWorkdirs } from '@/hooks/useRecentWorkdirs';

export type ProjectPickerEmptyLabelMode = 'generic' | 'dialogue';

function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Shared project picker source for creation surfaces.
 *
 * The persistent recent_workdirs table is independent of live sessions, so a
 * project remains selectable after all sessions under it are archived/deleted.
 */
export function useProjectPickerOptions(): FolderPickerOption[] {
  const { entries } = useRecentWorkdirs();

  return useMemo<FolderPickerOption[]>(() => {
    const posixAll = entries.map((entry) => toPosixPath(entry.path));
    return entries.map((entry, idx) => {
      const posix = posixAll[idx];
      const { name } = extractDisplayName(posix, posixAll);
      return {
        path: entry.path,
        name,
        description: posix,
        missing: entry.exists === false,
      };
    });
  }, [entries]);
}

export function getProjectPickerDisplayName(
  cwd: string | null | undefined,
  projectOptions: readonly FolderPickerOption[] | undefined,
  deviceLinkDeviceId?: string | null,
): string | null {
  if (!cwd) return null;
  const normalizedCwd = toPosixPath(cwd);
  const selectedProject = projectOptions?.find((project) => {
    const pathMatches = project.path === cwd || toPosixPath(project.path) === normalizedCwd;
    if (!pathMatches) return false;
    return deviceLinkDeviceId
      ? project.remoteDevice?.deviceId === deviceLinkDeviceId
      : project.remoteDevice === undefined;
  });
  if (selectedProject) return selectedProject.name;
  const parts = normalizedCwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

export function getProjectPickerEmptyLabelKey(mode: ProjectPickerEmptyLabelMode): string {
  return mode === 'generic'
    ? 'newChat.folderPicker.dialogueOrSelectProject'
    : 'newChat.folderPicker.dialogue';
}

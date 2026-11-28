import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import type { ConfirmDialogCheckboxItem } from '@/components/ui/confirm-dialog';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  archiveConfirmDescription,
  archiveDeleteScheduleWarning,
  archiveScheduleWarning,
  type ActiveBoundSchedule,
} from '@/features/scheduler/lib/archiveScheduleWarning';
import { isDirtyWorktree, type WorktreeRemovalPreflight } from '@/lib/worktreeRemovalWarning';

const CHECKBOX_DISCARD_CHANGES = 'discard-changes';
const CHECKBOX_DELETE_SCHEDULES = 'delete-schedules';

export type TaskArchiveConfirmation =
  | boolean
  | 'discard'
  | {
      discardWorktreeChanges?: boolean;
      deleteSchedules?: readonly ActiveBoundSchedule[];
    };

export function normalizeTaskArchiveConfirmation(
  confirmation: TaskArchiveConfirmation,
): {
  confirmed: boolean;
  discardWorktreeChanges: boolean;
  deleteSchedules: readonly ActiveBoundSchedule[];
} {
  if (!confirmation) {
    return { confirmed: false, discardWorktreeChanges: false, deleteSchedules: [] };
  }
  if (confirmation === true) {
    return { confirmed: true, discardWorktreeChanges: false, deleteSchedules: [] };
  }
  if (confirmation === 'discard') {
    return { confirmed: true, discardWorktreeChanges: true, deleteSchedules: [] };
  }
  return {
    confirmed: true,
    discardWorktreeChanges: Boolean(confirmation.discardWorktreeChanges),
    deleteSchedules: confirmation.deleteSchedules ?? [],
  };
}

function normalizeSchedules(
  items: readonly (string | ActiveBoundSchedule)[],
): ActiveBoundSchedule[] {
  return items.map((item) =>
    typeof item === 'string'
      ? { id: item, name: item, deviceId: null, deletable: false }
      : item,
  );
}

export function useConfirmTaskArchive() {
  const { t } = useTranslation();
  const { confirm, confirmWithCheckboxes } = useConfirmDialog();

  return useCallback(async (
    preflight: WorktreeRemovalPreflight,
    schedules: readonly (string | ActiveBoundSchedule)[],
    target?: { title: string; description: string },
  ): Promise<TaskArchiveConfirmation> => {
    const normalizedSchedules = normalizeSchedules(schedules);
    const allScheduleNames = normalizedSchedules.map((s) => s.name);
    const deletableSchedules = normalizedSchedules.filter((s) => s.deletable);
    const deletableNames = deletableSchedules.map((s) => s.name);
    const keptNames = normalizedSchedules.filter((s) => !s.deletable).map((s) => s.name);

    const scheduleWarning = archiveScheduleWarning(t, allScheduleNames);
    const options = {
      title: target
        ? `${t('ccAgent.sidebar.confirmArchive.title')} · ${target.title}`
        : t('ccAgent.sidebar.confirmArchive.title'),
      confirmText: t('ccAgent.workdirBrowse.archiveSession.confirm'),
      cancelText: t('ccAgent.sidebar.confirmArchive.cancel'),
    };
    const saveWarning = isDirtyWorktree(preflight)
      ? t('ccAgent.sidebar.confirmArchive.dirtyWorktreeWarning')
      : '';
    const canDiscard = preflight === 'dirty-discardable';
    const canDeleteSchedules = deletableSchedules.length > 0;

    if (!canDiscard && !canDeleteSchedules) {
      return confirm({
        ...options,
        description: archiveConfirmDescription(
          t,
          { dirtyWorktree: Boolean(saveWarning), scheduleNames: allScheduleNames },
          target?.description,
        ),
      });
    }

    const checkboxes: ConfirmDialogCheckboxItem[] = [];
    if (canDiscard) {
      checkboxes.push({
        id: CHECKBOX_DISCARD_CHANGES,
        label: t('ccAgent.sidebar.confirmArchive.discardChanges'),
      });
    }
    if (canDeleteSchedules) {
      checkboxes.push({
        id: CHECKBOX_DELETE_SCHEDULES,
        label: t('ccAgent.sidebar.confirmArchive.deleteSchedules', {
          count: deletableNames.length,
        }),
      });
    }

    const defaultDescription = canDiscard
      ? [saveWarning, scheduleWarning].filter(Boolean).join(' ')
      : archiveConfirmDescription(
          t,
          { dirtyWorktree: Boolean(saveWarning), scheduleNames: allScheduleNames },
          target?.description,
        );

    const result = await confirmWithCheckboxes({
      ...options,
      description: defaultDescription,
      checkboxes,
      resolveCheckedOverrides: (checkedIds) => {
        const discard = checkedIds.has(CHECKBOX_DISCARD_CHANGES);
        const deleteSchedules = checkedIds.has(CHECKBOX_DELETE_SCHEDULES);
        if (!discard && !deleteSchedules) return undefined;

        const worktreePart = discard
          ? t('ccAgent.sidebar.confirmArchive.discardWarning')
          : saveWarning;
        const schedulePart = deleteSchedules
          ? [
              archiveDeleteScheduleWarning(t, deletableNames),
              archiveScheduleWarning(t, keptNames),
            ]
              .filter(Boolean)
              .join(' ')
          : scheduleWarning;
        const confirmText =
          discard && deleteSchedules
            ? t('ccAgent.sidebar.confirmArchive.discardDeleteAndArchive')
            : discard
              ? t('ccAgent.sidebar.confirmArchive.discardAndArchive')
              : t('ccAgent.sidebar.confirmArchive.deleteSchedulesAndArchive');

        return {
          description: [worktreePart, schedulePart].filter(Boolean).join(' '),
          confirmText,
          confirmVariant: 'destructive',
        };
      },
    });

    if (!result.ok) return false;
    const discard = result.checkedIds.includes(CHECKBOX_DISCARD_CHANGES);
    const deleteSchedules = result.checkedIds.includes(CHECKBOX_DELETE_SCHEDULES);
    if (deleteSchedules) {
      return {
        discardWorktreeChanges: discard,
        deleteSchedules: deletableSchedules,
      };
    }
    return discard ? 'discard' : true;
  }, [confirm, confirmWithCheckboxes, t]);
}

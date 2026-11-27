import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { archiveConfirmDescription, archiveScheduleWarning } from '@/features/scheduler/lib/archiveScheduleWarning';
import { isDirtyWorktree, type WorktreeRemovalPreflight } from '@/lib/worktreeRemovalWarning';

export function useConfirmTaskArchive() {
  const { t } = useTranslation();
  const { confirm, confirmWithCheckbox } = useConfirmDialog();

  return useCallback(async (
    preflight: WorktreeRemovalPreflight,
    scheduleNames: readonly string[],
    target?: { title: string; description: string },
  ): Promise<boolean | 'discard'> => {
    const scheduleWarning = archiveScheduleWarning(t, scheduleNames);
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
    if (preflight !== 'dirty-discardable') {
      return confirm({
        ...options,
        description: archiveConfirmDescription(t, { dirtyWorktree: Boolean(saveWarning), scheduleNames }, target?.description),
      });
    }

    const result = await confirmWithCheckbox({
      ...options,
      description: [saveWarning, scheduleWarning].filter(Boolean).join(' '),
      checkboxLabel: t('ccAgent.sidebar.confirmArchive.discardChanges'),
      checkedOverrides: {
        description: [
          t('ccAgent.sidebar.confirmArchive.discardWarning'),
          scheduleWarning,
        ].filter(Boolean).join(' '),
        confirmText: t('ccAgent.sidebar.confirmArchive.discardAndArchive'),
        confirmVariant: 'destructive',
      },
    });
    return result.ok && (result.checked ? 'discard' : true);
  }, [confirm, confirmWithCheckbox, t]);
}

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getComposerDraftSessionIds, subscribeAllDraftPresence } from '@/lib/composerDraftStore';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';

const log = createLogger('task-management');
export function useTaskArchiveProtection(
  ownerId: string | null,
  ownerGeneration: number,
  visible: string | string[] | null,
): void {
  const { t } = useTranslation();
  useEffect(() => {
    const api = window.electronAPI?.taskManagement;
    if (!ownerId || !api) return;
    const report = () => {
      void api
        .protect({
          ownerId,
          ownerGeneration,
          viewed: typeof visible === 'string' ? [visible] : (visible ?? []),
          drafts: getComposerDraftSessionIds(),
        })
        .catch(() => log.warn('Could not report task archive protection'));
    };
    report();
    const off = subscribeAllDraftPresence(report);
    window.addEventListener('focus', report);
    return () => {
      off();
      window.removeEventListener('focus', report);
    };
  }, [ownerId, ownerGeneration, visible]);
  useEffect(() => {
    const api = window.electronAPI?.taskManagement;
    if (!ownerId || !api) return;
    return api.onArchived((notice) => {
      if (notice.ownerId !== ownerId) return;
      toast.success(t('taskManagement.archivedNotice', { count: notice.count }), {
        duration: 8000,
        action: {
          label: t('taskManagement.undo'),
          onClick: () => {
            void api
              .undo(notice.batchId, { ownerId, ownerGeneration })
              .catch(() => toast.error(t('taskManagement.undoFailed')));
          },
        },
      });
    });
  }, [ownerId, ownerGeneration, t]);
}

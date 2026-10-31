import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';

export function ProjectAutomationNotifyBridge() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();

  useEffect(() => {
    let active = true;
    const shown = new Set<string>();
    const toastIds = new Set<string>();
    const controller = new AbortController();
    const offerImport = (pending: ProjectAutomationImport) => {
      if (!active) return;
      const key = `${pending.workingDir}\n${pending.configHash}`;
      if (shown.has(key)) return;
      shown.add(key);
      let reviewing = false;
      const toastId = toast.info(t('scheduler.projectAutomation.import.found', { projectName: lastPathSegment(pending.workingDir) }), {
        duration: 0,
        action: {
          label: t('scheduler.projectAutomation.import.review'),
          onClick: () => {
            if (!active || reviewing) return;
            reviewing = true;
            void (async () => {
              try {
                const accepted = await confirm({
                  title: t('scheduler.projectAutomation.import.title'),
                  description: t('scheduler.projectAutomation.import.description', { workingDir: pending.workingDir }),
                  confirmText: t('scheduler.projectAutomation.import.accept'),
                  contentSelectable: true,
                  maxWidth: 560,
                  content: <div className="text-sm text-foreground">
                    {pending.schedules.map((schedule, index) => <div key={index} className="mb-3">
                      <div className="font-medium break-words">{String(schedule.name ?? '')}</div>
                      <pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(schedule, null, 2)}</pre>
                    </div>)}
                    {pending.removedNames.length > 0 && <div className="whitespace-pre-wrap break-words">
                      {t('scheduler.projectAutomation.import.removed', { names: pending.removedNames.join('\n') })}
                    </div>}
                  </div>,
                }, controller.signal);
                if (!accepted || !active) return;
                const result = await window.electronAPI.maker.projectAutomation.reconcile({
                  workingDir: pending.workingDir, approvedHash: pending.configHash,
                });
                if (result.pendingImport) offerImport(result.pendingImport);
              } catch (error) {
                if (active) toast.error(error instanceof Error ? error.message : String(error));
              } finally {
                shown.delete(key);
              }
            })();
          },
        },
        onClose: () => {
          toastIds.delete(toastId);
          if (!reviewing) shown.delete(key);
        },
      });
      toastIds.add(toastId);
    };
    const unsubscribe = window.electronAPI.maker.projectAutomation.onEvent((event: ProjectAutomationEvent) => {
      if (event.type === 'import-required') {
        offerImport(event.pendingImport);
        return;
      }
      if (event.type !== 'reconciled') return;
      if (!event.hashChanged) return;
      const { inserted, updated, deleted, isFirstTime, workingDir } = event;
      if (inserted + updated + deleted === 0) return;

      const projectName = lastPathSegment(workingDir);
      const summary = t('scheduler.projectAutomation.toast.summary', {
        inserted,
        updated,
        deleted,
      });
      if (isFirstTime) {
        toast.success(t('scheduler.projectAutomation.toast.installed', { projectName, summary }));
      } else {
        toast.success(t('scheduler.projectAutomation.toast.updated', { projectName, summary }));
      }
    });
    // Startup discovery can complete before this bridge mounts. Re-read pending
    // imports instead of relying on a transient event as the only review entry.
    void window.electronAPI.maker.projectAutomation.listPendingImports()
      .then((pending) => pending.forEach(offerImport))
      .catch(() => { /* scheduler startup will emit discovery when ready */ });
    return () => {
      active = false;
      controller.abort();
      unsubscribe();
      toastIds.forEach((id) => toast.dismiss(id));
    };
  }, [confirm, t]);

  return null;
}

function lastPathSegment(input: string): string {
  return input.split(/[\\/]/).filter(Boolean).pop() ?? input;
}

/**
 * Batch plugin update dialog: rows stream through the unified Main install
 * transaction and only expose progress here.
 *
 * Inputs: live batch rows owned by the Plugin page runner plus row actions.
 * Outputs: progress presentation only; no IPC and no batch policy here.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import * as Dialog from '@radix-ui/react-dialog';
import { Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { GhostPluginIcon } from './GhostPluginIcon';
import { isBatchFinished, type UpdateAllRow } from './lib/updateAllModel';

interface UpdateAllDialogProps {
  open: boolean;
  rows: readonly UpdateAllRow[];
  iconByGhostId: ReadonlyMap<string, string | undefined>;
  /** 关弹窗;批量运行器继续在页面组件里跑(「后台继续」语义)。 */
  onClose: () => void;
}

/** 单行状态徽标(纯文字 + 图标,不用彩色圆点——绿色专职未读语义)。 */
function RowStatus({ row }: { row: UpdateAllRow }) {
  const { t } = useTranslation();
  if (row.status === 'done') {
    return (
      <span className="flex items-center gap-1.5 text-12 text-[var(--card-status-done)]">
        <Check size={14} aria-hidden="true" />
        {t('settings.ghosts.updateAll.statusDone')}
      </span>
    );
  }
  if (row.status === 'installing') {
    return (
      <span className="flex items-center gap-1.5 text-12 text-[var(--text-secondary)]">
        <Spinner size={13} />
        {t('settings.ghosts.updateAll.statusInstalling')}
      </span>
    );
  }
  if (row.status === 'skipped') {
    return (
      <span className="text-12 text-[var(--text-tertiary)]">
        {t('settings.ghosts.updateAll.statusSkipped')}
      </span>
    );
  }
  if (row.status === 'failed') {
    return (
      <span className="text-12 text-[var(--error-fg)]">
        {row.errorText ?? t('settings.ghosts.updateAll.statusFailed')}
      </span>
    );
  }
  return (
    <span className="text-12 text-[var(--text-tertiary)]">
      {t('settings.ghosts.updateAll.statusPending')}
    </span>
  );
}

export function UpdateAllDialog({
  open,
  rows,
  iconByGhostId,
  onClose,
}: UpdateAllDialogProps) {
  const { t } = useTranslation();
  const finished = isBatchFinished(rows);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]"
          style={WINDOW_NO_DRAG_STYLE}
        />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[10000] flex max-h-[70vh] w-[calc(100vw-48px)] max-w-[520px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-menu)] focus:outline-none"
          style={WINDOW_NO_DRAG_STYLE}
        >
          <div className="flex items-start gap-4 border-b-[0.5px] border-[var(--border-default)] px-6 py-5">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-18 font-medium">
                {t('settings.ghosts.updateAll.title', { count: rows.length })}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-13 leading-5 text-[var(--text-tertiary)]">
                {t('settings.ghosts.updateAll.description')}
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label={t('settings.ghosts.detail.closeDialog')}
              className="grid size-9 shrink-0 place-items-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              <X size={17} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <div className="overflow-y-auto px-6 py-2">
            {rows.map((row) => (
              <div
                key={row.pluginId}
                className="border-b-[0.5px] border-[var(--border-default)] py-3.5 last:border-b-0"
              >
                <div className="flex items-center gap-3">
                  <GhostPluginIcon
                    iconDataUrl={iconByGhostId.get(row.ghostId)}
                    iconId={row.ghostId}
                    iconName={row.name}
                    size="menu"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-13 font-medium leading-5">{row.name}</p>
                    <p className="text-11 text-[var(--text-tertiary)]">
                      {t('settings.ghosts.updateAll.versionRange', {
                        from: row.fromVersion,
                        to: row.toVersion,
                      })}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <RowStatus row={row} />
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-end gap-2 border-t-[0.5px] border-[var(--border-default)] px-6 py-4">
            <button
              type="button"
              onClick={onClose}
              className={cn(
                'inline-flex h-9 items-center rounded-full px-5 text-13 font-medium',
                finished
                  ? 'bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)] hover:bg-[var(--accent-hover)]'
                  : 'border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--surface-hover-soft)]',
                'transition-colors duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
              )}
            >
              {t(
                finished
                  ? 'settings.ghosts.updateAll.doneAction'
                  : 'settings.ghosts.updateAll.background',
              )}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

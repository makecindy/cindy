import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Info,
  ArrowRight,
  Archive,
  Copy,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Collapse } from '@/components/ui/collapse';
import { Spinner } from '@/components/ui/spinner';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { formatCheckoutError, type useCheckout } from '@/hooks/useCheckout';
import type { CheckoutStatus } from '../../../shared/worktreeCheckout';

export function CheckoutSessions({
  status,
  onUseWorktree,
}: {
  status: CheckoutStatus;
  onUseWorktree?: () => void;
}) {
  const { t } = useTranslation();
  const running = status.sessions.filter((s) => s.running);
  const vars = {
    count: running.length || status.sessions.length,
    name: (running[0] || status.sessions[0])?.name,
  };
  if (status.blocked === 'busy' && running.length)
    return (
      <div className="m-1 rounded-lg bg-[var(--surface-chip)] p-3" role="status">
        <div className="flex items-center gap-2">
          <Spinner size={14} aria-hidden />
          <span
            className="min-w-0 truncate text-13 font-medium"
            title={t(`newChat.checkout.runningTitle${vars.count === 1 ? '_one' : ''}`, vars)}
          >
            {t(`newChat.checkout.runningTitle${vars.count === 1 ? '_one' : ''}`, vars)}
          </span>
        </div>
        <div className="ml-[22px] mt-1 space-y-2 text-12 text-[var(--text-secondary)]">
          <p>
            {t(
              `newChat.checkout.${onUseWorktree ? 'runningWithWorktree' : 'runningWait'}${vars.count === 1 ? '_one' : ''}`,
              vars,
            )}
          </p>
          {onUseWorktree && (
            <Button compact size="sm" variant="secondary" onClick={onUseWorktree}>
              {t('newChat.checkout.startWorktree')}
            </Button>
          )}
        </div>
      </div>
    );
  if (status.blocked || !status.sessions.length) return null;
  return (
    <div
      className="flex items-center gap-1 px-2 py-2 text-12 text-[var(--text-secondary)]"
      role="status"
    >
      <Info size={14} className="shrink-0" aria-hidden />
      <span
        className="min-w-0 flex-1 truncate"
        title={t(`newChat.checkout.idleSessions${vars.count === 1 ? '_one' : ''}`, vars)}
      >
        {t(`newChat.checkout.idleSessions${vars.count === 1 ? '_one' : ''}`, vars)}
      </span>
      {onUseWorktree && (
        <Button compact tone="quiet" size="sm" className="px-1" onClick={onUseWorktree}>
          {t('newChat.checkout.useWorktree')}
        </Button>
      )}
    </div>
  );
}

/** The same conflict detail appears in feedback, the dialog and the branch menu. */
export function CheckoutError({
  code,
  status,
  branch,
}: {
  code: string;
  status?: CheckoutStatus;
  branch?: string;
}) {
  const { t } = useTranslation();
  return <span className="break-words">{formatCheckoutError(t, code, status, branch)}</span>;
}

/** Persistent recovery lives in the popover, never in the controls row. */
export function CheckoutStashes({ checkout }: { checkout: ReturnType<typeof useCheckout> }) {
  const { t } = useTranslation();
  return checkout.status?.stashes.length ? (
    <div className="space-y-1">
      {checkout.status.stashes.map((stash) => (
        <CheckoutNotice
          key={stash.id}
          action={
            <Button
              compact
              size="sm"
              variant="secondary"
              disabled={
                checkout.busy || !!checkout.status?.blocked || !!checkout.status?.files.length
              }
              onClick={() => void checkout.restore(stash.id)}
            >
              {t('newChat.checkout.restore')}
            </Button>
          }
        >
          {t('newChat.checkout.savedChanges', { branch: stash.branch })}
        </CheckoutNotice>
      ))}
    </div>
  ) : null;
}

export function CheckoutNotice({
  children,
  action,
  warning = false,
}: {
  children: ReactNode;
  action?: ReactNode;
  warning?: boolean;
}) {
  const Icon = warning ? AlertTriangle : Info;
  return (
    <div
      className="flex items-start text-left gap-2 px-3 py-2 text-12 text-foreground"
      role={warning ? 'alert' : 'status'}
    >
      <Icon
        size={14}
        aria-hidden
        className={
          warning
            ? 'mt-0.5 shrink-0 text-[var(--warning-fg)]'
            : 'mt-0.5 shrink-0 text-muted-foreground'
        }
      />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2 break-words">
        <div className="min-w-[140px] flex-1">{children}</div>
        {action}
      </div>
    </div>
  );
}

export function CheckoutDialog({
  checkout,
  onUseWorktree,
}: {
  checkout: ReturnType<typeof useCheckout>;
  onUseWorktree?: (branch?: string) => void;
}) {
  const { t } = useTranslation();
  const { dialog, busy } = checkout;
  const [strategy, setStrategy] = useState<'carry' | 'stash' | 'worktree'>('carry');
  const [filesOpen, setFilesOpen] = useState(false);
  const filesId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  useEffect(() => {
    setStrategy(dialog?.status.carryAllowed ? 'carry' : 'stash');
    setFilesOpen(false);
  }, [dialog]);
  useEffect(() => {
    if (strategy === 'worktree' && !onUseWorktree)
      setStrategy(dialog?.status.carryAllowed ? 'carry' : 'stash');
  }, [strategy, onUseWorktree, dialog]);
  const target = dialog?.branch.replace(/^refs\/remotes\//, '') ?? '';
  const vars = { branch: target, current: dialog?.status.current };
  const idle = dialog?.status.sessions.filter((s) => !s.running) ?? [];
  return (
    <Dialog.Root
      open={!!dialog}
      onOpenChange={(open) => {
        if (!open && !busy) checkout.closeDialog();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" />
        <Dialog.Content
          style={WINDOW_NO_DRAG_STYLE}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            cancel.current?.focus();
          }}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
          className="modal-panel fixed left-1/2 top-1/2 z-[10000] flex max-h-[85vh] w-[calc(100vw-32px)] max-w-[460px] -translate-x-1/2 -translate-y-1/2 flex-col gap-2 p-4"
        >
          <Dialog.Title className="break-words text-18 font-medium text-[var(--confirm-title)]">
            {t('newChat.checkout.title', vars)}
          </Dialog.Title>
          <div className="min-h-0 overflow-y-auto space-y-2 text-13">
            <div className="flex items-center justify-between gap-2">
              <Dialog.Description className="break-words text-[var(--confirm-desc)]">
                {t('newChat.checkout.dirtyDescription', {
                  branch: dialog?.status.current,
                  count: dialog?.status.files.length,
                })}
              </Dialog.Description>
              <Button
                compact
                tone="quiet"
                size="sm"
                aria-expanded={filesOpen}
                aria-controls={filesId}
                onClick={() => setFilesOpen(!filesOpen)}
              >
                {t(`newChat.checkout.${filesOpen ? 'hideFiles' : 'showFiles'}`)}
                {filesOpen ? (
                  <ChevronUp size={14} aria-hidden />
                ) : (
                  <ChevronDown size={14} aria-hidden />
                )}
              </Button>
            </div>
            <Collapse open={filesOpen} id={filesId}>
              <div className="rounded-lg bg-[var(--surface-chip)] px-3 py-1">
                <ul className="text-12">
                  {dialog?.status.files.slice(0, 3).map((file) => {
                    const detail = dialog.status.fileDetails?.[file];
                    return (
                      <li key={file} className="flex min-h-6 items-center gap-3" title={file}>
                        <span className="flex min-w-0 flex-1 font-mono" aria-label={file}>
                          <span className="min-w-0 overflow-hidden whitespace-nowrap">
                            {file.slice(0, Math.ceil(file.length / 2))}
                          </span>
                          <span dir="rtl" className="max-w-[50%] shrink-0 truncate text-left">
                            <bdi dir="ltr">{file.slice(Math.ceil(file.length / 2))}</bdi>
                          </span>
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {detail?.kind === 'new'
                            ? t('newChat.checkout.newFile')
                            : detail?.kind === 'deleted'
                              ? t('newChat.checkout.deletedFile')
                              : detail?.added !== undefined && detail.removed !== undefined
                                ? `+${detail.added} −${detail.removed}`
                                : ''}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {dialog && dialog.status.files.length > 3 && (
                  <p className="text-12 text-muted-foreground">
                    {t('newChat.checkout.moreFiles', { count: dialog.status.files.length - 3 })}
                  </p>
                )}
              </div>
            </Collapse>
            <div className="flex items-center justify-between gap-2">
              <span className="text-13 font-medium">{t('newChat.checkout.question')}</span>
              <span className="text-12 text-[var(--text-tertiary)]">
                {t('newChat.checkout.noLoss')}
              </span>
            </div>
            <div
              role="radiogroup"
              aria-label={t('newChat.checkout.question')}
              className="overflow-hidden rounded-xl border border-[var(--border-default)] divide-y divide-[var(--border-default)]"
            >
              {(['carry', 'stash', ...(onUseWorktree ? (['worktree'] as const) : [])] as const).map(
                (choice) => {
                  const disabled = !!busy || (choice === 'carry' && !dialog?.status.carryAllowed);
                  const Icon =
                    choice === 'carry' ? ArrowRight : choice === 'stash' ? Archive : Copy;
                  return (
                    <label
                      key={choice}
                      className={`relative flex cursor-pointer items-center gap-3 px-3 py-2 ${disabled ? 'cursor-not-allowed' : 'hover:bg-[var(--surface-hover)]'} ${strategy === choice ? 'bg-[var(--surface-chip)]' : ''}`}
                    >
                      <span
                        className={`${disabled ? 'opacity-60' : ''} flex size-[30px] shrink-0 items-center justify-center rounded-lg ${strategy === choice ? 'bg-[var(--confirm-btn-primary-bg)] text-[var(--confirm-btn-primary-text)]' : 'bg-[var(--surface-chip)] text-[var(--text-secondary)]'}`}
                      >
                        <Icon size={16} aria-hidden />
                      </span>
                      <input
                        type="radio"
                        aria-label={t(`newChat.checkout.${choice}`, {
                          branch: choice === 'carry' ? target : dialog?.status.current,
                        })}
                        aria-describedby={`${descriptionId}-${choice}`}
                        name="checkout-strategy"
                        value={choice}
                        checked={strategy === choice}
                        disabled={disabled}
                        onChange={() => setStrategy(choice)}
                        className="peer sr-only"
                      />
                      <span className="min-w-0 flex-1 break-words">
                        <span className={`block font-medium ${disabled ? 'opacity-60' : ''}`}>
                          {t(`newChat.checkout.${choice}`, {
                            branch: choice === 'carry' ? target : dialog?.status.current,
                          })}
                        </span>
                        <span
                          id={`${descriptionId}-${choice}`}
                          className="block text-12 text-[var(--text-secondary)]"
                        >
                          {t(
                            `newChat.checkout.${choice === 'carry' && !dialog?.status.carryAllowed ? 'carryConflict' : choice + 'Description'}`,
                            vars,
                          )}
                        </span>
                      </span>
                      <span
                        aria-hidden
                        className={`${disabled ? 'opacity-60' : ''} flex size-4 shrink-0 items-center justify-center rounded-full peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--focus-ring)] border-[1.5px] border-[var(--text-tertiary)] ${strategy === choice ? 'bg-[var(--text-primary)] border-[var(--text-primary)]' : ''}`}
                      >
                        {strategy === choice && (
                          <span className="size-1.5 rounded-full bg-[var(--confirm-bg)]" />
                        )}
                      </span>
                    </label>
                  );
                },
              )}
            </div>
          </div>
          {!!idle.length && (
            <div className="flex items-start gap-2 text-12 text-[var(--text-secondary)]">
              <Info size={14} className="shrink-0 mt-0.5" aria-hidden />
              <span>
                {t(`newChat.checkout.dialogSessions${idle.length === 1 ? '_one' : ''}`, {
                  count: idle.length,
                  name: idle[0].name,
                  branch: target,
                })}
              </span>
            </div>
          )}
          <div className="flex shrink-0 justify-end gap-2">
            <div className="ml-auto flex flex-row-reverse gap-2">
              <Button
                compact
                size="sm"
                palette="confirmation"
                variant="primary"
                className="min-h-9"
                disabled={
                  busy ||
                  (strategy !== 'worktree' && !!dialog?.status.blocked) ||
                  (strategy === 'carry' && !dialog?.status.carryAllowed)
                }
                onClick={() =>
                  dialog &&
                  (strategy === 'worktree'
                    ? onUseWorktree?.(dialog.branch)
                    : void checkout.performSwitch(dialog.branch, dialog.status, strategy))
                }
              >
                {t(
                  `newChat.checkout.${strategy === 'worktree' ? 'startWorktree' : strategy + 'Confirm'}`,
                )}
              </Button>
              <Button
                compact
                ref={cancel}
                size="sm"
                palette="confirmation"
                variant="secondary"
                className="min-h-9"
                disabled={busy}
                onClick={checkout.closeDialog}
              >
                {t('commonUi.confirmDialog.cancel')}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

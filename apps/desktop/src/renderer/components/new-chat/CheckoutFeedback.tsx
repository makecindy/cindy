import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { Tip } from '@/components/ui/tooltip';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { formatCheckoutError, type useCheckout } from '@/hooks/useCheckout';
import type { CheckoutStatus } from '../../../shared/worktreeCheckout';

/** Every explicit worktree alternative uses the checkbox's existing preference callback. */
export function UseWorktreeButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Button compact size="sm" variant="secondary" disabled={disabled} onClick={onClick}>
      {t('newChat.checkout.useWorktree')}
    </Button>
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
  const [strategy, setStrategy] = useState<'carry' | 'stash'>('carry');
  const cancel = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  useEffect(() => {
    setStrategy(dialog?.status.carryAllowed ? 'carry' : 'stash');
  }, [dialog]);
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
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            cancel.current?.focus();
          }}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
          className="modal-panel fixed left-1/2 top-1/2 z-[10000] flex max-h-[85vh] w-[calc(100vw-32px)] max-w-[460px] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 p-4"
        >
          <Dialog.Title className="break-words text-18 font-medium text-[var(--confirm-title)]">
            {t('newChat.checkout.title', vars)}
          </Dialog.Title>
          <div className="min-h-0 overflow-y-auto space-y-4 text-13">
            <Dialog.Description className="break-words text-[var(--confirm-desc)]">
              {t('newChat.checkout.dirtyDescription', {
                branch: dialog?.status.current,
                count: dialog?.status.files.length,
              })}
            </Dialog.Description>
            {!!idle.length && (
              <p className="text-muted-foreground">
                {t('newChat.checkout.dialogSessions', { count: idle.length, branch: target })}
              </p>
            )}
            <ul className="max-h-[140px] overflow-y-auto border-y border-border py-1 text-12">
              {dialog?.status.files.map((file) => {
                const detail = dialog.status.fileDetails?.[file];
                return (
                  <li key={file} className="flex min-h-7 items-center gap-3" title={file}>
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
            <div
              role="radiogroup"
              aria-label={t('newChat.checkout.title', vars)}
              className="space-y-2"
            >
              {(['carry', 'stash'] as const).map((choice) => {
                const disabled = !!busy || (choice === 'carry' && !dialog?.status.carryAllowed);
                return (
                  <label
                    key={choice}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 focus-within:ring-2 focus-within:ring-[var(--focus-ring)] ${disabled ? 'cursor-not-allowed' : 'hover:bg-accent'} ${strategy === choice ? 'border-foreground bg-accent' : 'border-border'}`}
                  >
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
                      className={`mt-0.5 size-4 shrink-0 accent-[var(--text-primary)] ${disabled ? 'opacity-50' : ''}`}
                    />
                    <span className="min-w-0 break-words">
                      <span className={`block font-medium ${disabled ? 'opacity-50' : ''}`}>
                        {t(`newChat.checkout.${choice}`, {
                          branch: choice === 'carry' ? target : dialog?.status.current,
                        })}
                      </span>
                      <span
                        id={`${descriptionId}-${choice}`}
                        className="mt-1 block text-12 text-muted-foreground"
                      >
                        {t(
                          `newChat.checkout.${choice === 'carry' && !dialog?.status.carryAllowed ? 'carryConflict' : choice + 'Description'}`,
                          vars,
                        )}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {onUseWorktree && (
              <Tip text={t('newChat.checkout.worktreeHint', vars)} contentClassName="z-[10001]">
                <Button
                  compact
                  variant="secondary"
                  tone="quiet"
                  size="sm"
                  disabled={busy}
                  onClick={() => onUseWorktree(dialog?.branch)}
                >
                  {t('newChat.checkout.useWorktree')}
                </Button>
              </Tip>
            )}
            <div className="ml-auto flex flex-row-reverse gap-2">
              <Button
                compact
                size="sm"
                palette="confirmation"
                variant="primary"
                className="min-h-9"
                disabled={
                  busy ||
                  !!dialog?.status.blocked ||
                  (strategy === 'carry' && !dialog?.status.carryAllowed)
                }
                onClick={() =>
                  dialog && void checkout.performSwitch(dialog.branch, dialog.status, strategy)
                }
              >
                {t('newChat.checkout.confirmSwitch')}
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

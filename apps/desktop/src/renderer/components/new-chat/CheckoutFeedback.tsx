import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { useCheckout } from '@/hooks/useCheckout';

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
    <Button size="sm" variant="secondary" disabled={disabled} onClick={onClick}>
      {t('newChat.checkout.useWorktree')}
    </Button>
  );
}

export function CheckoutFeedback({
  checkout,
  onUseWorktree,
}: {
  checkout: ReturnType<typeof useCheckout>;
  onUseWorktree?: (branch?: string) => void;
}) {
  const { t } = useTranslation();
  const { dialog, receipt, status, busy } = checkout;
  const target = dialog?.branch.replace(/^refs\/remotes\//, '') ?? '';
  const idle = receipt?.sessions
    .filter((s) => !s.running)
    .map((s) => s.name)
    .join(', ');
  const count = dialog?.status.sessions.length ?? 0;
  return (
    <>
      {checkout.error || checkout.worktreeNotice || receipt || status?.stashes.length ? (
        <div role="status" className="mt-2 space-y-1 break-words text-12 text-muted-foreground">
          {checkout.error && <p>{t(`newChat.checkout.errors.${checkout.error}`)}</p>}
          {checkout.worktreeNotice && <p>{t('newChat.checkout.worktreeDefault')}</p>}
          {receipt && (
            <div>
              <span>
                {t('newChat.checkout.switched', { branch: receipt.to })}
                {receipt.hadChanges
                  ? t(`newChat.checkout.${receipt.strategy === 'stash' ? 'stashed' : 'carried'}`)
                  : ''}
              </span>
              <Button
                size="xs"
                variant="secondary"
                disabled={busy}
                onClick={() => void checkout.undo()}
                className="ml-2"
              >
                {t('newChat.checkout.undo')}
              </Button>
              {idle && (
                <p>{t('newChat.checkout.sessionsContinue', { names: idle, branch: receipt.to })}</p>
              )}
            </div>
          )}
          {status?.stashes.map((stash) => (
            <div key={stash.id} className="flex flex-wrap items-center gap-2">
              <span>{t('newChat.checkout.savedChanges', { branch: stash.branch })}</span>
              <Button
                size="xs"
                variant="secondary"
                disabled={busy || !!status.blocked || !!status.files.length}
                onClick={() => void checkout.restore(stash.id)}
              >
                {t('newChat.checkout.restore')}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      <Dialog.Root
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open && !busy) checkout.closeDialog();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" />
          <Dialog.Content
            onPointerDownOutside={(event) => event.preventDefault()}
            onEscapeKeyDown={(event) => {
              if (busy) event.preventDefault();
            }}
            className="modal-panel fixed left-1/2 top-1/2 z-[10000] flex max-h-[85vh] w-[calc(100vw-32px)] max-w-[460px] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 p-4"
          >
            <Dialog.Title className="break-words text-16 font-medium text-[var(--confirm-title)]">
              {t('newChat.checkout.title', { branch: target })}
            </Dialog.Title>
            <Dialog.Description className="break-words text-13 text-[var(--confirm-desc)]">
              {t('newChat.checkout.dirtyDescription', {
                branch: dialog?.status.current,
                count: dialog?.status.files.length,
              })}
            </Dialog.Description>
            <div className="min-h-0 overflow-y-auto text-13">
              <ul className="max-h-40 overflow-y-auto border-y border-border py-2 font-mono text-12 text-muted-foreground">
                {dialog?.status.files.map((file) => (
                  <li key={file} className="break-all">
                    {file}
                  </li>
                ))}
              </ul>
              {!dialog?.status.carryAllowed && (
                <p className="mt-2 text-muted-foreground">
                  {t('newChat.checkout.errors.conflict')}
                </p>
              )}
              {checkout.error && (
                <p className="mt-2 text-muted-foreground">
                  {t(`newChat.checkout.errors.${checkout.error}`)}
                </p>
              )}
              {onUseWorktree && (
                <div className="mt-3 space-y-2 rounded-xl border border-border p-3 text-muted-foreground">
                  <p>
                    {t(
                      count
                        ? 'newChat.checkout.worktreeGuideSessions'
                        : 'newChat.checkout.worktreeGuide',
                      { branch: target, count },
                    )}
                  </p>
                  <UseWorktreeButton
                    disabled={busy}
                    onClick={() => onUseWorktree(dialog?.branch)}
                  />
                </div>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              <Button
                variant="primary"
                size="sm"
                className="min-w-0 max-w-full"
                disabled={busy || !dialog?.status.carryAllowed || !!dialog?.status.blocked}
                onClick={() =>
                  dialog && void checkout.performSwitch(dialog.branch, dialog.status, 'carry')
                }
              >
                <span className="truncate" title={t('newChat.checkout.carry', { branch: target })}>
                  {t('newChat.checkout.carry', { branch: target })}
                </span>
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="min-w-0 max-w-full"
                disabled={busy || !!dialog?.status.blocked}
                onClick={() =>
                  dialog && void checkout.performSwitch(dialog.branch, dialog.status, 'stash')
                }
              >
                <span
                  className="truncate"
                  title={t('newChat.checkout.stash', { branch: dialog?.status.current })}
                >
                  {t('newChat.checkout.stash', { branch: dialog?.status.current })}
                </span>
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={checkout.closeDialog}>
                {t('commonUi.confirmDialog.cancel')}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Building2, Check, Plus, UserRound, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';
import { useOptionalConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Tip } from '@/components/ui/tooltip';
import { useAuth } from '@/contexts/AuthContext';
import type { DesktopSavedAccount } from '@/lib/authService';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

interface AccountSwitcherDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddAccount: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

function AccountAvatar({ account }: { account: DesktopSavedAccount }) {
  const [imageFailed, setImageFailed] = useState(false);
  const imageUrl = account.kind === 'org' ? account.orgLogoUrl : account.avatarUrl;

  useEffect(() => setImageFailed(false), [imageUrl]);

  if (imageUrl && !imageFailed) {
    return (
      <img
        src={imageUrl}
        alt=""
        className="h-10 w-10 shrink-0 rounded-full object-cover"
        onError={() => setImageFailed(true)}
      />
    );
  }

  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--surface-hover)] text-[var(--text-secondary)]">
      {account.kind === 'org' ? (
        <Building2 className="h-5 w-5" aria-hidden="true" />
      ) : (
        <UserRound className="h-5 w-5" aria-hidden="true" />
      )}
    </span>
  );
}

export function AccountSwitcherDialog({
  open,
  onOpenChange,
  onAddAccount,
  triggerRef,
}: AccountSwitcherDialogProps) {
  const { listAccounts, syncAccounts, switchAccount } = useAuth();
  const confirmDialog = useOptionalConfirmDialog();
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<DesktopSavedAccount[]>([]);
  const [mutationAllowed, setMutationAllowed] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [switchingKey, setSwitchingKey] = useState<string | null>(null);
  const [addingAccount, setAddingAccount] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setSyncing(true);

    void listAccounts()
      .then((snapshot) => {
        if (!active) return;
        setAccounts(snapshot.accounts);
        setMutationAllowed(snapshot.mutationAllowed);
      })
      .then(() => syncAccounts())
      .then((snapshot) => {
        if (!active) return;
        setAccounts(snapshot.accounts);
        setMutationAllowed(snapshot.mutationAllowed);
      })
      .catch(() => {
        if (active) toast.error(t('sidebar.accountSwitcher.syncFailed'));
      })
      .finally(() => {
        if (active) setSyncing(false);
      });

    return () => {
      active = false;
    };
  }, [listAccounts, open, syncAccounts, t]);

  const confirmRunningTaskInterruption = async (): Promise<boolean> => {
    // Lazy-load the task store only when the user requests an account boundary
    // change. The dialog is mounted with the sidebar shell, while chat runtime is not.
    const { makerChatStore } = await import('@/lib/makerChatStore');
    const hasRunningTask = [...makerChatStore.getRunningSnapshot().values()].some(
      (status) => status.isRunning,
    );
    if (!hasRunningTask) return true;
    // Full app windows always provide the shared confirmation host. Standalone
    // story/test mounts fail closed instead of changing accounts without consent.
    if (!confirmDialog) return false;
    return confirmDialog.confirm({
      title: t('sidebar.accountSwitcher.runningTaskTitle'),
      description: t('sidebar.accountSwitcher.runningTaskDescription'),
      confirmText: t('sidebar.accountSwitcher.runningTaskConfirm'),
      cancelText: t('logic.confirm.cancel'),
      confirmVariant: 'destructive',
    });
  };

  const handleSwitch = async (account: DesktopSavedAccount) => {
    if (account.isCurrent || switchingKey || addingAccount || !mutationAllowed) return;
    setSwitchingKey(account.accountKey);

    try {
      if (!(await confirmRunningTaskInterruption())) return;

      // Main owns the account boundary: it stops and drains the outgoing runtime
      // before committing the selected account, so this await is also the stop barrier.
      await switchAccount(account.accountKey);
      onOpenChange(false);
    } catch {
      toast.error(t('sidebar.accountSwitcher.switchFailed'));
    } finally {
      setSwitchingKey(null);
    }
  };

  const handleAddAccount = async () => {
    if (switchingKey || addingAccount || !mutationAllowed) return;
    setAddingAccount(true);
    try {
      if (!(await confirmRunningTaskInterruption())) return;
      onAddAccount();
    } catch {
      toast.error(t('sidebar.accountSwitcher.switchFailed'));
    } finally {
      setAddingAccount(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)] data-[state=open]:animate-confirm-overlay-in data-[state=closed]:animate-confirm-overlay-out"
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        />
        <Dialog.Content
          ref={contentRef}
          tabIndex={-1}
          className={cn(
            'fixed left-1/2 top-1/2 z-[10000] w-[420px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2',
            'select-none rounded-xl bg-[var(--confirm-bg)] p-5 shadow-[var(--confirm-shadow)]',
            'data-[state=open]:animate-confirm-content-in data-[state=closed]:animate-confirm-content-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <Dialog.Title className="pr-10 text-18 font-medium text-[var(--confirm-title)]">
            {t('sidebar.accountSwitcher.title')}
          </Dialog.Title>
          <Dialog.Description className="mt-1 pr-10 text-13 text-[var(--confirm-desc)]">
            {t('sidebar.accountSwitcher.description')}
          </Dialog.Description>
          <Dialog.Close asChild>
            <Tip
              text={t('sidebar.accountSwitcher.close')}
              side="bottom"
              contentClassName="z-[10001]"
            >
              <button
                type="button"
                aria-label={t('sidebar.accountSwitcher.close')}
                className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-[var(--confirm-desc)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--confirm-title)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </Tip>
          </Dialog.Close>

          <div className="mt-4 max-h-[360px] space-y-1 overflow-y-auto" aria-live="polite">
            {accounts.map((account) => {
              const switching = switchingKey === account.accountKey;
              const hasDistinctOrgName =
                account.kind === 'org' &&
                Boolean(account.orgName?.trim()) &&
                account.orgName !== account.displayName;
              const primaryLabel = hasDistinctOrgName ? account.orgName : account.displayName;
              const secondaryLabel =
                account.kind === 'org' && hasDistinctOrgName ? account.displayName : account.email;
              return (
                <button
                  key={account.accountKey}
                  type="button"
                  disabled={
                    account.isCurrent ||
                    switchingKey !== null ||
                    addingAccount ||
                    !mutationAllowed
                  }
                  onClick={() => void handleSwitch(account)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
                    'hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                    'disabled:cursor-default disabled:opacity-100',
                  )}
                >
                  <AccountAvatar account={account} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-14 font-medium text-[var(--text-primary)]">
                      {primaryLabel}
                    </span>
                    {secondaryLabel ? (
                      <span className="mt-0.5 block truncate text-12 text-[var(--text-secondary)]">
                        {secondaryLabel}
                      </span>
                    ) : null}
                  </span>
                  {switching ? (
                    <Spinner size={16} className="text-[var(--text-secondary)]" />
                  ) : account.isCurrent ? (
                    <Check
                      className="h-4 w-4 shrink-0 text-[var(--text-primary)]"
                      aria-hidden="true"
                    />
                  ) : null}
                </button>
              );
            })}
            {syncing ? (
              <div className="flex items-center justify-center gap-2 py-3 text-12 text-[var(--text-secondary)]">
                <Spinner size={14} />
                {t('sidebar.accountSwitcher.syncing')}
              </div>
            ) : null}
          </div>

          <div className="mt-4 border-t border-[var(--border-default)] pt-4">
            <button
              type="button"
              disabled={!mutationAllowed || switchingKey !== null || addingAccount}
              onClick={() => void handleAddAccount()}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2.5 text-14 font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('sidebar.accountSwitcher.addAccount')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

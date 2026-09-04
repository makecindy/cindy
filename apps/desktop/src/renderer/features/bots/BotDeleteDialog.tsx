import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { BotProfile } from './botStore';
import { runBotLifecycleAction } from './botStore';

/** Destructive confirmation owned by the roster, where teammate deletion lives. */
export function BotDeleteDialog({
  bot,
  onOpenChange,
  onDeleted,
}: {
  bot: BotProfile | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: (botId: string) => void;
}) {
  const { t } = useTranslation();
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setConfirmName('');
    setFailed(false);
  }, [bot?.id]);

  if (!bot) return null;

  const deleteBot = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await runBotLifecycleAction({
        botId: bot.id,
        action: 'delete',
        confirmName,
        keepTaskHistory: true,
        worktreeDisposition: 'retain',
      });
      onOpenChange(false);
      onDeleted(bot.id);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !busy && onOpenChange(open)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-[var(--overlay-modal)]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[71] w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 outline-none">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-16 font-medium text-[var(--text-danger)]">
                {t('bots.lifecycle.deleteTitle')}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
                {t('bots.lifecycle.deleteDescription', { name: bot.name })}
              </Dialog.Description>
            </div>
            <Dialog.Close
              disabled={busy}
              aria-label={t('bots.close')}
              className="rounded-lg p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
            >
              <X size={16} />
            </Dialog.Close>
          </div>
          <label className="mt-4 block text-12 text-[var(--text-secondary)]">
            {t('bots.lifecycle.confirmName', { name: bot.name })}
            <input
              value={confirmName}
              onChange={(event) => setConfirmName(event.target.value)}
              className="mt-2 h-9 w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface)] px-3 text-12 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
            />
          </label>
          {failed ? (
            <p className="mt-3 text-11 text-[var(--text-danger)]" role="alert">
              {t('bots.lifecycle.actionFailed')}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close
              disabled={busy}
              className="h-9 rounded-lg px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
            >
              {t('bots.cancel')}
            </Dialog.Close>
            <button
              type="button"
              onClick={() => void deleteBot()}
              disabled={busy || confirmName !== bot.name}
              className="h-9 rounded-lg bg-[var(--text-danger)] px-4 text-12 font-medium text-white disabled:opacity-50"
            >
              {busy ? t('bots.lifecycle.working') : t('bots.lifecycle.delete')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

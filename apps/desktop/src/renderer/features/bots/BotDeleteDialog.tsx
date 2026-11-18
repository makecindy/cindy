import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';

import type { BotProfile } from './botStore';
import { useBotSettingsTarget } from './useBotSettingsTarget';

/**
 * Shared destructive confirmation for the roster and teammate settings.
 * Built on the shared ConfirmDialog (DESIGN.md §4 Dialog & Modal): no parallel
 * dialog shell, no top-right × beside Cancel.
 */
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
  const target = useBotSettingsTarget();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [bot?.id]);

  if (!bot) return null;

  const deleteBot = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await target.lifecycle.run({
        botId: bot.id,
        action: 'delete',
        confirmName: bot.name,
        keepTaskHistory: true,
        worktreeDisposition: 'retain',
      });
      onOpenChange(false);
      onDeleted(bot.id);
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open
      // The confirm action closes the AlertDialog right after onConfirm; keep it
      // open while the deletion runs so a failure can be shown in place.
      onOpenChange={(open) => {
        if (!open && inFlight.current) return;
        onOpenChange(open);
      }}
      title={t('bots.lifecycle.deleteTitle')}
      description={t('bots.lifecycle.deleteDescription', { name: bot.name })}
      content={
        failed ? (
          <p className="text-13 text-[var(--text-danger)]" role="alert">
            {t('bots.lifecycle.deleteFailed')}
          </p>
        ) : undefined
      }
      cancelText={t('bots.cancel')}
      confirmText={t('bots.lifecycle.delete')}
      confirmVariant="destructive"
      loading={busy}
      onConfirm={() => void deleteBot()}
    />
  );
}

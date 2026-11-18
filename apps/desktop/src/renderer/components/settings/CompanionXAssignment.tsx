import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';

/**
 * Who the official X account's questions go to, and assigning it to or releasing it from one teammate.
 * The teammate's channel page shows it for a teammate on this computer (inside the X card of
 * `HookConnectionsSection`) and for one on another computer (`RemoteOfficialXCard`); both pass the call
 * that changes the assignment on the computer that runs X.
 */
export function CompanionXAssignment({
  companion,
  companionBotId,
  assign,
  unavailable,
  onFailed,
  settingId,
}: {
  companion: { id: string; name: string };
  /** The teammate the account is assigned to now, if any. */
  companionBotId: string | null;
  /** `expectedBotId` is the assignment this change replaces, so a concurrent change is not overwritten. */
  assign(assign: boolean, expectedBotId: string | null): Promise<void>;
  /** Shown instead of the assign button while this teammate cannot be assigned here. */
  unavailable?: ReactNode;
  onFailed?(): void;
  settingId?: string;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const bound = companionBotId === companion.id;

  const change = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      const ok = await confirm({
        title: t(`bots.channels.officialX.${bound ? 'removeTitle' : 'bindTitle'}`, { name: companion.name }),
        description: t(`bots.channels.officialX.${bound ? 'removeBody' : 'bindBody'}`, { name: companion.name }),
        confirmText: t(`bots.channels.officialX.${bound ? 'remove' : 'bind'}`),
      });
      if (!ok) return;
      await assign(!bound, companionBotId);
    } catch {
      toast.error(t('settings.remoteControl.hook.toast.actionFailed'));
      onFailed?.();
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  return (
    <>
      <p className="text-12 leading-relaxed text-[var(--text-secondary)]">
        {t(
          bound
            ? 'bots.channels.officialX.bound'
            : companionBotId
              ? 'bots.channels.officialX.boundElsewhere'
              : 'bots.channels.officialX.unbound',
          { name: companion.name },
        )}
      </p>
      {unavailable && !bound ? unavailable : (
        <Button data-setting-id={settingId}
          data-settings-search-action="Assign or unassign the official X account to this teammate"
          variant="secondary" size="sm" type="button"
          loading={pending} disabled={pending} onClick={() => void change()}>
          {t(bound ? 'bots.channels.officialX.remove' : 'bots.channels.officialX.bind')}
        </Button>
      )}
    </>
  );
}

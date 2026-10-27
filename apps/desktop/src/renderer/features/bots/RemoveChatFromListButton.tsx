import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { chatErrorKey } from './chatError';
import { refreshBotGroups } from './botGroupStore';

/** A historical membership may remove its list entry even when the snapshot is forbidden. */
export function RemoveChatFromListButton({ groupId, onRemoved }: { groupId: string; onRemoved(): void }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, [groupId]);
  return <Button variant="secondary" size="lg" compact disabled={busy} onClick={async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    const owner = getDataOwnerGeneration();
    const current = () => active.current && isDataOwnerGenerationCurrent(owner);
    try {
      if (!await confirm({ presentation: 'standard', title: t('bots.groupChat.lifecycle.hide'), description: t('bots.groupChat.lifecycle.hideNote'),
        confirmText: t('bots.groupChat.lifecycle.hide'), cancelText: t('bots.cancel'), confirmVariant: 'destructive' }) || !current()) return;
      const result = await window.electronAPI.maker.chatServer.manage({ groupId, action: { type: 'hide' } });
      if (!current()) return;
      if (!result.ok) toast.error(t(chatErrorKey(result.errorCode)));
      else { refreshBotGroups(); onRemoved(); }
    } catch { if (current()) toast.error(t(chatErrorKey('REQUEST_FAILED'))); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }}>{t('bots.groupChat.lifecycle.hide')}</Button>;
}

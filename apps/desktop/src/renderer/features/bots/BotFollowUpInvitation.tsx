import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerIdCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { setBotSchedulerBotId, useBotAutonomySettings } from './botStore';

/** A local invitation after a user sends a message; showing it never runs a model or reads tasks. */
export function BotFollowUpInvitation({ botId, engaged }: { botId: string; engaged: boolean }) {
  const { t } = useTranslation();
  const settings = useBotAutonomySettings();
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  if (!engaged || !settings || settings.isCustomized || settings.schedulerBotId !== null) return null;

  const choose = async (enable: boolean) => {
    if (saving.current) return;
    saving.current = true;
    setPending(true);
    const owner = getDataOwnerGeneration();
    try {
      // null is an explicit choice too: do not ask again after "Not now".
      await setBotSchedulerBotId(enable ? botId : null);
    } catch {
      if (isDataOwnerGenerationCurrent(owner)) toast.error(t('bots.autonomy.saveFailed'));
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  return <BotFollowUpInvitationCard pending={pending} onChoose={choose} />;
}

export function BotFollowUpInvitationCard({ pending, onChoose, consent }: {
  pending: boolean; onChoose(enable: boolean): void | Promise<void>; consent?: string;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  // 卡片只占一行；读什么、会用模型额度在开启前的确认框里完整说明（与设置页同一确认），确认后才保存。
  const scope = consent ?? t('bots.autonomy.consent');
  // 确认框挂在账号层之上，卡片卸载（例如切换账号）时一并关掉；回来的结果只认发起时的账号和仍在的卡片。
  // 连点只排一个确认框。
  const asking = useRef(false);
  const mounted = useRef(true);
  const dialog = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      dialog.current?.abort();
    };
  }, []);
  const start = async () => {
    if (asking.current || pending) return;
    asking.current = true;
    const owner = getDataOwnerGeneration();
    const controller = new AbortController();
    dialog.current = controller;
    try {
      const accepted = await confirm({
        presentation: 'standard',
        title: t('bots.autonomy.invitation.title'),
        description: scope,
        confirmText: t('bots.autonomy.invitation.start'),
        cancelText: t('bots.autonomy.invitation.notNow'),
      }, controller.signal);
      // 同一账号内的代次修复不卸载卡片，确认仍有效；换了账号才丢弃。
      if (accepted && mounted.current && isDataOwnerIdCurrent(owner)) await onChoose(true);
    } finally {
      asking.current = false;
      if (dialog.current === controller) dialog.current = null;
    }
  };
  return (
    <section
      className="flex w-full flex-wrap items-center justify-end gap-x-2 gap-y-1 rounded-xl border border-[var(--border-default)] py-1.5 pl-3 pr-1.5"
      aria-label={t('bots.autonomy.invitation.title')}
    >
      <p className="min-w-[8rem] flex-1 text-13 leading-5 text-[var(--text-primary)]">{t('bots.autonomy.invitation.title')}</p>
      <Button variant="cta" size="sm" disabled={pending} onClick={() => void start()}>{t('bots.autonomy.invitation.start')}</Button>
      <Button variant="secondary" tone="quiet" size="sm" disabled={pending} onClick={() => void onChoose(false)}>{t('bots.autonomy.invitation.notNow')}</Button>
    </section>
  );
}

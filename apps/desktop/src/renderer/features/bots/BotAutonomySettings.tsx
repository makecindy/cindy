/**
 * 伙伴设置「例行任务」页顶部的两项自动跟进设置。
 *
 * - 自动跟进所有任务：账号里只有一个伙伴负责（默认关闭）。在这里打开 = 把它移到
 *   这位伙伴，原来负责的伙伴的开关随宿主推送自动关上；开启前说明读取范围与用量，关闭直接生效。
 *   只在用户改过时显示「恢复默认」，恢复 = 删除 override（docs/dev-rules/configuration-and-overrides.md）。
 * - 它开的任务也交给负责所有任务的伙伴跟：每伙伴的能力位（默认关 = 只看不跟），随伙伴设置自动保存；
 *   负责所有任务的伙伴自己、以及当前没有伙伴负责时不显示。
 * - 主人关掉了这位伙伴的系统技能「跟进」：它不能负责所有任务，开关置灰并说明，由技能里那一个开关决定；
 *   宿主同样不把它当总调度，但保留原来的选择，重新打开技能后恢复。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Switch } from '@/components/ui/switch';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { useBotSettingsTarget } from './useBotSettingsTarget';

const TITLE_CLASS = 'text-13 font-medium leading-5 text-[var(--text-primary)]';
const HINT_CLASS = 'mt-1 text-12 leading-5 text-[var(--text-secondary)]';

export function BotAutonomySettings({
  botId,
  botName,
  allowSchedulerFollow,
  onAllowSchedulerFollowChange,
  followOff = false,
}: {
  botId: string;
  botName: string;
  allowSchedulerFollow: boolean;
  onAllowSchedulerFollowChange: (value: boolean) => void;
  /** capabilities.systemSkillsOff 含 follow。 */
  followOff?: boolean;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const target = useBotSettingsTarget();
  const settings = target.autonomy.useSettings();
  const profiles = target.useRoster();
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const currentBot = useRef(botId); currentBot.current = botId;
  const [movedFrom, setMovedFrom] = useState<string | null>(null);
  useEffect(() => setMovedFrom(null), [botId]);

  if (!settings) return null;
  const nameOf = (id: string | null) => (id ? (profiles.find((bot) => bot.id === id)?.name ?? null) : null);
  const holderId = settings.schedulerBotId;
  const isHolder = holderId === botId;
  const holderName = nameOf(holderId);

  const run = (operation: () => Promise<void>, onDone?: () => void) => {
    if (saving.current) return;
    saving.current = true;
    setPending(true);
    const owner = getDataOwnerGeneration();
    void operation()
      .then(() => { if (isDataOwnerGenerationCurrent(owner) && currentBot.current === botId) onDone?.(); })
      .catch(() => { if (isDataOwnerGenerationCurrent(owner)) toast.error(t('bots.autonomy.saveFailed')); })
      .finally(() => { saving.current = false; setPending(false); });
  };

  const toggle = (next: boolean) => {
    const owner = getDataOwnerGeneration();
    const previous = holderId && holderId !== botId ? holderName : null;
    run(async () => {
      if (next && !await confirm({
        presentation: 'standard',
        title: t('bots.autonomy.invitation.title'),
        description: t('bots.autonomy.consent'),
        confirmText: t('bots.autonomy.invitation.start'),
        cancelText: t('bots.autonomy.invitation.notNow'),
      })) return;
      if (!isDataOwnerGenerationCurrent(owner) || currentBot.current !== botId) return;
      await target.autonomy.setSchedulerBotId(next ? botId : null);
      if (isDataOwnerGenerationCurrent(owner) && currentBot.current === botId) setMovedFrom(next ? previous : null);
    });
  };

  const status = isHolder
    ? movedFrom
      ? t('bots.autonomy.movedFrom', { name: movedFrom })
      : t('bots.autonomy.descriptionOn', { name: botName })
    : holderName
      ? t('bots.autonomy.heldBy', { name: holderName })
      : t('bots.autonomy.heldByNobody');

  return (
    <section className="flex flex-col gap-5 border-b border-[var(--border-default)] pb-5 pt-3" aria-label={t('bots.autonomy.title')}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className={TITLE_CLASS}>{t('bots.autonomy.title')}</p>
          <p className={HINT_CLASS} role="status">{status}</p>
          <p className={HINT_CLASS}>
            {followOff ? t('bots.systemSkills.followOffHint', { name: botName }) : t('bots.autonomy.routineScopeHint')}
          </p>
          {settings.isCustomized ? (
            <Button
              variant="secondary"
              size="xs"
              compact
              tone="quiet"
              className="-ml-3 mt-1"
              disabled={pending}
              onClick={() => run(target.autonomy.reset, () => setMovedFrom(null))}
            >
              {t('settings.defaults.restore')}
            </Button>
          ) : null}
        </div>
        <Switch
          aria-label={t('bots.autonomy.title')}
          className="mt-0.5 shrink-0"
          checked={isHolder}
          disabled={pending || followOff}
          onCheckedChange={(value) => toggle(value === true)}
        />
      </div>
      {!isHolder && holderId && holderName ? (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className={TITLE_CLASS}>{t('bots.autonomy.allowSchedulerFollow.title', { name: holderName })}</p>
            <p className={HINT_CLASS}>
              {t('bots.autonomy.allowSchedulerFollow.description', { name: botName, scheduler: holderName })}
            </p>
          </div>
          <Switch
            aria-label={t('bots.autonomy.allowSchedulerFollow.title', { name: holderName })}
            className="mt-0.5 shrink-0"
            checked={allowSchedulerFollow}
            onCheckedChange={(value) => onAllowSchedulerFollowChange(value === true)}
          />
        </div>
      ) : null}
    </section>
  );
}

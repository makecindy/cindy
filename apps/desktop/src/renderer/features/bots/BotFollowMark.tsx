import { Tip } from '@/components/ui/tooltip';
import { useStableTranslation as useTranslation } from '@/hooks/useStableTranslation';
import { BotAvatar } from './BotAvatar';
import type { TaskBotIdentity } from './botFollowScopes';

export { useSessionFollowers } from './botFollowScopes';

/**
 * 普通任务行上的创建者／跟进者：优先显示创建者的 14px 头像，归档后仍保留。
 * 悬停区分创建与跟进关系。没有伙伴归属时不占位。
 * 行组件用 `useSessionFollowers(session)` 取伙伴列表,自己决定要不要为标记让位。
 */
export function BotFollowMark({ followers }: { followers: readonly TaskBotIdentity[] }) {
  const { t, i18n } = useTranslation();
  const first = followers[0];
  if (!first) return null;
  const formatter = new Intl.ListFormat(i18n.language, { style: 'long', type: 'conjunction' });
  const creators = followers.filter(bot => bot.taskRelation === 'created');
  const owners = followers.filter(bot => bot.taskRelation === 'owned');
  const responsible = followers.filter(bot => !bot.taskRelation);
  const label = [
    owners.length ? t('bots.workbench.ownedMark', { names: formatter.format(owners.map(bot => bot.name)) }) : '',
    creators.length ? t('bots.workbench.createdMark', { names: formatter.format(creators.map(bot => bot.name)) }) : '',
    responsible.length ? t('bots.workbench.followingMark', { names: formatter.format(responsible.map(bot => bot.name)) }) : '',
  ].filter(Boolean).join('\n');
  return (
    <Tip text={label}>
      <span role="img" aria-label={label} className="inline-flex shrink-0" data-testid="bot-follow-mark">
        <BotAvatar bot={first} size="xs" className="h-3.5 w-3.5 text-10" />
      </span>
    </Tip>
  );
}

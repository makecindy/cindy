import { Tip } from '@/components/ui/tooltip';
import { useStableTranslation as useTranslation } from '@/hooks/useStableTranslation';
import { BotAvatar } from './BotAvatar';
import type { BotProfile } from './botStore';

export { useSessionFollowers } from './botFollowScopes';

/**
 * 普通任务行上的「<伙伴>在跟进」:这件任务所在的项目交给了哪个伙伴。只显示第一位伙伴的
 * 14px 头像(头像底色是伙伴身份,不是状态),悬停说明全部伙伴。没有伙伴跟进时不占位。
 * 行组件用 `useSessionFollowers(session)` 取伙伴列表,自己决定要不要为标记让位。
 */
export function BotFollowMark({ followers }: { followers: readonly BotProfile[] }) {
  const { t, i18n } = useTranslation();
  const first = followers[0];
  if (!first) return null;
  const names = new Intl.ListFormat(i18n.language, { style: 'long', type: 'conjunction' })
    .format(followers.map((bot) => bot.name));
  const label = t('bots.workbench.followingMark', { names });
  return (
    <Tip text={label}>
      <span role="img" aria-label={label} className="inline-flex shrink-0" data-testid="bot-follow-mark">
        <BotAvatar bot={first} size="xs" className="h-3.5 w-3.5 text-10" />
      </span>
    </Tip>
  );
}

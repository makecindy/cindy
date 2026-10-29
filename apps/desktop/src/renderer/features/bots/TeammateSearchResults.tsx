import { Users } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { BotAvatar } from './BotAvatar';
import { useBotGroupList } from './botGroupStore';
import { filterBotRoster, sortBotRoster } from './botRosterDisplay';
import { useBotProfiles } from './botStore';
import { useCompanionCloud } from './companionCloudStore';
import { cloudRemoteBots, withoutShadowedBots } from './companionCloudPresentation';
import { useRemoteBots } from './useRemoteBots';

export interface TeammateSearchMatch {
  key: string;
  kind: 'bot' | 'group';
  name: string;
  /** 已归档的群:段内不再列出,只能从这里找回。 */
  archived?: boolean;
  detail: string;
  route: string;
  avatar: Parameters<typeof BotAvatar>[0]['bot'] | null;
}

/**
 * 侧栏总搜索里的伙伴 / 群聊命中(2026-10-13:伙伴段不再有独立搜索框)。
 * 本机伙伴按名字、简介、技能匹配,含已隐藏、不含已停止;远程伙伴按名字、简介、电脑名;
 * 群聊按群名与成员名,含已归档的群(段内不列出,在这里找回)。只读已有的名册投影,不发起额外查询。
 * 锁定任务分组时不搜索名册，避免组内搜索混入伙伴或群聊。
 */
export function useTeammateSearchMatches(
  rawQuery: string,
  lockedSessionGroupName: string | null,
): TeammateSearchMatch[] {
  const cloud = useCompanionCloud();
  const allBots = useBotProfiles();
  const rosterRemoteBots = useRemoteBots();
  // 与伙伴段同一份名册:隐藏已交给别的电脑的本机副本,每个云端伙伴只在主力电脑上列一行。
  const bots = useMemo(() => withoutShadowedBots(allBots, cloud), [allBots, cloud]);
  const remoteBots = useMemo(() => cloudRemoteBots(cloud, rosterRemoteBots), [rosterRemoteBots, cloud]);
  const { groups } = useBotGroupList();
  return useMemo(() => {
    const query = rawQuery.trim().toLocaleLowerCase();
    if (!query || lockedSessionGroupName !== null) return [];
    const includes = (...values: Array<string | null | undefined>) =>
      values.some((value) => Boolean(value) && value!.toLocaleLowerCase().includes(query));
    const local = filterBotRoster(
      sortBotRoster(bots.filter((bot) => bot.status !== 'archived')),
      query,
    ).map((bot): TeammateSearchMatch => ({
      key: `bot:${bot.id}`,
      kind: 'bot',
      name: bot.name,
      detail: bot.description,
      route: `/bots/${bot.id}`,
      avatar: bot,
    }));
    const remote = remoteBots
      .filter((bot) => includes(bot.name, bot.description, bot.deviceName))
      .map((bot): TeammateSearchMatch => ({
        key: `remote:${bot.deviceId}:${bot.id}`,
        kind: 'bot',
        name: bot.name,
        detail: bot.deviceName,
        route: `/bots/remote/${encodeURIComponent(bot.deviceId)}/${encodeURIComponent(bot.id)}`,
        avatar: bot,
      }));
    const groupMatches = groups
      .filter((group) => includes(group.name, ...group.members.map((member) => member.name)))
      .map((group): TeammateSearchMatch => ({
        key: `group:${group.id}`,
        kind: 'group',
        name: group.name,
        archived: Boolean(group.archived),
        detail: group.members.map((member) => member.name).join('、'),
        route: `/bots/groups/${encodeURIComponent(group.id)}`,
        avatar: group.members[0] ?? null,
      }));
    return [...local, ...remote, ...groupMatches];
  }, [bots, remoteBots, groups, rawQuery, lockedSessionGroupName]);
}

/** 与会话结果行同几何(rounded-lg、px-3 py-2.5、20px 标记、13 号标题、类型小标签)。 */
export function TeammateSearchResults({
  matches,
  onSelected,
}: {
  matches: readonly TeammateSearchMatch[];
  /** 选中后的附加动作;内联展开态默认保留查询,便于连续点开。 */
  onSelected?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (matches.length === 0) return null;
  return (
    <div data-teammate-search-results>
      {matches.map((match) => (
        <button
          key={match.key}
          type="button"
          onClick={() => {
            navigate(match.route);
            onSelected?.();
          }}
          className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-[var(--cmd-palette-item-hover)]"
        >
          {match.avatar ? (
            <BotAvatar bot={match.avatar} size="xs" className="mt-0.5" />
          ) : (
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--cmd-palette-item-icon)]">
              <Users size={13} />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--text-primary)]">{match.name}</span>
              {match.archived ? (
                <span className="shrink-0 text-10 leading-none text-[var(--text-tertiary)]">{t('bots.archived')}</span>
              ) : null}
              <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-1.5 py-0.5 text-10 leading-none text-[var(--text-tertiary)]">
                {match.kind === 'group' ? t('bots.groupChat.sidebar.title') : t('bots.title')}
              </span>
            </span>
            {match.detail ? (
              <span className="mt-1 block truncate text-11 leading-none text-[var(--text-tertiary)]">{match.detail}</span>
            ) : null}
          </span>
        </button>
      ))}
    </div>
  );
}

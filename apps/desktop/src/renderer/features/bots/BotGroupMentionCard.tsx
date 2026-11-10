import { useTranslation } from 'react-i18next';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import type { BotGroupMemberView, BotGroupMention } from '../../../shared/botGroupChat';
import { BotAvatar } from './BotAvatar';
import { botGroupMemberDisplayName } from './BotGroupTimelineModel';

const key = (name: string) => `bots.groupChat.server.settings.${name}`;

/**
 * Prefer explicit mention ids. Server snapshots currently omit those ids, so they may
 * fall back to a unique roster name; ambiguous names and broadcast labels never guess.
 */
export function botGroupMentionMember(label: string, members: readonly BotGroupMemberView[],
  mentions: BotGroupMention, allLabel: string, serverBacked = false): BotGroupMemberView | undefined {
  const name = label.replace(/^@/, '').trim();
  const fallback = serverBacked && !mentions.all && !mentions.allBots && mentions.botIds.length === 0;
  // The sender's locale can differ from the reader's; cover every shipped broadcast label.
  const broadcast = [allLabel, '所有人', '全員', '모두', 'all', 'everyone'].some((label) => label.toLowerCase() === name.toLowerCase());
  if ((mentions.all || fallback) && broadcast) return undefined;
  const botBroadcast = ['所有伙伴', '所有夥伴', 'すべての仲間', '모든 동료', 'all teammates', 'bots'].some(label => label.toLowerCase() === name.toLowerCase());
  if ((mentions.allBots || fallback) && botBroadcast) return undefined;
  const mentioned = new Set(mentions.botIds);
  const matches = members.filter((member) => (fallback || mentioned.has(member.botId))
    && [member.name, botGroupMemberDisplayName(member), member.nickname || member.displayName || member.name]
      .some((candidate) => candidate?.trim() === name));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Who a mention names, shown while the pointer rests on it: avatar, name and what they are in the
 * group (a teammate and whose it is, or a person's role). Read-only; the pointer can move onto it.
 */
export function BotGroupMentionCard({ member, anchor, onPointerEnter, onPointerLeave }: {
  member: BotGroupMemberView | null;
  /** The mention's box, relative to the message text. */
  anchor: { left: number; top: number; width: number; height: number } | null;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const { t } = useTranslation();
  const open = Boolean(member && anchor);
  const role = member
    ? member.actorKind === 'bot' || (!member.actorKind && !member.role)
      ? member.ownerName ? t(key('companionOf'), { name: member.ownerName }) : null
      : t(key(member.role === 'owner' ? 'owner' : member.role === 'admin' ? 'admin' : member.role === 'guest' ? 'guest' : 'member'))
    : null;
  const status = !member || member.status === 'active' ? ''
    : member.status === 'paused' ? t('bots.groupChat.memberStatus.paused') : t('bots.groupChat.memberStatus.unavailable');
  const fullName = member?.nickname && member.displayName && member.nickname !== member.displayName ? member.displayName : null;
  return (
    <Popover open={open}>
      <PopoverAnchor asChild>
        <span aria-hidden className="pointer-events-none absolute"
          style={anchor ? { left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height } : { left: 0, top: 0 }} />
      </PopoverAnchor>
      {member ? (
        <PopoverContent side="bottom" align="start" sideOffset={6} data-bot-group-mention-card=""
          className="flex w-64 items-center gap-3 p-3"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
          <BotAvatar bot={member} size="md" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-14 font-medium leading-5 text-[var(--text-primary)]">{botGroupMemberDisplayName(member)}</span>
            {fullName ? <span className="truncate text-12 leading-4 text-[var(--text-secondary)]">{fullName}</span> : null}
            {role || status ? (
              <span className="truncate text-12 leading-4 text-[var(--text-tertiary)]">{[role, status].filter(Boolean).join(' · ')}</span>
            ) : null}
          </span>
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

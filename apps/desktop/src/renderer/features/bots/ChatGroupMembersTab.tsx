/**
 * 群设置「成员」标签：搜索 + 一张成员卡。每行头像、名字（别人带来的伙伴带主人名）和
 * 身份一行；能操作的成员在行尾有「⋯」，右键同一行打开同一个菜单。菜单项只出现自己
 * 能做的：自己的伙伴调「在本群的权限」，群主/管理员设管理员、转让群主（只转给人）、移出。
 */
import { useState } from 'react';
import { MoreHorizontal, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import type { BotGroupMemberView, BotGroupSummary } from '../../../shared/botGroupChat';
import { BotAvatar } from './BotAvatar';
import { botGroupMemberDisplayName } from './BotGroupTimelineModel';
import { SETTINGS_DIVIDER, SETTINGS_HINT, SettingsCard, SettingsRow, SettingsSection } from './ChatGroupSettingsRows';

const key = (name: string) => `bots.groupChat.server.settings.${name}`;
const shared = (name: string) => `bots.groupChat.settings.${name}`;
export const ACCESS_LABELS = { none: key('accessNone'), chat: key('accessChat'), tools: key('accessTools') } as const;

export interface MemberActions {
  /** Your own teammate's 在本群的权限 page. */
  access(member: BotGroupMemberView): void;
  role(member: BotGroupMemberView): void;
  transfer(member: BotGroupMemberView): void;
  remove(member: BotGroupMemberView): void;
}

export function ChatGroupMembersTab({ group, owner, manager, busy, actions }: {
  group: BotGroupSummary; owner: boolean; manager: boolean; busy: boolean; actions: MemberActions;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const shown = needle ? group.members.filter(member => botGroupMemberDisplayName(member).toLocaleLowerCase().includes(needle)) : group.members;
  return <>
    <div className="relative">
      <Search size={16} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
      <Input size="sm" value={query} onChange={setQuery} placeholder={t(key('searchMembers'))} aria-label={t(key('searchMembers'))} inputClassName="pl-9" />
    </div>
    <SettingsSection title={t(shared('members'))} count={shown.length} testId="chat-group-members">
      {shown.length
        ? <SettingsCard>{shown.map(member => <MemberRow key={member.actorId ?? member.botId} member={member} group={group}
          owner={owner} manager={manager} busy={busy} actions={actions} />)}</SettingsCard>
        : <p className={`py-4 text-center [overflow-wrap:anywhere] ${SETTINGS_HINT}`}>{t(key('membersNoMatch'), { query: query.trim() })}</p>}
    </SettingsSection>
  </>;
}

function MemberRow({ member, group, owner, manager, busy, actions }: {
  member: BotGroupMemberView; group: BotGroupSummary; owner: boolean; manager: boolean; busy: boolean; actions: MemberActions;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const name = botGroupMemberDisplayName(member);
  const bot = member.actorKind === 'bot';
  const paused = bot && member.status === 'paused';
  const mine = bot && member.isOwned === true;
  // Owners manage everyone but themselves; admins manage everyone but the owner.
  const manageable = manager && !member.isSelf && !!member.actorId && (owner || member.role !== 'owner');
  // Ownership goes to a person, including yourself when your teammate holds it.
  const transferable = owner && !!member.actorId && member.actorKind === 'human' && member.role !== 'owner';
  const menuable = !group.dissolvedAt && (manageable || transferable || (mine && !!member.actorId));
  const hint = bot
    ? `${t(key('teammateTag'))} · ${t(paused ? key('paused') : ACCESS_LABELS[member.guestAccess ?? 'chat'])}`
    : t(key(member.role ?? 'member'));
  // The wrapper carries the card divider: the row inside is always its first child.
  return <div className={SETTINGS_DIVIDER} onContextMenu={menuable ? event => { event.preventDefault(); setOpen(true); } : undefined}>
    <SettingsRow media lead={<BotAvatar bot={member} size="sm" className={paused ? 'h-8 w-8 opacity-60' : 'h-8 w-8'} />}
      title={name} tag={member.isSelf ? t(key('you')) : undefined} hint={hint}
      trailing={menuable ? <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={name} data-testid="chat-group-member-menu" disabled={busy}
            className="-mr-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] outline-none hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] data-[state=open]:bg-[var(--surface-hover)]">
            <MoreHorizontal size={16} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          {mine && <DropdownMenuItem onSelect={() => actions.access(member)}>{t(key('accessMenu'))}</DropdownMenuItem>}
          {manageable && <DropdownMenuItem onSelect={() => actions.role(member)}>{t(key(member.role === 'admin' ? 'removeAdmin' : 'makeAdmin'))}</DropdownMenuItem>}
          {transferable && <DropdownMenuItem onSelect={() => actions.transfer(member)}>{t(key('transfer'))}</DropdownMenuItem>}
          {manageable && <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="danger" onSelect={() => actions.remove(member)}>{t(shared('remove'))}</DropdownMenuItem>
          </>}
        </DropdownMenuContent>
      </DropdownMenu> : undefined} />
  </div>;
}

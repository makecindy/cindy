/**
 * 群聊唯一的「邀请」入口：群头和群设置里是同一个下拉菜单，每位成员看到的都一样。
 * 「邀请朋友」生成链接（ChatInviteDialog），只有群主和管理员能用，其他人看到灰色原因；
 * 「邀请伙伴」在同一个菜单里展开自己的伙伴，搜索 + 虚拟列表，上万位也只渲染看得见的
 * 几行，点一下直接加入。能用哪几项跟着服务端：链接看 `canInvite`，带自己的伙伴所有已
 * 加入成员都可以（bot-group-chat.md §5）。
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Bot, ChevronDown, ChevronLeft, ChevronRight, Link2, Plus, Search, UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { menuSkipAttrs } from '@/components/ui/menu-row';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { BotGroupSummary } from '../../../shared/botGroupChat';
import { BotAvatar } from './BotAvatar';
import { ChatInviteDialog } from './ChatInviteDialog';
import { chatErrorKey } from './chatError';
import { refreshBotGroups } from './botGroupStore';
import { useBotProfiles } from './botStore';

const key = (name: string) => `bots.groupChat.server.settings.${name}`;
// Only opened when the account has no teammate yet, so it loads on demand.
const BotRosterView = lazy(() => import('./BotRosterView').then(module => ({ default: module.BotRosterView })));
const api = () => window.electronAPI.maker.chatServer;
/** A search field appears once the list no longer fits at a glance. */
const SEARCH_FROM = 7;
const ROW_HEIGHT = 32;

type OwnedBot = { actorId: string; botId?: string; name: string };
type OwnedBots = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; bots: OwnedBot[] };

export function ChatGroupInviteMenu({ group, variant }: {
  group: Pick<BotGroupSummary, 'id' | 'members' | 'canInvite'>;
  /** `pill` in the settings hero, `icon` in the group header. */
  variant: 'pill' | 'icon';
}) {
  const { t } = useTranslation();
  const profiles = useBotProfiles();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'root' | 'bots'>('root');
  const [query, setQuery] = useState('');
  const [owned, setOwned] = useState<OwnedBots>({ status: 'loading' });
  const [dialog, setDialog] = useState<'link' | 'create' | null>(null);
  const adding = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // Read the account's teammates each time the menu opens; they change outside this group.
  useEffect(() => {
    if (!open) return;
    let stale = false;
    const generation = getDataOwnerGeneration();
    setOwned({ status: 'loading' });
    void api().ownedBots().then(result => {
      if (!stale && isDataOwnerGenerationCurrent(generation)) setOwned(result.ok ? { status: 'ready', bots: result.bots } : { status: 'failed' });
    }).catch(() => { if (!stale) setOwned({ status: 'failed' }); });
    return () => { stale = true; };
  }, [open, group.id]);

  const addable = useMemo(() => owned.status === 'ready'
    ? owned.bots.filter(bot => !group.members.some(member => member.actorId === bot.actorId)) : [], [owned, group.members]);
  const needle = query.trim().toLocaleLowerCase();
  const shown = useMemo(() => needle ? addable.filter(bot => bot.name.toLocaleLowerCase().includes(needle)) : addable, [addable, needle]);
  const profileById = useMemo(() => new Map(profiles.map(profile => [profile.id, profile])), [profiles]);

  const reset = () => { setView('root'); setQuery(''); };
  async function add(bot: OwnedBot) {
    if (adding.current) return;
    adding.current = true;
    const generation = getDataOwnerGeneration();
    try {
      const result = await api().manage({ groupId: group.id, action: { type: 'member', actorId: bot.actorId, action: 'invite' } });
      if (!isDataOwnerGenerationCurrent(generation)) return;
      if (!result.ok) { toast.error(t(chatErrorKey(result.errorCode))); return; }
      refreshBotGroups();
      toast.success(t(key('inviteBotsAdded'), { name: bot.name }));
    } catch {
      if (isDataOwnerGenerationCurrent(generation)) toast.error(t(chatErrorKey('REQUEST_FAILED')));
    } finally { adding.current = false; }
  }
  // Typing stays in the search field: the menu's typeahead would move focus to a row.
  function searchKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }
    event.stopPropagation();
  }

  const label = t(key('inviteEntry'));
  const triggerButton = variant === 'pill'
    ? <Button ref={trigger} variant="secondary" size="sm" compact data-testid="chat-group-invite" className="ml-auto gap-1.5 pl-2.5 pr-2 data-[state=open]:[--button-face-border:var(--focus-ring-soft)]">
      <UserPlus size={14} aria-hidden />{label}<ChevronDown size={14} aria-hidden className="text-[var(--text-tertiary)]" />
    </Button>
    : <button ref={trigger} type="button" aria-label={label} data-testid="chat-group-invite" style={WINDOW_NO_DRAG_STYLE}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] outline-none hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] data-[state=open]:bg-[var(--surface-hover)] data-[state=open]:text-[var(--text-primary)]">
      <UserPlus size={16} />
    </button>;

  return <>
    <DropdownMenu open={open} onOpenChange={next => { setOpen(next); if (!next) reset(); }}>
      {variant === 'icon' ? <Tip text={label}><DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger></Tip>
        : <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>}
      <DropdownMenuContent align="end" sideOffset={6} className="w-72 p-1.5" data-testid="chat-group-invite-menu"
        onEscapeKeyDown={event => { if (view === 'bots') { event.preventDefault(); reset(); } }}
        onCloseAutoFocus={event => { if (dialog) event.preventDefault(); }}>
        <div key={view} className="animate-fade-in">
          {view === 'root' ? <>
            <DropdownMenuItem disabled={!group.canInvite} onSelect={() => setDialog('link')}
              className={cn('items-start gap-2.5', !group.canInvite && 'text-[var(--text-tertiary)] data-[disabled]:opacity-100')}>
              <Link2 size={16} aria-hidden className={cn('mt-0.5 shrink-0', group.canInvite ? 'text-[var(--text-secondary)]' : 'text-[var(--text-tertiary)]')} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span>{t(key('inviteFriendsItem'))}</span>
                <span className={cn('text-12 font-normal leading-[1.42] [text-wrap:pretty]', group.canInvite ? 'text-[var(--text-secondary)]' : 'text-[var(--text-tertiary)]')}>
                  {t(key(group.canInvite ? 'inviteFriendsItemHint' : 'inviteFriendsLocked'))}</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem className="items-start gap-2.5" onSelect={event => { event.preventDefault(); setView('bots'); }}>
              <Bot size={16} aria-hidden className="mt-0.5 shrink-0 text-[var(--text-secondary)]" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span>{t(key('inviteBotsItem'))}</span>
                <span className="text-12 font-normal leading-[1.42] text-[var(--text-secondary)] [text-wrap:pretty]">{t(key('inviteBotsItemHint'))}</span>
              </span>
              <ChevronRight size={14} aria-hidden className="shrink-0 self-center text-[var(--text-tertiary)]" />
            </DropdownMenuItem>
          </> : <>
            <DropdownMenuItem className="gap-2.5 font-medium" onSelect={event => { event.preventDefault(); reset(); }}>
              <ChevronLeft size={16} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />
              {t(key('inviteBotsItem'))}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {owned.status === 'loading' && <div className="flex justify-center py-3 text-[var(--text-tertiary)]" role="status"><Spinner size={16} /></div>}
            {owned.status === 'failed' && <p role="alert" className="px-2 py-2 text-13 leading-[1.54] text-[var(--text-secondary)]">{t(chatErrorKey('REQUEST_FAILED'))}</p>}
            {owned.status === 'ready' && (owned.bots.length === 0 ? <>
              <DropdownMenuLabel className="text-13">{t(key('noTeammates'))}</DropdownMenuLabel>
              <DropdownMenuItem className="gap-2.5" onSelect={() => setDialog('create')}>
                <Plus size={16} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />{t(key('createTeammate'))}
              </DropdownMenuItem>
            </> : addable.length === 0
              ? <p className="px-2 py-2 text-13 leading-[1.54] text-[var(--text-secondary)]">{t(key('inviteBotsAllIn'))}</p>
              : <>
                {addable.length >= SEARCH_FROM && <div {...menuSkipAttrs} className="relative mx-0.5 mb-1.5 mt-0.5">
                  <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                  <Input size="sm" autoFocus value={query} onChange={setQuery} placeholder={t(key('searchTeammates'))} aria-label={t(key('searchTeammates'))}
                    inputClassName="pl-8" onKeyDown={searchKeys} />
                </div>}
                {shown.length === 0
                  ? <p className="px-2 py-2 text-13 leading-[1.54] text-[var(--text-secondary)] [overflow-wrap:anywhere]">{t(key('inviteBotsNoMatch'), { query: query.trim() })}</p>
                  : <InviteBotList listRef={list} bots={shown} avatarFor={bot => profileById.get(bot.botId ?? '')} onAdd={bot => void add(bot)} />}
                {addable.length >= SEARCH_FROM && !needle && <div className="mt-1 border-t border-[var(--cmd-palette-border)] px-2 pb-0.5 pt-1.5 text-12 leading-[1.33] tabular-nums text-[var(--text-tertiary)]">
                  {t(key('inviteBotsCount'), { count: addable.length })}</div>}
              </>)}
          </>}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
    {dialog === 'link' && <ChatInviteDialog groupId={group.id} members={group.members} onClose={() => { setDialog(null); trigger.current?.focus(); }} />}
    {dialog === 'create' && <Suspense fallback={null}><BotRosterView restoreFocus={() => trigger.current?.focus()} onClose={() => setDialog(null)} /></Suspense>}
  </>;
}

/** Only the rows in view are mounted, so ten thousand teammates scroll like ten. */
function InviteBotList({ bots, avatarFor, onAdd, listRef }: {
  bots: readonly OwnedBot[];
  avatarFor: (bot: OwnedBot) => { name: string; avatar?: string | null; avatarColor?: string | null; avatarUrl?: string | null } | undefined;
  onAdd: (bot: OwnedBot) => void;
  listRef: RefObject<HTMLDivElement | null>;
}) {
  const virtualizer = useVirtualizer({
    count: bots.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    getItemKey: index => bots[index].actorId,
    initialRect: { width: 276, height: 296 },
  });
  return <div ref={listRef} className="max-h-[296px] overflow-y-auto overscroll-contain" data-testid="chat-group-invite-bots">
    <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map(item => {
        const bot = bots[item.index];
        const profile = avatarFor(bot);
        return <DropdownMenuItem key={item.key} className="absolute left-0 top-0 w-full gap-2.5" style={{ transform: `translateY(${item.start}px)` }}
          onSelect={() => onAdd(bot)}>
          <BotAvatar bot={{ name: bot.name, avatar: profile?.avatar, avatarColor: profile?.avatarColor, avatarUrl: profile?.avatarUrl }} size="xs" />
          <span className="min-w-0 flex-1 truncate">{bot.name}</span>
        </DropdownMenuItem>;
      })}
    </div>
  </div>;
}

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { BotAvatar } from './BotAvatar';
import type { BotGroupMemberView, BotGroupMessageView, ChatReactor } from '../../../shared/botGroupChat';

type Reaction = NonNullable<BotGroupMessageView['reactions']>[number];
type Loaded = { summary: string; reactors: ChatReactor[] | null };

const key = (name: string) => `bots.groupChat.server.${name}`;
/** Like Telegram: a few reactors appear as avatars on the badge; more than this shows the count. */
export const REACTION_AVATAR_LIMIT = 3;

/** Self first, then current and former members by name. Actors without a member record are counted, never named. */
function reactorOrder(reactors: ChatReactor[], language: string) {
  const collator = new Intl.Collator(language);
  return [...reactors].sort((a, b) => Number(b.isSelf) - Number(a.isSelf)
    || Number(a.name === null) - Number(b.name === null) || Number(a.formerMember) - Number(b.formerMember)
    || collator.compare(a.name ?? '', b.name ?? '') || a.actorId.localeCompare(b.actorId));
}

function reactorNames(reactors: ChatReactor[], t: TFunction, language: string) {
  const named = reactors.filter(r => r.isSelf || r.name !== null);
  const labels = named.map(r => r.isSelf ? t(key('reactorSelf'))
    : r.formerMember ? t(key('reactorFormer'), { name: r.name }) : r.name!);
  const unavailable = reactors.length - named.length;
  if (unavailable) labels.push(t(key('reactorsUnavailable'), { count: unavailable }));
  return new Intl.ListFormat(language, { style: 'long', type: 'conjunction' }).format(labels);
}

/**
 * A reaction badge. Clicking toggles the current actor's reaction. With only a few reactors the
 * badge shows their avatars instead of a number; avatars come from the group member projection,
 * and actors without one fall back to an initial, never an invented identity.
 */
export function ChatReactionButton({ groupId, messageId, reaction, revision = 0, members, disabled, onToggle, corner = false }: {
  groupId?: string; messageId: string; reaction: Reaction; revision?: string | number; members?: readonly BotGroupMemberView[]; disabled: boolean; onToggle: () => void;
  /** Pinned to a bubble's corner: a small card-colored badge, your own reaction marked by a stronger outline. */
  corner?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // Changes on every add/remove, local or remote — including a same-count swap of who reacted,
  // which only the message's realtime reaction revision reveals.
  const summary = `${reaction.count}:${reaction.me}:${revision}`;
  const wantsAvatars = !!groupId && reaction.count > 0 && reaction.count <= REACTION_AVATAR_LIMIT;
  // Only badges near the viewport read, so opening a long history does not fire one read per badge.
  const badgeRef = useRef<HTMLButtonElement>(null);
  const [nearViewport, setNearViewport] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = badgeRef.current;
    if (!wantsAvatars || !el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => setNearViewport(entries.some(e => e.isIntersecting)), { rootMargin: '200px 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [wantsAvatars]);
  const loadedSummary = loaded?.summary;
  // Read when a visible badge's summary changes; a superseded or cross-account read never lands.
  useEffect(() => {
    if (!wantsAvatars || !groupId || !nearViewport || loadedSummary === summary) return;
    let superseded = false;
    const owner = getDataOwnerGeneration();
    const settle = (reactors: ChatReactor[] | null) => {
      if (!superseded && isDataOwnerGenerationCurrent(owner)) setLoaded({ summary, reactors });
    };
    window.electronAPI.maker.chatServer.reactors({ groupId, messageId, emoji: reaction.emoji })
      .then(result => settle(result.ok ? result.reactors : null), () => settle(null));
    return () => { superseded = true; };
  }, [wantsAvatars, groupId, nearViewport, loadedSummary, messageId, reaction.emoji, summary]);
  // Reactors read for an older summary are never shown for the current one. A failed read, or a list
  // that disagrees with the count (a change still in flight), keeps the honest count instead.
  const current = loaded?.summary === summary ? loaded : null;
  const showAvatars = wantsAvatars && (!current || current.reactors?.length === reaction.count);
  // Membership follows the latest projection both ways: a current member takes its current name, and a
  // named actor missing from it has left since the read. Only unrecorded actors stay unnamed.
  const reactors = showAvatars && current?.reactors ? reactorOrder(current.reactors.map(r => {
    if (!members) return r;
    const member = members.find(m => m.actorId === r.actorId);
    return member ? { ...r, name: member.name, formerMember: false } : r.name !== null ? { ...r, formerMember: true } : r;
  }), i18n.language) : null;
  const countLabel = t(key('reactionCount'), { emoji: reaction.emoji, count: reaction.count });
  const label = reactors?.length
    ? t(key('reactionWho'), { emoji: reaction.emoji, count: reaction.count, names: reactorNames(reactors, t, i18n.language) })
    : countLabel;
  const ringClass = corner ? 'ring-2 ring-[var(--surface-elevated)]' : 'ring-2 ring-[var(--button-face-bg)]';
  return (
    <Button ref={badgeRef} variant={reaction.me && !corner ? 'primary' : 'secondary'} size="sm" compact
      disabled={disabled} aria-pressed={reaction.me} aria-label={label}
      // Corner badges paint through the shared face variables; your own reaction gets a stronger outline.
      className={cn(showAvatars && 'pr-1', corner && cn('h-7 gap-1 px-1.5 text-13 [--button-face-bg:var(--surface-elevated)]',
        reaction.me ? '[--button-face-border:var(--text-tertiary)]' : '[--button-face-border:var(--border-default)]'))}
      onClick={onToggle}>
      <span>{reaction.emoji}</span>
      {showAvatars ? (
        // Fixed slots sized by the count, so loading and remote updates never shift the row.
        <span aria-hidden className="flex items-center -space-x-1.5" data-testid="reaction-avatars">
          {Array.from({ length: reaction.count }, (_, index) => {
            const reactor = reactors?.[index];
            const member = reactor && members?.find(m => m.actorId === reactor.actorId);
            return reactor ? (
              <BotAvatar key={reactor.actorId} size="xs" className={ringClass} bot={{
                name: reactor.name ?? '', avatar: member?.avatar ?? null, avatarUrl: member?.avatarUrl, avatarColor: member?.avatarColor ?? null,
              }} />
            ) : (
              <span key={`slot-${index}`} className={cn('h-5 w-5 rounded-full bg-[var(--surface-hover)]', ringClass)} />
            );
          })}
        </span>
      ) : <span>{reaction.count}</span>}
    </Button>
  );
}

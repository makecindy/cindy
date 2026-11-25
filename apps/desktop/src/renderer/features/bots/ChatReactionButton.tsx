import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { ReactionGlyph, ChatReactionMotion } from './ChatReactionMotion';
import type { ReactionGesture } from './useChatReactions';
import { BotAvatar } from './BotAvatar';
import type { BotGroupMemberView, BotGroupMessageView, ChatReactor } from '../../../shared/botGroupChat';

type Reaction = NonNullable<BotGroupMessageView['reactions']>[number];
type Loaded = { summary: string; reactors: ChatReactor[] | null };
export type ReactorReads = Map<string, { summary: string; request: Promise<ChatReactor[] | null> }>;

const key = (name: string) => `bots.groupChat.server.${name}`;
const REACTION_AVATAR_LIMIT = 3;

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

export function ChatReactionButton({ groupId, messageId, reaction, revision = 0, members, disabled, onToggle, gesture, onFinishGesture, reads, optimistic = false, compact = false }: {
  groupId?: string; messageId: string; reaction: Reaction; revision?: string | number; members?: readonly BotGroupMemberView[]; disabled: boolean; onToggle: () => void;
  gesture?: ReactionGesture; onFinishGesture?: (gesture: ReactionGesture) => void;
  optimistic?: boolean; compact?: boolean; reads?: ReactorReads;
}) {
  const { t, i18n } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // The revision distinguishes two sets of reactors with the same count.
  const owner = getDataOwnerGeneration();
  const summary = JSON.stringify([owner, groupId, messageId, reaction.emoji, reaction.count, reaction.me, revision]);
  const wantsAvatars = !optimistic && !!groupId && reaction.count > 0 && reaction.count <= REACTION_AVATAR_LIMIT;
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
  useEffect(() => {
    if (!wantsAvatars || !groupId || !nearViewport || loadedSummary === summary) return;
    let superseded = false;
    let entry = reads?.get(reaction.emoji);
    if (entry?.summary !== summary) {
      const request = window.electronAPI.maker.chatServer.reactors({ groupId, messageId, emoji: reaction.emoji })
        .then(result => result.ok ? result.reactors : null, () => null);
      entry = { summary, request };
      reads?.set(reaction.emoji, entry);
    }
    void entry.request.then(reactors => {
      if (reactors === null && reads?.get(reaction.emoji) === entry) reads?.delete(reaction.emoji);
      if (!superseded && isDataOwnerGenerationCurrent(owner)) setLoaded({ summary, reactors });
    });
    return () => { superseded = true; };
  }, [wantsAvatars, groupId, nearViewport, loadedSummary, messageId, owner, reaction.emoji, reads, summary]);
  const current = loaded?.summary === summary ? loaded : null;
  const showAvatars = wantsAvatars && (!current || current.reactors?.length === reaction.count);
  const reactors = showAvatars && current?.reactors ? reactorOrder(current.reactors.map(r => {
    if (!members) return r;
    const member = members.find(m => m.actorId === r.actorId);
    return member ? { ...r, name: member.name, formerMember: false } : r.name !== null ? { ...r, formerMember: true } : r;
  }), i18n.language) : null;
  const countLabel = t(key('reactionCount'), { emoji: reaction.emoji, count: reaction.count });
  const label = reactors?.length
    ? t(key('reactionWho'), { emoji: reaction.emoji, count: reaction.count, names: reactorNames(reactors, t, i18n.language) })
    : countLabel;
  const ringClass = 'ring-2 ring-[var(--button-face-bg)]';
  const button = (
    <Button ref={badgeRef} variant={reaction.me && !compact ? 'primary' : 'secondary'} size="sm" compact
      disabled={disabled} aria-pressed={reaction.me} aria-label={label}
      className={cn(showAvatars && !compact && 'pr-1', compact && cn('h-[22px] gap-0.5 px-1.5 text-13 [--button-face-bg:var(--surface-elevated)]',
        reaction.me ? '[--button-face-border:var(--text-tertiary)]' : '[--button-face-border:var(--border-default)]'))}
      onClick={onToggle}>
      <span className="relative inline-flex">
        <ReactionGlyph emoji={reaction.emoji} />
        {reaction.me && gesture && onFinishGesture && <ChatReactionMotion gesture={gesture} onFinish={onFinishGesture} />}
      </span>
      {showAvatars && !compact ? (
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
  return compact ? <Tip text={label}>{button}</Tip> : button;
}

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, CheckCheck } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SHARE_EXCLUDE_ATTR } from '@/lib/shareConversationImage';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { BotAvatar } from './BotAvatar';
import type { BotGroupMemberView, BotGroupMessageReader, BotGroupMessageReaders } from '../../../shared/botGroupChat';

const key = (name: string) => `bots.groupChat.server.${name}`;
type State =
  | { status: 'idle' }
  | { status: 'loading'; readers: BotGroupMessageReaders | null }
  | { status: 'ready'; readers: BotGroupMessageReaders }
  | { status: 'failed' }
  | { status: 'too-large' }
  /** Only the author may read the list: this reader is not it, so the check is only a mark. */
  | { status: 'forbidden' };

/**
 * The read list of one message (bot-group-chat.md「消息已读」). It is read when its check is opened,
 * never ahead of time; the host keeps the answer per message until a member reads more, so
 * reopening the list does not ask the server again.
 */
function useMessageReaders(groupId: string | undefined, messageId: string, enabled: boolean) {
  const [state, setState] = useState<State>({ status: 'idle' });
  const latest = useRef(0);
  useEffect(() => () => { latest.current += 1; }, []);
  const load = useCallback(() => {
    if (!enabled || !groupId) return;
    const request = ++latest.current;
    const owner = getDataOwnerGeneration();
    const settle = (next: State) => { if (request === latest.current && isDataOwnerGenerationCurrent(owner)) setState(next); };
    setState(previous => ({ status: 'loading', readers: previous.status === 'ready' || previous.status === 'loading' ? previous.readers : null }));
    window.electronAPI.maker.chatServer.readers({ groupId, messageId }).then(
      result => settle(result.ok ? { status: 'ready', readers: result.readers }
        : { status: result.errorCode === 'GROUP_TOO_LARGE' ? 'too-large' : result.errorCode === 'MESSAGE_AUTHOR_REQUIRED' ? 'forbidden' : 'failed' }),
      () => settle({ status: 'failed' }),
    );
  }, [enabled, groupId, messageId]);
  /** Forget the answer (the message was read since): the next open asks again. */
  const reset = useCallback(() => { latest.current += 1; setState({ status: 'idle' }); }, []);
  return { state, load, reset };
}

/** Current members take their current name and avatar; an actor who has left keeps the name the read recorded. */
function readerIdentity(reader: Pick<BotGroupMessageReader, 'actorId' | 'name'>, members: readonly BotGroupMemberView[] | undefined) {
  const member = members?.find(candidate => candidate.actorId === reader.actorId);
  return {
    name: member?.name ?? reader.name,
    former: !member && reader.name !== null,
    avatar: { name: member?.name ?? reader.name ?? '', avatar: member?.avatar ?? null, avatarUrl: member?.avatarUrl, avatarColor: member?.avatarColor ?? null },
  };
}

function ReaderRow({ reader, members }: { reader: Pick<BotGroupMessageReader, 'actorId' | 'name'>; members?: readonly BotGroupMemberView[] }) {
  const { t } = useTranslation();
  const identity = readerIdentity(reader, members);
  const name = identity.name === null ? t(key('readerUnknown')) : identity.former ? t(key('reactorFormer'), { name: identity.name }) : identity.name;
  return (
    <li className="flex h-8 items-center gap-2 rounded-lg px-2 text-14">
      <BotAvatar size="xs" bot={identity.avatar} />
      <span className="min-w-0 truncate">{name}</span>
    </li>
  );
}

/** Who has read the message (never who has not), or just how many in a very large group; loading and failed are one quiet line. */
function ReadersList({ state, members }: { state: State; members?: readonly BotGroupMemberView[] }) {
  const { t } = useTranslation();
  const heading = 'px-2 pb-0.5 pt-1.5 text-12 font-medium text-[var(--text-tertiary)]';
  const note = (text: string) => <p role="status" className="px-2 py-1.5 text-13 text-[var(--text-tertiary)]">{text}</p>;
  if (state.status === 'too-large') return note(t(key('readersTooLarge')));
  if (state.status === 'failed') return note(t(key('readersFailed')));
  const readers = state.status === 'ready' || state.status === 'loading' ? state.readers : null;
  if (!readers) return note(t(key('readersLoading')));
  if (!readers.listed) return (
    <div>
      <p className="px-2 pt-1.5 text-14 tabular-nums">{t(key('readersOfTotal'), { read: readers.readCount, total: readers.eligibleCount })}</p>
      {note(t(key('readersTooLarge')))}
    </div>
  );
  return readers.readers.length ? (
    <div>
      <h3 className={heading}>{t(key('readersHeading'))}</h3>
      <ul>{readers.readers.map(reader => <ReaderRow key={reader.actorId} reader={reader} members={members} />)}</ul>
    </div>
  ) : note(t(key('readersNone')));
}

// Inside the bubble, at its bottom right, level with the last line of text (which reserves the room); 12px is the bubble's vertical padding.
const MARK_CLASS = 'absolute bottom-[12px] right-1.5 flex h-6 w-6 select-none items-center justify-center rounded-full';

/**
 * Inside your own bubble, at its bottom right: one check once it is sent, two once another member has
 * read it. The shape, not the color, tells them apart. In a server group it is a button that opens who has
 * read the message (a small list, closed with Esc or a click outside, focus back on the check); while
 * messages are being picked for sharing, or when the group cannot list readers, it is only the mark.
 */
export function ChatReadReceipt({ groupId, messageId, read, members, interactive }: {
  groupId: string | undefined; messageId: string; read: boolean; members?: readonly BotGroupMemberView[];
  /** The server lists readers and the message is not being picked for sharing. */
  interactive: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { state, load, reset } = useMessageReaders(groupId, messageId, interactive);
  // A message read since the list was fetched: an open list reads again, a closed one forgets what it knew.
  const lastRead = useRef(read);
  useEffect(() => {
    if (lastRead.current === read) return;
    lastRead.current = read;
    if (open) load(); else reset();
  }, [read, open, load, reset]);
  const Icon = read ? CheckCheck : Check;
  // On the bubble's own background: its text color, quieter while only sent.
  const icon = <Icon size={14} strokeWidth={2} aria-hidden className={cn('text-[var(--msg-user-text)]', read ? 'opacity-50' : 'opacity-30')} />;
  if (!interactive || !groupId || state.status === 'forbidden') {
    return (
      <span {...{ [SHARE_EXCLUDE_ATTR]: '' }} role="img" data-testid="read-receipt" data-read={read}
        aria-label={t(key(read ? 'readStatusRead' : 'readStatusSent'))} className={MARK_CLASS}>
        {icon}
      </span>
    );
  }
  const loaded = state.status === 'ready' ? state.readers : null;
  const label = !loaded ? t(key('readersView'))
    : !loaded.listed ? t(key('readersOfTotal'), { read: loaded.readCount, total: loaded.eligibleCount })
    : loaded.readers.length ? t(key('readersCount'), { count: loaded.readers.length }) : t(key('readersNone'));
  return (
    <Popover open={open} onOpenChange={next => { setOpen(next); if (next) load(); }}>
      <Tip text={label}>
        <PopoverTrigger asChild>
          <button type="button" {...{ [SHARE_EXCLUDE_ATTR]: '' }} data-testid="read-receipt" data-read={read} aria-label={label}
            onClick={event => event.stopPropagation()}
            className={cn(MARK_CLASS, 'cursor-pointer border-none bg-transparent p-0 outline-none transition-colors',
              'hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]')}>
            {icon}
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="z-[80] max-h-[min(360px,var(--radix-popover-content-available-height))] w-fit min-w-40 max-w-64 overflow-y-auto p-1.5" aria-label={label}>
        <ReadersList state={state} members={members} />
      </PopoverContent>
    </Popover>
  );
}

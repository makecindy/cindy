/**
 * Thread presence in the main chat (docs/product-rules/bot-group-chat.md §10「Thread 预览与贴回主群」):
 * a root shows its newest replies, and a share shows the original reply in its author's
 * name with the sharer kept separate. Both open the thread; neither copies text locally.
 */
import { useId, type ReactNode } from 'react';
import { ChevronRight, CornerDownRight, MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatBotMessageGroupTime } from '@cindy/maker-shared/botTimeline';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { SessionQuickSendProvider } from '@/components/chat/SessionQuickSendContext';
import { CHAT_BODY_CLASS } from '@/components/chat/chatChrome';
import { formatAbsolute, useRelativeTime } from '@/hooks/useRelativeTime';
import { SHARE_EXCLUDE_ATTR, SHARE_MESSAGE_ATTR } from '@/lib/shareConversationImage';
import { cn } from '@/lib/utils';
import type {
  BotGroupMemberView,
  BotGroupMessageView,
  BotGroupThreadPreviewReply,
  BotGroupThreadShareView,
} from '../../../shared/botGroupChat';
import { BotAvatar } from './BotAvatar';

const key = (name: string) => `bots.groupChat.server.thread.${name}`;
const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';

const FLASH_CLASSES = ['ring-2', 'ring-[var(--focus-ring)]', 'rounded-xl'];
const FLASH_MS = 1600;
/** The rendered message with this ID, compared as a value rather than a selector. */
export function findThreadMessageElement(container: HTMLElement | null, messageId: string) {
  return [...container?.querySelectorAll<HTMLElement>(`[${SHARE_MESSAGE_ATTR}]`) ?? []]
    .find(element => element.getAttribute(SHARE_MESSAGE_ATTR) === messageId) ?? null;
}

/** Bring a jumped-to message into view and outline it briefly, without moving focus. */
export function flashThreadTarget(target: HTMLElement) {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  target.scrollIntoView?.({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  target.classList.add(...FLASH_CLASSES);
  window.setTimeout(() => target.classList.remove(...FLASH_CLASSES), FLASH_MS);
}

function memberFor(members: readonly BotGroupMemberView[], botId: string | null) {
  return botId ? members.find(member => member.botId === botId) : undefined;
}

function ReplySummary({ reply }: { reply: BotGroupThreadPreviewReply }) {
  const { t } = useTranslation();
  if (reply.text) return <>{reply.text}</>;
  const first = reply.attachments[0];
  if (!first) return <span className="italic">{t(key('emptyReply'))}</span>;
  const label = t(key(first.category === 'image' ? 'image' : 'file'));
  return <>{reply.attachments.length > 1 ? t(key('attachmentsSummary'), { label, name: first.name, count: reply.attachments.length }) : `${label} · ${first.name}`}</>;
}

/** Thread summary; recent replies provide the button's accessible description. */
export function BotGroupThreadPreview({ message, members, onOpen }: {
  message: BotGroupMessageView; members: readonly BotGroupMemberView[]; onOpen: () => void;
}) {
  const { t, i18n } = useTranslation();
  const linesId = useId();
  const count = message.replyCount ?? 0;
  const replies = message.threadPreview?.replies ?? [];
  const latestAt = replies.at(-1)?.createdAt;
  const lastReplyAt = !message.threadUnread?.count && latestAt !== undefined ? latestAt : undefined;
  const lastReplyIso = lastReplyAt !== undefined ? new Date(lastReplyAt).toISOString() : undefined;
  if (count <= 0) return null;
  const repliers = message.threadPreview?.responders ?? replies.filter((reply, index) =>
    replies.findIndex(other => (other.authorBotId ?? other.authorName) === (reply.authorBotId ?? reply.authorName)) === index).slice(-3);
  return (
    <button type="button" data-thread-preview={message.id} {...{ [SHARE_EXCLUDE_ATTR]: '' }}
      aria-label={t(key('open'), { count })}
      aria-describedby={replies.length ? linesId : undefined}
      onClick={onOpen}
      className={cn('group/thread flex min-h-6 min-w-0 max-w-full flex-wrap self-start select-none items-center gap-2 rounded-full text-left text-13 leading-5', FOCUS)}>
      {repliers.length ? (
        <span aria-hidden className="flex shrink-0 items-center -space-x-1.5">
          {repliers.map(reply => {
            const member = memberFor(members, reply.authorBotId);
            return <BotAvatar key={reply.id} size="xs" className="h-[18px] w-[18px] text-11 ring-2 ring-[var(--surface)]"
              bot={{ name: reply.authorName, avatar: member?.avatar ?? null, avatarUrl: member?.avatarUrl, avatarColor: member?.avatarColor ?? null }} />;
          })}
        </span>
      ) : <MessageSquare size={13} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />}
      <span className="shrink-0 font-medium text-[var(--text-primary)] underline-offset-[3px] group-hover/thread:underline">
        {t('bots.groupChat.server.replyCount', { count })}
      </span>
      {lastReplyAt !== undefined ? (
        <time className="min-w-0 truncate text-12 text-[var(--text-tertiary)]" dateTime={lastReplyIso} title={formatAbsolute(lastReplyIso)}>
          {formatBotMessageGroupTime(lastReplyAt, i18n.language)}
        </time>
      ) : null}
      <ChevronRight size={12} aria-hidden className="shrink-0 text-[var(--text-tertiary)] opacity-0 transition-opacity duration-[var(--motion-fast)] group-hover/thread:opacity-100 group-focus-visible/thread:opacity-100" />
      {replies.length ? (
        <span id={linesId} className="sr-only">
          {replies.slice(-2).map(reply => <span key={reply.id}>{reply.authorName}: <ReplySummary reply={reply} />. </span>)}
        </span>
      ) : null}
    </button>
  );
}

/** Who did what: the sharer stays the message author; the reply keeps its own author. */
export function botGroupThreadShareLabel(share: BotGroupThreadShareView, t: (key: string, options?: Record<string, unknown>) => string) {
  if (share.status !== 'available') return t(key('sharedReply'));
  return share.sharedByAuthor ? t(key('alsoSent')) : t(key('sharedReplyFrom'), { name: share.authorName });
}

/** The referenced reply as the server has it now: edits show, deletions say so. */
export function BotGroupThreadShareQuote({ share, members, attachments, onOpenThread, inset = false, richScope, corner }: {
  richScope?: string;
  corner?: ReactNode;
  share: BotGroupThreadShareView; members: readonly BotGroupMemberView[]; attachments: ReactNode;
  /** Omitted inside the thread panel, where the quote is already the thread's root. */
  onOpenThread?: () => void;
  /** Inside a teammate's bubble: a flat inset instead of a bordered frame. */
  inset?: boolean;
}) {
  const { t } = useTranslation();
  const createdAt = share.createdAt ? new Date(share.createdAt).toISOString() : undefined;
  const relative = useRelativeTime(createdAt, { hovered: false });
  const member = memberFor(members, share.authorBotId);
  const available = share.status === 'available';
  return (
    <figure className={cn('relative flex w-full min-w-0 flex-col gap-1.5 px-3 py-2.5',
      inset ? 'rounded-lg bg-[var(--surface)]' : 'max-w-[560px] rounded-xl border border-[var(--border-default)]')}>
      {corner}
      {available ? (
        <>
          <figcaption className="flex min-w-0 select-none items-center gap-2 text-12 text-[var(--text-tertiary)]">
            {/* The message header already names someone who shared their own reply. */}
            {share.sharedByAuthor ? null : <>
              <BotAvatar size="xs" bot={{ name: share.authorName, avatar: member?.avatar ?? null, avatarUrl: member?.avatarUrl, avatarColor: member?.avatarColor ?? null }} />
              <span className="min-w-0 truncate text-13 font-medium text-[var(--text-primary)]">{share.authorName}</span>
            </>}
            {relative ? <time dateTime={createdAt} title={formatAbsolute(createdAt)} className="shrink-0">{relative}</time> : null}
            {share.edited ? <span className="shrink-0">{t(key('edited'))}</span> : null}
          </figcaption>
          {share.content.trim() ? (
            <blockquote className={`min-w-0 break-words text-[var(--msg-assistant-text)] ${CHAT_BODY_CLASS}`}>
              <SessionQuickSendProvider value={null}>
                <MarkdownRenderer workingDir="" content={share.content} allowPrivilegedLinks={false}
                  renderRichAnswers={share.authorKind === 'bot'} streamFadeKey={`group:${richScope}:${share.messageId}`} />
              </SessionQuickSendProvider>
            </blockquote>
          ) : null}
          {attachments}
        </>
      ) : (
        <p role={share.status === 'loading' ? 'status' : undefined} className="text-13 text-[var(--text-tertiary)]">
          {t(key(share.status === 'loading' ? 'loadingSource' : 'sourceUnavailable'))}
        </p>
      )}
      {/* Only a verified share leads anywhere: the card's own thread ID is not trusted. */}
      {onOpenThread && available ? <button type="button" onClick={onOpenThread} {...{ [SHARE_EXCLUDE_ATTR]: '' }}
        className={cn('-ml-1.5 inline-flex min-h-6 w-fit select-none items-center gap-1 rounded-full px-1.5 text-12 text-[var(--text-secondary)] transition-colors duration-[var(--motion-fast)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]', FOCUS)}>
        <CornerDownRight size={12} aria-hidden />
        {t(key('viewThread'))}
      </button> : null}
    </figure>
  );
}

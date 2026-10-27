/**
 * 群聊时间线的一行（主时间线与话题面板共用），与伙伴私聊同一套气泡：
 *
 * - 自己的消息靠右，沿用用户气泡；其他人（伙伴与别的人）靠左：28px 头像 + 名字（text-13）+
 *   时刻（text-11），下面是一个卡片底、细边框的气泡。引用、任务卡、分工表、附件与贴回的话题
 *   回复都收在气泡里。同一作者五分钟内的连续消息合并：后续行不再带头像和名字，时刻只在悬停
 *   时出现在左侧槽位。
 * - 气泡宽度由内容决定，上限 720px，并始终给外侧的操作栏留出位置；正文与任务正文同一字号。
 * - 表情回应贴在气泡外上角；消息操作栏（引用回复、话题、表情、更多）悬停时出现在气泡外侧，键盘
 *   聚焦与触屏时常显；话题入口是气泡下方一行。
 * - @ 点名在所有消息里都高亮：正文仍交给 MarkdownRenderer，高亮走 CSS Custom Highlight
 *   （不改 Markdown 的 DOM，也就不会和 React 抢节点）。
 * - 轮次结束、分工结束与系统提示是居中的一行小字。
 *
 * 行用 `memo` 包住：父组件只在这条消息（或它的引用、安排快照、高亮状态）真的变了时才会
 * 让它重绘；回调一律是父组件的稳定引用，按消息 id 调用。
 */
import type { BotGroupAuthorKind } from '@cindy/maker-shared/botGroupChat';
import { botGroupBodyParts } from '@cindy/maker-shared/botGroupPresentation';
import { memo, useEffect, useState, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleAlert, CornerDownRight, RefreshCcw } from 'lucide-react';
import { BotGroupThreadPreview, BotGroupThreadShareQuote, botGroupThreadShareLabel } from './BotGroupThreadViews';
import { toast } from '@/lib/toast';
import { editBotGroupSend, retryBotGroupSend, type BotGroupOutboxEntry } from './botGroupOutbox';

import { formatBotTimelineClock, formatBotTimelineDate } from '@cindy/maker-shared/botTimeline';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { CHAT_BODY_CLASS } from '@/components/chat/chatChrome';
import { ShareMessageCheckbox } from '@/components/chat/ShareMessageCheckbox';
import { Button } from '@/components/ui/button';
import { SHARE_MESSAGE_ATTR, SHARE_SESSION_ATTR } from '@/lib/shareConversationImage';
import { cn } from '@/lib/utils';
import type {
  BotGroupMention,
  BotGroupMemberView,
  BotGroupPlanStepView,
  BotGroupPlanView,
  BotGroupQuoteDisplay,
  BotGroupQuoteView,
} from '../../../shared/botGroupChat';
import { isBotGroupRuntimeFailureCode } from '../../../shared/botGroupChat';
import { BotAvatar } from './BotAvatar';
import { BotGroupMentionCard, botGroupMentionMember } from './BotGroupMentionCard';
import { splitBotGroupMentionSegments } from './botGroupMentions';
import { botGroupNoticeKey } from './botGroupPresentation';
import {
  BotGroupHandoffFiles,
  BotGroupOrganizerTag,
  BotGroupPlanCard,
  BotGroupPlanEndDivider,
  type BotGroupPlanCardAction,
} from './BotGroupPlan';
import { BotGroupMessageAttachments } from './BotGroupMessageAttachments';
import { BotGroupQuoteBlock } from './BotGroupQuote';
import { BotGroupRuntimeFailureNotice } from './BotGroupRuntimeFailureNotice';
import { BotGroupTaskCard } from './BotGroupTaskCard';
import type { BotGroupTimelineMessage } from './BotGroupTimelineModel';
import { ChatMessageHoverActions, ChatMessageReactions } from './ChatServerControls';

/** Message width: content first, at most 720px, always leaving the toolbar room on the outer side. */
const BUBBLE_COLUMN_CLASS = 'max-w-[min(720px,calc(100%-120px))]';

// ---- @ mention highlight ----------------------------------------------------------------

const MENTION_HIGHLIGHT = 'bot-group-mention';
const mentionRanges = new Map<object, Range[]>();
let highlightSyncQueued = false;
let highlightStyleInstalled = false;

type HighlightRegistry = { set: (name: string, value: unknown) => void; delete: (name: string) => void };
function highlightApi(): { registry: HighlightRegistry; Highlight: new (...ranges: Range[]) => unknown } | null {
  const registry = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return registry && typeof Highlight === 'function' ? { registry, Highlight } : null;
}

function installHighlightStyle(): void {
  if (highlightStyleInstalled || typeof document === 'undefined') return;
  highlightStyleInstalled = true;
  // One rule, rewritten in place: an earlier copy (a reload of this module) must not keep painting.
  const [existing, ...stale] = document.head.querySelectorAll<HTMLStyleElement>('style[data-bot-group-mention]');
  stale.forEach((copy) => copy.remove());
  const style = existing ?? document.createElement('style');
  style.dataset.botGroupMention = '';
  // Mentions read as the theme's link color with no fill; hovering one shows who it names.
  style.textContent = `::highlight(${MENTION_HIGHLIGHT}) { color: var(--msg-link); background-color: transparent; }`;
  if (!style.isConnected) document.head.append(style);
}

function syncMentionHighlight(): void {
  if (highlightSyncQueued) return;
  highlightSyncQueued = true;
  queueMicrotask(() => {
    highlightSyncQueued = false;
    const api = highlightApi();
    if (!api) return;
    const ranges = [...mentionRanges.values()].flat();
    if (ranges.length === 0) api.registry.delete(MENTION_HIGHLIGHT);
    else api.registry.set(MENTION_HIGHLIGHT, new api.Highlight(...ranges));
  });
}

function collectMentionRanges(root: HTMLElement, labels: readonly string[]): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (!node.data.includes('@') || node.parentElement?.closest('pre, code')) continue;
    let offset = 0;
    for (const segment of splitBotGroupMentionSegments(node.data, labels)) {
      if (segment.mention) {
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + segment.text.length);
        ranges.push(range);
      }
      offset += segment.text.length;
    }
  }
  return ranges;
}

const MENTION_CARD_OPEN_MS = 250;
const NO_MENTIONS: BotGroupMention = { all: false, botIds: [] };
const MENTION_CARD_CLOSE_MS = 150;

/**
 * Message text as Markdown, with `@名字` of known members in the link color. Resting the pointer on a
 * mention shows that member's card; mentions are text ranges, so the hit test reads their boxes.
 */
function BotGroupMessageText({ content, mentionLabels, members, mentions, serverBacked, authorKind }: {
  authorKind?: BotGroupAuthorKind; content: string; mentionLabels: readonly string[]; members: readonly BotGroupMemberView[];
  /** Who the message mentioned; decides whose card a highlighted name opens. */
  mentions: BotGroupMention;
  serverBacked: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const rangesRef = useRef<Range[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Range | null>(null);
  const [card, setCard] = useState<{ member: BotGroupMemberView; anchor: { left: number; top: number; width: number; height: number } } | null>(null);
  const labelsKey = mentionLabels.join('\u0000');
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !content.includes('@')) { rangesRef.current = []; return; }
    const api = highlightApi();
    if (api) installHighlightStyle();
    const owner = {};
    const refresh = () => {
      rangesRef.current = collectMentionRanges(root, mentionLabels);
      if (!api) return;
      mentionRanges.set(owner, rangesRef.current);
      syncMentionHighlight();
    };
    refresh();
    // Markdown may finish later (code highlighting, lazy blocks); follow its DOM.
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(refresh);
    observer?.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer?.disconnect();
      rangesRef.current = [];
      if (!api) return;
      mentionRanges.delete(owner);
      syncMentionHighlight();
    };
    // labelsKey stands in for the label array.
  }, [content, labelsKey]);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const schedule = (next: () => void, ms: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { timerRef.current = null; next(); }, ms);
  };
  const keepOpen = () => { if (timerRef.current) clearTimeout(timerRef.current); timerRef.current = null; };
  const scheduleClose = () => { pendingRef.current = null; schedule(() => setCard(null), MENTION_CARD_CLOSE_MS); };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const root = ref.current;
    if (!root || rangesRef.current.length === 0) return;
    const { clientX: x, clientY: y } = event;
    const hit = rangesRef.current.find((range) => typeof range.getClientRects === 'function' && [...range.getClientRects()].some((box) =>
      x >= box.left && x <= box.right && y >= box.top && y <= box.bottom));
    // mentionLabels[0] is the broadcast label (BotGroupChatView).
    const member = hit ? botGroupMentionMember(hit.toString(), members, mentions, mentionLabels[0] ?? '', serverBacked) : undefined;
    root.style.cursor = member ? 'pointer' : '';
    if (!hit || !member) { if (pendingRef.current || card) scheduleClose(); return; }
    if (pendingRef.current === hit) return;
    pendingRef.current = hit;
    schedule(() => {
      const box = hit.getBoundingClientRect();
      const origin = root.getBoundingClientRect();
      setCard({ member, anchor: { left: box.left - origin.left, top: box.top - origin.top, width: box.width, height: box.height } });
    }, card ? 0 : MENTION_CARD_OPEN_MS);
  };
  return (
    <div ref={ref} className="relative min-w-0 break-words" onPointerMove={onPointerMove}
      onPointerLeave={() => { if (ref.current) ref.current.style.cursor = ''; scheduleClose(); }}>
      {botGroupBodyParts(content, authorKind).map((part, index) => part.kind === 'markdown'
        ? <MarkdownRenderer key={index} workingDir="" content={part.content} allowPrivilegedLinks={false} />
        : <p key={index} className="whitespace-pre-wrap break-words">{part.content}</p>)}
      <BotGroupMentionCard member={card?.member ?? null} anchor={card?.anchor ?? null}
        onPointerEnter={keepOpen} onPointerLeave={scheduleClose} />
    </div>
  );
}

// ---- Pieces ----------------------------------------------------------------------------

/** Quiet pill after an author name (负责人, 第 k 步, 某某的主人). */
export function BotGroupNameTag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex min-h-[18px] max-w-[12rem] shrink-0 select-none items-center truncate rounded-full bg-[var(--surface-chip)] px-1.5 py-px text-11 font-medium leading-tight text-[var(--text-secondary)]">
      {children}
    </span>
  );
}

/** One quiet centered line per local day, in the flow like the private chat's time stamps. */
export function BotGroupDateDivider({ timestamp, locale }: { timestamp: number; locale: string }) {
  return (
    <div data-testid="bot-group-date-divider" className="mt-6 flex select-none justify-center first:mt-0">
      <span className="text-11 leading-4 text-[var(--text-tertiary)]">
        {formatBotTimelineDate(timestamp, locale)}
      </span>
    </div>
  );
}

// ---- The row ---------------------------------------------------------------------------

export interface BotGroupTimelineItemProps {
  message: BotGroupTimelineMessage;
  /** Same author as the row above within five minutes: no avatar or name. */
  continued: boolean;
  /** Author name as this reader sees it (`伙伴名 (主人昵称)` where it applies). */
  authorName: string;
  /** Avatar identity of the author (the organizer on a 安排卡). */
  avatar?: { name: string; avatar: string | null; avatarUrl?: string | null; avatarColor: string | null };
  /** Bots a human author brought into the group: 「某某的主人」. */
  ownerOf?: string;
  /** 「第 k 步」 on a step hand-off. */
  stepNumber?: number;
  members: readonly BotGroupMemberView[];
  mentionLabels: readonly string[];
  locale: string;
  shareScope: string;
  sharing: boolean;
  /** Context-only roots have no action owner; do not offer sharing or mutations. */
  showActions?: boolean;
  /** Server group id: reactions and the toolbar's reaction picker. */
  reactionGroupId?: string;
  /** The message's reaction version (`messageReactionRevision`): who reacted is re-read when it moves. */
  reactionRevision?: string;
  quoteDisplay?: BotGroupQuoteDisplay;
  onLocateQuote?: (quote: BotGroupQuoteView) => void;
  onQuote?: (messageId: string) => void;
  onOpenThread?: (messageId: string, focusMessageId?: string) => void;
  menuActions?: Parameters<typeof ChatMessageHoverActions>[0]['menuActions'];
  footer?: ReactNode;
  /** This client changed the message (a reaction): the timeline refreshes its copy. */
  onChanged: (messageId: string) => void;
  highlighted?: boolean;
  /** Focusable only as a jump target, so a click elsewhere keeps its usual focus. */
  focusable?: boolean;
  /** Arrived while the reader was watching: fade in (opacity only). */
  entering?: boolean;
  // Round and plan pieces; the Thread panel leaves them out.
  canContinue?: boolean;
  continuing?: boolean;
  onContinue?: () => void;
  plan?: BotGroupPlanView;
  planActionable?: boolean;
  planReassignable?: boolean;
  planPending?: BotGroupPlanCardAction | null;
  /** Live start of the plan's running step (its Session's turn), for the elapsed time. */
  planRunningSince?: number | null;
  /** Finish time of each done step (1-based), read off its hand-off message. */
  planDoneAt?: ReadonlyMap<number, number>;
  onPlanAction?: (action: 'start' | 'dismiss', planId: string) => void;
  readOnly?: boolean;
  onEditStep?: (planId: string, step: BotGroupPlanStepView, action: 'reassign' | 'remove', botId?: string) => void;
  /** Present on the open 分工 card for whoever may press 继续 (§7.4). */
  onPlanAutoContinue?: (planId: string, on: boolean) => void;
}

function Row({ message, highlighted, focusable, entering, block, children }: {
  message: BotGroupTimelineMessage; highlighted?: boolean; focusable?: boolean; entering?: boolean;
  /** Space above: a new author block, a merged line, or a compact system line. */
  block: 'author' | 'continued' | 'system';
  children: ReactNode;
}) {
  return (
    <div
      data-bot-group-message-id={message.id}
      tabIndex={focusable ? -1 : undefined}
      className={cn(
        'rounded-lg outline-none transition-colors first:mt-0',
        block === 'continued' ? 'mt-0.5' : block === 'author' ? 'mt-3.5' : 'mt-3',
        entering && 'animate-fade-in motion-reduce:animate-none',
        highlighted && 'bg-[hsl(var(--search-match-bg))] ring-1 ring-[var(--border-default)]',
      )}
    >
      {children}
    </div>
  );
}

function SystemLine({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="flex select-none items-center gap-3 text-12 text-[var(--text-tertiary)]">
      <span aria-hidden className="h-px min-w-6 flex-1 bg-[var(--border-default)]" />
      {children}
      <span aria-hidden className="h-px min-w-6 flex-1 bg-[var(--border-default)]" />
    </div>
  );
}

/** A task card is live only for a member of this group whose teammate is mine; unknown authors are snapshots. */
export function botGroupTaskOwned(authorBotId: string | null, members: readonly BotGroupMemberView[]): boolean {
  const author = authorBotId ? members.find((member) => member.botId === authorBotId) : undefined;
  return author !== undefined && author.isOwned !== false;
}

function BotGroupTimelineItemImpl(props: BotGroupTimelineItemProps) {
  const { t } = useTranslation();
  const { message, continued, authorName, members, mentionLabels, locale, shareScope, sharing } = props;
  const rowProps = { message, highlighted: props.highlighted, focusable: props.focusable, entering: props.entering };

  if (message.kind === 'round-end') {
    return (
      <Row {...rowProps} block="system">
        <SystemLine>
          <span>{t('bots.groupChat.timeline.roundEnded')}</span>
          {props.canContinue && props.onContinue ? (
            <Button variant="secondary" tone="quiet" size="sm" compact type="button" loading={props.continuing} onClick={props.onContinue}>
              {t('bots.groupChat.timeline.continue')}
            </Button>
          ) : null}
        </SystemLine>
      </Row>
    );
  }
  if (message.kind === 'plan-end') {
    return (
      <Row {...rowProps} block="system">
        <BotGroupPlanEndDivider stepCount={props.plan ? props.plan.steps.length : null} />
      </Row>
    );
  }
  if (message.kind === 'notice' || message.authorKind === 'system') {
    const name = message.authorName.trim() || authorName;
    if (isBotGroupRuntimeFailureCode(message.runtimeFailureCode)) {
      return (
        <Row {...rowProps} block="system">
          <BotGroupRuntimeFailureNotice name={name} code={message.runtimeFailureCode} />
        </Row>
      );
    }
    const key = botGroupNoticeKey(message.noticeCode, message.planId !== null);
    return (
      <Row {...rowProps} block="system">
        <p className="select-none text-center text-12 leading-5 text-[var(--text-tertiary)]">{key ? t(key, { name }) : message.content}</p>
      </Row>
    );
  }

  const shareable = message.kind === 'message' && !message.pending;
  const shareAttrs = shareable ? { [SHARE_SESSION_ATTR]: shareScope, [SHARE_MESSAGE_ATTR]: message.id } : {};
  const hasText = message.content.trim().length > 0;
  const hasAttachments = (message.attachments?.length ?? 0) > 0;
  const self = message.authorKind === 'user' && message.isSelf !== false;
  const hasReactions = !message.pending && (message.reactions?.length ?? 0) > 0;
  // Your own message's reactions hang over the left corner of its bubble, or of its first block without text.
  const reactions = hasReactions ? <ChatMessageReactions corner groupId={props.reactionGroupId} message={message} members={members} reactionRevision={props.reactionRevision} align="right" onChanged={props.onChanged} /> : null;
  const quote = props.quoteDisplay ? (
    <BotGroupQuoteBlock
      display={props.quoteDisplay}
      onLocate={props.onLocateQuote && message.quote ? () => props.onLocateQuote!(message.quote!) : undefined}
      // In a bubble the quote leads the text; without one it lines up with the message's side.
      align={self && (message.threadShare || (!hasText && !hasAttachments)) ? 'right' : 'left'}
    />
  ) : null;
  const share = message.threadShare;
  const threadPreview = props.onOpenThread && (message.replyCount ?? 0) > 0 ? (
    <BotGroupThreadPreview message={message} members={members}
      onOpen={() => props.onOpenThread!(message.id)} />
  ) : null;
  const shareBody = share ? <>
    <p className="flex select-none items-center gap-1 text-12 text-[var(--text-tertiary)]">
      <CornerDownRight size={12} aria-hidden />{botGroupThreadShareLabel(share, t)}</p>
    <BotGroupThreadShareQuote share={share} members={members} inset={!self}
      attachments={<BotGroupMessageAttachments attachments={share.attachments} align="start" />}
      onOpenThread={props.onOpenThread ? () => props.onOpenThread!(share.threadRootId, share.messageId) : undefined} />
  </> : null;
  const actions = shareable && props.showActions !== false ? (
    <ChatMessageHoverActions
      groupId={props.reactionGroupId}
      shareScope={shareScope}
      message={message}
      align={self ? 'right' : 'left'}
      besideReactions={hasReactions}
      onQuote={props.onQuote ? () => props.onQuote!(message.id) : undefined}
      onReply={props.onOpenThread ? () => props.onOpenThread!(message.id) : undefined}
      onChanged={props.onChanged}
      copyText={share ? share.status === 'available' ? share.content : '' : undefined}
      replyCountShown={Boolean(threadPreview)}
      menuActions={props.menuActions}
    />
  ) : null;

  if (message.kind === 'message' && self) {
    return (
      <Row {...rowProps} block={continued ? 'continued' : 'author'}>
        <article
          {...shareAttrs}
          data-testid={message.outbox ? "bot-group-outbox" : undefined}
          data-status={message.outbox?.status}
          aria-busy={message.pending && message.outbox?.status !== 'failed' ? true : undefined}
          className={cn('group/message relative flex min-w-0 justify-end rounded-lg py-0.5', sharing && 'ml-10')}
        >
          {sharing && shareable ? <ShareMessageCheckbox clientId={message.id} /> : null}
          <div className={cn('flex min-w-0 flex-col items-end gap-1.5 transition-opacity', share ? 'max-w-[min(560px,calc(100%-120px))]' : BUBBLE_COLUMN_CLASS, message.pending && message.outbox?.status !== 'failed' && 'opacity-60')}>
            {/* The toolbar and the reaction corner hang off the message's own content. */}
            <div className={cn("relative flex min-w-0 max-w-full flex-col items-end gap-1.5", threadPreview && "self-stretch")}>
              {share ? <>{reactions}<div className="relative flex w-full min-w-0 max-w-full flex-col items-end gap-1.5">{quote}{shareBody}{actions}</div></> : null}
              {/* A short root and its wider thread entry share the column width and both edges. */}
              {!share && (hasText || hasAttachments) ? (
                <div className={cn("flex min-w-0 max-w-full flex-col", threadPreview ? "w-full" : "w-fit")}>
                  {reactions}
                  <div
                    data-testid="bot-group-self-bubble"
                    className={`relative flex max-w-full flex-col gap-2 rounded-xl border border-[var(--msg-user-border)] bg-[var(--msg-user-bg)] px-3.5 py-2 text-[var(--msg-user-text)] ${CHAT_BODY_CLASS}`}
                  >
                    {quote}
                    {hasText ? <BotGroupMessageText content={message.content} mentionLabels={mentionLabels} members={members} mentions={message.mentions ?? NO_MENTIONS} serverBacked={Boolean(props.reactionGroupId)} /> : null}
                    <BotGroupMessageAttachments attachments={message.attachments ?? []} align="start" />
                    {actions}
                  </div>
                </div>
              ) : null}
              {!share && !hasText && !hasAttachments ? <>{reactions}<div className="relative">{quote}{actions}</div></> : null}
            </div>
            {threadPreview}
            {props.footer}
            {message.outbox ? <BotGroupOutboxStatus entry={message.outbox} readOnly={props.readOnly} /> : null}
            {message.pending && !message.outbox ? <span className="sr-only">{t('bots.groupChat.timeline.sending')}</span> : null}
          </div>
        </article>
      </Row>
    );
  }

  // A server queue stands on its own under the request: the turns it lines up, never folded
  // into someone's reply (bot-group-chat.md §7).
  if (message.kind === 'plan' && props.plan?.kind === 'talk') {
    return (
      <Row {...rowProps} block="author">
        <div className="flex min-w-0 gap-2.5">
          <span aria-hidden className="w-7 shrink-0" />
          <div data-testid="bot-group-arrangement" className={cn('min-w-0', BUBBLE_COLUMN_CLASS)}>
            <div className="w-fit min-w-0 max-w-full">
              <BotGroupPlanCard
                plan={props.plan}
                members={members}
                actionable={false}
                // Only the creator, an owner or an admin may change who speaks next.
                reassignable={(props.planReassignable ?? false) && props.plan.canManage !== false}
                pending={props.planPending ?? null}
                runningSince={props.planRunningSince ?? null}
                doneAt={props.planDoneAt}
                locale={locale}
                onStart={() => undefined}
                onDismiss={() => undefined}
                onEditStep={(step, action, botId) => { if (message.planId) props.onEditStep?.(message.planId, step, action, botId); }}
              />
            </div>
          </div>
        </div>
      </Row>
    );
  }
  // A legacy plan is signed by its human creator; present the organizer without changing authorship.
  const isPlanCard = message.kind === 'plan';
  const timed = Number.isFinite(message.createdAt) && message.createdAt > 0;
  const clock = timed ? formatBotTimelineClock(message.createdAt, locale) : '';
  const dateTime = timed ? new Date(message.createdAt).toISOString() : undefined;
  return (
    <Row {...rowProps} block={continued ? 'continued' : 'author'}>
      <article
        {...shareAttrs}
        className={cn('group/message relative flex min-w-0 items-start gap-2.5 rounded-lg py-0.5', sharing && 'ml-8')}
      >
        {sharing && shareable ? <ShareMessageCheckbox clientId={message.id} /> : null}
        <div className="flex w-7 shrink-0 justify-end">
          {continued ? (
            <time
              dateTime={dateTime}
              className="select-none pt-0.5 text-11 leading-5 tabular-nums text-[var(--text-tertiary)] opacity-0 group-hover/message:opacity-100"
            >
              {clock}
            </time>
          ) : (
            <BotAvatar bot={props.avatar ?? { name: authorName, avatar: null, avatarColor: null }} size="sm" />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
          {!continued ? (
            <span className="flex min-w-0 max-w-full select-none items-baseline gap-1.5">
              <span className="min-w-0 truncate text-13 font-medium leading-5 text-[var(--text-primary)]">{authorName}</span>
              {isPlanCard ? <BotGroupOrganizerTag /> : null}
              {props.stepNumber ? <BotGroupNameTag>{t('bots.groupChat.timeline.stepTag', { count: props.stepNumber })}</BotGroupNameTag> : null}
              {props.ownerOf ? <BotGroupNameTag>{t('bots.groupChat.ownerOf', { name: props.ownerOf })}</BotGroupNameTag> : null}
              {timed ? (
                <time dateTime={dateTime} className="shrink-0 text-11 tabular-nums text-[var(--text-tertiary)]">
                  {clock}
                </time>
              ) : null}
            </span>
          ) : null}
          <div className={cn('relative flex min-w-0 flex-col', BUBBLE_COLUMN_CLASS)}>
            <ChatMessageReactions corner groupId={props.reactionGroupId} message={message} members={members} reactionRevision={props.reactionRevision} onChanged={props.onChanged} />
            <div data-testid="bot-group-bubble"
              className={cn('relative flex min-w-0 max-w-full flex-col gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3.5 py-2.5 text-[var(--msg-assistant-text)]', CHAT_BODY_CLASS)}>
              {isPlanCard ? (
                <div>
                  <BotGroupPlanCard
                    plan={props.plan}
                    members={members}
                    actionable={props.planActionable ?? false}
                    reassignable={props.planReassignable ?? false}
                    pending={props.planPending ?? null}
                    runningSince={props.planRunningSince ?? null}
                    doneAt={props.planDoneAt}
                    locale={locale}
                    onStart={() => { if (message.planId) props.onPlanAction?.('start', message.planId); }}
                    onDismiss={() => { if (message.planId) props.onPlanAction?.('dismiss', message.planId); }}
                    onEditStep={(step, action, botId) => { if (message.planId) props.onEditStep?.(message.planId, step, action, botId); }}
                    onAutoContinueChange={props.onPlanAutoContinue && message.planId
                      ? (on) => props.onPlanAutoContinue?.(message.planId!, on) : undefined}
                  />
                </div>
              ) : (
                <>
                  {quote}
                  {shareBody}
                  {!share && hasText ? (
                    <div className="min-w-0">
                      <BotGroupMessageText authorKind={message.authorKind} content={message.content} mentionLabels={mentionLabels} members={members} mentions={message.mentions ?? NO_MENTIONS} serverBacked={Boolean(props.reactionGroupId)} />
                    </div>
                  ) : null}
                  {/* A task this teammate started from the group, under what it said about it; mine is live
                      where it runs, another owner's is a snapshot. An author no longer in the group is unknown:
                      its task may run on another computer, so it stays a snapshot rather than a lookup here. */}
                  {!share && message.task ? (
                    <BotGroupTaskCard task={message.task} owned={botGroupTaskOwned(message.authorBotId, members)}
                      botId={message.authorBotId} />
                  ) : null}
                  {!share && <BotGroupMessageAttachments attachments={message.attachments ?? []} align="start" />}
                  <BotGroupHandoffFiles files={message.files ?? []} workDir={props.plan?.workDir ?? null} />
                </>
              )}
              {actions}
            </div>
          </div>
          {threadPreview}
          {props.footer}
        </div>
      </article>
    </Row>
  );
}

export const BotGroupTimelineItem = memo(BotGroupTimelineItemImpl);

/** Queue feedback shares the same message row, so receipts do not remount its content. */
function BotGroupOutboxStatus({ entry, readOnly }: { entry: BotGroupOutboxEntry; readOnly?: boolean }) {
  const { t } = useTranslation();
  const sending = entry.status === 'sending';
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!sending) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), 600);
    return () => window.clearTimeout(timer);
  }, [sending]);
  return (
    <>
      {sending && slow ? (
        <p role="status" className="select-none text-12 leading-[1.33] text-[var(--text-tertiary)]">
          {t('bots.groupChat.outbox.sending')}
        </p>
      ) : null}
      {entry.status === 'failed' ? (
        <div role="alert" className="flex flex-wrap items-center justify-end gap-2">
          <span className="flex select-none items-center gap-1 text-12 leading-[1.33] text-[var(--text-danger)]">
            <CircleAlert size={13} aria-hidden className="shrink-0" />
            {t('bots.groupChat.outbox.failed')}
          </span>
          <Button
            variant="secondary"
            size="sm"
            compact
            type="button"
            disabled={readOnly}
            onClick={() => {
              if (!editBotGroupSend(entry.input.groupId, entry.input.clientId)) toast.warning(t('bots.groupChat.outbox.editBlocked'));
            }}
          >
            {t('bots.groupChat.outbox.edit')}
          </Button>
          {entry.retryable !== false ? (
            <Button variant="secondary" size="sm" compact type="button" disabled={readOnly} onClick={() => retryBotGroupSend(entry.input.groupId, entry.input.clientId)}>
              <RefreshCcw size={13} />
              {t('bots.retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

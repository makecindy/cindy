/**
 * 群聊时间线的纯数据层（不挂 React，便于单测）：
 *
 * - 推送刷新的增量合并：main 每次只回最新一页（BOT_GROUP_PAGE_SIZE），这里把它并进屏幕上
 *   已有的消息，而不是整页替换——被新消息挤出最新页的旧消息留在「更早」里，不会出现缺口或
 *   顶部跳动；最新页覆盖的序号区间内以 main 为准（编辑、删除、表情、话题数就地更新）。
 * - 引用稳定：内容没变的消息、安排沿用上一份对象，memo 过的消息行就不会重绘。
 * - 乐观发送：发出那一刻先插一条「发送中」的自己的消息，main 的详情里出现对应消息
 *   （按 send 返回的 messageId，返回前按序号之后的同文自发消息）后撤掉。
 * - Telegram / Slack 式排版：同一作者五分钟内的连续消息合并（只首条带头像与名字），
 *   每个自然日一条日期分隔。
 * - 多人群的显示名「伙伴名 (主人昵称)」与人类成员的「某某的主人」小标。
 */
import { collectBotTimelineDateDividers, isSameBotTimelineDay } from '@cindy/maker-shared/botTimeline';
import type {
  BotGroupAttachment,
  BotGroupDetail,
  BotGroupMemberView,
  BotGroupMention,
  BotGroupMessageView,
  BotGroupPlanStepView,
  BotGroupPlanView,
  BotGroupQuoteView,
  BotGroupThreadSummary,
} from '../../../shared/botGroupChat';
import type { BotGroupOutboxEntry } from './botGroupOutbox';
import { mergeBotGroupMessages, mergeBotGroupPlans } from './botGroupPresentation';

/** A timeline row; `pending` marks the optimistic copy of a message still on its way. */
export type BotGroupTimelineMessage = BotGroupMessageView & { pending?: true; outbox?: BotGroupOutboxEntry };

/** Consecutive messages by one author within this window share one header. */
export const BOT_GROUP_MERGE_WINDOW_MS = 5 * 60 * 1_000;

export interface BotGroupLoadedTimeline {
  group: BotGroupDetail;
  /** Messages on screen that the latest page no longer covers (paged in, or pushed out). */
  older: BotGroupMessageView[];
  olderPlans: BotGroupPlanView[];
  olderHasMore: boolean;
}

const signatures = new WeakMap<object, string>();
function signature(value: object): string {
  let cached = signatures.get(value);
  if (cached === undefined) {
    cached = JSON.stringify(value);
    signatures.set(value, cached);
  }
  return cached;
}

/**
 * `next` with every entry whose content equals the previous entry of the same id replaced by
 * that previous object; the previous array itself when nothing changed at all.
 */
/**
 * Pages opened through 「查看更早」 are not re-read, so their Thread roots take the unread state
 * from the latest Thread list; otherwise a Thread read here or on another computer keeps its badge.
 */
function withThreadUnread(older: BotGroupMessageView[], threads: readonly BotGroupThreadSummary[] | undefined): BotGroupMessageView[] {
  if (!threads?.length || !older.length) return older;
  const unread = new Map(threads.map(thread => [thread.rootId, thread.unread]));
  let changed = false;
  const next = older.map((message) => {
    const latest = unread.get(message.id);
    if (!latest || signature(latest) === signature(message.threadUnread ?? {})) return message;
    changed = true;
    return { ...message, threadUnread: latest };
  });
  return changed ? next : older;
}

export function stabilizeById<T extends { id: string }>(
  previous: readonly T[],
  next: readonly T[],
  /** More earlier copies to reuse (e.g. messages that moved between pages). */
  pool: readonly T[] = [],
): T[] {
  if (previous === next) return next as T[];
  const byId = new Map([...pool, ...previous].map((item) => [item.id, item]));
  let same = previous.length === next.length;
  const result = next.map((item, index) => {
    const old = byId.get(item.id);
    if (old && (old === item || signature(old) === signature(item))) {
      if (previous[index] !== old) same = false;
      return old;
    }
    same = false;
    return item;
  });
  return same ? (previous as T[]) : result;
}

/**
 * Merges a push refresh's latest page into the timeline on screen. Inside the page's range the
 * page wins; anything displayed below it stays (as `older`), so a message pushed out of the
 * newest page by new ones never disappears. A page that is the whole history drops the rest.
 */
export function mergeBotGroupLatestPage(
  previous: BotGroupLoadedTimeline,
  next: BotGroupDetail,
): BotGroupLoadedTimeline {
  const page = next.messages;
  const floor = page.reduce((min, message) => Math.min(min, message.sequence), Number.POSITIVE_INFINITY);
  const ceiling = previous.group.messages.reduce((max, message) => Math.max(max, message.sequence), Number.NEGATIVE_INFINITY);
  // More than a page arrived at once (e.g. while the window was in the background): the new page
  // neither overlaps nor directly adjoins the one on screen. Keeping the old rows
  // would hide that gap for good, so start over from the new page, as on first load; 「查看更早」
  // then reads on from right below it.
  if (next.hasMoreBefore && page.length > 0 && previous.group.messages.length > 0 && floor > ceiling + 1) {
    return {
      group: { ...next, messages: stabilizeById(previous.group.messages, page, previous.older),
        plans: stabilizeById(previous.group.plans, next.plans, previous.olderPlans) },
      older: [],
      olderPlans: [],
      olderHasMore: next.hasMoreBefore,
    };
  }
  // A page that says nothing comes before it is the whole recent history: whatever the last
  // latest page showed below it is gone. Pages opened through 「查看更早」 stay as they were;
  // their quoted originals are re-checked separately.
  const pushedOut = next.hasMoreBefore
    ? previous.group.messages.filter((message) => message.sequence < floor)
    : [];
  const older = withThreadUnread(pushedOut.length > 0
    ? stabilizeById(previous.older, mergeBotGroupMessages(previous.older, pushedOut))
    : previous.older, next.threads);
  // The first rows moving down take over what the old latest page said about earlier history.
  const olderHasMore = pushedOut.length > 0 && previous.older.length === 0 ? previous.group.hasMoreBefore : previous.olderHasMore;
  const messages = stabilizeById(previous.group.messages, page, previous.older);
  const plans = stabilizeById(previous.group.plans, next.plans, previous.olderPlans);
  // Plans the pushed-out messages point at stay with them.
  const olderPlans = pushedOut.length > 0
    ? stabilizeById(previous.olderPlans, mergeBotGroupPlans(previous.olderPlans, previous.group.plans))
    : previous.olderPlans;
  // Nothing moved: hand back the same object so the page skips the render entirely.
  if (messages === previous.group.messages && plans === previous.group.plans && older === previous.older
    && olderPlans === previous.olderPlans
    && olderHasMore === previous.olderHasMore
    && signature({ ...next, messages: null, plans: null }) === signature({ ...previous.group, messages: null, plans: null })) {
    return previous;
  }
  return {
    group: { ...next, messages, plans },
    older,
    olderPlans,
    olderHasMore,
  };
}

// ---- Optimistic sends -------------------------------------------------------------------

export interface BotGroupPendingSend {
  clientId: string;
  text: string;
  mentions: BotGroupMention;
  attachments: BotGroupAttachment[];
  quote: BotGroupQuoteView | null;
  createdAt: number;
  /** Last real sequence on screen when it was sent; its echo comes after this. */
  afterSequence: number;
  /** Set once main accepted it. */
  messageId?: string;
}

export function pendingBotGroupMessageId(clientId: string): string {
  return `pending:${clientId}`;
}

/** The optimistic row for a send still on its way. */
export function pendingBotGroupMessage(send: BotGroupPendingSend): BotGroupTimelineMessage {
  return {
    id: pendingBotGroupMessageId(send.clientId),
    // Shown after every real row; never used for paging or failure reconciliation.
    sequence: Number.MAX_SAFE_INTEGER,
    kind: 'message',
    authorKind: 'user',
    isSelf: true,
    authorBotId: null,
    authorName: '',
    content: send.text,
    mentions: send.mentions,
    noticeCode: null,
    planId: null,
    files: [],
    attachments: send.attachments,
    ...(send.quote ? { quote: send.quote } : {}),
    createdAt: send.createdAt,
    pending: true,
  };
}

function isOwnMessage(message: BotGroupMessageView): boolean {
  return message.kind === 'message' && message.authorKind === 'user' && message.isSelf !== false;
}

const NO_MATCHES: ReadonlyMap<string, string> = new Map();

/**
 * Which pending sends have shown up, as clientId → message id. A send main accepted matches its
 * message id; before the answer it matches the first own message after it with the same text and
 * as many attachments (each message settles one send). `adopted` (real message id → the pending
 * row key that already took it) carries those settlements across renders, so a later send of the
 * same words never claims a message an earlier send already became.
 */
export function matchBotGroupPendingSends(
  pending: readonly BotGroupPendingSend[],
  displayed: readonly BotGroupMessageView[],
  adopted: ReadonlyMap<string, string> = NO_MATCHES,
): ReadonlyMap<string, string> {
  if (pending.length === 0) return NO_MATCHES;
  const ids = new Set(displayed.map((message) => message.id));
  const claimed = new Set<string>();
  const matches = new Map<string, string>();
  for (const send of pending) {
    if (send.messageId && ids.has(send.messageId)) {
      claimed.add(send.messageId);
      matches.set(send.clientId, send.messageId);
    }
  }
  for (const send of pending) {
    if (send.messageId) continue;
    const text = send.text.trim();
    const key = pendingBotGroupMessageId(send.clientId);
    const echo = displayed.find((message) => !claimed.has(message.id) && (adopted.get(message.id) ?? key) === key && isOwnMessage(message)
      && message.sequence > send.afterSequence && message.content.trim() === text
      && message.attachments.length === send.attachments.length);
    if (!echo) continue;
    claimed.add(echo.id);
    matches.set(send.clientId, echo.id);
  }
  return matches.size === 0 ? NO_MATCHES : matches;
}

/** Pending sends whose message has not shown up yet; the same array when nothing settled. */
export function settleBotGroupPendingSends<T extends BotGroupPendingSend>(
  pending: readonly T[],
  displayed: readonly BotGroupMessageView[],
): T[] {
  const matches = matchBotGroupPendingSends(pending, displayed);
  if (matches.size === 0) return pending as T[];
  return pending.filter((send) => !matches.has(send.clientId));
}

// ---- Layout ----------------------------------------------------------------------------

export interface BotGroupRowLayout {
  /** Same author as the row above, within the merge window: no avatar or name. */
  continued: boolean;
  /** First message of a local day: the date to show above it. */
  dateDivider: number | null;
}

function authorKey(message: BotGroupTimelineMessage): string | null {
  // Notices, dividers, plan cards and step hand-offs (which carry a step tag) always open a block.
  if (message.kind !== 'message' || message.authorKind === 'system' || message.planId) return null;
  if (isOwnMessage(message)) return 'self';
  return `${message.authorKind}:${message.authorBotId ?? ''}:${message.authorName}`;
}

export function layoutBotGroupTimeline(
  messages: readonly BotGroupTimelineMessage[],
): ReadonlyMap<string, BotGroupRowLayout> {
  const dividers = collectBotTimelineDateDividers(messages.map((message) => ({ clientId: message.id, createdAt: message.createdAt })));
  const layout = new Map<string, BotGroupRowLayout>();
  let previous: BotGroupTimelineMessage | null = null;
  for (const message of messages) {
    const dateDivider = dividers.get(message.id) ?? null;
    const key = authorKey(message);
    const continued = previous !== null && dateDivider === null && key !== null && key === authorKey(previous)
      && message.createdAt - previous.createdAt >= 0
      && message.createdAt - previous.createdAt < BOT_GROUP_MERGE_WINDOW_MS
      && isSameBotTimelineDay(previous.createdAt, message.createdAt);
    layout.set(message.id, { continued, dateDivider });
    previous = message;
  }
  return layout;
}

// ---- Names -----------------------------------------------------------------------------

type NamedMember = Pick<BotGroupMemberView, 'name' | 'ownerName' | 'isOwned' | 'actorKind'>;

function ownerSuffix(member: NamedMember): string | null {
  const owner = member.ownerName?.trim();
  return owner ? ` (${owner})` : null;
}

/** The member's own name without a 「 (主人昵称)」 suffix the host may already have added. */
export function botGroupMemberBaseName(member: NamedMember): string {
  const name = member.name.trim();
  const suffix = ownerSuffix(member);
  return suffix && name.endsWith(suffix) && name.length > suffix.length ? name.slice(0, -suffix.length) : name;
}

/**
 * 多人群里别人带来的伙伴显示为 `伙伴名 (主人昵称)`（bot-group-chat.md §10）；自己的伙伴、
 * 人类成员与本地群照常显示名字。只用于展示，点名与身份仍按 id。
 */
export function botGroupMemberDisplayName(member: NamedMember): string {
  const suffix = ownerSuffix(member);
  if (suffix && member.isOwned === false && member.actorKind !== 'human') return `${botGroupMemberBaseName(member)}${suffix}`;
  return member.name.trim();
}

/** Names of the bots a human member brought into the group (for 「某某的主人」). */
export function botGroupOwnedBotNames(
  member: Pick<BotGroupMemberView, 'actorId' | 'actorKind'> | undefined,
  members: readonly BotGroupMemberView[],
): string[] {
  if (!member?.actorId || member.actorKind !== 'human') return [];
  return members
    .filter((candidate) => candidate.actorKind === 'bot' && candidate.ownerActorId === member.actorId)
    .map(botGroupMemberBaseName)
    .filter(Boolean);
}

// ---- Plans -----------------------------------------------------------------------------

export interface BotGroupRunningStep {
  plan: BotGroupPlanView;
  step: BotGroupPlanStepView;
  /** 1-based place in the plan, as shown to the user. */
  index: number;
  total: number;
}

/** The step of an open plan that is in progress right now. */
export function runningBotGroupPlanStep(plan: BotGroupPlanView | null): BotGroupRunningStep | null {
  if (!plan || plan.status !== 'running') return null;
  const index = plan.steps.findIndex((step) => step.status === 'running');
  if (index < 0) return null;
  return { plan, step: plan.steps[index]!, index: index + 1, total: plan.steps.length };
}

/**
 * 「第 k 步」 on a step's hand-off message. Where the plan names each step's latest hand-off, that
 * message gets its step exactly, and a hand-off a redo replaced gets the step of the same
 * author's next hand-off (a redo follows the step it redoes); one that matches nothing stays
 * unnumbered rather than numbered wrong. Without those ids (Chat Server plans, older hosts) the
 * author's hand-offs are matched to the author's steps in order.
 */
export function botGroupHandoffStepNumbers(
  messages: readonly BotGroupMessageView[],
  plans: ReadonlyMap<string, BotGroupPlanView>,
): ReadonlyMap<string, number> {
  const numbers = new Map<string, number>();
  const handoffs = messages.filter((message) => message.kind === 'message' && message.authorKind === 'bot'
    && message.planId && message.authorBotId && plans.has(message.planId));
  const exact = new Map<string, number>();
  const exactPlans = new Set<string>();
  for (const plan of plans.values()) {
    plan.steps.forEach((step, index) => {
      if (step.resultMessageId === undefined) return;
      exactPlans.add(plan.id);
      if (step.resultMessageId) exact.set(step.resultMessageId, index + 1);
    });
  }
  const next = new Map<string, number>();
  for (const message of [...handoffs].reverse()) {
    if (!exactPlans.has(message.planId!)) continue;
    const key = `${message.planId}:${message.authorBotId}`;
    const number = exact.get(message.id) ?? next.get(key);
    if (number === undefined) continue;
    numbers.set(message.id, number);
    next.set(key, number);
  }
  const seen = new Map<string, number>();
  for (const message of handoffs) {
    if (exactPlans.has(message.planId!)) continue;
    const plan = plans.get(message.planId!)!;
    const key = `${plan.id}:${message.authorBotId}`;
    const nth = seen.get(key) ?? 0;
    const positions = plan.steps.flatMap((step, index) => (step.botId === message.authorBotId ? [index + 1] : []));
    const number = positions[Math.min(nth, positions.length - 1)];
    if (number !== undefined) numbers.set(message.id, number);
    seen.set(key, nth + 1);
  }
  return numbers;
}

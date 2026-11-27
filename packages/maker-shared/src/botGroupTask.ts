/**
 * An independent background task started from a group by its owner's teammate
 * (docs/product-rules/bot-group-chat.md §10). The task lives in the group: its
 * card, confirmations and result are posted there as the teammate's own messages,
 * each carrying one of these cards. Older clients read the `fallback` line.
 */
import type { BotGroupMessageView } from './botGroupChat';
import { readBotCollaborationMeta, type BotCollaborationMeta } from './botCollaboration';

export const BOT_GROUP_TASK_NAMESPACE = 'cindy.task';
export const BOT_GROUP_TASK_SCHEMA_REVISION = 1;

/** What the card said when it was posted; the owner's clients read the live row instead. */
export type BotGroupTaskCardState = 'started' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'timed-out';
const STATES: readonly BotGroupTaskCardState[] = ['started', 'waiting', 'completed', 'failed', 'cancelled', 'timed-out'];

export interface BotGroupTaskCardView {
  /** The task anchor (`delegation-request`); `parentSessionId` is the group lane on the owner's computer. */
  meta: BotCollaborationMeta;
  state: BotGroupTaskCardState;
  /** Task title when this card was posted. */
  title: string;
  /** What the task is waiting on (only for `waiting`). */
  summary?: string;
}

export interface BotGroupTaskCard {
  type: 'card';
  namespace: typeof BOT_GROUP_TASK_NAMESPACE;
  schemaRevision: typeof BOT_GROUP_TASK_SCHEMA_REVISION;
  fallback: string;
  data: { meta: BotCollaborationMeta; state: BotGroupTaskCardState; title: string; summary?: string };
}

/** Preview/quote text without duplicating a task card in the message body. */
export function botGroupMessageSummaryText(message: Pick<BotGroupMessageView, 'content' | 'task' | 'deleted'> & Partial<Pick<BotGroupMessageView, 'liveTask'>>): string {
  return message.content.trim() || (message.deleted ? '' : message.task?.title.trim() ?? message.liveTask?.title.trim() ?? '');
}

const TITLE_MAX = 120;
const SUMMARY_MAX = 400;

/**
 * Words for the `fallback` line, supplied by the sender in its own UI language: this
 * module has no locale, and a card is read by clients in any language.
 */
export interface BotGroupTaskCardLabels {
  /** Short noun before the title, e.g. "Task". */
  task: string;
  /** Title for a task that has none yet. */
  untitled: string;
  states: Record<BotGroupTaskCardState, string>;
}

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  let end = max - 1;
  // Never split a surrogate pair (emoji and other astral characters are two UTF-16 units).
  const high = text.charCodeAt(end - 1);
  if (high >= 0xd800 && high <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

export function buildBotGroupTaskCard(view: BotGroupTaskCardView, labels: BotGroupTaskCardLabels): BotGroupTaskCard {
  const title = clip(view.title, TITLE_MAX) || clip(labels.untitled, TITLE_MAX);
  const summary = view.summary ? clip(view.summary, SUMMARY_MAX) : undefined;
  return {
    type: 'card',
    namespace: BOT_GROUP_TASK_NAMESPACE,
    schemaRevision: BOT_GROUP_TASK_SCHEMA_REVISION,
    fallback: `[${labels.task}] ${title} · ${labels.states[view.state]}${summary ? `: ${summary}` : ''}`,
    data: { meta: view.meta, state: view.state, title, ...(summary ? { summary } : {}) },
  };
}

function viewFromFields(data: Record<string, unknown>): BotGroupTaskCardView | null {
  const meta = readBotCollaborationMeta(data.meta);
  if (!meta || meta.role !== 'delegation-request') return null;
  if (typeof data.state !== 'string' || !STATES.includes(data.state as BotGroupTaskCardState)) return null;
  if (typeof data.title !== 'string') return null;
  if (data.summary !== undefined && typeof data.summary !== 'string') return null;
  return {
    meta,
    state: data.state as BotGroupTaskCardState,
    title: clip(data.title, TITLE_MAX),
    ...(data.summary ? { summary: clip(data.summary, SUMMARY_MAX) } : {}),
  };
}

/** Strict: a malformed card is no card, and the message renders as plain text. */
export function readBotGroupTaskCard(block: unknown): BotGroupTaskCardView | null {
  if (!block || typeof block !== 'object') return null;
  const value = block as { type?: unknown; namespace?: unknown; schemaRevision?: unknown; data?: unknown };
  if (value.type !== 'card' || value.namespace !== BOT_GROUP_TASK_NAMESPACE
    || value.schemaRevision !== BOT_GROUP_TASK_SCHEMA_REVISION) return null;
  const data = value.data && typeof value.data === 'object' && !Array.isArray(value.data)
    ? value.data as Record<string, unknown> : null;
  return data ? viewFromFields(data) : null;
}

/** The card as a controller receives it in a message view (same fields, already projected). */
export function parseBotGroupTaskCardView(value: unknown): BotGroupTaskCardView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return viewFromFields(value as Record<string, unknown>);
}

/**
 * Revision 2: an ordinary task opened from a group request with `send_to_session`
 * (bot-group-chat.md §10). The computer that runs the task posts the card as the teammate that
 * opened it and edits that same message when the task's status changes; nobody else writes it.
 * Clients that only know revision 1 read the `fallback` line.
 */
export const BOT_GROUP_LIVE_TASK_SCHEMA_REVISION = 2;
/**
 * `idle`: the task's turn ended and it is not running. That is not "done": the task may be waiting
 * for an answer it asked in text, which the host cannot tell apart. `waiting` is a pending
 * confirmation or question the host does see.
 */
export type BotGroupLiveTaskState = 'running' | 'waiting' | 'idle' | 'failed';
const LIVE_STATES: readonly BotGroupLiveTaskState[] = ['running', 'waiting', 'idle', 'failed'];

/**
 * The card state for a task's activity phase on the computer that runs it (`running`,
 * `needs-interaction`, `completed` = its turn ended, `error`); undefined while it has none.
 */
export function botGroupLiveTaskStateOfPhase(phase: string | undefined): BotGroupLiveTaskState | undefined {
  return phase === 'running' ? 'running' : phase === 'needs-interaction' ? 'waiting'
    : phase === 'error' ? 'failed' : phase === 'completed' ? 'idle' : undefined;
}

export interface BotGroupLiveTaskView {
  /** The task's session id on the computer that runs it. */
  taskId: string;
  /** That computer (null on hosts that do not know their device id). */
  deviceId: string | null;
  title: string;
  state: BotGroupLiveTaskState;
  /** Who asked in the group, and which teammate opened the task (names when posted). */
  requesterName: string;
  botName: string;
  /** The task's pull request, when it has recorded one. */
  prUrl?: string;
  /** Where the task stopped: one plain line of its last reply the group may read; absent while running. */
  summary?: string;
}

export interface BotGroupLiveTaskCardLabels {
  task: string;
  untitled: string;
  states: Record<BotGroupLiveTaskState, string>;
}

const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;
const NAME_MAX = 80;
const LINE_MAX = 80;

/**
 * The card's one line for a task reply: its first non-empty line as plain text (Markdown markers
 * dropped, a link reads as its words), clipped. Empty when the reply has no text.
 */
export function botGroupLiveTaskReplyLine(reply: string): string {
  for (const raw of reply.split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*(?:```.*|#{1,6}\s+|>\s*|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)+/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|~~|`)/g, '')
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_](?=$|[\s.,;:!?)])/g, '$1$2');
    const text = clip(line, LINE_MAX);
    if (text) return text;
  }
  return '';
}

export function buildBotGroupLiveTaskCard(view: BotGroupLiveTaskView, labels: BotGroupLiveTaskCardLabels) {
  const title = clip(view.title, TITLE_MAX) || clip(labels.untitled, TITLE_MAX);
  const summary = view.summary ? clip(view.summary, LINE_MAX) : '';
  return {
    type: 'card' as const,
    namespace: BOT_GROUP_TASK_NAMESPACE,
    schemaRevision: BOT_GROUP_LIVE_TASK_SCHEMA_REVISION,
    fallback: `[${labels.task}] ${title} · ${labels.states[view.state]}${summary ? ` · ${summary}` : ''}${view.prUrl ? ` · ${view.prUrl}` : ''}`,
    data: { taskId: view.taskId, deviceId: view.deviceId, title, state: view.state,
      requesterName: clip(view.requesterName, NAME_MAX), botName: clip(view.botName, NAME_MAX),
      ...(view.prUrl && PR_URL.test(view.prUrl) ? { prUrl: view.prUrl } : {}), ...(summary ? { summary } : {}) },
  };
}

/** Strict, like revision 1: a malformed card is no card. */
export function readBotGroupLiveTaskCard(block: unknown): BotGroupLiveTaskView | null {
  if (!block || typeof block !== 'object') return null;
  const value = block as { type?: unknown; namespace?: unknown; schemaRevision?: unknown; data?: unknown };
  if (value.type !== 'card' || value.namespace !== BOT_GROUP_TASK_NAMESPACE
    || value.schemaRevision !== BOT_GROUP_LIVE_TASK_SCHEMA_REVISION) return null;
  return parseBotGroupLiveTaskView(value.data);
}

/** The card as a controller receives it in a message view. */
export function parseBotGroupLiveTaskView(value: unknown): BotGroupLiveTaskView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.taskId !== 'string' || !/^[\w-]{1,128}$/.test(data.taskId)) return null;
  if (data.deviceId !== null && (typeof data.deviceId !== 'string' || !/^[\w.:-]{1,128}$/.test(data.deviceId))) return null;
  const state = data.state;
  if (typeof state !== 'string' || !LIVE_STATES.includes(state as BotGroupLiveTaskState)) return null;
  if (typeof data.title !== 'string' || typeof data.requesterName !== 'string' || typeof data.botName !== 'string') return null;
  if (data.prUrl !== undefined && (typeof data.prUrl !== 'string' || !PR_URL.test(data.prUrl))) return null;
  if (data.summary !== undefined && typeof data.summary !== 'string') return null;
  const summary = typeof data.summary === 'string' ? clip(data.summary, LINE_MAX) : '';
  return { taskId: data.taskId, deviceId: data.deviceId as string | null, title: clip(data.title, TITLE_MAX),
    state: state as BotGroupLiveTaskState, requesterName: clip(data.requesterName, NAME_MAX), botName: clip(data.botName, NAME_MAX),
    ...(data.prUrl ? { prUrl: data.prUrl as string } : {}), ...(summary ? { summary } : {}) };
}

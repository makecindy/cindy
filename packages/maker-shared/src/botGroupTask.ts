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
export function botGroupMessageSummaryText(message: Pick<BotGroupMessageView, 'content' | 'task' | 'deleted'>): string {
  return message.content.trim() || (message.deleted ? '' : message.task?.title.trim() ?? '');
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

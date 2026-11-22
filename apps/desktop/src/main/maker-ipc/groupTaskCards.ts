import { createHash } from 'node:crypto';
import {
  botGroupLiveTaskReplyLine, buildBotGroupLiveTaskCard, buildBotGroupQuoteCard, isBotGroupNoReplyText,
  type BotGroupLiveTaskCardLabels, type BotGroupLiveTaskState, type BotGroupLiveTaskView, type BotGroupQuoteView,
} from '../../shared/botGroupChat.js';
import type { BotGroupLaneTerminal } from './botGroupChatService.js';
import type { ChatLiveTaskCardRecord } from './chatServerWorkspaces.js';

/**
 * Task cards (bot-group-chat.md §10). A task opened from a group request shows in the group as a
 * card, posted where the request was. The computer that runs the task keeps the group informed:
 *
 * - the card itself follows the task's title, state and pull request (the same message, edited);
 * - each turn that ends in the task posts its reply into the card's Thread, the task's window in
 *   the group.
 *
 * The host does not report a result for the task. When the task sends word back to the task that
 * opened it (`send_to_session`), that task's teammate answers as it sees fit, and its answer goes
 * where the request was, as a quote-reply to the request that names who asked.
 *
 * A card posted inside a Thread cannot root one of its own: its replies and that answer go to that
 * Thread. Everything is posted as the teammate that opened the task, once per turn end, and
 * survives a restart: what is still to post is kept with the card.
 */
export interface GroupTaskCardsDeps {
  current: () => boolean;
  store: () => { read(): Record<string, ChatLiveTaskCardRecord>; save(value: Record<string, ChatLiveTaskCardRecord>): void };
  /** This computer; cards of tasks running on another of the account's computers are left to it. */
  deviceId: () => string | null | undefined;
  /** Posts a group message as `actorId`; the operation makes a retry the same message. */
  post: (roomId: string, actorId: string, body: { operationId: string; content: unknown[]; mentions: string[]; threadRootId?: string }) =>
    Promise<{ id?: string; revision?: number } | undefined>;
  /** Edits a message `actorId` posted, at the revision it was last seen. */
  edit: (roomId: string, messageId: string, actorId: string, body: { operationId: string; expectedRevision: number; content: unknown[] }) =>
    Promise<{ revision?: number } | undefined>;
  /** How a refused request reads: never to be accepted, when it may be retried, the message is gone. */
  refusal: (error: unknown) => { final: boolean; retryAt?: number; gone: boolean };
  /** The task on this computer: `state` undefined while it has none yet; null once the task is gone. */
  readTask?: (taskId: string) => Promise<{ title: string; state?: BotGroupLiveTaskState; prUrl?: string } | null>;
  /** The task that sent the input a turn answered, when another task on this computer did. */
  inputSender: (sessionId: string, inputClientId: string) => Promise<string | null>;
  /** The reply a finished turn stored, when its terminal carries no text. */
  storedReply: (sessionId: string, messageClientId: string) => Promise<string | null>;
  labels: () => BotGroupLiveTaskCardLabels;
  changed: (roomId: string) => void;
  log?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}

/** Cards follow their task for a week; after that a card keeps what it last said. */
const FOLLOW_MS = 7 * 24 * 60 * 60_000;
/** A new task counts as started for this long before a card without a turn end reads as idle. */
const STARTING_MS = 120_000;
/** A message that could not reach the group is retried with backoff, then dropped. */
const POST_ATTEMPTS = 8;
/** Turn ends a card remembers, so the same end seen again posts nothing again. */
const TURNS_KEPT = 20;
const MESSAGE_CHARS = 16_000;

export function createGroupTaskCards(deps: GroupTaskCardsDeps) {
  const mine = (card: ChatLiveTaskCardRecord) => !(card.deviceId && deps.deviceId() && card.deviceId !== deps.deviceId());
  const cardBlock = (view: BotGroupLiveTaskView) => buildBotGroupLiveTaskCard(view, deps.labels());
  const warn = (message: string) => (error: unknown) => deps.log?.warn(message, { error: error instanceof Error ? error.message : String(error) });

  /** Read-modify-write of one card against the current file, never a stale copy; null removes it. */
  function update(messageId: string, change: (card: ChatLiveTaskCardRecord) => ChatLiveTaskCardRecord | null) {
    if (!deps.current()) return;
    const cards = deps.store().read();
    const card = cards[messageId];
    if (!card) return;
    const next = change(card);
    if (next) cards[messageId] = next; else delete cards[messageId];
    deps.store().save(cards);
  }

  /** Turn ends of tasks whose card is still being posted, noted in order once the card is saved. */
  const posting = new Map<string, Array<[BotGroupLaneTerminal, boolean]>>();

  /**
   * Posts the card of a task just opened from a group request. `quote` is that request, when it can
   * still be read; `requesterId` whom the answer names (null when they are no longer in the group);
   * `openerTaskId` the task that opened it, whose answers to its word come back to the group.
   */
  async function post(card: {
    executionId: string; roomId: string; botId: string; threadRootId: string | null;
    taskId: string; openerTaskId: string; deviceId: string | null; title: string; requesterName: string; botName: string;
    /** The request it quotes, still being read: the card is reserved before, so a fast first turn is kept. */
    quote: Promise<BotGroupQuoteView | undefined>; requesterId: string | null;
  }) {
    if (!deps.current()) return;
    const view: BotGroupLiveTaskView = { taskId: card.taskId, deviceId: card.deviceId ?? deps.deviceId() ?? null, title: card.title,
      state: 'running', requesterName: card.requesterName, botName: card.botName };
    const ended = posting.get(card.taskId) ?? [];
    posting.set(card.taskId, ended);
    try {
      const quote = await card.quote.catch(() => undefined);
      const body = { operationId: `task-card:${card.executionId}:${card.taskId}`.slice(0, 160),
        content: [cardBlock(view)], mentions: [], ...(card.threadRootId ? { threadRootId: card.threadRootId } : {}) };
      // A card that could not reach the group is retried as the same message, with backoff, until it is refused.
      let posted: { id?: string; revision?: number } | undefined;
      for (let attempt = 1; ; attempt++) {
        try { posted = await deps.post(card.roomId, card.botId, body); break; } catch (error) {
          const refusal = deps.refusal(error);
          if (refusal.final || attempt >= POST_ATTEMPTS || !deps.current()) throw error;
          const wait = Math.max(15_000 * 2 ** (attempt - 1), (refusal.retryAt ?? 0) - Date.now());
          await new Promise(resolve => setTimeout(resolve, wait));
          if (!deps.current()) return;
        }
      }
      if (!deps.current() || typeof posted?.id !== 'string') return;
      const cards = deps.store().read();
      cards[posted.id] = { ...view, roomId: card.roomId, botId: card.botId, threadRootId: card.threadRootId, requesterId: card.requesterId,
        openerTaskId: card.openerTaskId, ...(quote ? { quote } : {}), revision: posted.revision ?? 1, createdAt: Date.now() };
      deps.store().save(cards);
      deps.changed(card.roomId);
    } catch (error) {
      warn('Group task card could not be posted')(error);
    } finally {
      // A fast task can end its first turn before its card is saved (an end arriving now still joins the list).
      for (const [terminal, fromThread] of ended) await noteTurn(terminal, fromThread, true).catch(warn('Group task card turn could not be noted'));
      if (posting.get(card.taskId) === ended) posting.delete(card.taskId);
    }
  }

  /** The reply a turn ended with, as the group may read it: empty when it said nothing for the group. */
  async function replyOf(terminal: BotGroupLaneTerminal) {
    let text = terminal.resultText;
    if (terminal.outcome === 'done' && !text.trim() && terminal.resultMessageClientId)
      text = (await deps.storedReply(terminal.sessionId, terminal.resultMessageClientId).catch(() => null)) ?? '';
    return isBotGroupNoReplyText(text) ? '' : text.trim().slice(0, MESSAGE_CHARS);
  }
  /** Names one turn end: its input and reply (the error and the done that close one turn share both). */
  const turnOf = (terminal: BotGroupLaneTerminal) => [terminal.activeInputClientId, terminal.resultMessageClientId].filter(Boolean).join(':');
  const opOf = (kind: 'task-reply' | 'task-result', messageId: string, turn: string) =>
    `${kind}:${messageId}:${createHash('sha256').update(turn).digest('hex').slice(0, 32)}`;

  /**
   * A turn ended in a task on this computer. `fromThread`: the turn was a group member's words from
   * the card's Thread, whose answer the group already has there.
   */
  async function noteTurn(terminal: BotGroupLaneTerminal, fromThread: boolean, replay = false) {
    if (!deps.current() || !terminal.sessionId) return;
    if (!replay) await noteAnswer(terminal);
    const waiting = replay ? undefined : posting.get(terminal.sessionId);
    if (waiting) { waiting.push([{ ...terminal }, fromThread]); return; }
    const cards = Object.entries(deps.store().read()).filter(([, card]) => card.taskId === terminal.sessionId && mine(card));
    if (!cards.length) return;
    const text = await replyOf(terminal);
    const line = botGroupLiveTaskReplyLine(text);
    const turn = turnOf(terminal);
    for (const [messageId] of cards) update(messageId, card => {
      if (turn && card.turns?.includes(turn)) return card;
      // Every end gives the card its line; one that cannot be told apart from another is never posted.
      const next: ChatLiveTaskCardRecord = { ...card, lastLine: line || undefined };
      if (!turn) return next;
      next.turns = [...(card.turns ?? []), turn].slice(-TURNS_KEPT);
      if (!fromThread && text) next.outbox = [...(card.outbox ?? []), { op: opOf('task-reply', messageId, turn), kind: 'reply', text }];
      return next;
    });
    void sync(true);
  }

  /**
   * The turn answered word a card's task sent back to the task that opened it: the answer is what
   * the group hears of the result, where the request was. Saying nothing for the group posts nothing.
   */
  async function noteAnswer(terminal: BotGroupLaneTerminal) {
    const cards = Object.entries(deps.store().read()).filter(([, card]) => card.openerTaskId === terminal.sessionId && mine(card));
    const turn = turnOf(terminal);
    if (!cards.length || !turn || !terminal.activeInputClientId) return;
    const sender = await deps.inputSender(terminal.sessionId, terminal.activeInputClientId).catch(() => null);
    const answered = cards.filter(([, card]) => card.taskId === sender);
    if (!answered.length) return;
    const text = await replyOf(terminal);
    if (!text) return;
    for (const [messageId] of answered) update(messageId, card => {
      const op = opOf('task-result', messageId, turn);
      return card.outbox?.some(item => item.op === op) || card.answers?.includes(op) ? card
        : { ...card, answers: [...(card.answers ?? []), op].slice(-TURNS_KEPT), outbox: [...(card.outbox ?? []), { op, kind: 'result', text }] };
    });
    void sync(true);
  }

  /** Posts what a card's task left for the group, oldest first; the next waits while one is retried. */
  async function postOutbox(messageId: string) {
    for (;;) {
      const card = deps.store().read()[messageId];
      const item = card?.outbox?.[0];
      if (!deps.current() || !card || !item || Date.now() < (item.retryAt ?? 0)) return;
      const drop = (fresh: ChatLiveTaskCardRecord) => ({ ...fresh, outbox: fresh.outbox?.filter(other => other.op !== item.op) });
      // The Thread holds each reply as it is. The answer goes where the request was (the main group, or
      // the Thread the card sits in) as a quote-reply to the request that names who asked.
      const result = item.kind === 'result';
      const names = result && !!card.requesterId;
      const threadRootId = result ? card.threadRootId : card.threadRootId ?? messageId;
      try {
        await deps.post(card.roomId, card.botId, {
          operationId: item.op, mentions: names ? [card.requesterId!] : [],
          ...(threadRootId ? { threadRootId } : {}),
          content: [...(result && card.quote ? [buildBotGroupQuoteCard(card.quote)] : []),
            { type: 'text', text: names && card.requesterName ? `@${card.requesterName} ${item.text}` : item.text }],
        });
        update(messageId, drop);
        deps.changed(card.roomId);
      } catch (error) {
        const refusal = deps.refusal(error);
        const attempts = (item.attempts ?? 0) + 1;
        const giveUp = attempts >= POST_ATTEMPTS || refusal.final;
        if (giveUp) warn('Group task message could not be posted')(error);
        update(messageId, fresh => giveUp ? drop(fresh) : { ...fresh, outbox: fresh.outbox?.map(other => other.op !== item.op ? other
          // A rate limit's own wait wins when it is longer than the backoff.
          : { ...other, attempts, retryAt: Math.max(Date.now() + 15_000 * 2 ** (attempts - 1), refusal.retryAt ?? 0) }) });
        if (!giveUp) return;
      }
    }
  }

  let syncing = false;
  let syncAgain = false;
  /**
   * One pass over this computer's cards: posts what is waiting and brings each card in step with
   * its task. `soon`: a turn just ended; if a pass is under way, run another right after it.
   */
  async function sync(soon = false) {
    if (syncing) { if (soon) syncAgain = true; return; }
    if (!deps.current() || !deps.readTask) return;
    syncing = true;
    try {
      for (const [messageId, card] of Object.entries(deps.store().read())) {
        if (!deps.current()) return;
        if (Date.now() - card.createdAt > FOLLOW_MS) { update(messageId, () => null); continue; }
        if (!mine(card)) continue;
        await postOutbox(messageId);
        const task = await deps.readTask(card.taskId).catch(() => undefined);
        if (task === undefined) continue;
        if (task === null) { update(messageId, () => null); continue; }
        const latest = deps.store().read()[messageId];
        if (!latest) continue;
        const state = task.state ?? (latest.state === 'running' && Date.now() - latest.createdAt > STARTING_MS ? 'idle' : latest.state);
        const prUrl = task.prUrl ?? latest.prUrl;
        const next: BotGroupLiveTaskView = { taskId: latest.taskId, deviceId: latest.deviceId, title: task.title || latest.title, state,
          requesterName: latest.requesterName, botName: latest.botName, ...(prUrl ? { prUrl } : {}),
          // Where it stopped comes with a turn's end; a running or waiting task is inside a turn.
          ...((state === 'idle' || state === 'failed') && latest.lastLine ? { summary: latest.lastLine } : {}) };
        if (next.title === latest.title && next.state === latest.state && next.prUrl === latest.prUrl && next.summary === latest.summary) continue;
        // A refused edit waits as long as the server asked before the card is edited again.
        if (Date.now() < (latest.editRetryAt ?? 0)) continue;
        try {
          const edited = await deps.edit(latest.roomId, messageId, latest.botId,
            { operationId: `task-card:${messageId}:${latest.revision}`, expectedRevision: latest.revision, content: [cardBlock(next)] });
          update(messageId, fresh => ({ ...fresh, title: next.title, state: next.state, prUrl: next.prUrl, summary: next.summary,
            revision: edited?.revision ?? latest.revision + 1, editRetryAt: undefined }));
          deps.changed(latest.roomId);
        } catch (error) {
          // A deleted card, a teammate that left or a card edited elsewhere is no longer ours to keep.
          const refusal = deps.refusal(error);
          if (refusal.gone) update(messageId, () => null);
          else update(messageId, fresh => ({ ...fresh, editRetryAt: Math.max(Date.now() + 15_000, refusal.retryAt ?? 0) }));
        }
      }
    } catch (error) {
      warn('Group task cards could not be refreshed')(error);
    } finally {
      syncing = false;
      if (syncAgain) { syncAgain = false; void sync(); }
    }
  }

  return {
    post, noteTurn, sync, update,
    /** The card a Thread hangs under, when this computer runs its task. */
    ofThread(roomId: string, rootId: string): ChatLiveTaskCardRecord | null {
      const card = deps.store().read()[rootId];
      return card && card.roomId === roomId && mine(card) ? card : null;
    },
  };
}

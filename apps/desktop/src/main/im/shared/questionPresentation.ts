import { randomBytes } from 'node:crypto';
import type { IMMessageEvent, ImOutputDriver, TextChannelIM } from '@cindy/im';
import type { QuestionControls } from '../../maker-ipc/interactionRouter';
import { createQuestionCard, type QuestionRequest } from './questionCard';
import { imText } from './imText';

export const IM_QUESTION_TIMEOUT_MS = 30 * 60_000;

// One registry per transport instance; it only matches explicit question references.
// Plain conversation never implicitly answers an asynchronous question.
type Reply = Pick<IMMessageEvent, 'senderId' | 'text'> & Partial<IMMessageEvent>;
type Pending = { code: string; lane: string; respondent: string; scope?: string;
  messages: Set<string>; current(): boolean; answer(text: string): Promise<boolean> };
const pending = new WeakMap<TextChannelIM, Set<Pending>>();
export function findImQuestionReply(im: TextChannelIM, event: Reply): (() => Promise<boolean>) | undefined {
  if (/^\s*[!/]/.test(event.text)) return;
  for (const entry of pending.get(im) ?? []) {
    const coded = event.text.trim().match(/^\[?(Q[0-9a-f]{8})\]?\s+([\s\S]+)$/i);
    const quoted = event.replyContext?.messageId && entry.messages.has(event.replyContext.messageId);
    if (!quoted && coded?.[1].toLowerCase() !== entry.code.toLowerCase()) continue;
    if (event.senderId !== entry.lane || (event.speaker?.id ?? event.senderId) !== entry.respondent
      || (entry.scope !== undefined && event.scopeKey !== entry.scope) || !entry.current()) {
      return async () => false; // Matched another person's question: never enqueue as a model turn.
    }
    return () => entry.answer(coded ? coded[2] : event.text);
  }
}

export async function presentImQuestion(args: {
  output: ImOutputDriver; lane: string; respondent: string; scope?: string;
  request: QuestionRequest; controls: QuestionControls; current(): boolean;
  warn(): void;
}): Promise<void> {
  const { output, request, controls } = args;
  const im = output.im;
  const initialStatus = im.getStatus?.();
  let revoked = false;
  const current = () => !revoked && args.current() && (initialStatus?.kind !== 'connected'
    || im.getStatus?.().kind === 'connected' && (im.getStatus() as { appId?: string }).appId === initialStatus.appId);
  const code = `Q${randomBytes(4).toString('hex')}`;
  const entries = pending.get(im) ?? new Set<Pending>();
  pending.set(im, entries);
  let messageId: string | undefined;
  let attempted = false;
  const messages = new Set<string>();
  const card = createQuestionCard(request, controls, async (spec, closed) => {
    if (!current()) throw new Error('stale question session');
    if (output.kind === 'rich-card') {
      if (messageId) await output.im.updateInteractiveCard(messageId, spec, {
        questionRespondentId: args.respondent, questionClosed: closed,
      });
      else {
        if (attempted) throw new Error('question delivery already attempted');
        attempted = true;
        messageId = (await output.im.sendInteractiveCard(args.lane, spec, {
          threadTs: args.scope, questionRespondentId: args.respondent,
        })).messageId;
        messages.add(messageId);
      }
    } else {
      const sent = await im.sendText(args.lane, spec.body, { threadTs: args.scope });
      messages.add(sent.messageId);
    }
  }, imText(output.kind === 'rich-card' ? 'imBot.text.questions.replyHint' : 'imBot.text.questions.textHint', { code }));
  const entry: Pending = { code, lane: args.lane, respondent: args.respondent, scope: args.scope,
    messages, current, answer: text => (request.questions.length > 1 || request.questions.some(q => q.multiSelect)) && text.trim().toLowerCase() === 'ok' ? card.submit() : card.replyText(text) };
  entries.add(entry);
  const unsubscribe = output.kind === 'rich-card' ? output.im.onCardAction(event => {
    if (event.messageId !== messageId || event.senderId !== args.lane || !current()) return;
    // The transport verifies the real platform actor; never trust callback payload identity.
    if ((event.actorId ?? event.senderId) !== args.respondent) return;
    void (event.buttonId === 'question:reply' && typeof event.payload?.answerText === 'string'
      ? card.replyText(event.payload.answerText) : card.click(event.buttonId)).catch(args.warn);
  }) : () => {};
  const unsubscribeStatus = im.onStatusChange?.(status => {
    if (['idle', 'offline', 'conflict', 'error'].includes(status.kind)
      || (status.kind === 'connected' && initialStatus?.kind === 'connected' && status.appId !== initialStatus.appId)) {
      revoked = true; entries.delete(entry); unsubscribe();
    }
  });
  const cleanup = () => { entries.delete(entry); unsubscribe(); unsubscribeStatus?.(); };
  void controls.settled.then(cleanup, cleanup);
  try { await card.ready; } catch (error) { cleanup(); throw error; }
}

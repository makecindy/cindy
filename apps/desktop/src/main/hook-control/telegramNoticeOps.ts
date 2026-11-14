import { randomUUID } from 'node:crypto';
import { layoutTelegramCard } from '@cindy/im';
import { makeMessageOp } from '@cindy/slack-hook-protocol';
import { TELEGRAM_OP_MARKER, type MsgOpResultRouter, type MsgOpSendFn } from './telegramMsgOp';
import { createQuestionCard, type QuestionRequest } from '../im/shared/questionCard';
import type { QuestionControls } from '../maker-ipc/interactionRouter';

/** Shared question transport; blocking closure drains with the turn, async cards remain alive. */
export function createTelegramNoticePublisher(deps: {
  connectionId: string;
  requestId: string;
  externalKey: string;
  getSend(): MsgOpSendFn | undefined;
  router: MsgOpResultRouter;
  register(id: string, click: (button: string, text?: string) => Promise<boolean>): () => void;
}) {
  let accepting = true;
  const initial = new Set<Promise<void>>();
  return {
    async open(request: QuestionRequest, controls: QuestionControls): Promise<void> {
      if (!accepting) return;
      let messageId: string | undefined;
      let attempted = false;
      const interactionId = randomUUID();
      const card = createQuestionCard(request, controls, async (spec, closed) => {
        if (!messageId && attempted) throw new Error('question send already attempted');
        const send = deps.getSend();
        if (!send) throw new Error('question channel unavailable');
        const { html, rows } = layoutTelegramCard(spec);
        const opId = `${deps.requestId}${TELEGRAM_OP_MARKER.notice}${randomUUID()}`;
        attempted = true;
        const result = await deps.router.request(deps.connectionId, send, makeMessageOp({
          opId, requestId: deps.requestId, scope: { externalKey: deps.externalKey },
          purpose: 'turn-notice', interactionId, questionMode: request.delivery === 'async' ? 'async' : 'blocking',
          ...(messageId && closed ? { interactionClosed: true } : {}),
          action: { ...(messageId ? { kind: 'edit' as const, messageId } : { kind: 'send' as const }),
            text: html, tier: 'html', buttons: rows.map(row => row.map(({ button, text }) => ({ token: button.id, label: text }))) },
        }), opId, 10_000);
        if (!result?.ok || !result.messageId) throw new Error('question delivery not confirmed');
        messageId = result.messageId;
      });
      const unregister = deps.register(interactionId, (button, text) => button === 'question:reply' && text !== undefined
        ? card.replyText(text) : card.click(button));
      void controls.settled.finally(unregister).catch(() => undefined);
      if (request.delivery !== 'async') {
        initial.add(card.completed);
        void card.completed.finally(() => { initial.delete(card.completed); });
      }
      initial.add(card.ready);
      try { await card.ready; } catch (error) { unregister(); throw error; } finally { initial.delete(card.ready); }
    },
    async drain(): Promise<void> {
      accepting = false;
      if (!initial.size) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.allSettled([...initial]),
          new Promise<void>(resolve => { timer = setTimeout(resolve, 10_000); timer.unref?.(); })]);
      } finally { if (timer) clearTimeout(timer); }
    },
  };
}

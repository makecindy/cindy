import { randomBytes, randomUUID } from 'node:crypto';
import { makeInteractionRequest, makeInteractionCancel, type HookMessage } from '@cindy/slack-hook-protocol';
import type { QuestionControls } from '../maker-ipc/interactionRouter';
import { createQuestionCard, type QuestionRequest } from '../im/shared/questionCard';
import { imText } from '../im/shared/imText';

/** Channels render the same Host-owned question model, never reconstruct answer semantics. */
export function createHookQuestionPublisher(deps: {
  requestId: string; send(frame: HookMessage): boolean;
  register(id: string, answer: (button: string, text?: string) => Promise<boolean>): () => void;
}) {
  const pending = new Set<Promise<void>>();
  let accepting = true;
  return {
    async open(request: QuestionRequest, controls: QuestionControls) {
      if (!accepting) return;
      const interactionId = randomUUID();
      const code = `Q${randomBytes(8).toString('hex')}`;
      const card = createQuestionCard(request, controls, async (spec, closed) => {
        const frame = closed ? makeInteractionCancel({ requestId: deps.requestId, interactionId, reason: spec.body })
          : makeInteractionRequest({ requestId: deps.requestId, interactionId, kind: 'ask_user_question',
            questionMode: request.delivery === 'async' ? 'async' : 'blocking', questionCode: code,
            title: spec.title || '❓', body: spec.body,
            buttons: (spec.buttons ?? []).map(b => ({ id: b.id, label: b.label, style: 'default' as const })),
          });
        if (!deps.send(frame)) throw new Error('question connection unavailable');
      }, imText('imBot.text.questions.replyHint', { code }));
      const off = deps.register(interactionId, (button, text) => button === 'question:reply' && text !== undefined
        ? (request.questions.length > 1 || request.questions.some(q => q.multiSelect)) && text.trim().toLowerCase() === 'ok' ? card.submit() : card.replyText(text) : card.click(button));
      void controls.settled.then(off, off);
      if (request.delivery !== 'async') {
        pending.add(card.completed);
        void card.completed.then(() => pending.delete(card.completed));
      }
      try { await card.ready; } catch (error) { off(); throw error; }
    },
    async drain() {
      accepting = false;
      // Only local frame writes; no network acknowledgement to wait for here.
      await Promise.allSettled([...pending]);
    },
  };
}

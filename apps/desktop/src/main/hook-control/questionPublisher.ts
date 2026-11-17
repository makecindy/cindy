import { randomBytes, randomUUID } from 'node:crypto';
import { makeInteractionRequest, makeInteractionCancel, type HookMessage } from '@cindy/slack-hook-protocol';
import type { InteractionDecision } from '@cindy/maker-core';
import type { QuestionControls } from '../maker-ipc/interactionRouter';
import { createQuestionCard, type QuestionCardLook, type QuestionRequest } from '../im/shared/questionCard';
import { imText } from '../im/shared/imText';

type Question = QuestionRequest['questions'][number];

/** Channels render the same Host-owned question model, never reconstruct answer semantics. */
export function createHookQuestionPublisher(deps: {
  requestId: string; send(frame: HookMessage): boolean;
  register(id: string, answer: (button: string, text?: string) => Promise<boolean>): () => void;
  /**
   * 一题一张卡（官方飞书 / Lark）：每道题各发一张卡，答完一题再发下一题，最后一题答完才把
   * 全部答案一次交给 Host。缺省为多题合卡（官方 Slack）。
   */
  sequential?: boolean;
  /** 只记题号与阶段，不记题目、选项或答案。 */
  log?: { info(msg: string): void; warn(msg: string): void };
}) {
  const pending = new Set<Promise<void>>();
  let accepting = true;

  /** 发一张问题卡：独立的 interactionId 与回复码，按钮路由随这张卡的 settled 注销。 */
  const openCard = async (
    request: QuestionRequest,
    controls: QuestionControls,
    hint: (code: string) => string,
    look?: QuestionCardLook,
  ): Promise<void> => {
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
    }, hint(code), look);
    const off = deps.register(interactionId, (button, text) => button === 'question:reply' && text !== undefined
      ? card.replyText(text) : card.click(button));
    void controls.settled.then(off, off);
    if (request.delivery !== 'async') {
      pending.add(card.completed);
      void card.completed.then(() => pending.delete(card.completed));
    }
    try { await card.ready; } catch (error) { off(); throw error; }
  };

  const nextLabel = (last: boolean): string =>
    imText(last ? 'imBot.text.questions.submitLabel' : 'imBot.text.questions.nextLabel');

  const stepHint = (question: Question, code: string, last: boolean): string => {
    if (!question.options?.length) return imText('imBot.text.questions.stepTextHint', { code });
    const needsSubmit = question.multiSelect === true || question.answerConstraints?.required === false;
    return needsSubmit
      ? imText('imBot.text.questions.stepSubmitHint', { code, action: nextLabel(last) })
      : imText('imBot.text.questions.stepHint', { code });
  };

  const stepTitle = (question: Question, index: number, total: number): string => {
    const header = question.header?.trim();
    const progress = total > 1 ? ` ${index + 1}/${total}` : '';
    return `❓${progress}${header ? ` ${header}` : ''}`;
  };

  /**
   * 逐题推进。每道题的卡片拿到的是「这一题」的答题入口：答完只结束这张卡并发下一张；最后一题
   * 才合并全部答案调用 Host 的 answer。Host 先收口（App 已答、超时、轮次结束）时当前卡随之关闭，
   * 不再发后面的题；已答的中间结果不单独交给 Agent。
   */
  const openSequence = async (request: QuestionRequest, controls: QuestionControls): Promise<void> => {
    const total = request.questions.length;
    const answers: Record<string, string> = {};
    let hostSettled = false;
    const markSettled = (): void => { hostSettled = true; };
    void controls.settled.then(markSettled, markSettled);
    const openStep = async (index: number): Promise<void> => {
      const question = request.questions[index]!;
      const last = index === total - 1;
      let finishStep!: (decision: InteractionDecision) => void;
      const stepDone = new Promise<InteractionDecision>(resolve => { finishStep = resolve; });
      const step: QuestionControls = {
        answer: decision => {
          if (hostSettled || decision.kind !== 'ask_user_question') return;
          Object.assign(answers, decision.answers);
          finishStep(decision);
          deps.log?.info(`hook question ${deps.requestId} step ${index + 1}/${total} answered`);
          if (last) {
            controls.answer({ kind: 'ask_user_question', answers: { ...answers } });
            return;
          }
          if (!accepting) return;
          void openStep(index + 1).catch(() => {
            deps.log?.warn(`hook question ${deps.requestId} step ${index + 2}/${total} could not be shown`);
          });
        },
        settled: Promise.race([stepDone, controls.settled]),
      };
      await openCard({ ...request, questions: [question] }, step, code => stepHint(question, code, last), {
        single: true, title: stepTitle(question, index, total), submitLabel: nextLabel(last),
      });
      deps.log?.info(`hook question ${deps.requestId} step ${index + 1}/${total} shown`);
    };
    await openStep(0);
  };

  return {
    async open(request: QuestionRequest, controls: QuestionControls) {
      if (!accepting) return;
      if (deps.sequential && request.questions.length > 0) {
        await openSequence(request, controls);
        return;
      }
      await openCard(request, controls, code => imText('imBot.text.questions.replyHint', { code }));
    },
    async drain() {
      accepting = false;
      // Only local frame writes; no network acknowledgement to wait for here.
      await Promise.allSettled([...pending]);
    },
  };
}

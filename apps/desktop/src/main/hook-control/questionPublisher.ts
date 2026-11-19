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
    /** 服务端这张卡上现在的标题。收口帧只带正文，标题要靠 interaction.request 才能换。 */
    let shownTitle: string | undefined;
    const card = createQuestionCard(request, controls, async (spec, closed) => {
      const title = spec.title || '❓';
      const show = (): boolean => deps.send(makeInteractionRequest({
        requestId: deps.requestId, interactionId, kind: 'ask_user_question',
        questionMode: request.delivery === 'async' ? 'async' : 'blocking', questionCode: code,
        title, body: spec.body,
        buttons: (spec.buttons ?? []).map(b => ({ id: b.id, label: b.label, style: 'default' as const })),
      }));
      if (!closed) {
        if (!show()) throw new Error('question connection unavailable');
        shownTitle = title;
        return;
      }
      // 不是在这张卡上答的（App 里答了）时，回执的标题还没发过：先更新一帧把标题换成结论，再收口。
      // 服务端已先一步关掉这张卡（轮次结束）时这一帧会被它忽略，卡片保持原标题。
      if (shownTitle !== undefined && title !== shownTitle && !show()) throw new Error('question connection unavailable');
      if (!deps.send(makeInteractionCancel({ requestId: deps.requestId, interactionId, reason: spec.body }))) {
        throw new Error('question connection unavailable');
      }
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

  /** 有短标签时标题就是它（「发布环境 1/2」）；没有时才用「❓」占位，协议要求标题非空。 */
  const stepTitle = (question: Question, index: number, total: number): string => {
    const header = question.header?.trim();
    const progress = total > 1 ? ` ${index + 1}/${total}` : '';
    return `${header || '❓'}${progress}`;
  };

  /** 飞书 / Lark 卡片正文的灰色字：选项说明、提示语和答完后回执里的原问题用它弱化。 */
  const muted = (line: string): string => `<font color='grey'>${line}</font>`;

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
          // 本轮已收口: 服务端只在轮次运行期间受理新卡, 后面的题发不出去(只有中断式提问会走到这里)。
          if (!accepting) return;
          // 下一张卡发不出去(连接或账号已失效)时不替用户合成答案: 与首卡发不出去一样, 这道提问
          // 仍挂在 App 里可答, 中断式提问照常按渠道超时收口。
          void openStep(index + 1).catch((error: unknown) => {
            deps.log?.warn(`hook question ${deps.requestId} step ${index + 2}/${total} could not be shown: ${
              error instanceof Error ? error.message : 'unknown error'}`);
          });
        },
        settled: Promise.race([stepDone, controls.settled]),
      };
      await openCard({ ...request, questions: [question] }, step, code => stepHint(question, code, last), {
        single: true, title: stepTitle(question, index, total), submitLabel: nextLabel(last), muted,
      });
      deps.log?.info(`hook question ${deps.requestId} step ${index + 1}/${total} shown`);
    };
    await openStep(0);
  };

  return {
    async open(request: QuestionRequest, controls: QuestionControls) {
      if (!accepting) return;
      // 异步的多题提问仍合成一张卡: 异步卡要在本轮结束后继续可答, 而服务端只在轮次运行期间受理新卡,
      // 逐题发的话本轮一结束后面的题就发不出去, 提问永远答不完。异步单题只有一张卡, 可以用单题版式。
      const stepByStep = deps.sequential && request.questions.length > 0
        && (request.delivery !== 'async' || request.questions.length === 1);
      if (stepByStep) {
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

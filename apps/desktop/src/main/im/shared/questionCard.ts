import { randomUUID } from 'node:crypto';
import { answerKey, askAnswerError } from '@cindy/maker-shared';
import type { InteractionRequest } from '@cindy/maker-core';
import type { InteractiveCardSpec } from '@cindy/im';
import type { QuestionControls } from '../../maker-ipc/interactionRouter';
import { imText } from './imText';
import { encodeAskOptionAnswers, formatAskAnswersForDisplay } from './interactionCardModel';

export type QuestionRequest = Extract<InteractionRequest, { kind: 'ask_user_question' }>;

/** One shared choice model for every IM transport. Host owns the final answer. */
export function createQuestionCard(
  request: QuestionRequest,
  controls: QuestionControls,
  publish: (card: InteractiveCardSpec, closed: boolean) => Promise<void>,
  hint?: string,
) {
  const id = `aq:${randomUUID()}`;
  const selections = new Map<number, Set<number>>();
  const written = new Map<number, string>();
  let revision = 0;
  let closed = false;
  let submitted = false;
  let tail = Promise.resolve();
  const answerFor = (qi: number): string => {
    const q = request.questions[qi];
    if (written.has(qi)) return encodeAskOptionAnswers(q.multiSelect === true, [written.get(qi)!]);
    return encodeAskOptionAnswers(q.multiSelect === true,
      [...(selections.get(qi) ?? [])].sort((a, b) => a - b).map(oi => q.options![oi].label));
  };
  const body = () => request.questions.map((q, i) => [
    `${i + 1}. ${q.question}${q.multiSelect ? imText('imBot.text.questions.multiSelectHint') : ''}`,
    ...(q.options ?? []).map((o, j) => `${i + 1}·${j + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`),
    ...(answerFor(i) ? [imText('imBot.text.questions.resolved', { option: formatAskAnswersForDisplay({ value: answerFor(i) }) })] : []),
  ].join('\n')).join('\n\n');
  const render = (status?: string): InteractiveCardSpec => ({
    title: '❓',
    body: `${body()}\n\n${status ?? hint ?? imText('imBot.text.questions.cardHint')}`,
    buttons: closed || submitted ? [] : [
      ...request.questions.flatMap((q, qi) => (q.options ?? []).map((o, oi) => ({
        id: `${id}:${revision}:${qi}:${oi}`,
        label: `${selections.get(qi)?.has(oi) ? '✓ ' : ''}${qi + 1}·${oi + 1} ${o.label}`,
      }))),
      ...((request.questions.length > 1 || request.questions.some(q => q.multiSelect)) ? [{
        id: `${id}:${revision}:submit`, label: imText('imBot.text.questions.submitLabel'),
      }] : []),
    ],
  });
  const update = (status?: string) => {
    const card = render(status);
    const isClosed = closed;
    tail = tail.catch(() => undefined).then(() => publish(card, isClosed));
    return tail;
  };
  const ready = update();
  const completed = controls.settled.then(decision => {
    closed = true;
    const answers = decision.kind === 'ask_user_question' ? formatAskAnswersForDisplay(decision.answers) : '';
    return update(answers
      ? imText('imBot.text.questions.resolved', { option: answers })
      : imText('imBot.text.questions.expired'));
  }, () => { closed = true; return update(); }).catch(() => undefined);
  return {
    id, ready, completed,
    async submit(): Promise<boolean> { return this.click(`${id}:${revision}:submit`); },
    async replyText(text: string): Promise<boolean> {
      if (closed || submitted || !text.trim()) return false;
      const numbered = /^(\d+)\s*[:：]\s*([\s\S]+)$/.exec(text.trim());
      const qi = request.questions.length === 1 ? 0 : numbered ? Number(numbered[1]) - 1 : -1;
      const value = request.questions.length === 1 ? text.trim() : numbered?.[2].trim() ?? '';
      const q = request.questions[qi];
      if (!q || !value || askAnswerError(q, value)) return false;
      const indices = /^\d+(?:\s*[,，]\s*\d+)*$/.test(value) ? value.split(/[,，]/).map(v => Number(v.trim()) - 1) : [];
      if (indices.length && (q.multiSelect || indices.length === 1) && indices.every(index => q.options?.[index])) {
        written.delete(qi); selections.set(qi, new Set(indices));
      } else { written.set(qi, value); selections.delete(qi); }
      revision += 1;
      if (request.questions.length === 1 && !q.multiSelect) {
        submitted = true;
        controls.answer({ kind: 'ask_user_question', answers: { [answerKey(q)]: answerFor(qi) } });
      }
      await update();
      return true;
    },
    async click(buttonId: string): Promise<boolean> {
      if (closed || submitted || !buttonId.startsWith(`${id}:${revision}:`)) return false;
      const action = buttonId.slice(`${id}:${revision}:`.length);
      if (action === 'submit') {
        const answers: Record<string, string> = {};
        request.questions.forEach((q, qi) => {
          const value = answerFor(qi);
          if (value) answers[answerKey(q)] = value;
        });
        if (!Object.keys(answers).length || request.questions.some(q =>
          !answers[answerKey(q)] || askAnswerError(q, answers[answerKey(q)]!))) return false;
        submitted = true;
        controls.answer({ kind: 'ask_user_question', answers });
        await update();
        return true;
      }
      if (!/^\d+:\d+$/.test(action)) return false;
      const [qi, oi] = action.split(':').map(Number);
      const q = request.questions[qi];
      if (!Number.isInteger(qi) || !Number.isInteger(oi) || !q?.options?.[oi]
        || askAnswerError(q, q.options[oi].label)) return false;
      written.delete(qi);
      const selected = selections.get(qi) ?? new Set<number>();
      if (selected.has(oi)) selected.delete(oi);
      else { if (!q.multiSelect) selected.clear(); selected.add(oi); }
      selections.set(qi, selected);
      revision += 1;
      if (request.questions.length === 1 && !q.multiSelect && selected.size === 1) {
        submitted = true;
        controls.answer({ kind: 'ask_user_question', answers: { [answerKey(q)]: q.options[oi].label } });
      }
      await update();
      return true;
    },
  };
}

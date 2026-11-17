import { randomUUID } from 'node:crypto';
import { answerKey, askAnswerError } from '@cindy/maker-shared';
import type { InteractionRequest } from '@cindy/maker-core';
import type { InteractiveCardSpec } from '@cindy/im';
import type { QuestionControls } from '../../maker-ipc/interactionRouter';
import { imText } from './imText';
import { encodeAskOptionAnswers, formatAskAnswersForDisplay } from './interactionCardModel';

export type QuestionRequest = Extract<InteractionRequest, { kind: 'ask_user_question' }>;

/** Hook interaction.request 一张卡最多带的按钮数。 */
const MAX_CARD_BUTTONS = 24;

/**
 * 单题卡的呈现参数（官方飞书 / Lark 一题一张卡）。不传时为多题合卡：题号 + 「题号·选项号」按钮。
 * 只换呈现，答案模型、防旧按钮与提交规则不变。
 */
export interface QuestionCardLook {
  /** 卡片标题，默认「❓」。 */
  title?: string;
  /** 需要显式提交时的按钮文字，默认「提交答案」。 */
  submitLabel?: string;
  /**
   * 单题版式：只渲染第一题，正文不加题号，按钮只写选项文字；答完后收成回执——标题写结论，
   * 正文只留弱化的原问题，不再列选项和提示。正文按 Markdown 输出（带说明的选项名加粗）。
   */
  single?: boolean;
  /** 把一行文字写成渠道的弱化样式（如飞书的灰色字），用于选项说明、提示语和回执里的原问题。不传则原样。 */
  muted?: (line: string) => string;
}

/** 回执标题里能直接写下的答案长度；更长或多行的答案放进正文，标题只留题目的短标签。 */
const RECEIPT_TITLE_ANSWER_MAX = 60;

/** 题干已自带「可多选」说明时不再追加（模型常把它写进题干，追加后会重复两遍）。 */
function withMultiSelectHint(question: QuestionRequest['questions'][number]): string {
  if (!question.multiSelect) return question.question;
  const hint = imText('imBot.text.questions.multiSelectHint');
  return question.question.includes(hint.trim()) ? question.question : `${question.question}${hint}`;
}

/** One shared choice model for every IM transport. Host owns the final answer. */
export function createQuestionCard(
  request: QuestionRequest,
  controls: QuestionControls,
  publish: (card: InteractiveCardSpec, closed: boolean) => Promise<void>,
  hint?: string,
  look: QuestionCardLook = {},
) {
  const id = `aq:${randomUUID()}`;
  const selections = new Map<number, Set<number>>();
  const written = new Map<number, string>();
  let revision = 0;
  let closed = false;
  let submitted = false;
  /** Host 收口时的最终答案（在 App 里答的也算）；收口前为 undefined，展示用本卡上的选择。 */
  let settledAnswers: Record<string, string> | undefined;
  let tail = Promise.resolve();
  const requiresSubmit = request.questions.length > 1
    || request.questions.some(q => q.multiSelect || q.answerConstraints?.required === false);
  const answerFor = (qi: number): string => {
    const q = request.questions[qi];
    if (written.has(qi)) return encodeAskOptionAnswers(q.multiSelect === true, [written.get(qi)!]);
    if (!selections.get(qi)?.size) return '';
    return encodeAskOptionAnswers(q.multiSelect === true,
      [...(selections.get(qi) ?? [])].sort((a, b) => a - b).map(oi => q.options![oi].label));
  };
  /** 卡片上展示的答案：收口后以 Host 的最终答案为准（查找顺序同 Host 侧），之前是本卡上的选择。 */
  const shownAnswer = (qi: number): string => {
    if (!settledAnswers) return answerFor(qi);
    const q = request.questions[qi];
    return settledAnswers[answerKey(q)] ?? settledAnswers[q.question] ?? (q.header ? settledAnswers[q.header] : undefined) ?? '';
  };
  const displayAnswer = (qi: number): string => formatAskAnswersForDisplay({ value: shownAnswer(qi) });
  const resolvedLine = (qi: number): string[] => displayAnswer(qi)
    ? [imText('imBot.text.questions.resolved', { option: displayAnswer(qi) })]
    : [];
  const muted = (text: string): string => look.muted
    ? text.split('\n').map(line => (line.trim() ? look.muted!(line) : line)).join('\n')
    : text;
  const hintText = (): string => muted(hint ?? imText('imBot.text.questions.cardHint'));
  const body = () => look.single ? singleBody() : request.questions.map((q, i) => [
    `${i + 1}. ${withMultiSelectHint(q)}`,
    ...(q.options ?? []).map((o, j) => `${i + 1}·${j + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`),
    ...resolvedLine(i),
  ].join('\n')).join('\n\n');
  /** 按钮总数超过传输上限时不发选项按钮(见 render): 选项必须逐行写在正文里, 靠编号文字作答。 */
  const choiceButtonsOmitted = (): boolean =>
    request.questions.reduce((count, q) => count + (q.options?.length ?? 0), 0) + (requiresSubmit ? 1 : 0)
      > MAX_CARD_BUTTONS;
  // 单题版式：题干单独成段（不以「1.」开头，避免 Markdown 把后面的行并进同一个列表项）；
  // 选项只有带说明、或按钮放不下时才逐行列出，否则按钮已经写全了选项。带说明时选项名加粗、
  // 说明弱化，一眼分得清哪段是选项、哪段是解释。
  const singleBody = (): string => {
    const q = request.questions[0];
    const options = q.options ?? [];
    const described = options.some(o => o.description);
    return [
      withMultiSelectHint(q),
      ...(described || choiceButtonsOmitted()
        ? ['', ...options.map((o, j) =>
          `${j + 1}. ${described ? `**${o.label}**` : o.label}${o.description ? ` ${muted(o.description)}` : ''}`)]
        : []),
      ...resolvedLine(0).flatMap(line => ['', line]),
    ].join('\n');
  };
  /**
   * 单题版式答完（或 Host 收口）后的回执：标题写结论，正文只留弱化的原问题。答完还把题干、全部选项
   * 和提示留在卡片上，聊天里就堆着一张张过期的表单。还在作答、或被中止时返回 undefined，照常画题目。
   */
  const receipt = (): InteractiveCardSpec | undefined => {
    if (!look.single || !(closed || submitted)) return undefined;
    const q = request.questions[0];
    const answer = displayAnswer(0);
    const question = muted(q.question);
    const base = { buttonLayout: 'list' as const, buttons: [] };
    if (!answer) {
      // 没拿到这道题的答案就收口了（超时、轮次结束）：标题不变，只说明卡片已失效。
      return settledAnswers
        ? { ...base, title: look.title ?? '❓', body: `${question}\n\n${imText('imBot.text.questions.expired')}` }
        : undefined;
    }
    const label = q.header?.trim();
    if (answer.length > RECEIPT_TITLE_ANSWER_MAX || answer.includes('\n')) {
      return { ...base, title: label ? `✅ ${label}` : '✅', body: `${answer}\n\n${question}` };
    }
    return { ...base, body: question, title: label
      ? imText('imBot.text.questions.resolvedLabeled', { label, option: answer })
      : imText('imBot.text.questions.resolved', { option: answer }) };
  };
  const render = (status?: string): InteractiveCardSpec => {
    const done = receipt();
    if (done) return done;
    const choices = request.questions.flatMap((q, qi) => (q.options ?? []).map((o, oi) => ({
      id: `${id}:${revision}:${qi}:${oi}`,
      label: `${selections.get(qi)?.has(oi) ? '✓ ' : ''}${look.single ? '' : `${qi + 1}·${oi + 1} `}${o.label}`,
    })));
    const submit = requiresSubmit ? [{
      id: `${id}:${revision}:submit`, label: look.submitLabel ?? imText('imBot.text.questions.submitLabel'),
    }] : [];
    return {
      title: look.title ?? '❓',
      body: [body(), status ?? hintText()].filter(Boolean).join('\n\n'),
      // 选项文案常常较长: 一行一个满宽按钮, 不挤在同一行被压缩。
      buttonLayout: 'list',
      buttons: closed || submitted ? [] : [
        // Hook interaction.request allows 24 buttons. Oversized forms retain all
        // choices in the numbered body and the same text-answer/submit path.
        ...(choices.length + submit.length <= MAX_CARD_BUTTONS ? choices : []),
        ...submit,
      ],
    };
  };
  const update = (status?: string) => {
    const card = render(status);
    const isClosed = closed;
    tail = tail.catch(() => undefined).then(() => publish(card, isClosed));
    return tail;
  };
  const ready = update();
  const completed = controls.settled.then(decision => {
    closed = true;
    settledAnswers = decision.kind === 'ask_user_question' ? decision.answers : {};
    const answers = formatAskAnswersForDisplay(settledAnswers);
    if (!answers) return update(imText('imBot.text.questions.expired'));
    // 每道题下面已经写着它的最终答案，末尾不再重复一遍「已选」；答案对不上任何一题时才用汇总行兜底。
    return update(request.questions.some((_, qi) => displayAnswer(qi))
      ? '' : imText('imBot.text.questions.resolved', { option: answers }));
  }, () => { closed = true; return update(); }).catch(() => undefined);
  return {
    id, ready, completed,
    async submit(): Promise<boolean> { return this.click(`${id}:${revision}:submit`); },
    async replyText(text: string): Promise<boolean> {
      if (closed || submitted || !text.trim()) return false;
      if (requiresSubmit && text.trim().toLowerCase() === 'ok') return this.submit();
      const numbered = /^(\d+)\s*[:：]\s*([\s\S]+)$/.exec(text.trim());
      const qi = request.questions.length === 1 ? 0 : numbered ? Number(numbered[1]) - 1 : -1;
      const value = request.questions.length === 1 ? text.trim() : numbered?.[2].trim() ?? '';
      const q = request.questions[qi];
      if (!q || !value) return false;
      const indices = /^\d+(?:\s*[,，]\s*\d+)*$/.test(value) ? value.split(/[,，]/).map(v => Number(v.trim()) - 1) : [];
      const numberedChoice = indices.length > 0 && (q.multiSelect || indices.length === 1)
        && indices.every(index => q.options?.[index]);
      const answer = encodeAskOptionAnswers(q.multiSelect === true, numberedChoice
        ? [...new Set(indices)].sort((a, b) => a - b).map(index => q.options![index].label) : [value]);
      if (askAnswerError(q, answer)) return false;
      if (numberedChoice) {
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
          answers[answerKey(q)] = value;
        });
        // 还有必答题没答(或答案不合约束)时不提交, 但要在卡片上说明缺哪几题 —— 否则用户点了提交、
        // 渠道已回「已收到」, 卡片却毫无变化, 看起来像点击失效。
        const missing = request.questions.flatMap((q, qi) =>
          (!answers[answerKey(q)] && q.answerConstraints?.required !== false)
            || askAnswerError(q, answers[answerKey(q)]!) ? [qi + 1] : []);
        if (!Object.keys(answers).length || missing.length > 0) {
          const warning = look.single || request.questions.length === 1
            ? imText('imBot.text.questions.unansweredSingle')
            : imText('imBot.text.questions.unanswered', { numbers: missing.join(imText('imBot.text.questions.numberSeparator')) });
          await update(`${warning}\n${hintText()}`);
          return false;
        }
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

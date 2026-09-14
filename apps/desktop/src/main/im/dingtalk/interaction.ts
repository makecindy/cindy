import type { InteractionDecision, InteractionRequest } from '@cindy/maker-core';
import type { DingTalkIM } from '@cindy/im';

import { autoReviewUnavailablePromptLine } from '../shared/autoReviewUnavailablePrompt';

export function handleDingTalkTextInteraction(
  im: DingTalkIM,
  userId: string,
  request: InteractionRequest,
): Promise<InteractionDecision> {
  if (request.kind === 'ask_user_question') {
    return answerQuestions(im, userId, request);
  }
  return im.requestTextReply(userId, formatInteractionPrompt(request), (text) =>
    parseInteractionReply(request, text),
  );
}

async function answerQuestions(
  im: DingTalkIM,
  userId: string,
  request: Extract<InteractionRequest, { kind: 'ask_user_question' }>,
): Promise<InteractionDecision> {
  const answers: Record<string, string> = {};
  for (const [index, question] of request.questions.entries()) {
    answers[question.question] = await im.requestTextReply(
      userId,
      formatQuestionPrompt(question, index, request.questions.length),
      (text) => parseQuestionAnswer(question, text),
    );
  }
  return { kind: 'ask_user_question', answers };
}

function formatInteractionPrompt(request: InteractionRequest): string {
  if (request.kind === 'permission') {
    const unavailable = autoReviewUnavailablePromptLine(request);
    return [
      `需要确认操作：${request.toolName}`,
      ...(unavailable ? [unavailable] : []),
      '回复“允许”继续，或回复“拒绝”取消。',
    ].join('\n');
  }
  if (request.kind === 'plan_review') {
    return ['计划已准备好。', '回复“批准”继续，或回复“拒绝”取消。'].join('\n');
  }
  const lines: string[] = ['需要你补充以下信息：'];
  request.questions.forEach((question, questionIndex) => {
    lines.push(`${questionIndex + 1}. ${question.question}`);
    question.options?.forEach((option, optionIndex) => {
      lines.push(`   ${optionIndex + 1}) ${option.label}`);
    });
  });
  lines.push('请直接回复选项序号或你的答案。');
  return lines.join('\n');
}

function formatQuestionPrompt(
  question: Extract<InteractionRequest, { kind: 'ask_user_question' }>['questions'][number],
  index: number,
  total: number,
): string {
  const lines = [`需要你补充信息（${index + 1}/${total}）：${question.question}`];
  question.options?.forEach((option, optionIndex) => {
    lines.push(`${optionIndex + 1}) ${option.label}`);
  });
  lines.push('请回复选项序号或你的答案。');
  return lines.join('\n');
}

function parseQuestionAnswer(
  question: Extract<InteractionRequest, { kind: 'ask_user_question' }>['questions'][number],
  rawText: string,
): string | null {
  const text = rawText.trim();
  if (!text) return null;
  const index = Number.parseInt(text, 10);
  const option = Number.isInteger(index) && index >= 1 ? question.options?.[index - 1] : undefined;
  return option?.label ?? text;
}

function parseInteractionReply(
  request: InteractionRequest,
  rawText: string,
): InteractionDecision | null {
  const text = rawText.trim();
  if (!text) return null;
  const normalized = text.toLowerCase();
  if (request.kind === 'permission') {
    if (['允许', '同意', '确认', '继续', 'allow', 'yes', 'y'].includes(normalized)) {
      return { kind: 'permission', behavior: 'allow' };
    }
    if (['拒绝', '取消', 'deny', 'no', 'n'].includes(normalized)) {
      return { kind: 'permission', behavior: 'deny', reason: 'dingtalk_user_denied' };
    }
    return null;
  }
  if (request.kind === 'plan_review') {
    if (['批准', '同意', '确认', '继续', 'approve', 'yes', 'y'].includes(normalized)) {
      return { kind: 'plan_review', behavior: 'allow' };
    }
    if (['拒绝', '取消', 'deny', 'no', 'n'].includes(normalized)) {
      return { kind: 'plan_review', behavior: 'deny', reason: 'dingtalk_user_denied' };
    }
    return null;
  }

  const answers: Record<string, string> = {};
  for (const question of request.questions) {
    const index = Number.parseInt(text, 10);
    const option =
      Number.isInteger(index) && index >= 1 ? question.options?.[index - 1] : undefined;
    answers[question.question] = option?.label ?? text;
  }
  return { kind: 'ask_user_question', answers };
}

export const __testing = {
  formatInteractionPrompt,
  formatQuestionPrompt,
  parseQuestionAnswer,
  parseInteractionReply,
};

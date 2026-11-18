import type { InteractionDecision, InteractionRequest } from '@cindy/maker-core';
import type { DingTalkIM } from '@cindy/im';

import { autoReviewUnavailablePromptLine, permissionOperationPreview, permissionPromptDescription } from '../shared/autoReviewUnavailablePrompt';
import type { SharedPermission } from '../../maker-ipc/sharedPermission';
import { imText } from '../shared/imText';
import { localizedReplyWords, matchesReplyWord, type ReplyWords } from '../shared/replyWords';
import { permissionOutcomeText } from '../shared/permissionPresentation';

// 钉钉与 iMessage 共用这套纯文本交互(iMessage 直接复用本文件)。
const K = 'imBot.text.dingtalk.interaction';

export function handleDingTalkTextInteraction(
  im: Pick<DingTalkIM, 'requestTextReply' | 'sendText'>,
  userId: string,
  request: InteractionRequest,
  options?: { timeoutMs?: number; sharedPermission?: SharedPermission },
): Promise<InteractionDecision> {
  const shared = options?.sharedPermission;
  if (shared?.decision) return shared.result;
  if (request.kind === 'ask_user_question') {
    return answerQuestions(im, userId, request);
  }
  const words = localizedReplyWords();
  const result = im.requestTextReply(userId, formatInteractionPrompt(request, words), (text) =>
    parseInteractionReply(request, text, words),
    options?.timeoutMs,
    shared,
  ).catch((error) => {
    if (!shared) throw error;
    shared.decide({ kind: 'permission', behavior: 'deny', reason: 'dingtalk_interaction_timeout_or_cancelled' });
    return shared.result;
  });
  if (shared) void result.then((decision) => im.sendText(userId,
    permissionOutcomeText(decision, request.kind === 'permission' ? request.toolName : undefined),
  )).catch(() => {});
  return result;
}

async function answerQuestions(
  im: Pick<DingTalkIM, 'requestTextReply' | 'sendText'>,
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

function formatInteractionPrompt(request: InteractionRequest, words = localizedReplyWords()): string {
  if (request.kind === 'permission') {
    const unavailable = autoReviewUnavailablePromptLine(request);
    const operation = permissionOperationPreview(request);
    return [
      imText(`${K}.permissionTitle`, { toolName: request.toolName }),
      ...(permissionPromptDescription(request) ? [permissionPromptDescription(request)!] : []),
      ...(unavailable ? [unavailable] : []),
      ...(operation ? [imText(`${K}.operationLine`, { operation })] : []),
      imText(`${K}.permissionFooter`, { allow: words.allow, deny: words.deny }),
    ].join('\n');
  }
  if (request.kind === 'plan_review') {
    return [
      imText(`${K}.planReady`),
      imText(`${K}.planFooter`, { approve: words.approve, deny: words.deny }),
    ].join('\n');
  }
  const lines: string[] = [imText(`${K}.questionsIntro`)];
  request.questions.forEach((question, questionIndex) => {
    lines.push(`${questionIndex + 1}. ${question.question}`);
    question.options?.forEach((option, optionIndex) => {
      lines.push(`   ${optionIndex + 1}) ${option.label}`);
    });
  });
  lines.push(imText(`${K}.questionsFooter`));
  return lines.join('\n');
}

function formatQuestionPrompt(
  question: Extract<InteractionRequest, { kind: 'ask_user_question' }>['questions'][number],
  index: number,
  total: number,
): string {
  const lines = [
    imText(`${K}.questionTitle`, { index: index + 1, total, question: question.question }),
  ];
  question.options?.forEach((option, optionIndex) => {
    lines.push(`${optionIndex + 1}) ${option.label}`);
  });
  lines.push(imText(`${K}.questionFooter`));
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
  words: ReplyWords = localizedReplyWords(),
): InteractionDecision | null {
  const text = rawText.trim();
  if (!text) return null;
  const normalized = text.toLowerCase();
  const is = (fixed: string[], localized: string) => matchesReplyWord(normalized, fixed, localized);
  if (request.kind === 'permission') {
    if (is(['允许', '同意', '确认', '继续', 'allow', 'yes', 'y'], words.allow)) {
      return { kind: 'permission', behavior: 'allow' };
    }
    if (is(['拒绝', '取消', 'deny', 'no', 'n'], words.deny)) {
      return { kind: 'permission', behavior: 'deny', reason: 'dingtalk_user_denied' };
    }
    return null;
  }
  if (request.kind === 'plan_review') {
    if (is(['批准', '同意', '确认', '继续', 'approve', 'yes', 'y'], words.approve)) {
      return { kind: 'plan_review', behavior: 'allow' };
    }
    if (is(['拒绝', '取消', 'deny', 'no', 'n'], words.deny)) {
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

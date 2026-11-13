import type { InteractionDecision, InteractionRequest } from '@cindy/maker-core';
import { escapeWecomMarkdown, type IMMessageEvent, type WecomIM } from '@cindy/im';

import { autoReviewUnavailablePromptLine, permissionOperationPreview, permissionPromptDescription } from '../shared/autoReviewUnavailablePrompt';
import { isStopCommand } from '../shared/controlCommands';
import { imText } from '../shared/imText';
import { localizedReplyWords, matchesReplyWord, type ReplyWords } from '../shared/replyWords';
import type { SharedPermission } from '../../maker-ipc/sharedPermission';
import { interactionChoiceReceivedText, permissionOutcomeText } from '../shared/permissionPresentation';

interface PendingInteraction {
  request: InteractionRequest;
  words: ReplyWords;
  resolve: (decision: InteractionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

const INTERACTION_TIMEOUT_MS = 10 * 60_000;

const K = 'imBot.text.wecom.interaction';

export class WecomTextInteractions {
  private readonly pending = new Map<string, PendingInteraction>();

  constructor(private readonly im: WecomIM) {
    im.onTextMessageIntercept((event) => this.consume(event));
    im.onStatusChange((status) => {
      if (status.kind === 'idle' || status.kind === 'conflict' || status.kind === 'error') {
        this.cancelAll('wecom_interaction_disconnected');
      }
    });
  }

  async handle(userId: string, request: InteractionRequest, options?: { sharedPermission?: SharedPermission }): Promise<InteractionDecision> {
    const shared = options?.sharedPermission;
    if (shared?.decision) return shared.result;
    const previous = this.pending.get(userId);
    if (previous) {
      clearTimeout(previous.timer);
      previous.resolve(defaultDecision(previous.request, 'replaced_by_new_request'));
    }

    let resolvePending!: (decision: InteractionDecision) => void;
    const result = new Promise<InteractionDecision>((resolve) => {
      resolvePending = resolve;
    });
    const settle = (decision: InteractionDecision) => shared ? shared.decide(decision) : resolvePending(decision);
    const timer = setTimeout(() => {
      this.pending.delete(userId);
      settle(defaultDecision(request, 'wecom_interaction_timeout'));
    }, INTERACTION_TIMEOUT_MS);
    timer.unref?.();
    const words = localizedReplyWords();
    const entry = { request, words, resolve: settle, timer };
    this.pending.set(userId, entry);
    if (shared) void shared.result.then((decision) => {
      if (this.pending.get(userId) === entry) this.pending.delete(userId);
      clearTimeout(timer);
      resolvePending(decision);
    });

    try {
      await this.im.sendMarkdownText(userId, formatWecomInteractionPrompt(request, words));
      if (shared) void shared.result.then((decision) => this.im.sendText(userId,
        permissionOutcomeText(decision, request.kind === 'permission' ? request.toolName : undefined),
      )).catch(() => {});
    } catch {
      const current = this.pending.get(userId);
      if (current?.request.requestId === request.requestId) {
        clearTimeout(current.timer);
        this.pending.delete(userId);
      }
      // Denial reasons are classified by exact/prefix match. Raw Error.message
      // is not a system code and would be presented as a user rejection.
      return shared ? shared.result : defaultDecision(request, 'wecom_interaction_send_failed');
    }
    return result;
  }

  private cancelAll(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(defaultDecision(pending.request, reason));
    }
    this.pending.clear();
  }

  private consume(event: IMMessageEvent): boolean {
    const pending = this.pending.get(event.senderId);
    if (!pending) return false;
    if (isStopCommand(event.text)) {
      clearTimeout(pending.timer);
      this.pending.delete(event.senderId);
      pending.resolve(defaultDecision(pending.request, 'wecom_interaction_cancelled_by_stop'));
      return false;
    }
    const decision = parseReply(pending.request, event.text, pending.words);
    if (!decision) {
      const words = pending.words;
      void this.im.sendText(
        event.senderId,
        imText(`${K}.invalidReply`, { allow: words.allow, deny: words.deny }),
      );
      return true;
    }
    clearTimeout(pending.timer);
    this.pending.delete(event.senderId);
    pending.resolve(decision);
    void this.im.sendText(event.senderId, interactionChoiceReceivedText());
    return true;
  }
}

export function formatWecomInteractionPrompt(request: InteractionRequest, words = localizedReplyWords()): string {
  if (request.kind === 'permission') {
    const toolName = escapeWecomMarkdown(request.displayName ?? request.toolName);
    const unavailable = autoReviewUnavailablePromptLine(request);
    return `${imText(`${K}.permissionTitle`, { toolName })}
${permissionPromptDescription(request) ?? ''}
${unavailable ? `\n${unavailable}\n` : ''}
${permissionOperationPreview(request) ? `${imText(`${K}.operationLabel`)}
\`\`\`
${permissionOperationPreview(request)}
\`\`\`
` : ''}

${imText(`${K}.permissionFooter`, { allow: words.allow, deny: words.deny })}`;
  }
  if (request.kind === 'plan_review') {
    const plan = request.plan.length > 6_000 ? `${request.plan.slice(0, 6_000)}…` : request.plan;
    return `${imText(`${K}.planIntro`)}

${plan}

${imText(`${K}.planFooter`, { approve: words.approve, deny: words.deny })}`;
  }
  const question = request.questions[0];
  if (!question) return imText(`${K}.askNoQuestion`);
  const options = (question.options ?? [])
    .slice(0, 9)
    .map((option, index) => `${index + 1}. ${escapeWecomMarkdown(option.label)}`)
    .join('\n');
  return `${imText(`${K}.askIntro`)}
${escapeWecomMarkdown(question.question)}
${options ? `\n${options}\n` : ''}
${imText(`${K}.askFooter`)}`;
}

function defaultDecision(request: InteractionRequest, reason: string): InteractionDecision {
  if (request.kind === 'ask_user_question') {
    return { kind: 'ask_user_question', answers: {} };
  }
  if (request.kind === 'plan_review') {
    return { kind: 'plan_review', behavior: 'deny', reason };
  }
  return { kind: 'permission', behavior: 'deny', reason };
}

function parseReply(request: InteractionRequest, rawText: string, words: ReplyWords): InteractionDecision | null {
  const text = rawText.trim();
  if (!text) return null;
  const normalized = text.toLowerCase();
  const is = (fixed: string[], localized: string) => matchesReplyWord(normalized, fixed, localized);
  if (request.kind === 'permission') {
    if (is(['允许', '同意', '确认', 'allow', 'yes', 'y'], words.allow)) {
      return { kind: 'permission', behavior: 'allow' };
    }
    if (is(['拒绝', '不允许', '取消', 'deny', 'no', 'n'], words.deny)) {
      return { kind: 'permission', behavior: 'deny', reason: 'wecom_user_denied' };
    }
    return null;
  }
  if (request.kind === 'plan_review') {
    if (is(['批准', '同意', '确认', '继续', 'approve', 'allow', 'yes', 'y'], words.approve)) {
      return { kind: 'plan_review', behavior: 'allow' };
    }
    if (is(['拒绝', '取消', 'deny', 'no', 'n'], words.deny)) {
      return { kind: 'plan_review', behavior: 'deny', reason: 'wecom_user_denied' };
    }
    return null;
  }
  const question = request.questions[0];
  if (!question) return { kind: 'ask_user_question', answers: {} };
  const index = Number.parseInt(text, 10);
  const option = Number.isInteger(index) && index >= 1 ? question.options?.[index - 1] : undefined;
  return {
    kind: 'ask_user_question',
    answers: { [question.question]: option?.label ?? text },
  };
}

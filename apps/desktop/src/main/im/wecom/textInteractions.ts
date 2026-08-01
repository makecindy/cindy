import type { InteractionDecision, InteractionRequest } from '@cindy/maker-core';
import { escapeWecomMarkdown, type IMMessageEvent, type WecomIM } from '@cindy/im';

import { isStopCommand } from '../shared/controlCommands';

interface PendingInteraction {
  request: InteractionRequest;
  resolve: (decision: InteractionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

const INTERACTION_TIMEOUT_MS = 10 * 60_000;
const MAX_PERMISSION_INPUT_PREVIEW = 800;

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

  async handle(userId: string, request: InteractionRequest): Promise<InteractionDecision> {
    const previous = this.pending.get(userId);
    if (previous) {
      clearTimeout(previous.timer);
      previous.resolve(defaultDecision(previous.request, 'replaced_by_new_request'));
    }

    let resolvePending!: (decision: InteractionDecision) => void;
    const result = new Promise<InteractionDecision>((resolve) => {
      resolvePending = resolve;
    });
    const timer = setTimeout(() => {
      this.pending.delete(userId);
      resolvePending(defaultDecision(request, 'wecom_interaction_timeout'));
    }, INTERACTION_TIMEOUT_MS);
    timer.unref?.();
    this.pending.set(userId, { request, resolve: resolvePending, timer });

    try {
      await this.im.sendMarkdownText(userId, formatWecomInteractionPrompt(request));
    } catch (error) {
      const current = this.pending.get(userId);
      if (current?.request.requestId === request.requestId) {
        clearTimeout(current.timer);
        this.pending.delete(userId);
      }
      return defaultDecision(
        request,
        error instanceof Error ? error.message : 'wecom_interaction_send_failed',
      );
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
    const decision = parseReply(pending.request, event.text);
    if (!decision) {
      void this.im.sendText(
        event.senderId,
        '回复格式不正确。请按上一条消息提示回复；权限确认只支持“允许”或“拒绝”。',
      );
      return true;
    }
    clearTimeout(pending.timer);
    this.pending.delete(event.senderId);
    pending.resolve(decision);
    void this.im.sendText(event.senderId, '已收到你的选择，继续处理。');
    return true;
  }
}

function previewPermissionInput(input: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(input, null, 2);
    if (!json) return '<无法序列化>';
    const preview = json.length > MAX_PERMISSION_INPUT_PREVIEW
      ? `${json.slice(0, MAX_PERMISSION_INPUT_PREVIEW)}\n…（已截断）`
      : json;
    // Keep the surrounding template fence intact even when a string value
    // contains model-controlled backticks. JSON's unicode escape stays valid.
    return preview.replaceAll('`', '\\u0060');
  } catch {
    return '<无法序列化>';
  }
}

export function formatWecomInteractionPrompt(request: InteractionRequest): string {
  if (request.kind === 'permission') {
    const toolName = escapeWecomMarkdown(request.displayName ?? request.toolName);
    return `需要确认工具“${toolName}”。

参数：
\`\`\`json
${previewPermissionInput(request.input)}
\`\`\`

回复“允许”执行一次，或回复“拒绝”取消本次操作。企业微信内不支持永久授权。`;
  }
  if (request.kind === 'plan_review') {
    const plan = request.plan.length > 6_000 ? `${request.plan.slice(0, 6_000)}…` : request.plan;
    return `Agent 提交了一份执行计划：

${plan}

回复“批准”继续，或回复“拒绝”取消。`;
  }
  const question = request.questions[0];
  if (!question) return 'Agent 正在等待你的回答，但没有可显示的问题。请回复“继续”。';
  const options = (question.options ?? [])
    .slice(0, 9)
    .map((option, index) => `${index + 1}. ${escapeWecomMarkdown(option.label)}`)
    .join('\n');
  return `Agent 需要你的回答：
${escapeWecomMarkdown(question.question)}
${options ? `\n${options}\n` : ''}
请回复选项序号，或直接输入你的回答。`;
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

function parseReply(request: InteractionRequest, rawText: string): InteractionDecision | null {
  const text = rawText.trim();
  if (!text) return null;
  const normalized = text.toLowerCase();
  if (request.kind === 'permission') {
    if (['允许', '同意', '确认', 'allow', 'yes', 'y'].includes(normalized)) {
      return { kind: 'permission', behavior: 'allow' };
    }
    if (['拒绝', '不允许', '取消', 'deny', 'no', 'n'].includes(normalized)) {
      return { kind: 'permission', behavior: 'deny', reason: 'wecom_user_denied' };
    }
    return null;
  }
  if (request.kind === 'plan_review') {
    if (['批准', '同意', '确认', '继续', 'approve', 'allow', 'yes', 'y'].includes(normalized)) {
      return { kind: 'plan_review', behavior: 'allow' };
    }
    if (['拒绝', '取消', 'deny', 'no', 'n'].includes(normalized)) {
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

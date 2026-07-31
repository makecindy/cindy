import type { AgentKind, UserMessage } from '../../types/common.js';

import { reviewAction, type ReviewableAction } from './auto-review.js';

/** Auto 对用户可见行为的最终三态；只有 `ask` 才允许弹用户确认。 */
export type AutoReviewDecision = {
  verdict: 'allow' | 'block' | 'ask';
  reason?: string;
};

/** 交给 host 侧轻量 reviewer 的最小上下文；不含历史、工具结果、Skill 或 Memory。 */
export interface AutoReviewRequest {
  sessionId?: string;
  agentKind: AgentKind;
  providerId?: string | null;
  model: string;
  userIntent: string;
  action: ReviewableAction;
  workspaceRoots: string[];
  platform: NodeJS.Platform;
}

export type AutoReviewDelegate = (
  request: AutoReviewRequest,
) => Promise<AutoReviewDecision | null>;

/**
 * 原生 reviewer 不可用时的统一裁决入口：明显安全和明显红线仍由本地规则确定，
 * 只有中间灰区才调用当前会话模型。delegate 缺失、超时、抛错或返回非法结果时
 * 灰区一律 `block`，不会退化成逐条弹窗。
 */
export async function resolveAutoReviewDecision(
  request: AutoReviewRequest,
  delegate: AutoReviewDelegate | undefined,
): Promise<AutoReviewDecision> {
  const localVerdict = reviewAction(
    request.action,
    request.workspaceRoots,
    { platform: request.platform },
  );
  if (localVerdict === 'auto-approve') return { verdict: 'allow' };
  if (localVerdict === 'prompt-each-time') return { verdict: 'ask' };
  if (!delegate) {
    return {
      verdict: 'block',
      reason: 'Automatic review is unavailable. Choose a safer, workspace-scoped alternative.',
    };
  }
  try {
    const decision = await delegate(request);
    if (
      decision?.verdict === 'allow'
      || decision?.verdict === 'block'
      || decision?.verdict === 'ask'
    ) {
      return decision;
    }
  } catch {
    // Reviewer outages must not turn Auto into Ask or hold the tool callback open.
  }
  return {
    verdict: 'block',
    reason: 'Automatic review could not complete. Choose a safer, workspace-scoped alternative.',
  };
}

/** 只取当前用户消息文本并设硬上限，避免复制主 Agent 的完整上下文。 */
export function extractAutoReviewUserIntent(content: UserMessage['content']): string {
  const text = typeof content === 'string'
    ? content
    : content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  return text.trim().slice(0, 2_000);
}

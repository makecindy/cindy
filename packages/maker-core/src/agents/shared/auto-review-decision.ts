import type { AgentKind, UserMessage } from '../../types/common.js';

import {
  reviewAction,
  type ReviewableAction,
  type ReviewVerdict,
} from './auto-review.js';

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
  /**
   * 位置语义(reviewAction 同契约):`[0]` 是唯一可写的工作目录,其余是只读引用目录
   * (additionalDirectories)。所有 agent 一律传 `[workingDir, ...extraDirs]`;host 侧
   * reviewer prompt 依赖该顺序区分可写/只读,不得打乱或拍平。
   */
  workspaceRoots: string[];
  platform: NodeJS.Platform;
}

export type AutoReviewDelegate = (
  request: AutoReviewRequest,
) => Promise<AutoReviewDecision | null>;

export const MAX_AUTO_REVIEW_ACTION_TEXT_CHARS = 4_096;
const MAX_AUTO_REVIEW_REASON_CHARS = 240;
const AUTO_REVIEW_DELEGATE_TIMEOUT_MS = 8_000;
const AUTO_REVIEW_TIMEOUT = Symbol('auto-review-timeout');

export function getAutoReviewActionTextLength(action: ReviewableAction): number {
  switch (action.kind) {
    case 'exec':
      return action.command.length + (action.cwd?.length ?? 0);
    case 'read':
    case 'file-write':
      return action.path?.length ?? 0;
    case 'network':
      return (action.target?.length ?? 0) + (action.operation?.length ?? 0);
    case 'other':
      return action.description?.length ?? 0;
    default:
      return 0;
  }
}

/**
 * `prompt` 是旧 core 给 UI adapter 用的名字；在新的 Auto reviewer 流程里它只代表
 * “确定性规则无法独立裁决”，不是“现在弹用户”。显式映射成独立 tier，避免两层语义混用。
 */
export type LocalAutoReviewTier = Exclude<ReviewVerdict, 'prompt'> | 'needs-review';

export function classifyLocalAutoReviewTier(
  request: AutoReviewRequest,
): LocalAutoReviewTier {
  const verdict = reviewAction(
    request.action,
    request.workspaceRoots,
    { platform: request.platform },
  );
  return verdict === 'prompt' ? 'needs-review' : verdict;
}

function missingReviewEvidence(action: ReviewableAction): string | null {
  switch (action.kind) {
    case 'file-write':
      return action.path?.trim()
        ? null
        : 'File-write review needs a concrete destination path.';
    case 'exec':
      return action.command.trim()
        ? null
        : 'Command review needs concrete command text.';
    case 'network':
      return action.target?.trim()
        ? null
        : 'Network review needs a concrete destination or query.';
    case 'other':
      return action.description?.trim()
        ? null
        : 'Unknown actions cannot be reviewed without concrete action details.';
    default:
      return null;
  }
}

function oversizedReviewEvidence(action: ReviewableAction): string | null {
  return getAutoReviewActionTextLength(action) > MAX_AUTO_REVIEW_ACTION_TEXT_CHARS
    ? `Automatic review requires action text at most ${MAX_AUTO_REVIEW_ACTION_TEXT_CHARS} characters.`
    : null;
}

/**
 * 原生 reviewer 不可用时的统一裁决入口：明显安全和明显红线仍由本地规则确定，
 * 只有中间灰区才调用当前会话模型。delegate 缺失、超时、抛错或返回非法结果时
 * 灰区一律 `block`，不会退化成逐条弹窗。
 */
export async function resolveAutoReviewDecision(
  request: AutoReviewRequest,
  delegate: AutoReviewDelegate | undefined,
): Promise<AutoReviewDecision> {
  const localTier = classifyLocalAutoReviewTier(request);
  if (localTier === 'auto-approve') return { verdict: 'allow' };
  if (localTier === 'prompt-each-time') return { verdict: 'ask' };
  // Never ask the model to approve an action whose material target/text is absent.
  // It has no evidence to distinguish routine work from an unsafe side effect.
  const missingEvidenceReason = missingReviewEvidence(request.action);
  if (missingEvidenceReason) {
    return {
      verdict: 'block',
      reason: missingEvidenceReason,
    };
  }
  // The model must see the complete material action. Character sampling can hide
  // a dangerous middle segment, so oversized gray actions must be retried in smaller form.
  const oversizedEvidenceReason = oversizedReviewEvidence(request.action);
  if (oversizedEvidenceReason) {
    return {
      verdict: 'block',
      reason: oversizedEvidenceReason,
    };
  }
  if (!delegate) {
    return {
      verdict: 'block',
      reason: 'Automatic review is unavailable. Choose a safer, workspace-scoped alternative.',
    };
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const decision = await Promise.race([
      delegate(request),
      new Promise<typeof AUTO_REVIEW_TIMEOUT>((resolve) => {
        timeout = setTimeout(
          () => resolve(AUTO_REVIEW_TIMEOUT),
          AUTO_REVIEW_DELEGATE_TIMEOUT_MS,
        );
      }),
    ]);
    if (
      decision !== AUTO_REVIEW_TIMEOUT
      && (
        decision?.verdict === 'allow'
        || decision?.verdict === 'block'
        || decision?.verdict === 'ask'
      )
    ) {
      // Delegate 是运行期边界：即便当前 host 实现已做解析，未来实现也不能把
      // 非字符串或无上限 reason 原样塞进日志、UI 或下一轮模型上下文。
      const reason = typeof decision.reason === 'string'
        ? decision.reason.trim().slice(0, MAX_AUTO_REVIEW_REASON_CHARS)
        : '';
      return {
        verdict: decision.verdict,
        ...(reason ? { reason } : {}),
      };
    }
  } catch {
    // Reviewer outages must not turn Auto into Ask or hold the tool callback open.
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  return {
    verdict: 'block',
    reason: 'Automatic review could not complete. Choose a safer, workspace-scoped alternative.',
  };
}

const MAX_USER_INTENT_CHARS = 2_000;
const USER_INTENT_TRUNCATION_MARKER = '\n…[middle omitted]…\n';

function compactCurrentUserIntent(text: string): string {
  const normalized = text.trim();
  if (normalized.length <= MAX_USER_INTENT_CHARS) return normalized;
  const remaining = MAX_USER_INTENT_CHARS - USER_INTENT_TRUNCATION_MARKER.length;
  const headChars = Math.ceil(remaining * 0.75);
  const tailChars = remaining - headChars;
  return `${normalized.slice(0, headChars)}${USER_INTENT_TRUNCATION_MARKER}${normalized.slice(-tailChars)}`;
}

/** 只取当前用户消息文本并设硬上限，保留末尾的最终要求或更正。 */
export function extractAutoReviewUserIntent(content: UserMessage['content']): string {
  const text = typeof content === 'string'
    ? content
    : content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  return compactCurrentUserIntent(text);
}

/**
 * Plan approval changes the authority for the implementation turn. Keep the
 * original request together with the approved plan without expanding the
 * lightweight reviewer beyond its existing intent budget.
 */
export function composeAutoReviewIntentWithApprovedPlan(
  currentUserIntent: string,
  approvedPlan: string,
): string {
  const plan = approvedPlan.trim();
  if (!plan) return compactCurrentUserIntent(currentUserIntent);
  return compactCurrentUserIntent([
    currentUserIntent.trim(),
    `Approved plan:\n${plan}`,
  ].filter(Boolean).join('\n\n'));
}

/**
 * 澄清问答同样改变本轮的授权范围:用户把范围从 `src/` 收窄到 `build/` 后,后续 `rm -rf src` 必须按
 * **澄清后**的意图裁决,而不是仍按原先那句含糊请求(否则可能被静默 allow)。答案与获批计划同理并入
 * 有界 intent,不扩大轻量 reviewer 的输入预算。
 */
export function composeAutoReviewIntentWithClarification(
  currentUserIntent: string,
  clarifications: readonly { question?: string; answer?: string }[],
): string {
  const lines = clarifications
    .map(({ question, answer }) => {
      const q = (question ?? '').trim();
      const a = (answer ?? '').trim();
      if (!a) return '';
      return q ? `- ${q} → ${a}` : `- ${a}`;
    })
    .filter(Boolean);
  if (lines.length === 0) return compactCurrentUserIntent(currentUserIntent);
  return compactCurrentUserIntent([
    currentUserIntent.trim(),
    `Clarifications:\n${lines.join('\n')}`,
  ].filter(Boolean).join('\n\n'));
}

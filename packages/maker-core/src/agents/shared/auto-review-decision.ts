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
  /**
   * `true` = 这个 `block` 来自**审阅器没跑起来**（delegate 缺失 / 超时 / 抛错 / 返回非法），
   * 不是模型判定动作危险。
   *
   * 两件事以前被压成同一个 `block`（issue #1574），于是「模型让我换个安全做法」和
   * 「基础设施故障，Auto 档整个不工作了」在上层完全无法区分 —— 后者是用户有权知道并接管的，
   * 却和前者一样对 UI 静默。区分之后：
   * - 模型判定的 `block` 继续静默，只把 reason 喂给模型（Auto 档的本意就是不打扰）；
   * - `unavailable` 的 `block` 额外触发一条**会话级一次性**提示（见
   *   createAutoReviewUnavailableNotice），动作本身仍然 deny —— 安全边界不变。
   *
   * 注意：证据不足（缺路径 / 命令、动作文本超限）**不算** unavailable。那时审阅器是好的，
   * 是这次请求没法审，属于正常判定。
   */
  unavailable?: boolean;
};

/**
 * 「自动审核不可用」的会话级提示错误码。走既有的 `[CODE] fallback text` 约定：
 * harness emit 非终止 error 事件，renderer 的 decodeRemoteErrorMessage 翻成 i18n 文案
 * （见 apps/desktop 的 chat.remoteError.*），不新增协议、不新增事件类型。
 */
export const AUTO_REVIEW_UNAVAILABLE_CODE = 'AUTO_REVIEW_UNAVAILABLE';

/**
 * 未落地 i18n 的宿主看到的兜底英文。用词与 desktop 权限选择器的档位标签对齐
 * （Auto-review / Default permissions），避免同一件事在两处叫不同名字。
 *
 * IM 渠道（Slack / Telegram / 飞书）**不**读它 —— 渠道文案硬编码中文、不进 renderer
 * 的 locale（见 docs/dev-rules/engineering-conventions.md §5），映射在
 * apps/desktop/src/main/im/shared/turnRetryNotice.ts。
 */
const AUTO_REVIEW_UNAVAILABLE_FALLBACK_TEXT =
  'Auto-review is temporarily unavailable, so actions that need review are being denied. '
  + 'Switch this task to Default permissions if you want to approve them yourself.';

/**
 * 判定一条 AgentEvent 的 error message 是否就是「自动审批不可用」提示。
 *
 * 消费方有三处、判据必须单点:desktop 需要把它**额外落库**成持久的 error 行(非终止
 * error 默认只进 ErrorBanner,会被下一条事件清掉);IM 渠道需要把它翻成渠道文案;
 * renderer 需要把它翻成 i18n。谁都不该自己去拼 `[CODE]` 前缀。
 */
export function isAutoReviewUnavailableNotice(message: unknown): boolean {
  return typeof message === 'string'
    && message.startsWith(`[${AUTO_REVIEW_UNAVAILABLE_CODE}]`);
}

/**
 * 会话级**一次性**提示的去重器 —— 逐条提示会把 Auto 档退化成比 Ask 更烦的东西，
 * 而完全不提示就是 issue #1574 报的「静默永久拒绝」。所以一个会话只说一次。
 *
 * `reset()` 用在换模型 / 换路由 / 用户主动改权限档之后：那些动作可能已经修好了问题，
 * 若之后**又**不可用，值得再提醒一次。
 */
export function createAutoReviewUnavailableNotice(
  emit: (message: string) => void,
): { notify(): void; reset(): void } {
  let sent = false;
  return {
    notify(): void {
      if (sent) return;
      sent = true;
      emit(`[${AUTO_REVIEW_UNAVAILABLE_CODE}] ${AUTO_REVIEW_UNAVAILABLE_FALLBACK_TEXT}`);
    },
    reset(): void {
      sent = false;
    },
  };
}

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
      unavailable: true,
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
  // 走到这里 = delegate 存在但没给出可用结果(超时 / 抛错 / 返回非法)。与「模型判定危险」
  // 不同,这是审阅器本身没跑起来,必须让上层能区分出来。
  return {
    verdict: 'block',
    reason: 'Automatic review could not complete. Choose a safer, workspace-scoped alternative.',
    unavailable: true,
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

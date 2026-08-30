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
   * `true` = 这个 `ask` 来自**审阅器没跑起来**（delegate 缺失 / 超时 / 抛错 / 返回非法），
   * 不是模型判定动作危险。
   *
   * 两件事以前被压成同一个 `block`（issue #1574），于是「模型让我换个安全做法」和
   * 「基础设施故障，Auto 档整个不工作了」在上层完全无法区分 —— 后者是用户有权知道并接管的，
   * 却和前者一样对 UI 静默。区分之后：
   * - 模型判定的 `block` 继续静默，只把 reason 喂给模型（Auto 档的本意就是不打扰）；
   * - `unavailable` 降级成 `ask`，弹确认卡让用户接管；另外发一条会话级一次性提示
   *   （见 createAutoReviewUnavailableNotice）。
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
  'Auto-review could not reach a decision (network or service hiccup), so actions that '
  + 'need review are being handed to you to confirm. Switch this task to Default '
  + 'permissions if you would rather not be interrupted.';

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

/**
 * 确认卡上的兜底英文：审阅器故障后改由用户点这一次。
 * Desktop renderer 见到 metadata 标记后会换成 i18n；IM / 无 locale 的宿主直接显示它。
 */
export const AUTO_REVIEW_UNAVAILABLE_PROMPT_TEXT =
  'Automatic review could not finish, so this action needs your confirmation.';

/** InteractionRequest.metadata 标记：这张确认卡是 Auto-review 故障降级，不是普通 Ask。 */
export const AUTO_REVIEW_UNAVAILABLE_METADATA_KEY = 'autoReviewUnavailable';

/**
 * 确认卡没送到 / 没被点 / 超时后的错误码。Codex vendor 会把所有 decline 打成
 * `rejected by user`，这条提示用来纠正归因：不是用户点了拒绝。
 */
export const AUTO_REVIEW_CONFIRM_UNDELIVERED_CODE = 'AUTO_REVIEW_CONFIRM_UNDELIVERED';

const AUTO_REVIEW_CONFIRM_UNDELIVERED_FALLBACK_TEXT =
  'Automatic review was unavailable, and the confirmation request was not completed. '
  + 'This is not a user rejection — do not retry the same action as if the user declined.';

export function isAutoReviewConfirmUndeliveredNotice(message: unknown): boolean {
  return typeof message === 'string'
    && message.startsWith(`[${AUTO_REVIEW_CONFIRM_UNDELIVERED_CODE}]`);
}

export function createAutoReviewConfirmUndeliveredNotice(
  emit: (message: string) => void,
): { notify(): void; reset(): void } {
  let sent = false;
  return {
    notify(): void {
      if (sent) return;
      sent = true;
      emit(
        `[${AUTO_REVIEW_CONFIRM_UNDELIVERED_CODE}] ${AUTO_REVIEW_CONFIRM_UNDELIVERED_FALLBACK_TEXT}`,
      );
    },
    reset(): void {
      sent = false;
    },
  };
}

/**
 * Desktop / IM / router 在确认失败时写下的系统 reason。
 * 这些不是用户点击「拒绝」，不能当成 `user-denied`。
 *
 * 必须覆盖所有会走到 permission deny 的系统码：漏一个，Codex 就会把这次系统拒绝
 * 显示成用户点了拒绝。Hook 超时、路由释放、turn 收口、卡片没发出去都属于这一类。
 */
export const SYSTEM_PERMISSION_DENIAL_REASONS: ReadonlySet<string> = new Set([
  'no_interaction_resolver',
  'no_resolver_attached',
  'no_interaction_route',
  'no_listener_attached',
  'interaction_resolver_error',
  'resolver_threw',
  'approval_timeout',
  'interaction_handler_failed',
  'interaction_timeout',
  'hook_interaction_timeout',
  'timeout',
  'stale_turn',
  'stale_route',
  'duplicate_request_id',
  'session_closed',
  'session_aborted',
  'session_cleanup',
  'session_disposed',
  'session disposed',
  'interaction_route_released',
  'hook_turn_terminal',
  'turn_terminal',
  'not_renderable',
  'headless_interaction_unavailable',
  'no_card',
  'rich_output_not_supported',
  'replaced_by_new_request',
  'wecom_interaction_disconnected',
  'wecom_interaction_timeout',
  'wecom_interaction_send_failed',
  'wecom_interaction_cancelled_by_stop',
  'wechat_interaction_timeout',
  'wechat_interaction_send_failed',
  'wechat_binding_stopped',
  'wechat_user_stopped',
  'turn_idle_reconcile',
  'orca_disable',
  'session_running_race',
  'turn_not_dispatched',
]);

/**
 * IM turnRunner 会把投递失败写成 `prefix: ${msg}`，不能靠精确集合命中。
 * 只认确认卡没送到 / 没登记完这类前缀；用户拒绝和 destructiveGuard 不在这里。
 */
export const SYSTEM_PERMISSION_DENIAL_PREFIXES: readonly string[] = Object.freeze([
  'card send failed:',
  'pending failed:',
  'text interaction failed:',
  'register failed:',
  'permission_mode_changed_to_',
  'plan_mode_',
  'wecom_interaction_',
  'wechat_interaction_',
]);

export function isSystemPermissionDenialReason(reason: unknown): boolean {
  if (typeof reason !== 'string' || reason.length === 0) return false;
  if (SYSTEM_PERMISSION_DENIAL_REASONS.has(reason)) return true;
  return SYSTEM_PERMISSION_DENIAL_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

export function isAutoReviewUnavailableMetadata(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return metadata?.[AUTO_REVIEW_UNAVAILABLE_METADATA_KEY] === true;
}

/** 给确认卡打上「自动审批失败，请你确认这一次」的说明，不重新跑审阅器。 */
export function annotatePermissionRequestForUnavailableReview<
  T extends {
    kind: 'permission';
    description?: string;
    metadata?: Record<string, unknown>;
  },
>(req: T): T {
  return {
    ...req,
    description: AUTO_REVIEW_UNAVAILABLE_PROMPT_TEXT,
    metadata: {
      ...req.metadata,
      [AUTO_REVIEW_UNAVAILABLE_METADATA_KEY]: true,
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
  /** 全部可读根；首项必须是主工作目录，供相对路径解析。 */
  workspaceRoots: string[];
  /**
   * 显式可写根。旧请求缺省时仍仅 workspaceRoots[0] 可写，保证跨版本 fail-closed。
   */
  writableRoots?: string[];
  platform: NodeJS.Platform;
}

export type AutoReviewDelegate = (
  request: AutoReviewRequest,
) => Promise<AutoReviewDecision | null>;

export const MAX_AUTO_REVIEW_ACTION_TEXT_CHARS = 4_096;
const MAX_AUTO_REVIEW_REASON_CHARS = 240;
/**
 * Auto-review is deliberately bounded: a reviewer outage must still resolve the
 * gray action instead of hanging the tool callback. Keep the host request
 * deadline below the core guard so a valid answer at the request deadline can
 * return before the outer guard fires.
 *
 * **两个数必须一起改。** delegate 侧现在会做重试(见 desktop 的
 * createAutoPermissionReviewer),而重试全部发生在 `delegateTimeoutMs` 之内 ——
 * 外层守卫若先触发,重试就完全失去意义(白等、白花钱,结果照样是不可用)。
 * 上限取「宿主侧最慢的一档 × 重试次数 + 退避」再留余量。
 */
export interface AutoReviewTimeoutPolicy {
  requestTimeoutMs: number;
  delegateTimeoutMs: number;
}

/**
 * 紧凑档(能关思考的模型)的默认策略。宿主侧每次尝试都用完整的
 * `requestTimeoutMs`(不按次数切分 —— 切分会把本来能成功的慢响应也判成超时),
 * 总耗时由 AUTO_REVIEW_DELEGATE_HARD_CEILING_MS 兜住。
 */
export const DEFAULT_AUTO_REVIEW_TIMEOUT_POLICY: Readonly<AutoReviewTimeoutPolicy> = Object.freeze({
  requestTimeoutMs: 12_000,
  delegateTimeoutMs: 13_000,
});

/** 宿主侧的重试次数与退避。核心侧据此推总预算,两边必须同源,否则守卫会截断重试。 */
export const AUTO_REVIEW_RETRY_ATTEMPTS = 3;
export const AUTO_REVIEW_RETRY_BACKOFF_MS: readonly number[] = Object.freeze([100, 200]);

/** 宿主侧单次请求的最宽一档(强制思考模型),核心侧守卫按它推上界。 */
export const AUTO_REVIEW_MAX_REQUEST_TIMEOUT_MS = 30_000;

/**
 * 调度余量:prompt 构造、`setTimeout` 抖动、事件循环排队都计入总耗时但不属于任何
 * 一次请求。宿主的时间兜底与核心守卫都要加上它 —— 不留余量等于要求这些开销恰好
 * 为零,真机上必然差那么几毫秒,于是最后一次重试恒定被自己的护栏挡掉
 * (PR #2474 review 两轮都指向这一点)。
 */
export const AUTO_REVIEW_RETRY_SCHEDULING_SLACK_MS = 2_000;

/**
 * 一轮审阅(含全部重试与退避)的总预算。
 *
 * 宿主用它决定"还够不够再跑一次",核心用它推外层守卫的上界 —— **必须同一个算法**,
 * 否则守卫会在重试跑完前触发,宽裕额度形同虚设(PR #2474 review:固定 35s 盖不住
 * 30s 档的三次尝试,第二次约 5s 就被丢弃且请求未取消、继续消耗额度)。
 */
export function autoReviewRetryBudgetMs(
  requestTimeoutMs: number,
  attempts: number = AUTO_REVIEW_RETRY_ATTEMPTS,
): number {
  const backoffTotal = AUTO_REVIEW_RETRY_BACKOFF_MS
    .slice(0, Math.max(0, attempts - 1))
    .reduce((sum, ms) => sum + ms, 0);
  return requestTimeoutMs * attempts + backoffTotal;
}

/**
 * 核心侧守卫的绝对上界:按最宽一档 + 全部重试与退避推出,再加**两份**调度余量 ——
 * 一份对应宿主时间兜底自己放宽的那份,另一份留给守卫与兜底之间的竞态。
 * 守卫必须严格晚于宿主的兜底触发,否则宿主刚放宽的余量会被守卫吃掉。
 *
 * 这是**兜底**不是常态:绝大多数请求 2s 内返回(实测 p95 ≈ 2.5s)。
 */
const AUTO_REVIEW_DELEGATE_HARD_CEILING_MS =
  autoReviewRetryBudgetMs(AUTO_REVIEW_MAX_REQUEST_TIMEOUT_MS)
  + AUTO_REVIEW_RETRY_SCHEDULING_SLACK_MS * 2;

/** 暴露给测试:守卫必须容得下最宽一档的全部重试,常量漂移时要红。 */
export function getAutoReviewDelegateHardCeilingMs(): number {
  return AUTO_REVIEW_DELEGATE_HARD_CEILING_MS;
}
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
    { platform: request.platform, writableRoots: request.writableRoots },
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
 * 只有中间灰区才调用当前会话模型。
 *
 * **审阅器故障时降级为 `ask`，不再静默 `block`。** 宿主侧已先做过重试
 * （见 desktop 的 createAutoPermissionReviewer），走到这里意味着重试也没救回来。
 * 此时静默拒绝是最差的选择：用户既看不到发生了什么，一批本来完全正常的灰区操作
 * 又被连续否掉，Auto 档表现得像坏了。降级成 `ask` 把决定权交回用户 ——
 * 安全边界不降低（未经用户点头仍然不会执行），但用户至少知道该点头还是拒绝。
 *
 * 与「模型判定危险」的 `block` 仍然严格区分：那个继续静默，因为 Auto 的本意
 * 就是不打扰；只有 `unavailable` 才升级成打扰。
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
      verdict: 'ask',
      reason: 'Automatic review is unavailable, so this action needs your confirmation.',
      unavailable: true,
    };
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const decision = await Promise.race([
      delegate(request),
      new Promise<typeof AUTO_REVIEW_TIMEOUT>((resolve) => {
        // 用硬上界而非紧凑档的 delegateTimeoutMs:宿主侧对强制思考的模型会放宽
        // 单次超时并叠加重试,守卫必须容得下最慢的那一档,否则重试与放宽额度
        // 都会被这里提前切断。
        timeout = setTimeout(
          () => resolve(AUTO_REVIEW_TIMEOUT),
          AUTO_REVIEW_DELEGATE_HARD_CEILING_MS,
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
    // 审阅器故障不得吊住 tool callback;下面统一降级收口。
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  // 走到这里 = delegate 存在但没给出可用结果(重试后仍超时 / 抛错 / 返回非法)。
  // 与「模型判定危险」不同,这是审阅器本身没跑起来 —— 交给用户确认,而不是替他拒绝。
  return {
    verdict: 'ask',
    reason: 'Automatic review could not complete, so this action needs your confirmation.',
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

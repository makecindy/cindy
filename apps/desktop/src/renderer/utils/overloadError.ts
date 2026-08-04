/**
 * 服务过载类错误识别(renderer 侧)— 判断错误 message 是不是"上游模型服务没有
 * 可用容量",以及它当前是否正在自动重试。ErrorBanner 用它把原始英文报错
 * (如 "Selected model is at capacity. Please try a different model.")换成友好
 * 文案,原始错误折叠可查。
 *
 * 判定与 maker-core 的 `packages/maker-core/src/agents/shared/overload-error.ts`
 * **语义一致**(那份决定 Codex 是否退避重投、进度后缀怎么编码;不跨 bundle 共享
 * 代码,与 network-error / 401 pattern 的两端一致性同款惯例)。修改时两处同步。
 *
 * **与 networkError.ts 的分工**:那份管"网络到不了上游"(网关 5xx、errno、fetch
 * 失败),本份管"网络通了、上游明确说自己没容量"。两者文案不同——把容量问题显示
 * 成"网络异常"会让用户白折腾自己的网络。
 *
 * 两种形态:
 *  - `capacity`:Codex 透传 OpenAI 的 `Selected model is at capacity`。
 *    app-server 侧不重试,由 maker-core 接管退避重投。
 *  - `overloaded`:Anthropic HTTP 529。Claude Code SDK 自己带退避重试,客户端
 *    只负责显示进度。
 */

export type OverloadErrorKind = 'capacity' | 'overloaded';

/**
 * maker-core 在过载 error 事件上带的**稳定 reason key**(见 maker-core 的
 * `agents/shared/overload-error.ts` 的 `UPSTREAM_OVERLOAD_REASON`)。
 *
 * 为什么 renderer 认这个而不是 codex 的原始 `codexErrorInfo` tag: 判定依据按
 * 进程边界分层 —— main 侧(goal-host / IM)直接消费 error data, 吃 codex 的原始
 * 结构化 tag; renderer 隔着 IPC 投影, 吃我们自己定义的稳定 key。后者不随 vendor
 * 协议演进而变, 也不需要把 vendor 枚举搬进 renderer bundle。
 *
 * 为什么两者都不能只靠文案: `Selected model is at capacity...` 是 codex 二进制里
 * 硬编码的用户可见提示语, 不是 API 契约。只认文案时 codex 改一次措辞, 用户就会在
 * 整段自动重试窗口(约 22-38s)里看到英文原文, 而不是本地化的重试进度与过载引导。
 *
 * 与 maker-core 侧同名常量两处同步(不跨 bundle 共享代码, 与本文件其它谓词同规)。
 */
export const UPSTREAM_OVERLOAD_REASON = 'upstream-overload';

export function parseOverloadError(
  message: string,
  errorStatus?: number,
  reason?: string | null,
): { kind: OverloadErrorKind } | null {
  if (reason === UPSTREAM_OVERLOAD_REASON) return { kind: 'capacity' };
  if (errorStatus === 529) return { kind: 'overloaded' };
  // 文案 pattern 保留作老 daemon(不发结构化标识)与 Anthropic 侧的兜底。
  if (/\bat capacity\b/i.test(message)) return { kind: 'capacity' };
  if (/\boverloaded_error\b|\b529\b/.test(message)) return { kind: 'overloaded' };
  return null;
}

export function isOverloadErrorMessage(
  message: string,
  errorStatus?: number,
  reason?: string | null,
): boolean {
  return parseOverloadError(message, errorStatus, reason) !== null;
}

/**
 * 解析重投进度后缀 `(auto-retry N/M)`(由 maker-core 的
 * `formatOverloadRetryMessage` 追加,两个 agent 共用同一套编码)。
 *
 * 返回 null = 没有进度后缀,即"已经放弃重试"(退避耗尽后的终止错误,或上游原样
 * 报错)。这个区分决定 banner 显示"正在重试"还是"请改用其它模型"。
 */
const OVERLOAD_RETRY_PROGRESS_RE = /\(auto-retry\s+(\d+)\s*\/\s*(\d+)\)\s*$/;

export function parseOverloadRetryProgress(
  message: string,
): { attempt: number; maxAttempts: number } | null {
  const match = OVERLOAD_RETRY_PROGRESS_RE.exec(message);
  if (!match) return null;
  const attempt = Number(match[1]);
  const maxAttempts = Number(match[2]);
  if (
    !Number.isSafeInteger(attempt) ||
    !Number.isSafeInteger(maxAttempts) ||
    attempt < 1 ||
    maxAttempts < attempt
  ) {
    return null;
  }
  return { attempt, maxAttempts };
}

/**
 * goal-host 在「上游过载」时写进 GoalState.lastReason 的判据串。
 *
 * 过载与账号限流共用 `usageLimited` 状态(可恢复 + 到点自动续跑), 所以状态本身分不出
 * 两者 —— 状态标签要说对话就得看这个 reason。判据来源是 main 侧的
 * goal-host/usageLimit.ts:OVERLOAD_LAST_REASON; renderer 不得 import main
 * (architecture-invariants), 因此在这里镜像一份常量, 与本文件其它谓词同规。
 * 两侧改动必须同步。
 */
export const GOAL_OVERLOAD_LAST_REASON = 'model service at capacity';

/**
 * 目标是否正处于「上游过载退避」而非账号限流。
 *
 * 两者共用 `usageLimited` 状态, 所以状态标签、恢复时刻文案都必须靠这个判定分岔:
 * 账号从没被限流时说「用量受限 / X 点恢复」是假信息 —— 那个时刻只是"现在 + 60s 后
 * 重试", 不是任何额度重置点(review #844 codex P1)。
 */
export function isGoalCapacityBackoff(
  status: string | null | undefined,
  lastReason: string | null | undefined,
): boolean {
  return status === 'usageLimited' && lastReason === GOAL_OVERLOAD_LAST_REASON;
}

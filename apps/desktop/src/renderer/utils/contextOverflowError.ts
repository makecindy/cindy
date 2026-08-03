/**
 * 上下文超限类错误识别(renderer 侧)— 判断错误 message 是不是"请求输入超出了
 * 模型 / 网关的上下文窗口上限"(#1429)。ErrorBanner 用它把原始报错(如 litellm 的
 * `400 ... "code": "context_length_exceeded"` 整段 JSON)换成友好文案 + 可执行
 * 恢复动作,并隐藏必败的 Retry —— 原样重发必然再撞同一个 4xx。
 *
 * 判定与 maker-core 的 `packages/maker-core/src/agents/shared/context-overflow-error.ts`
 * **语义一致**(那份决定 translator 是否给 error 事件带稳定 reason、tracker 是否锁到
 * 窗口满载;不跨 bundle 共享代码,与 overloadError / networkError 的两端一致性同款
 * 惯例)。desktop main 的 providerErrors.ts `CONTEXT_TOO_LONG_RE` 是第三份同语义
 * pattern(作用域是 proxy 层响应体)。修改措辞集合时三处同步。
 *
 * **与 overloadError / networkError 的分工**:那两份管"上游没容量 / 网络到不了",
 * 都可能重试自愈;本份管"请求本身太大被拒",重试必败 —— 恢复动作是压缩上下文或
 * 新建任务,文案与按钮完全不同,所以刻意不合并判定。
 */

/**
 * maker-core 在上下文超限 error 事件上带的**稳定 reason key**(见 maker-core 的
 * `agents/shared/context-overflow-error.ts` 的 `CONTEXT_OVERFLOW_REASON`)。
 * renderer 隔着 IPC 投影优先吃这个 key;文案 pattern 保留作历史持久化错误行
 * (只有原文可用)与老 maker-core 的兜底。两处同名常量同步。
 */
export const CONTEXT_OVERFLOW_REASON = 'context-overflow';

/** 措辞集合与 maker-core 侧同源(Anthropic / OpenAI / litellm·Azure)。 */
const CONTEXT_OVERFLOW_RE =
  /prompt is too long|maximum context length|context.{0,20}(length|window).{0,40}(exceed|too)|(input|request|message).{0,20}exceeds?.{0,40}context.{0,20}(length|window)|context_length_exceeded/i;

/** 是否是上下文超限类错误。命中 = 隐藏 Retry,给出压缩上下文 / 新建任务入口。 */
export function isContextOverflowError(message: string, reason?: string | null): boolean {
  if (reason !== undefined && reason !== null) return reason === CONTEXT_OVERFLOW_REASON;
  return CONTEXT_OVERFLOW_RE.test(message);
}

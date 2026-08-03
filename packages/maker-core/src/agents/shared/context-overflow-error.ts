/**
 * 上下文超限类错误识别 — 判断报错是不是"请求输入超出了模型 / 网关的上下文窗口上限"。
 *
 * **与 overload-error.ts / network-error.ts 的分工**：那两份分别管"上游没容量"与
 * "网络到不了上游"，都可能重试自愈；本份管"请求本身太大被上游拒绝"——重试**必然**
 * 原样再撞同一个 4xx，属于不可重试错误。三类驱动的 UI 文案与恢复动作完全不同
 * （过载 → 自动退避重投；网络 → 自动重连；超限 → 压缩上下文 / 新开会话），
 * 所以刻意不合并判定。
 *
 * 已知措辞形态（pattern 逐条对应，只认错误文本形态、与 provider 无关）：
 *  - Anthropic:        `prompt is too long: 250000 tokens > 200000 maximum`
 *  - OpenAI:           `This model's maximum context length is 128000 tokens...`
 *  - litellm / Azure:  `{"code": "context_length_exceeded"}` /
 *                      `Your input exceeds the context window of this model.`（#1429 实踩）
 *
 * 裸 `too many tokens` / `input length exceeds` 不足以证明是上下文窗口超限：它们也会
 * 出现在 token 速率限制、输出上限与工具参数长度错误中。只有文本明确提到 context
 * window / context length，或携带稳定错误码时才归为本类。
 *
 * 为什么会走到这一步（防线失效链，见 #1429）：声明窗口大于路由真实上限时，
 * SDK 内部与 host 侧两层 auto-compact 的阈值都建立在错误的分母上，永远触发不了；
 * 撞上限被 400 拒绝后请求拿不到 usage，tracker 的 contextTokens 停在旧值甚至 0，
 * ratio 判定进一步失效——会话自锁。本模块的 reason key 就是解锁链的起点：
 * translator 终态识别 → tracker 锁满窗口 → auto-compact 触发 + renderer 按 key
 * 隐藏必败的 Retry。
 *
 * 消费方：
 *  - claude-code / codex translator：终态 error 事件附带 `CONTEXT_OVERFLOW_REASON`。
 *  - claude-code translator：命中时调 `tracker.markContextOverflow()`（见 usage-tracker.ts）。
 *  - renderer ErrorBanner 有一份**语义一致**的同名判定
 *    （apps/desktop/src/renderer/utils/contextOverflowError.ts，不跨 bundle 共享代码，
 *    与 overload / network 两端一致性同款惯例）。修改 pattern 时两处同步。
 *  - desktop main 的 providerErrors.ts `CONTEXT_TOO_LONG_RE` 是第三份同语义 pattern
 *    （供应商上游错误分类，作用域是 proxy 层响应体而非 turn error）。三处的措辞
 *    集合保持同步。
 */

/**
 * 上下文超限 error 事件上带的**稳定 reason key**。
 *
 * 走 `reason` 这个既有通道而不是新增字段：`reason` 本就是「maker-core 用稳定 key 告诉
 * renderer 这是什么错误」的现成语义（`empty-response` / `upstream-overload` 同款）。
 * renderer 隔着 IPC 投影拿不到结构化的 provider 分类，靠这个 key 驱动 ErrorBanner 的
 * 本地化文案、hideRetry 与恢复动作；文案匹配仅作历史持久化错误行的兜底。
 */
export const CONTEXT_OVERFLOW_REASON = 'context-overflow';

/**
 * Pattern 与 desktop `providerErrors.ts` 的 `CONTEXT_TOO_LONG_RE` 同源，另补两条：
 *  - `(input|request|message).{0,20}exceed.{0,40}context`：litellm/Azure 的
 *    "Your input exceeds the context window of this model"（exceed 在 context **前**，
 *    原正则只覆盖 exceed 在后的语序）。
 *  - `context_length_exceeded` 的字面错误码在 message 未附带错误码 JSON 时可能缺席，
 *    上一条语序补齐正是为此。
 * 大小写不敏感。判定对象是 redact 后的 API 错误 envelope 文本，不是工具输出，
 * 误伤面与既有 overload / network pattern 同级。
 */
const CONTEXT_OVERFLOW_RE =
  /prompt is too long|maximum context length|context.{0,20}(length|window).{0,40}(exceed|too)|(input|request|message).{0,20}exceeds?.{0,40}context.{0,20}(length|window)|context_length_exceeded/i;

/** 是否是上下文超限类错误。命中 = 不可原样重试，恢复动作是压缩上下文或新开会话。 */
export function isContextOverflowErrorMessage(message: string): boolean {
  return CONTEXT_OVERFLOW_RE.test(message);
}

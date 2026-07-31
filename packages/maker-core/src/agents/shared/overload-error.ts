/**
 * 服务过载类错误识别与重试退避 — 判断报错是不是"上游模型服务没有可用容量"，
 * 以及这类错误该按什么节奏重试。
 *
 * **与 network-error.ts 的分工**：那份管"网络到不了上游"（网关 5xx、errno、
 * fetch 失败），本份管"网络通了、上游明确说自己没容量"。两者都可能重试自愈，
 * 但用户看到的文案和该由谁重试完全不同，所以刻意不合并进
 * `isNetworkishErrorMessage`——那个判定同时驱动"网络异常，正在自动重试"文案，
 * 混进来会让容量问题被误报成用户断网。
 *
 * 两种形态：
 *  - `capacity`：Codex app-server 透传 OpenAI 的
 *    `Selected model is at capacity. Please try a different model.`
 *    指所选模型的服务槽位不足，**不是**账号配额耗尽，也**不是**上下文超长。
 *    OpenAI 侧不会自己重试（openai/codex#22390 至今 open），turn 直接终止，
 *    所以这类必须由 Cindy 接管退避重投。
 *  - `overloaded`：Anthropic HTTP 529 overloaded_error。Claude Code SDK **自己**
 *    带退避重试（见 claude-code translator 的 `api_retry` 分支），Cindy 只负责
 *    把状态和文案透出，**绝不能再叠一层重投**——双层重试会让单次过载被放大成
 *    指数级请求，而且额度按次扣。
 *
 * 消费方：
 *  - codex translator / index：`capacity` 触发退避重投 turn/start。
 *  - goal-host：退避耗尽后据此置非终态并安排短窗口自动续跑，而不是判死。
 *  - renderer ErrorBanner 有一份**语义一致**的同名判定
 *    （apps/desktop/src/renderer/utils/overloadError.ts，不跨 bundle 共享代码，
 *    与 network-error 两端一致性同款惯例）。修改 pattern 时两处同步。
 */

/**
 * 过载 error 事件上带的**稳定 reason key**。
 *
 * 判定依据按进程边界分层：main 侧（goal-host / IM）直接消费 error data，吃 codex 的
 * 原始 `codexErrorInfo` tag；renderer 隔着 IPC 投影，吃这个我们自己定义的 key。
 * 后者不随 vendor 协议演进而变，也不用把 vendor 枚举搬进 renderer bundle。
 *
 * 走 `reason` 这个既有通道而不是新增字段：`reason` 本就是「maker-core 用稳定 key 告诉
 * renderer 这是什么错误」的现成语义（`empty-response` / `turn-failed` 同款），store 侧
 * 已随 error 一起清理，不必再引入一条平行的清理链（漏清会让过载标记残留到下一条
 * 非过载错误上）。
 *
 * renderer 侧有同名常量镜像（`apps/desktop/src/renderer/utils/overloadError.ts`），
 * 两处同步。
 */
export const UPSTREAM_OVERLOAD_REASON = 'upstream-overload';

/** 过载形态。决定由谁重试，以及用户看到哪条文案。 */
export type OverloadErrorKind = 'capacity' | 'overloaded';

export interface OverloadError {
  kind: OverloadErrorKind;
}

/**
 * 识别服务过载类错误。判定依据按可靠性排序，命中即返回：
 *
 * 1. `codexErrorInfoTag`（最可靠）：Codex app-server 的结构化错误标识，
 *    `serverOverloaded` 即上游临时过载。**这是 Codex 侧的首选依据** ——
 *    详见下面「为什么不能只靠文案」。
 * 2. `errorStatus === 529`：Anthropic 的 HTTP 状态码。
 * 3. 文案 pattern：老 daemon（不发 `codexErrorInfo`）与 Anthropic 侧的兜底。
 *
 * **为什么不能只靠文案**：`Selected model is at capacity. Please try a different
 * model.` 是 codex 二进制里硬编码的用户可见提示语（`CodexErr::ServerOverloaded`
 * 上的 `#[error(...)]`，见 codex-rs/protocol/src/error.rs），不是 API 契约。
 * codex 改一次措辞，靠它驱动的整套退避重投就**静默失效**：用户回到秒失败，日志
 * 里没有任何东西指向原因，而用同一句文案写的测试仍然全绿。Cindy 捆绑 codex 并
 * 跟着升级，所以这不是假想风险。结构化 tag 由 schema 承诺，不随文案漂移。
 *
 * 文案 pattern 仍然**保留**而不是删掉：远端可能跑着旧 daemon，Anthropic 侧也只有
 * 文案和状态码可用。它从「唯一依据」降级为「兜底」。
 *
 * pattern 说明：capacity 要求 `at capacity` 精确短语，避免误伤业务文案里的
 * "capacity"（如缓存容量、队列容量）；overloaded 认 529 状态码与 Anthropic 的
 * `overloaded_error` 错误码字面量，不认裸词 "overloaded"——后者在工具输出、日志
 * 摘要里太常见，会把模型正常返回的内容误判成平台故障。
 */
export function parseOverloadError(
  message: string,
  errorStatus?: number,
  codexErrorInfoTag?: string,
): OverloadError | null {
  if (codexErrorInfoTag === 'serverOverloaded') return { kind: 'capacity' };
  if (errorStatus === 529) return { kind: 'overloaded' };
  if (/\bat capacity\b/i.test(message)) return { kind: 'capacity' };
  if (/\boverloaded_error\b|\b529\b/.test(message)) return { kind: 'overloaded' };
  return null;
}

/** 是否是服务过载类错误。只需布尔判定时用这个，省掉解构。 */
export function isOverloadErrorMessage(
  message: string,
  errorStatus?: number,
  codexErrorInfoTag?: string,
): boolean {
  return parseOverloadError(message, errorStatus, codexErrorInfoTag) !== null;
}

/**
 * capacity 退避重投的最大次数。
 *
 * 上限刻意设小：容量被拒时额度照扣（社区实测，见 openai/codex#28507 讨论），
 * 一次区域性容量故障若配上大次数重试，会把用户额度烧光却仍然失败。4 次配合
 * 下面的退避序列约覆盖 30 秒窗口，够穿过常见的短时抖动；真正的区域性故障
 * （2026-06-16 那次持续数十分钟）本来就不该靠客户端重试硬扛。
 */
export const OVERLOAD_RETRY_MAX_ATTEMPTS = 4;

/** 首次退避基数。 */
const OVERLOAD_RETRY_BASE_DELAY_MS = 2_000;
/** 单次退避上限，防止指数增长把用户晾太久。 */
const OVERLOAD_RETRY_MAX_DELAY_MS = 30_000;
/** jitter 幅度（±25%），打散多会话同时重试造成的自制惊群。 */
const OVERLOAD_RETRY_JITTER_RATIO = 0.25;

/**
 * 第 `attempt` 次重投前该等多久（attempt 从 1 起）。指数退避 + 对称 jitter。
 *
 * jitter 必要性：容量故障是区域性的，同一台机器上的多个会话（以及同一用户的
 * 多个客户端）会在同一时刻收到拒绝。不打散的话它们会锁步重试，把已经没容量的
 * 上游继续同步砸——客户端侧自制的惊群。
 *
 * `random` 可注入，让单测能断言确定的边界值。
 */
export function overloadRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(
    OVERLOAD_RETRY_BASE_DELAY_MS * 2 ** exponent,
    OVERLOAD_RETRY_MAX_DELAY_MS,
  );
  // random() ∈ [0,1) → 系数 ∈ [0.75, 1.25)
  const factor = 1 + (random() * 2 - 1) * OVERLOAD_RETRY_JITTER_RATIO;
  // 封顶要在 jitter **之后**再做一次: 只封 base 的话, 触顶那几档乘上 1.25 会回到约 37.5s,
  // 与 OVERLOAD_RETRY_MAX_DELAY_MS 声明的"单次退避上限"自相矛盾(copilot 低置信提示)。
  // 触顶后 jitter 只能往下拉, 分布变成单边 —— 但打散惊群的作用仍在(区间还有 22.5s~30s),
  // 而"绝不让用户等过 30s"是这个常量要保证的硬边界, 优先。
  return Math.min(Math.round(base * factor), OVERLOAD_RETRY_MAX_DELAY_MS);
}

/**
 * 重投进度在 error message 里的编码格式。
 *
 * 为什么编码进文本而不是加结构化字段：非终止 error 透到 renderer 后落在
 * `recoverableError: string | null`（makerChatStore），这是个跨端投影字段
 * （mobile 的 sessionTailBannerModel 也消费同一个值），改成结构化要牵动两端
 * 投影协议。PR #790 的 Codex `Reconnecting... N/M` 是同款处理，这里保持一致。
 *
 * 原始错误原文保留在前面：日志与非 renderer 消费方要看到上游到底说了什么，
 * renderer 侧也沿用"友好文案 + 原始错误折叠可查"的既有做法。
 */
const OVERLOAD_RETRY_PROGRESS_RE = /\(auto-retry\s+(\d+)\s*\/\s*(\d+)\)\s*$/;

/** 给过载错误原文追加重投进度后缀。 */
export function formatOverloadRetryMessage(
  message: string,
  attempt: number,
  maxAttempts: number,
): string {
  return `${message} (auto-retry ${attempt}/${maxAttempts})`;
}

/**
 * 解析重投进度后缀。没有后缀（例如退避耗尽后的终止错误，或上游原样报错）
 * 返回 null——调用方据此区分"正在重试"与"已经放弃"。
 */
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

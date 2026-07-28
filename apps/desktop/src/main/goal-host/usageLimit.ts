/**
 * 账号用量受限识别 —— 纯函数,零依赖,可独立单测。
 *
 * 被动检测:goal turn 以 error 收尾时,判断该错误是不是"账号/套餐限流"(rate limit /
 * quota),从而把状态置 `usageLimited`(可恢复、到点自动续)而非 `blocked`(真出错)。
 *
 * 两个 agent 的错误形状不同(见 maker-core translator):
 *  - Claude Code:error 事件带结构化 `data.sdkError`,限流时 = `'rate_limit'`。
 *    注意 `billing_error`(余额耗尽、无周期重置)**不算** usage limit —— 那是"去充值",
 *    保持 blocked 更合适。
 *  - Codex:error 事件只有 `data.message` 文本,限流靠文本匹配(无结构化 tag)。
 */

/** turn error 的 data 是否表示"账号用量/限流"。 */
export function classifyTurnUsageLimit(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const d = data as {
    sdkError?: unknown;
    message?: unknown;
    errorStatus?: unknown;
    usageLimit?: unknown;
  };
  // Claude:结构化 tag(权威)。
  if (d.sdkError === 'rate_limit') return true;
  if (d.usageLimit === true) return true;
  if (d.errorStatus === 429 || d.errorStatus === 529) return true;
  // Codex / 兜底:文本匹配。
  const msg = typeof d.message === 'string' ? d.message : '';
  return /rate.?limit|usage.?limit|quota|too\s*many\s*requests/i.test(msg);
}

/**
 * turn error 的 data 是否表示"上游模型服务没有可用容量"(Codex 的
 * `Selected model is at capacity` / Anthropic 的 529 overloaded)。
 *
 * **为什么要和 usage limit 分开**:两者都是可恢复的非终态,但恢复时机差几个数量级
 * ——限额要等账号周期重置(小时级,resetAt 由账号快照给),容量抖动通常几十秒就好。
 * 混在一起会各错一边:
 *  - 容量问题走限额通道时,`getAccountLimit` 根本不会报 limited → 拿不到 resetAt →
 *    目标停在 usageLimited 永远不自动续,只能手动 resume(529 此前正是这个下场);
 *  - 而 Codex 的 `at capacity` 连 usage limit 都匹配不上,直接被判 blocked。
 *
 * 判定与 maker-core 的 shared/overload-error.ts 语义一致(那份决定 agent 侧是否
 * 退避重投)。跨进程边界不共享代码,与本文件既有的 usage limit 判定同款惯例。
 */
export function classifyTurnOverload(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const d = data as { message?: unknown; errorStatus?: unknown };
  if (d.errorStatus === 529) return true;
  const msg = typeof d.message === 'string' ? d.message : '';
  // `at capacity` 要求精确短语,避免误伤业务文案里的 capacity(缓存/队列容量)。
  return /\bat capacity\b/i.test(msg) || /\boverloaded_error\b/.test(msg);
}

/**
 * 过载后自动续跑的等待窗口。
 *
 * agent 侧已经就地退避重投过(Codex 约 30 秒预算,Claude 由 SDK 负责),走到这里
 * 说明那一轮没扛过去。再等 1 分钟给第二次机会:容量抖动多数已恢复,区域性故障则
 * 由目标自身的 maxTurns 兜底止损——每次续跑照常计一轮,不会无限重试。
 */
export const OVERLOAD_RESUME_DELAY_MS = 60_000;

/**
 * 连续多少轮过载后停止自动续跑,转 blocked 交回用户。
 *
 * **不能依赖既有的三道预算护栏**:budgetTokens / maxTurns / noProgressLimit 各自
 * 只在用户设了对应上限时生效,而过载轮不产出 token、也不推进 noProgressStreak——
 * 没设上限的目标会每分钟续一轮直到天荒地老。3 轮 ≈ 3 分钟、约 15 次上游请求
 * (每轮含 agent 侧的 1 次投递 + 最多 4 次退避重投),足够穿过短时抖动;真正的
 * 区域性容量故障(2026-06-16 那次持续数十分钟)本就不该靠客户端硬扛。
 */
export const MAX_CONSECUTIVE_OVERLOAD_TURNS = 3;

/**
 * 过载置 usageLimited 时写入的 lastReason。
 *
 * 到点自动续跑要靠它区分「上游没容量」与「账号真限流」——两者共用同一个
 * usageLimited 状态与同一个 timer，但给用户的说法必须不同：账号从没被限流时
 * 报「额度已重置」是假信息。内存里的连续过载计数在进程重启后会丢，存档里的
 * lastReason 不会，所以判据以它为准。
 */
export const OVERLOAD_LAST_REASON = 'model service at capacity';

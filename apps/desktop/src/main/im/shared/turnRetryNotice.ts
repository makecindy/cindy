/**
 * main/im/shared/turnRetryNotice.ts
 * ---------------------------------------------------------------------------
 * 把「agent 正在自动重试」这类**非终止** error 事件翻成一行渠道可读的状态说明,
 * 供 Slack / Telegram hook 与飞书 / Discord 的进度区共用。
 *
 * 为什么需要它: 上游过载(Codex 的 `Selected model is at capacity` / Anthropic
 * 529)现在会被自动退避重试 —— Codex 由 maker-core 接管重投, Claude 由 SDK 自己
 * 重试, 两者都以 `isTerminal:false, willRetry:true` 的 error 事件透出进度
 * (见 maker-core 的 agents/shared/overload-error.ts)。桌面端 ErrorBanner 会显示
 * 「模型服务繁忙, 正在自动重试」, 但渠道侧此前对非终止 error 一律静默:
 *
 *   - hook 的进度快照只由 text / thinking / tool_use 事件驱动;
 *   - IM turnRunner 的 error 分支对非终止 error 直接 return。
 *
 * 而过载重投**只在本 turn 零产出时**发生(maker-core 的
 * currentTurnProducedOutput 守卫), 于是那段退避窗口(交互式约 22-38s)里过程区
 * 与正文都是空的, 渠道那条占位消息一个字都不变 —— 用户看到的就是"卡死了"。
 *
 * 只认已有本地化契约的过载、终态 429 外层重投与 Auto 档审阅器不可用；其它非终止
 * error(普通 429 / 5xx / 网络重连等)保持既有静默行为:
 * 它们的 message 是内部英文串, 渠道侧没有对应的中文表达, 贸然透出等于把裸英文
 * 推给用户(这也是 maker-core 侧 claude translator 只透过载类的同一条理由)。
 * 将来要放开某一类, 在这里按 kind 补一条文案即可, 不要直接外发原文。
 *
 * 文案硬编码中文, 与 hook-control/interactions.ts 的卡片按钮、dispatcher.ts 的
 * NOTICE_* 同规 —— 渠道侧文案不进 renderer 的 locale 文件
 * (见 docs/dev-rules/engineering-conventions.md §5)。
 */

import {
  isAutoReviewUnavailableNotice,
  parseOverloadError,
  parseOverloadRetryProgress,
  parseTerminalRateLimitRetryProgress,
} from '@cindy/maker-core';

/**
 * Auto 档「自动审批不可用」-> 渠道说明。
 *
 * 这不是自动重试,但同样是**非终止** error 携带的会话级状态,渠道侧此前对非终止 error
 * 一律静默 —— 于是 Slack / Telegram 上的用户只会看到工具一个接一个被拒、没有任何原因
 * (codex P1 of #1574)。它有明确的用户动作可给(切到默认权限自己确认),所以必须透出。
 *
 * 判据走 maker-core 的单点函数,不在这里匹配英文原文或自己拼 `[CODE]` 前缀;文案硬编码
 * 中文、不进 renderer locale(与本文件其它渠道文案同规)。
 */
function autoReviewUnavailableNotice(message: string): string | null {
  return isAutoReviewUnavailableNotice(message)
    ? '自动审批暂时无法给出判断（网络或服务波动），需要审批的操作已转由你来确认。'
      + '想少被打断，可以把这个任务切到「默认权限」自行掌控。'
    : null;
}

/** 已知的非终止自动重试事件 -> 渠道侧本地化进度；其它错误保持静默。 */
export function turnRetryNotice(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as { message?: unknown; reason?: unknown };
  const message = typeof record.message === 'string' ? record.message : '';
  const reason = typeof record.reason === 'string' ? record.reason : undefined;
  const autoReviewNotice = autoReviewUnavailableNotice(message);
  if (autoReviewNotice) return autoReviewNotice;
  const rateLimitProgress = parseTerminalRateLimitRetryProgress(message, reason);
  if (rateLimitProgress) {
    return `请求受到限流，正在自动重试（${rateLimitProgress.attempt}/${rateLimitProgress.maxAttempts}）…`;
  }
  return overloadRetryNotice(data);
}

/**
 * 非终止 error 事件的 data -> 状态说明文案; 不是"正在自动重试的过载错误"时返回
 * null(调用方保持原有静默)。
 *
 * 调用方必须**先**用 isTerminalAgentErrorEvent 排除终止型错误: 退避耗尽后的终止
 * error 文案一样命中过载判定, 但那时该走失败收口, 不是"正在重试"。
 */
export function overloadRetryNotice(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as { message?: unknown; errorStatus?: unknown; codexErrorInfo?: unknown };
  const message = typeof record.message === 'string' ? record.message : '';
  const errorStatus = typeof record.errorStatus === 'number' ? record.errorStatus : undefined;
  // 结构化 tag 一并取: codex 改过载文案后, 只认文案会让整段退避窗口(约 22-38s)在
  // 渠道侧重新变回"一个字都不动", 也就是本文件开头描述的那个"卡死了"观感复发。
  const codexErrorInfo =
    typeof record.codexErrorInfo === 'string' ? record.codexErrorInfo : undefined;
  // 空 payload 守卫也要算上 tag, 否则「无 message + 只有结构化 tag」会被提前挡掉。
  if (message.length === 0 && errorStatus === undefined && codexErrorInfo === undefined) return null;
  if (parseOverloadError(message, errorStatus, codexErrorInfo) === null) return null;
  const progress = parseOverloadRetryProgress(message);
  // 次数缺省(上游没带 attempt/max_retries)时不编造分母, 只说明正在重试。
  return progress
    ? `模型服务繁忙，正在自动重试（${progress.attempt}/${progress.maxAttempts}）…`
    : '模型服务繁忙，正在自动重试…';
}

/**
 * 终止型过载错误 -> 渠道可读的失败说明; 非过载错误返回 null(调用方沿用原文)。
 *
 * 渠道侧与桌面端的处境不同: 桌面端 ErrorBanner 上有「重试」按钮, 而**桌面端点
 * 重试起的是一个新 turn, 结果不会回流到渠道**(渠道消息以 turn 的 requestId 为
 * 键, 那一轮已经收口)。所以这里必须把"在原渠道重发这条消息"说出来 —— 否则用户
 * 在桌面端点了重试、任务确实在跑, 但渠道那条消息永远停在失败上, 只能干等。
 */
export function overloadFailureNotice(
  message: string,
  errorStatus?: number,
  codexErrorInfo?: string,
): string | null {
  if (parseOverloadError(message, errorStatus, codexErrorInfo) === null) return null;
  // 刻意**不**声称"自动重试多次后仍未成功": 走到终态的原因不止预算耗尽, 还包括
  // "本 turn 已有产出所以不重投"(maker-core 的 currentTurnProducedOutput 守卫)与接管
  // 条件不满足, 那些情况下一次自动重试都没发生过(review #844 codex P1)。真重试过时
  // 用户已经在退避窗口里看过「正在自动重试（N/M）」那一行, 终态只需要给下一步。
  // 与桌面端 ErrorBanner 的 overloadBusy 文案同口径。
  return (
    '⚠️ 模型服务繁忙：上游暂时没有可用容量。' +
    '请直接在这里重发这条消息重试，或在 Cindy 里换一个模型。' +
    '（在桌面端点「重试」也能继续任务，但结果不会回到这条消息里。）'
  );
}

/**
 * 终态 error 事件的 data -> 渠道要展示的失败文案: 过载类换成上面那条可操作说明,
 * 其它错误沿用上游原文。
 *
 * 单独抽出来是因为渠道侧有**两条**终态收口路径 —— 用户 turn 的 handleTurnErrorAsync
 * 与调度转播的 finalizeTranspond。此前只有前者做了映射, 定时任务的卡片在重试耗尽
 * 时仍会从本地化进度突然跳回 `Selected model is at capacity...`(review #844 codex
 * P1)。两边共用本函数, 顺带保证 errorStatus(Anthropic 529 只有状态码、message 里
 * 不一定带 529)不被丢掉。
 */
export function terminalErrorText(data: unknown): string {
  const record =
    data && typeof data === 'object'
      ? (data as { message?: unknown; errorStatus?: unknown; codexErrorInfo?: unknown })
      : null;
  // 判**值**而不是判 key 是否存在: 上游 payload 带一个 message: undefined 时, 'in' 判定
  // 会成立并 String(undefined) 出字面量 "undefined" 给用户看, 同时让过载文案映射取决于这个
  // 意外字符串而不是真实内容(copilot 低置信提示)。null / undefined 一律退回 String(data)。
  const message =
    record?.message !== undefined && record.message !== null
      ? String(record.message)
      : String(data);
  const errorStatus = typeof record?.errorStatus === 'number' ? record.errorStatus : undefined;
  const codexErrorInfo =
    typeof record?.codexErrorInfo === 'string' ? record.codexErrorInfo : undefined;
  return overloadFailureNotice(message, errorStatus, codexErrorInfo) ?? message;
}

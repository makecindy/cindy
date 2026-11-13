import { parseOutputLimitDetails, isReasoningDominatedOutputLimit } from '@cindy/maker-shared';
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
 * 文案走 imText(`imBot.text.shared.*`), 跟随主人的 Cindy 界面语言, 发送时现取。
 */

import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import {
  isAutoReviewConfirmUndeliveredNotice,
  isAutoReviewUnavailableNotice,
  parseOverloadError,
  parseOverloadRetryProgress,
  parseTerminalRateLimitRetryProgress,
  parseToolLoopErrorDetails,
} from '@cindy/maker-core';

import { isQuotaExhaustedErrorMessage } from '../../../shared/providerErrors.js';
import { imText } from './imText';

/**
 * Auto 档「自动审批不可用」-> 渠道说明。
 *
 * 这不是自动重试,但同样是**非终止** error 携带的会话级状态,渠道侧此前对非终止 error
 * 一律静默 —— 于是 Slack / Telegram 上的用户只会看到工具一个接一个被拒、没有任何原因
 * (codex P1 of #1574)。少打断只能建议切到完全访问,不能建议默认权限:
 * 那一档在 Pi 上问得更多,在 Claude / Codex 上也不会少问联网和提权。完全访问风险更高,必须点明。
 * 个人微信每轮都挂逐条确认策略,三个 Harness 都不允许在该策略下使用完全访问;
 * 微信提示不建议切档,只要求直接确认。
 *
 * 判据走 maker-core 的单点函数,不在这里匹配英文原文或自己拼 `[CODE]` 前缀;文案与桌面端
 * 同名提示同句, 跟随界面语言。
 */
function autoReviewUnavailableNotice(message: string, channel?: string): string | null {
  if (isAutoReviewUnavailableNotice(message)) {
    return channel === 'wechat'
      ? imText('imBot.text.shared.retry.autoReviewUnavailableWechat')
      : imText('imBot.text.shared.retry.autoReviewUnavailable');
  }
  if (isAutoReviewConfirmUndeliveredNotice(message)) {
    return imText('imBot.text.shared.retry.autoReviewConfirmUndelivered');
  }
  return null;
}

/** 已知的非终止自动重试事件 -> 渠道侧本地化进度；其它错误保持静默。 */
export function turnRetryNotice(data: unknown, options?: { channel?: string }): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as { message?: unknown; reason?: unknown };
  const message = typeof record.message === 'string' ? record.message : '';
  const reason = typeof record.reason === 'string' ? record.reason : undefined;
  const autoReviewNotice = autoReviewUnavailableNotice(message, options?.channel);
  if (autoReviewNotice) return autoReviewNotice;
  const rateLimitProgress = parseTerminalRateLimitRetryProgress(message, reason);
  if (rateLimitProgress) {
    return imText('imBot.text.shared.retry.rateLimitRetrying', {
      attempt: rateLimitProgress.attempt,
      maxAttempts: rateLimitProgress.maxAttempts,
    });
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
    ? imText('imBot.text.shared.retry.overloadRetrying', {
      attempt: progress.attempt,
      maxAttempts: progress.maxAttempts,
    })
    : imText('imBot.text.shared.retry.overloadRetryingNoCount');
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
  return imText('imBot.text.shared.retry.overloadFailed');
}

/**
 * 终态 tool-loop 保护 -> 渠道可读的安全说明。
 *
 * maker-core 同时保留了稳定 reason 和受限 toolLoop 结构, 但 message 仍可能带有
 * `missing_required_field` 等内部分类。这里只根据白名单后的 kind/count 生成安全文案,
 * 绝不把原始 loopHint 外发。
 */
function toolLoopFailureNotice(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as { reason?: unknown; toolLoop?: unknown };
  if (record.reason !== 'tool_use_loop_detected') return null;

  const details = parseToolLoopErrorDetails(record.toolLoop);
  if (!details) {
    return imText('imBot.text.shared.toolLoop.generic');
  }

  // 次数取自循环检测阈值, 不会是 1, 所以用普通变量 n 而不走复数分支。
  switch (details.kind) {
    case 'consecutive':
      return imText('imBot.text.shared.toolLoop.consecutive', { n: details.count });
    case 'pingpong':
      return imText('imBot.text.shared.toolLoop.pingpong', { n: details.count });
    case 'rotation':
      return imText('imBot.text.shared.toolLoop.rotation', { n: details.count });
    case 'contract':
      return imText('imBot.text.shared.toolLoop.contract', { n: details.count });
  }
}

/**
 * 额度类失败说明的固定开头(当前界面语言)。hook 主日志只记失败类别(原文可能带用户内容),
 * dispatcher 据此把这类失败记成 provider-quota-exhausted, 而不是 unclassified。
 */
export function quotaFailureNoticePrefix(): string {
  return imText('imBot.text.shared.quota.prefix');
}

const SPEND_CAP_RE = /\bspend(?:ing)?[-_ ]?cap\b/i;
const USAGE_LIMIT_RE = /\busage\s+limit\b/i;

function terminalErrorRecord(data: unknown): {
  message: string;
  errorStatus?: number;
  codexErrorInfo?: string;
  sdkError?: string;
  reason?: string;
} {
  const record =
    data && typeof data === 'object'
      ? (data as {
          message?: unknown;
          errorStatus?: unknown;
          codexErrorInfo?: unknown;
          sdkError?: unknown;
          reason?: unknown;
        })
      : null;
  // 判**值**而不是判 key 是否存在: 上游 payload 带一个 message: undefined 时, 'in' 判定
  // 会成立并 String(undefined) 出字面量 "undefined" 给用户看, 同时让过载文案映射取决于这个
  // 意外字符串而不是真实内容(copilot 低置信提示)。null / undefined 一律退回 String(data)。
  const message =
    record?.message !== undefined && record.message !== null
      ? String(record.message)
      : String(data);
  return {
    message,
    ...(typeof record?.errorStatus === 'number' ? { errorStatus: record.errorStatus } : {}),
    ...(typeof record?.codexErrorInfo === 'string' ? { codexErrorInfo: record.codexErrorInfo } : {}),
    ...(typeof record?.sdkError === 'string' ? { sdkError: record.sdkError } : {}),
    ...(typeof record?.reason === 'string' ? { reason: record.reason } : {}),
  };
}

/**
 * 终态错误是不是「供应商账号的额度 / 花费上限 / 余额用完了」。
 *
 * 文案判据复用 shared 的 `isQuotaExhaustedErrorMessage`(桌面错误横幅同一份, 底层是 Codex
 * 终态重投、伙伴候选恢复共用的 maker-shared 判定), 只额外认上游给出的结构化信号, 不在
 * 这里另写一套措辞表。普通 429 限流不算 —— 那类错误等一会儿就好, 换供应商不是正确出口。
 */
export function isQuotaExhaustionFailure(data: unknown): boolean {
  if (data === null || data === undefined) return false;
  const e = terminalErrorRecord(data);
  if (e.reason === 'provider_quota_limit') return true;
  if (e.sdkError === 'billing_error') return true;
  if (e.codexErrorInfo === 'usageLimitExceeded') return true;
  if (e.errorStatus === 402) return true;
  return isQuotaExhaustedErrorMessage(e.message);
}

/** IM 失败说明只定位当前 bot / 任务 / 路由，并给当前任务的恢复动作。 */
export interface QuotaFailureNoticeOptions {
  providerLabel?: string | null;
  modelLabel?: string;
  taskLabel?: string;
  botLabel?: string;
  surface: 'personal' | 'official';
  /** 只有个人富卡渠道的 /model 改当前任务；官方的 /model 改目录默认。 */
  supportsModelCommand?: boolean;
}

function quotaRecoveryHint(options: QuotaFailureNoticeOptions): string {
  return options.surface === 'personal' && options.supportsModelCommand
    ? imText('imBot.text.shared.quota.recoveryModelCommand')
    : imText('imBot.text.shared.quota.recoveryOpenTask');
}

export function quotaFailureNotice(
  data: unknown,
  options: QuotaFailureNoticeOptions,
): string | null {
  if (!isQuotaExhaustionFailure(data)) return null;
  const { message, codexErrorInfo } = terminalErrorRecord(data);
  const headlineKey = SPEND_CAP_RE.test(message)
    ? 'imBot.text.shared.quota.headlineSpendCap'
    : codexErrorInfo === 'usageLimitExceeded' || USAGE_LIMIT_RE.test(message)
      ? 'imBot.text.shared.quota.headlineUsageLimit'
      : 'imBot.text.shared.quota.headlineBalance';
  const display = (value: string | null | undefined): string =>
    redactSensitiveText(value?.replace(/\s+/g, ' ').trim() ?? '').slice(0, 100);
  const label = display(options.providerLabel);
  const who = label
    ? imText('imBot.text.shared.quota.namedProvider', { name: label })
    : imText('imBot.text.shared.quota.currentProvider');
  const bot = display(options.botLabel) || imText(options.surface === 'official'
    ? 'imBot.text.shared.quota.officialBot'
    : 'imBot.text.shared.quota.personalBot');
  return [
    imText(headlineKey, { prefix: quotaFailureNoticePrefix(), who }),
    options.modelLabel
      ? imText('imBot.text.shared.quota.sourceWithModel', { bot, model: display(options.modelLabel) })
      : imText('imBot.text.shared.quota.source', { bot }),
    ...(options.taskLabel ? [imText('imBot.text.shared.quota.task', { task: display(options.taskLabel) })] : []),
    ...(SPEND_CAP_RE.test(message) ? [imText('imBot.text.shared.quota.spendCapHint')] : []),
    quotaRecoveryHint(options),
  ].join('\n');
}

/**
 * 终态 error 事件的 data -> 渠道要展示的失败文案: 已知 reason 与过载类使用可操作说明,
 * 其它错误沿用上游原文。额度指引须由 IM 调用方显式传入入口选项，避免定时任务的
 * 运行记录与通知误用 bot 命令和设置路径。
 *
 * 单独抽出来是因为渠道侧有**两条**终态收口路径 —— 用户 turn 的 handleTurnErrorAsync
 * 与调度转播的 finalizeTranspond。此前只有前者做了映射, 定时任务的卡片在重试耗尽
 * 时仍会从本地化进度突然跳回 `Selected model is at capacity...`(review #844 codex
 * P1)。两边共用本函数, 顺带保证 errorStatus(Anthropic 529 只有状态码、message 里
 * 不一定带 529)不被丢掉。
 */
export function terminalErrorText(data: unknown, options?: QuotaFailureNoticeOptions): string {
  if (data && typeof data === 'object' && 'reason' in data && data.reason === 'output-limit') {
    const details = parseOutputLimitDetails((data as { outputLimit?: unknown }).outputLimit);
    const usage = details
      ? details.reasoningTokens === undefined
        ? imText('imBot.text.shared.outputLimit.usage', { outputTokens: details.outputTokens })
        : imText('imBot.text.shared.outputLimit.usageWithReasoning', {
          outputTokens: details.outputTokens,
          reasoningTokens: details.reasoningTokens,
        })
      : '';
    const guidance = details && isReasoningDominatedOutputLimit(details)
      ? imText('imBot.text.shared.outputLimit.reasoningDominated')
      : imText('imBot.text.shared.outputLimit.generic');
    // 句间是否留空格随语言而定(中日文不留), 由 join 文案决定。
    return usage ? imText('imBot.text.shared.outputLimit.join', { usage, guidance }) : guidance;
  }
  if (data && typeof data === 'object' && 'reason' in data && data.reason === 'silent-stop-exhausted') {
    return imText('imBot.text.shared.outputLimit.silentStopExhausted');
  }
  const { message, errorStatus, codexErrorInfo } = terminalErrorRecord(data);
  return (
    toolLoopFailureNotice(data) ??
    overloadFailureNotice(message, errorStatus, codexErrorInfo) ??
    (options ? quotaFailureNotice(data, options) : null) ??
    message
  );
}

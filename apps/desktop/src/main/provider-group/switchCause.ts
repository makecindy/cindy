/**
 * 哪些失败会触发自动换电脑(docs/product-rules/provider-groups.md §6.1)：问题出在那台电脑或它的
 * 账号上才换；用户停止、权限被拒、上下文超限、请求无效、内容被拒、工具出错等换到哪台都一样，
 * 不换。这里只做白名单判定，认不出的一律不换。
 *
 * 走到这里的已是终态错误：偶发的网络 / 过载抖动先由中断自愈按现有规则重试，重试用尽才会到这里，
 * 对应「同一台连续失败才算」。
 */
import { classifyTurnOverload, classifyTurnUsageLimit } from '../goal-host/usageLimit.js';
import type { InterruptedTurnErrorSignals } from '../maker-ipc/interruptedTurnAutoResume.js';
import type { AutoResumeAgentSwitchCause } from '../../shared/agentInputQueue.js';
import { isBillingDepletionError } from '../../shared/usageLimitRecovery.js';

/**
 * - usage-limit：用量上限、额度或余额用完、请求频率限制；
 * - auth：那台电脑的供应商登录失效、被拒绝或被停用；
 * - unavailable：那台电脑离线、不可达、关闭了远程调用、分享被暂停或删除，或 Agent 没能启动；
 * - overload：供应商服务过载，现有重试用尽。
 */
export type ProviderGroupSwitchCause = AutoResumeAgentSwitchCause;

const REMOTE_UNAVAILABLE = /\[REMOTE_AGENT_(?:UNAVAILABLE|PROVIDER_NOT_ALLOWED|DEVICE_UNREACHABLE|MODEL_UNAVAILABLE|SHARE_PAUSED|SHARE_REMOVED|SHARE_UNAVAILABLE|ACCOUNT_CHANGED|EXPIRED|PEER_TOO_OLD|BUSY|NOT_FOUND)\]/;
const AUTH_TEXT = /\b(?:authentication[_ ](?:failed|error)|invalid[_ -]?(?:x-)?api[_ -]?key|unauthorized|not logged in|login (?:has )?expired|oauth token (?:has )?expired|token (?:has been )?revoked)\b/i;

export function classifyProviderGroupSwitchCause(
  signals: InterruptedTurnErrorSignals | null | undefined,
): ProviderGroupSwitchCause | null {
  if (!signals) return null;
  const message = typeof signals.message === 'string' ? signals.message : '';
  if (signals.reason === 'remote_agent_closed' || REMOTE_UNAVAILABLE.test(message)) return 'unavailable';
  if (classifyTurnOverload(signals)) return 'overload';
  if (isBillingDepletionError(signals) || classifyTurnUsageLimit(signals)) return 'usage-limit';
  if (
    signals.sdkError === 'authentication_failed'
    || signals.codexErrorInfo === 'unauthorized'
    || signals.errorStatus === 401
    || AUTH_TEXT.test(message)
  ) {
    return 'auth';
  }
  return null;
}

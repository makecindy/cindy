/**
 * 供应商组「这次失败怎么办」的唯一判定(docs/product-rules/provider-groups.md §6.1「怎么判断换不换」)。
 *
 * 所有路径都问这里：新任务启动失败、运行中的终态错误、发送前与换电脑途中换不过去、组所在电脑替分享的人中转时
 * 组内电脑的失败、协同 Worker。路径只负责「拿到这次失败」与「执行决定」，不再各自判断换不换、等不等、记不记进组。
 *
 * 默认换(2026-10-11 用户确认：出问题就换，除非换到哪台都一样)。不换的只有：
 * - 换到哪台都一样：上下文或输出超出上限、请求本身无效、内容被拒、工具循环被拦、权限确认被拒、本机准入(模型停用等)；
 * - 不是那台电脑的问题：本机主动关掉了会话、用户已经接手、任务此刻的状态不允许(在运行、已删除等)。
 *
 * 换的时候再分两件事：
 * - `connection`：要不要先等那台恢复(连不上时)；
 * - `cool`：要不要记进组的状态——只有那台账号的问题(用量上限、登录失效、服务繁忙)记进去，使用方自己连不过去、
 *   那台 Agent 起不来等不记(2026-10-11 用户确认：组内状态以组所在电脑为准，使用方自己的问题不记进组)。
 *
 * 走到运行中这一步的已是终态错误：偶发的网络 / 过载抖动先由中断自愈在同一台重试，重试用尽才会到这里，
 * 对应「同一台连续失败才算」。
 */
import { SESSION_CLOSED_MID_TURN_MESSAGE } from '@cindy/maker-core';

import type { AutoResumeAgentSwitchCause, InterruptedTurnErrorSignals } from './failureSignals.js';
import type { ProviderGroupUsageLimit } from '../shared/providerGroup.js';
import { isBillingDepletionError } from '../shared/usageLimitRecovery.js';
import { classifyTurnOverload, classifyTurnUsageLimit } from './usageLimit.js';
import { isContextOverflowErrorData, isOversizedHistoryErrorData } from './errorClassifiers.js';

/**
 * - usage-limit：用量上限、额度或余额用完、请求频率限制；
 * - auth：那台电脑的供应商登录失效、被拒绝或被停用；
 * - overload：供应商服务过载，现有重试用尽；
 * - unavailable：那台电脑离线、不可达、关闭了远程调用、分享被暂停或删除、不提供这个模型；
 * - failed：那台出了别的问题(Agent 起不来、意外退出、服务报错且重试用尽等)。
 */
export type ProviderGroupFailureCause = AutoResumeAgentSwitchCause;

/**
 * 失败发生在哪一步：
 * - start：Agent 还没开始运行(打开任务、启动 Agent)；
 * - run：运行中的终态错误；
 * - target：换电脑时换不过去(要换过去的那台的问题，或任务此刻的状态不允许)。
 */
export type ProviderGroupFailurePhase = 'start' | 'run' | 'target';

/**
 * 和那台的连接：
 * - lost：只是连接断了(断线、对方 Cindy 重启后会话没了)：先等它恢复；现读第一次就连得上也算恢复，留在原电脑继续；
 * - check：可能连不上(离线、读取放弃、分享连不上)：现读一次，确实连不上才等；连得上说明问题不在连接，直接换。
 */
export type ProviderGroupFailureConnection = 'lost' | 'check';

export type ProviderGroupFailureDecision =
  | { action: 'stay'; why: ProviderGroupStayReason }
  | {
      action: 'switch';
      cause: ProviderGroupFailureCause;
      /** null = 问题不在连接，不等，直接换。 */
      connection: ProviderGroupFailureConnection | null;
      /** 记进组的状态(冷却那台)。 */
      cool: boolean;
    };

export type ProviderGroupStayReason =
  | 'no-signal'
  | 'context'
  | 'invalid-request'
  | 'policy'
  | 'tool-loop'
  | 'user'
  | 'local'
  | 'task-state'
  | 'group-unavailable';

/** 换电脑途中用户已接手：交接在改动之前停下(不是目标电脑的问题)。 */
export const PROVIDER_GROUP_SUPERSEDED_ERROR = 'provider group: superseded by user action';

/** 组里没有能接这个任务的电脑(本机任务的错误码，渲染端按 chat.remoteError 给文案)。 */
export const PROVIDER_GROUP_UNAVAILABLE_ERROR =
  '[REMOTE_AGENT_GROUP_UNAVAILABLE] no computer in the provider group can run this task right now';

/** Created before dispatch, from the group's verified quota result (not provider error text). */
export class ProviderGroupUsageLimitError extends Error {
  constructor(readonly limit: ProviderGroupUsageLimit) {
    super('[REMOTE_AGENT_GROUP_USAGE_LIMIT] usage_limit_reached: the available accounts for this model have reached their usage limit'
      + (limit.resetAtMs === null ? '' : `; resets_at: ${limit.resetAtMs}`));
  }
}

export function providerGroupUnavailableError(pick: { usageLimit?: ProviderGroupUsageLimit }): Error {
  return pick.usageLimit ? new ProviderGroupUsageLimitError(pick.usageLimit) : new Error(PROVIDER_GROUP_UNAVAILABLE_ERROR);
}

/** 远程 Agent 任务结束时本机给的 reason(remote-agent/controller/proxyHandle)：lost = 连续拉不到那台，closed = 那台那边结束了。 */
const REMOTE_AGENT_LOST_REASON = 'remote_agent_lost';
const REMOTE_AGENT_CLOSED_REASON = 'remote_agent_closed';

/** 只说明连接断了：那台本身没问题(断线、对方 Cindy 重启后会话没了)。 */
const CONNECTION_LOST_CODES = new Set(['REMOTE_AGENT_DEVICE_UNREACHABLE', 'REMOTE_AGENT_EXPIRED', 'REMOTE_AGENT_NOT_FOUND']);
/** 可能连不上：现读一次再说。 */
const CONNECTION_CHECK_CODES = new Set([
  'REMOTE_AGENT_UNAVAILABLE',
  'REMOTE_AGENT_SHARE_UNAVAILABLE',
  'REMOTE_AGENT_BUSY',
  'DEVICE_LINK_DEVICE_OFFLINE',
  'DEVICE_OFFLINE',
  'NOT_CONNECTED',
  'PEER_RESET',
  'LINK_CLOSED',
  'LINK_NOT_OPEN',
  'TIMEOUT',
  'INVOKE_TIMEOUT',
]);
/** 那台本身现在不能接这个任务(不是连接的问题)：直接换。 */
const MEMBER_UNAVAILABLE_CODES = new Set([
  'REMOTE_AGENT_PROVIDER_NOT_ALLOWED',
  // 分享来的那台的主人没同意这个受邀者经组使用(转分享)：换组里别的电脑。
  'REMOTE_AGENT_RESHARE_NOT_ALLOWED',
  'REMOTE_AGENT_MODEL_UNAVAILABLE',
  'REMOTE_AGENT_SHARE_PAUSED',
  'REMOTE_AGENT_SHARE_REMOVED',
  'REMOTE_AGENT_ACCOUNT_CHANGED',
  'REMOTE_AGENT_PEER_TOO_OLD',
  'REMOTE_AGENT_UNSUPPORTED',
  'ACCESS_REVOKED',
  'REMOTE_DISABLED',
  'CHANNEL_NOT_ALLOWED',
]);

/** 本机记下的、换到哪台都一样或与那台无关的 reason(translator / Cindy 自己给出的稳定 key)。 */
const STAY_REASONS: ReadonlyMap<string, ProviderGroupStayReason> = new Map([
  ['context-overflow', 'context'],
  ['codex_history_oversized', 'context'],
  ['output-limit', 'context'],
  ['tool_use_loop_detected', 'tool-loop'],
  ['user-denied', 'user'],
  ['user_rejected', 'user'],
  ['user-revoked', 'user'],
  ['cancelled-before-dispatch', 'user'],
  ['turn_continuation_cancelled', 'user'],
  ['permission-tighten-interrupt-failed', 'local'],
  ['approved-skill-snapshot-failed', 'local'],
  ['approved-repo-root-changed', 'local'],
  ['approval-working-dir-mismatch', 'local'],
  ['approval-resolver-unavailable', 'local'],
  ['runtime-skills-missing', 'local'],
]);

/** Codex 结构化错误里换到哪台都一样的(上下文、请求无效、内容策略、本机沙箱)。 */
const STAY_CODEX_ERRORS: ReadonlyMap<string, ProviderGroupStayReason> = new Map([
  ['contextWindowExceeded', 'context'],
  ['badRequest', 'invalid-request'],
  ['cyberPolicy', 'policy'],
  ['sandboxError', 'local'],
]);

/** 用户在权限确认里拒绝了、取消了：换到哪台都一样。 */
const USER_DECISION_TEXT = /\b(?:permission denied by (?:the )?user|user (?:denied|rejected|declined) (?:the )?(?:permission|request|tool))\b/i;
/** 工具本身执行出错、任务所在电脑上的工作目录不在了(文件和命令都在任务所在电脑，换 Agent 所在电脑也一样)。 */
const TOOL_FAILURE_TEXT = /\btool (?:execution|call) failed\b|\bworking directory is missing\b/i;
const AUTH_TEXT = /\b(?:authentication[_ ](?:failed|error)|invalid[_ -]?(?:x-)?api[_ -]?key|unauthorized|not (?:logged in|authenticated)|login (?:has )?expired|oauth token (?:has )?expired|token (?:has been )?revoked)\b/i;
/** 开头的错误码，如 `[REMOTE_AGENT_UNAVAILABLE] …`、`[SESSION_RUNNING] …`。 */
const LEADING_CODE = /^\s*\[([A-Z][A-Z0-9_]+)\]/;
/** 消息里任意位置的远程错误码(包装过的错误可能把它放在中间)。 */
const REMOTE_CODE = /\[(REMOTE_AGENT_[A-Z_]+)\]/;
/** 任务此刻的状态不允许(在运行、已删除、参数不对等)：Cindy 自己的错误码，与那台电脑无关。 */
const TASK_STATE_CODES = new Set([
  'SESSION_RUNNING',
  'NOT_FOUND',
  'INVALID_PARAMS',
  'UNSUPPORTED_CAPABILITY',
  'PRECONDITION_FAILED',
  'SEND_CANCELLED_BEFORE_DISPATCH',
  'OWNER_CHANGED',
  'ACCOUNT_BOUNDARY',
  'WORKDIR_MISSING',
]);

/** 发送失败的展示文案带一层宿主错误码前缀(`LAZY_CREATE_FAILED: …`)，判定看里面那层。 */
const HOST_SEND_PREFIX = /^\s*[A-Z][A-Z0-9_]+:\s+/;

function errorCodeOf(message: string): string | null {
  const inner = message.replace(HOST_SEND_PREFIX, '');
  return REMOTE_CODE.exec(inner)?.[1] ?? LEADING_CODE.exec(inner)?.[1] ?? null;
}

/** 把任意失败(终态错误的字段、启动或换电脑时抛出的错误)整理成判定用的字段。 */
export function providerGroupFailureSignals(error: unknown): InterruptedTurnErrorSignals {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const message = error.message || (typeof code === 'string' ? `[${code}]` : '');
    return { message };
  }
  if (typeof error === 'string') return { message: error };
  if (error && typeof error === 'object') return error as InterruptedTurnErrorSignals;
  return {};
}

const switchTo = (
  cause: ProviderGroupFailureCause,
  connection: ProviderGroupFailureConnection | null,
): ProviderGroupFailureDecision => ({
  action: 'switch',
  cause,
  connection,
  cool: cause === 'usage-limit' || cause === 'auth' || cause === 'overload',
});

/**
 * 这次失败怎么办。`phase` 只影响一件事：启动与换过去这两步里，Cindy 自己的错误码(任务在运行、已删除、模型停用等)
 * 说明问题在本机这边，不换；运行中的终态错误不带这类错误码。
 */
export function decideProviderGroupFailure(
  signals: InterruptedTurnErrorSignals | null | undefined,
  phase: ProviderGroupFailurePhase,
): ProviderGroupFailureDecision {
  if (!signals) return { action: 'stay', why: 'no-signal' };
  const message = typeof signals.message === 'string' ? signals.message : '';
  const reason = typeof signals.reason === 'string' ? signals.reason : '';
  if (!message && !reason && !signals.sdkError && signals.errorStatus === undefined
    && !signals.usageLimit && !signals.codexErrorInfo) {
    return { action: 'stay', why: 'no-signal' };
  }

  // ── 不是那台电脑的问题 ──
  if (message === PROVIDER_GROUP_SUPERSEDED_ERROR) return { action: 'stay', why: 'user' };
  // 本机主动关掉了还在运行的会话(本机的操作，不是那台的问题)。
  if (message.startsWith(SESSION_CLOSED_MID_TURN_MESSAGE)) return { action: 'stay', why: 'local' };
  const code = errorCodeOf(message);
  if (code === 'REMOTE_AGENT_GROUP_UNAVAILABLE' || code === 'REMOTE_AGENT_GROUP_USAGE_LIMIT') return { action: 'stay', why: 'group-unavailable' };
  if (phase !== 'run' && code && TASK_STATE_CODES.has(code)) return { action: 'stay', why: 'task-state' };

  // ── 换到哪台都一样 ──
  const stayReason = STAY_REASONS.get(reason);
  if (stayReason) return { action: 'stay', why: stayReason };
  // Claude 的终态错误保留 SDK tag，不一定带 output-limit reason；输出上限换到哪台都一样。
  if (signals.sdkError === 'max_output_tokens') return { action: 'stay', why: 'context' };
  if (signals.toolLoop) return { action: 'stay', why: 'tool-loop' };
  if (USER_DECISION_TEXT.test(message)) return { action: 'stay', why: 'user' };
  if (TOOL_FAILURE_TEXT.test(message)) return { action: 'stay', why: 'local' };
  if (isContextOverflowErrorData(signals) || isOversizedHistoryErrorData(signals)) return { action: 'stay', why: 'context' };
  const codexStay = signals.codexErrorInfo ? STAY_CODEX_ERRORS.get(signals.codexErrorInfo) : undefined;
  if (codexStay) return { action: 'stay', why: codexStay };

  // ── 那台账号的问题：换，并记进组的状态 ──
  // 过载先于用量上限判(529 / serverOverloaded 也会被用量判定认作限流)：过载只短冷却，用量上限按重置时刻冷却。
  if (classifyTurnOverload(signals)) return switchTo('overload', null);
  if (isBillingDepletionError(signals) || classifyTurnUsageLimit(signals)) return switchTo('usage-limit', null);
  if (
    signals.sdkError === 'authentication_failed'
    || signals.codexErrorInfo === 'unauthorized'
    || signals.errorStatus === 401
    || AUTH_TEXT.test(message)
  ) {
    return switchTo('auth', null);
  }

  // 请求本身无效：换到哪台都一样(放在账号问题之后：429 / 401 有时也带 invalid_request 的外壳)。
  if (
    signals.sdkError === 'invalid_request'
    || signals.errorStatus === 400
    || signals.errorStatus === 413
    || signals.errorStatus === 422
  ) {
    return { action: 'stay', why: 'invalid-request' };
  }

  // ── 那台连不上或不能用 ──
  if (code && CONNECTION_LOST_CODES.has(code)) return switchTo('unavailable', 'lost');
  if (code && MEMBER_UNAVAILABLE_CODES.has(code)) return switchTo('unavailable', null);
  // 连续拉不到那台(remote-agent/controller/proxyHandle)：只说明连接断了。
  if (reason === REMOTE_AGENT_LOST_REASON) return switchTo('unavailable', 'lost');
  if ((code && CONNECTION_CHECK_CODES.has(code)) || reason === REMOTE_AGENT_CLOSED_REASON) return switchTo('unavailable', 'check');

  // ── 其余：那台出了别的问题，换 ──
  return switchTo('failed', null);
}

/** 运行中、启动阶段换下一台用的简写：不换返回 null。 */
export function providerGroupSwitchCause(
  signals: InterruptedTurnErrorSignals | null | undefined,
  phase: ProviderGroupFailurePhase,
): ProviderGroupFailureCause | null {
  const decision = decideProviderGroupFailure(signals, phase);
  return decision.action === 'switch' ? decision.cause : null;
}

/**
 * 决定日志用的摘要：只带错误码与结构化字段，不带错误原文(原文可能含对话内容)。
 */
export function describeProviderGroupFailure(
  signals: InterruptedTurnErrorSignals | null | undefined,
  decision: ProviderGroupFailureDecision,
): Record<string, unknown> {
  const message = typeof signals?.message === 'string' ? signals.message : '';
  return {
    action: decision.action,
    ...(decision.action === 'switch'
      ? { cause: decision.cause, ...(decision.connection ? { connection: decision.connection } : {}), cool: decision.cool }
      : { why: decision.why }),
    ...(errorCodeOf(message) ? { code: errorCodeOf(message) } : {}),
    ...(signals?.reason ? { reason: signals.reason } : {}),
    ...(signals?.sdkError ? { sdkError: signals.sdkError } : {}),
    ...(signals?.errorStatus !== undefined ? { errorStatus: signals.errorStatus } : {}),
    ...(signals?.codexErrorInfo ? { codexErrorInfo: signals.codexErrorInfo } : {}),
  };
}

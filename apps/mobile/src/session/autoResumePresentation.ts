import type { ContinuationInFlightProjectionCapability } from '@/session/types';

/** 对齐桌面 USAGE_LIMIT_RESET_AUTO_RESUME_REASON(apps/desktop/src/shared/agentInputQueue.ts)。 */
const USAGE_LIMIT_RESET_REASON = 'usage-limit-reset';

export type MobileAutoResumeAgentSwitchCause = 'usage-limit' | 'auth' | 'unavailable' | 'overload';

/** 对齐桌面 AutoResumeAgentSwitch:供应商组自动换电脑后继续。 */
export interface MobileAutoResumeAgentSwitch {
  from: string;
  to: string;
  cause: MobileAutoResumeAgentSwitchCause;
}

const AGENT_SWITCH_CAUSES: readonly MobileAutoResumeAgentSwitchCause[] = ['usage-limit', 'auth', 'unavailable', 'overload'];

function readAgentSwitch(value: unknown): MobileAutoResumeAgentSwitch | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { from, to, cause } = value as Record<string, unknown>;
  if (typeof from !== 'string' || !from || typeof to !== 'string' || !to) return undefined;
  if (!AGENT_SWITCH_CAUSES.includes(cause as MobileAutoResumeAgentSwitchCause)) return undefined;
  return { from: from.slice(0, 128), to: to.slice(0, 128), cause: cause as MobileAutoResumeAgentSwitchCause };
}

/** 对齐桌面 AutoResumeAgentReconnect:供应商组等原电脑恢复后在原电脑继续(读不到名称时为空)。 */
export interface MobileAutoResumeAgentReconnect {
  computer: string;
}

function readAgentReconnect(value: unknown): MobileAutoResumeAgentReconnect | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { computer } = value as Record<string, unknown>;
  return { computer: typeof computer === 'string' ? computer.slice(0, 128) : '' };
}

/** 对齐桌面 AutoResumeGroupSwitch:分享者的供应商组替分享的人换了一台电脑(不显示电脑名称)。 */
export interface MobileAutoResumeGroupSwitch {
  cause: MobileAutoResumeAgentSwitchCause;
}

function readGroupSwitch(value: unknown): MobileAutoResumeGroupSwitch | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { cause } = value as Record<string, unknown>;
  if (!AGENT_SWITCH_CAUSES.includes(cause as MobileAutoResumeAgentSwitchCause)) return undefined;
  return { cause: cause as MobileAutoResumeAgentSwitchCause };
}

export interface MobileAutoResumeInfo {
  /** 账号用量上限重置后自动继续(不是重连:不展示重试次数)。 */
  usageLimitReset?: boolean;
  /** 供应商组自动换电脑后继续(与 usageLimitReset 同时出现)。 */
  agentSwitch?: MobileAutoResumeAgentSwitch;
  /** 供应商组等原电脑恢复后在原电脑继续(与 usageLimitReset 同时出现)。 */
  agentReconnect?: MobileAutoResumeAgentReconnect;
  /** 分享的人这边的自动换电脑:活动行写「已自动换一台电脑继续」。 */
  groupSwitch?: MobileAutoResumeGroupSwitch;
  /** 进行中:供应商组正在为这次失败换电脑,错误先不呈现,写「正在换一台电脑继续」。 */
  groupSwitchPending?: MobileAutoResumeGroupSwitch;
  error?: string;
  attempt?: number;
  maxAttempts?: number;
  sessionTotal?: number;
  outcome?: 'succeeded' | 'failed';
}

export type MobileAutoResumeState = 'separator' | 'live' | 'succeeded' | 'failed' | 'neutral';

export interface MobileAutoResumePresentation {
  info: MobileAutoResumeInfo;
  state: MobileAutoResumeState;
  summary?: string;
  hasProgress: boolean;
  canExpand: boolean;
}

export function readMobileAutoResumeInfo(data?: Record<string, unknown>): MobileAutoResumeInfo {
  const number = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  const usageLimitReset = data?.reason === USAGE_LIMIT_RESET_REASON;
  const attempt = usageLimitReset ? undefined : number(data?.attempt);
  const maxAttempts = usageLimitReset ? undefined : number(data?.maxAttempts);
  const sessionTotal = usageLimitReset ? undefined : number(data?.sessionTotal);
  const agentSwitch = readAgentSwitch(data?.agentSwitch);
  const agentReconnect = readAgentReconnect(data?.agentReconnect);
  const groupSwitch = readGroupSwitch(data?.groupSwitch);
  const groupSwitchPending = readGroupSwitch(data?.groupSwitchPending);
  return {
    ...(usageLimitReset ? { usageLimitReset: true } : {}),
    ...(agentSwitch ? { agentSwitch } : {}),
    ...(agentReconnect ? { agentReconnect } : {}),
    ...(groupSwitch ? { groupSwitch } : {}),
    ...(groupSwitchPending ? { groupSwitchPending } : {}),
    // 正在换电脑时错误先不呈现:行内不带原始错误。
    ...(!groupSwitchPending && typeof data?.error === 'string' && data.error.trim()
      ? { error: data.error }
      : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(sessionTotal !== undefined ? { sessionTotal } : {}),
    ...(data?.outcome === 'succeeded' || data?.outcome === 'failed'
      ? { outcome: data.outcome }
      : {}),
  };
}

export function summarizeMobileInterruption(detail?: string): string | undefined {
  if (!detail) return undefined;
  const compact = detail
    .replace(/^\s*API Error:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!compact) return undefined;
  const firstSentence = compact.match(/^.*?[.。!?！？](?=\s|$)/)?.[0] ?? compact;
  return firstSentence.length > 72 ? `${firstSentence.slice(0, 71)}…` : firstSentence;
}

export function canExpandMobileAutoResume(info: MobileAutoResumeInfo): boolean {
  return Boolean(info.error) || (info.attempt !== undefined && info.maxAttempts !== undefined)
    || info.sessionTotal !== undefined;
}

export function getMobileAutoResumePresentation(
  data: Record<string, unknown> | undefined,
  inFlight = false,
): MobileAutoResumePresentation {
  const info = readMobileAutoResumeInfo(data);
  const hasProgress = info.attempt !== undefined && info.maxAttempts !== undefined;
  const hasInterruptionContext =
    info.usageLimitReset === true ||
    data?.live === true ||
    info.error !== undefined ||
    hasProgress ||
    info.sessionTotal !== undefined ||
    info.outcome !== undefined;

  if (!hasInterruptionContext) {
    return { info, state: 'separator', hasProgress, canExpand: false };
  }

  // A recorded terminal outcome wins over any stale live/in-flight signal.
  const state: MobileAutoResumeState = info.outcome
    ?? ((data?.live === true || inFlight) ? 'live' : 'neutral');
  const summary = summarizeMobileInterruption(info.error);
  return {
    info,
    state,
    ...(summary ? { summary } : {}),
    hasProgress,
    canExpand: canExpandMobileAutoResume(info),
  };
}

export function toggleMobileAutoResumeExpanded(expanded: boolean, canExpand: boolean): boolean {
  return canExpand ? !expanded : false;
}

/** Mirror Desktop's continuation-owner rule, including its explicit legacy fallback. */
export function isMobileAutoResumeRowInFlight(args: {
  isContinuationTurnOwner: boolean;
  makerTurnRunning: boolean;
  isLastUserInput: boolean;
  projectionCapability: ContinuationInFlightProjectionCapability;
}): boolean {
  return args.isContinuationTurnOwner || (
    args.projectionCapability === 'legacy' && args.makerTurnRunning && args.isLastUserInput
  );
}

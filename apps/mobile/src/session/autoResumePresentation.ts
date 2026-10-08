import type { ContinuationInFlightProjectionCapability } from '@/session/types';

/** 对齐桌面 USAGE_LIMIT_RESET_AUTO_RESUME_REASON(apps/desktop/src/shared/agentInputQueue.ts)。 */
const USAGE_LIMIT_RESET_REASON = 'usage-limit-reset';

export interface MobileAutoResumeInfo {
  /** 账号用量上限重置后自动继续(不是重连:不展示重试次数)。 */
  usageLimitReset?: boolean;
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
  return {
    ...(usageLimitReset ? { usageLimitReset: true } : {}),
    ...(typeof data?.error === 'string' && data.error.trim() ? { error: data.error } : {}),
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

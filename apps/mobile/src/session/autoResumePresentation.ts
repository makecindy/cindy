import {
  codexQuotaResumeKind,
  type CodexQuotaResumeKind,
} from '@cindy/maker-shared/synthetic-trigger';
import type { ContinuationInFlightProjectionCapability } from '@/session/types';

export interface MobileAutoResumeInfo {
  error?: string;
  attempt?: number;
  maxAttempts?: number;
  sessionTotal?: number;
  outcome?: 'succeeded' | 'failed';
  /** Codex 配额耗尽后的处理（检查配额 / 用了重置 / 配额已恢复），不是重连；没有重连次数可言。 */
  quotaKind?: CodexQuotaResumeKind;
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
  const quotaKind = codexQuotaResumeKind(data?.reason);
  const attempt = quotaKind ? undefined : number(data?.attempt);
  const maxAttempts = quotaKind ? undefined : number(data?.maxAttempts);
  const sessionTotal = quotaKind ? undefined : number(data?.sessionTotal);
  return {
    ...(quotaKind ? { quotaKind } : {}),
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
    data?.live === true ||
    info.quotaKind !== undefined ||
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

/** 续跑行文案 key（配额处理与重连各一套；检查配额只会出现在进行中）。 */
export function mobileAutoResumeLabelKey(
  quotaKind: CodexQuotaResumeKind | undefined,
  state: Exclude<MobileAutoResumeState, 'separator'>,
  hasProgress: boolean,
): string {
  const base = 'message.systemCard.autoResume.';
  if (quotaKind === 'checking' && state === 'live') return `${base}resetCreditChecking`;
  if (quotaKind === 'reset' || quotaKind === 'restored') {
    const prefix = quotaKind === 'reset' ? 'resetCredit' : 'quotaRestored';
    const suffix = { live: 'Pending', succeeded: 'Succeeded', failed: 'Failed', neutral: 'Neutral' }[state];
    return `${base}${prefix}${suffix}`;
  }
  if (state === 'live') return `${base}${hasProgress ? 'pendingWithProgress' : 'pending'}`;
  return `${base}${state}`;
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

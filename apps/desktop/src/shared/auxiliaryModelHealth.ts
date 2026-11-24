import type { DataOwnerPushStamp } from './dataOwnerPush';
import type { UtilityTextAttempt, UtilityTextAttemptReason } from './utilityTextResult';

export type AuxiliaryFailureReason = UtilityTextAttemptReason | 'permission_denied' | 'quota';
export function auxiliaryFailureReason(attempt?: UtilityTextAttempt): AuxiliaryFailureReason {
  if (!attempt) return 'request_failed';
  if (attempt.quotaExhausted) return 'quota';
  if (attempt.reason !== 'http_error') return attempt.reason;
  switch (attempt.httpStatus) {
    case 401: return 'not_authenticated';
    case 403: return 'permission_denied';
    case 404: return 'model_unavailable';
    case 405: return 'unsupported_transport';
    default: return 'http_error';
  }
}

/** Operation of this completed request. Only these host-defined labels may reach a conversation. */
export function auxiliaryNoticeOperation(source?: string, automaticTitle?: boolean) {
  switch (source) {
    case 'title': return automaticTitle ? 'auto-title' : 'title';
    case 'task-summary':
    case 'prompt-prediction':
    case 'working-status':
    case 'tool-loop-review':
      return source;
    default: return undefined;
  }
}

export type AuxiliaryNoticeOperation = NonNullable<ReturnType<typeof auxiliaryNoticeOperation>>;

export interface AuxiliaryDisplayError {
  reason: AuxiliaryFailureReason;
  httpStatus?: number;
  upstreamMessage?: string;
}

export interface AuxiliaryModelHealthSnapshot extends AuxiliaryDisplayError {
  ownerStamp: DataOwnerPushStamp;
  providerId: string;
  auxiliaryRef?: string;
  model: string;
  sessionId?: string;
  operation?: AuxiliaryNoticeOperation;
  noticeId?: number;
  status: 'monitoring' | 'warning' | 'isolated' | 'recovered';
  errorRevision?: number;
  lastErrorAt: number;
  failureCount: number;
  attemptCount: number;
  failureRate: number;
  switchedToBackup: boolean;
}

export type AuxiliaryModelHealthEvent = AuxiliaryModelHealthSnapshot & { notify?: boolean; removed?: boolean; conversationOnly?: boolean };
/**
 * Whether the auxiliary-model chain can currently run, as shown to the user.
 *
 * Auxiliary models power task titles, summaries, Help, plugin tasks such as
 * subtitle translation and more. When every candidate is unusable those
 * features silently degrade, so the app surfaces this state in Settings and
 * once as a notification (see docs/product-rules/auxiliary-model-health.md).
 */

/** Why one candidate of the chain cannot be used right now. */
export type AuxiliaryModelIssue =
  /** Cindy AI route while not signed in to Cindy. */
  | 'signed_out'
  /** The provider is turned off in Settings → Model providers. */
  | 'provider_disabled'
  /** The model itself is turned off for this provider. */
  | 'model_disabled'
  /** Cindy AI route that the current plan or balance does not cover. */
  | 'payment_required'
  /** Another provider without a usable sign-in or key. */
  | 'no_credential'
  /** No longer offered by the provider, or not routable for short text. */
  | 'unavailable';

export interface AuxiliaryModelHealthCandidate {
  ref: string;
  /** Model and provider name, already localized by the main process where possible. */
  label: string;
  issue: AuxiliaryModelIssue;
}

export type AuxiliaryModelHealth =
  | { status: 'ok' }
  | {
    status: 'unavailable';
    /** Settings make every candidate unusable; no request reached a model. */
    kind: 'config';
    candidates: AuxiliaryModelHealthCandidate[];
    /** Model plugin tasks are temporarily using instead, when one was chosen. */
    fallbackModel?: string;
    since: number;
  }
  | {
    status: 'unavailable';
    /** Candidates were usable but several consecutive requests all failed. */
    kind: 'runtime';
    fallbackModel?: string;
    since: number;
  };

/** Section name reused on the existing app-settings change push. */
export const AUXILIARY_MODEL_HEALTH_SECTION = 'auxiliary-model-health';

/** Settings route of the auxiliary-model section. */
export const AUXILIARY_MODEL_SETTINGS_PATH = '/settings?tab=personalization&section=personalization.auxiliaryModels';

/**
 * Identity of one problem for "notify once": the same problem with the same
 * causes is not announced again, a different cause or a recovery is.
 */
export function auxiliaryModelHealthFingerprint(health: AuxiliaryModelHealth): string | null {
  if (health.status === 'ok') return null;
  if (health.kind === 'runtime') return 'runtime';
  return `config:${health.candidates.map((candidate) => `${candidate.ref}=${candidate.issue}`).join('|')}`;
}

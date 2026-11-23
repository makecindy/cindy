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

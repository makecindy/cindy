import { parseAgentErrorCode } from '@cindy/maker-shared/error-redaction';
import { isQuotaExhaustedErrorMessage } from './providerErrors';

/** Public, bounded diagnostics: never forward upstream messages, URLs or identities to a guest. */
export const SHARED_TASK_RECOVERY_REASONS = [
  'offline', 'timeout', 'relay', 'denied', 'model', 'budget', 'capacity',
  'unsupported', 'authorization', 'history', 'policy', 'rate', 'service', 'unknown',
] as const;
export type SharedTaskRecoveryReason = typeof SHARED_TASK_RECOVERY_REASONS[number];
export type SharedTaskRecoveryStage = 'owner' | 'allocation' | 'executor' | 'capability' | 'authorization';

export function sharedTaskRecoveryReason(message: string): SharedTaskRecoveryReason | undefined {
  const reason = /\[SHARED_TASK_RECOVERY_([a-z]+)\]/.exec(message)?.[1];
  return SHARED_TASK_RECOVERY_REASONS.find(value => value === reason)
    ?? (message.includes('the computer holding this shared task is unavailable') ? 'unknown' : undefined);
}

export function sharedTaskRecoveryFor(message: string, agentDeviceId?: string | null): SharedTaskRecoveryReason | undefined {
  const detailed = sharedTaskRecoveryReason(message);
  if (detailed) return detailed;
  if (!agentDeviceId?.startsWith('share:')) return undefined;
  if (parseAgentErrorCode(message)?.code === 'REMOTE_AGENT_RESUME_UNAVAILABLE') return 'history';
  // These errors already explain model/member budget actions precisely.
  if (/\[REMOTE_AGENT_(?:GROUP_USAGE_LIMIT|MEMBER_BUDGET_PAUSED)\]/.test(message)) return undefined;
  if (isQuotaExhaustedErrorMessage(message)) return 'budget';
  // Only terminal remote-route failures. OAuth, input and model response errors
  // keep their existing recovery UI rather than suggesting a machine switch.
  if (!/\[(?:REMOTE_AGENT_(?:UNAVAILABLE|BUSY|PEER_TOO_OLD|GROUP_USAGE_LIMIT|MEMBER_BUDGET_PAUSED|PROVIDER_NOT_ALLOWED)|DEVICE_OFFLINE|TIMEOUT|INVOKE_TIMEOUT|NOT_CONNECTED|DEVICE_UNRESPONSIVE|ACCESS_REVOKED|REMOTE_DISABLED|LINK_CLOSED)\]/.test(message)) return undefined;
  return sharedTaskFailureReason(message);
}

export function sharedTaskFailureReason(error: unknown): SharedTaskRecoveryReason {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const explicit = (error as { code?: unknown } | null)?.code;
  // An authoritative transport denial outranks even an older diagnostic marker.
  if (['ACCESS_REVOKED', 'PERMISSION_DENIED', 'REMOTE_DISABLED', 'UNAUTHORIZED', 'REMOTE_AGENT_ACCOUNT_CHANGED'].includes(String(explicit))) return 'denied';
  const retained = sharedTaskRecoveryReason(message);
  if (retained) return retained;
  if (explicit === 'INSUFFICIENT_QUOTA' || isQuotaExhaustedErrorMessage(message)) return 'budget';
  const status = (error as { statusCode?: unknown; status?: unknown } | null)?.statusCode
    ?? (error as { status?: unknown } | null)?.status;
  if (status === 429) return 'rate';
  if (typeof status === 'number' && status >= 500 && status <= 599) return 'service';
  // remoteAgentLinkError adds a generic prefix but deliberately preserves the
  // real transport code. IPC_ERROR is only an envelope, not the failure cause.
  const code = explicit && explicit !== 'IPC_ERROR' && explicit !== 'REMOTE_AGENT_UNAVAILABLE'
    ? explicit : /\[([A-Z][A-Z_]+)\]/.exec(message)?.[1] ?? explicit;
  switch (code) {
    case 'DEVICE_OFFLINE': return 'offline';
    case 'TIMEOUT': case 'INVOKE_TIMEOUT': case 'DEVICE_UNRESPONSIVE': return 'timeout';
    case 'NOT_CONNECTED': case 'LINK_NOT_OPEN': case 'LINK_CLOSED': case 'PEER_RESET': return 'relay';
    case 'ACCESS_REVOKED': case 'PERMISSION_DENIED': case 'REMOTE_DISABLED': case 'UNAUTHORIZED': return 'denied';
    case 'REMOTE_AGENT_ACCOUNT_CHANGED': return 'denied';
    case 'RATE_LIMITED': case 'BACKPRESSURE': return 'rate';
    case 'NETWORK_ERROR': return 'service';
    case 'REMOTE_AGENT_PROVIDER_NOT_ALLOWED': case 'REMOTE_AGENT_MODEL_NOT_ALLOWED': return 'model';
    case 'REMOTE_AGENT_GROUP_USAGE_LIMIT': case 'REMOTE_AGENT_MEMBER_BUDGET_PAUSED': case 'USAGE_LIMIT_REACHED': case 'INSUFFICIENT_QUOTA': return 'budget';
    case 'REMOTE_AGENT_BUSY': case 'DEVICE_LIMIT': case 'TOTAL_LIMIT': return 'capacity';
    case 'REMOTE_AGENT_PEER_TOO_OLD': case 'PEER_TOO_OLD': case 'CHANNEL_NOT_ALLOWED': return 'unsupported';
    default: return 'unknown';
  }
}

export function sharedTaskRecoveryError(stage: SharedTaskRecoveryStage, reason: SharedTaskRecoveryReason, source?: unknown): Error {
  const code = ['denied', 'model', 'budget', 'policy'].includes(reason) ? 'REMOTE_AGENT_PROVIDER_NOT_ALLOWED'
    : reason === 'capacity' || reason === 'rate' ? 'REMOTE_AGENT_BUSY'
    : reason === 'unsupported' ? 'REMOTE_AGENT_PEER_TOO_OLD' : 'REMOTE_AGENT_UNAVAILABLE';
  const sourceCode = (source as { code?: unknown } | null)?.code;
  const diagnostic = typeof sourceCode === 'string' && [
    'TIMEOUT', 'INVOKE_TIMEOUT', 'DEVICE_UNRESPONSIVE', 'DEVICE_OFFLINE',
    'NOT_CONNECTED', 'LINK_NOT_OPEN', 'LINK_CLOSED', 'PEER_RESET',
    'ACCESS_REVOKED', 'PERMISSION_DENIED', 'REMOTE_DISABLED', 'UNAUTHORIZED',
  ].includes(sourceCode) ? ` [SHARED_TASK_CODE_${sourceCode}]` : '';
  return Object.assign(new Error(`[${code}] [SHARED_TASK_RECOVERY_${reason}] [SHARED_TASK_STAGE_${stage}]${diagnostic} Shared task recovery failed`), {
    code,
  });
}

/** Only pre-open recovery requests may be retried. Never retry permission, quota, capacity or unknown failures. */
export function canRetrySharedTaskRecovery(error: unknown): boolean {
  return ['timeout', 'relay'].includes(sharedTaskFailureReason(error));
}

/** Recovery is bounded to one retry of an idempotent probe, never open/send/allocate. */
export async function probeSharedTask<T>(stage: SharedTaskRecoveryStage, probe: () => Promise<T>, assertCurrent: () => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    assertCurrent();
    try {
      const value = await probe();
      assertCurrent();
      return value;
    } catch (error) {
      assertCurrent();
      if (attempt === 0 && canRetrySharedTaskRecovery(error)) continue;
      throw sharedTaskRecoveryError(stage, sharedTaskFailureReason(error), error);
    }
  }
}

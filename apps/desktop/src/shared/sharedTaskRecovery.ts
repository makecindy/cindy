import { isProviderSafetyRefusalError, parseAgentErrorCode } from '@cindy/maker-shared/error-redaction';
import { BREAKER_PROBE_BACKOFF_MAX_MS } from '@cindy/maker-shared/device-responsiveness';
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
  if (isProviderSafetyRefusalError(message)) return undefined;
  const detailed = sharedTaskRecoveryReason(message);
  if (detailed) return detailed;
  if (!agentDeviceId?.startsWith('share:')) return undefined;
  // Presentation aliases only. Keep the probe/replay policy below based on the
  // original transport code; these aliases must not authorize another call.
  switch (parseAgentErrorCode(message)?.code) {
    case 'REMOTE_AGENT_RESUME_UNAVAILABLE': return 'history';
    case 'REMOTE_AGENT_TIMEOUT': case 'REMOTE_AGENT_UNRESPONSIVE': return 'timeout';
    case 'REMOTE_AGENT_LINK_BUSY': return 'rate';
    case 'REMOTE_AGENT_OFFLINE': return 'offline';
    case 'REMOTE_AGENT_ACCESS_DENIED': return 'denied';
  }
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
  const safeSourceCode = typeof sourceCode === 'string' && [
    'TIMEOUT', 'INVOKE_TIMEOUT', 'DEVICE_UNRESPONSIVE', 'DEVICE_OFFLINE',
    'NOT_CONNECTED', 'LINK_NOT_OPEN', 'LINK_CLOSED', 'PEER_RESET',
    'ACCESS_REVOKED', 'PERMISSION_DENIED', 'REMOTE_DISABLED', 'UNAUTHORIZED',
  ].includes(sourceCode) ? sourceCode : undefined;
  const diagnostic = safeSourceCode ? ` [SHARED_TASK_CODE_${safeSourceCode}]` : '';
  const error = Object.assign(new Error(`[${code}] [SHARED_TASK_RECOVERY_${reason}] [SHARED_TASK_STAGE_${stage}]${diagnostic} Shared task recovery failed`), { code });
  if (source !== undefined) {
    // Retain only bounded local evidence. Keeping the upstream object (even as
    // Error.cause) would let later logging/serialization expose private details.
    Object.defineProperty(error, 'cause', { value: Object.freeze({
      reason: sharedTaskFailureReason(source), ...(safeSourceCode ? { code: safeSourceCode } : {}),
    }), configurable: true, writable: true });
  }
  return error;
}

/** Only pre-open recovery requests may be retried. Never retry permission, quota, capacity or unknown failures. */
export function canRetrySharedTaskRecovery(error: unknown): boolean {
  return ['timeout', 'relay'].includes(sharedTaskFailureReason(error));
}

/** Only an unaccepted report's preparation may be repeated. An allocation or
 * authorization timeout is not proof that the grant write did not happen. */
export function canRecoverUndeliveredOrcaReport(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const stage = /\[SHARED_TASK_STAGE_([a-z]+)\]/.exec(message)?.[1];
  const reason = sharedTaskFailureReason(error);
  // Executor/capability failures may follow a committed allocation. Recover
  // those probes in place below, not by replaying the whole startup pipeline.
  if (stage && stage !== 'owner') return false;
  return ['offline', 'relay'].includes(reason)
    || (!!stage && reason === 'timeout');
}

/** Retry only the same idempotent probe, keeping its grant and cancellation fence.
 * A restarted executor can outlive the old four-second window. Keep one immediate
 * retry, then bounded exponential jitter; never restart allocation/open/send. */
export async function probeSharedTask<T>(
  stage: SharedTaskRecoveryStage,
  probe: () => Promise<T>,
  assertCurrent: () => void,
  signal?: AbortSignal,
): Promise<T> {
  // Desktop's breaker probe serially restores the link, then invokes caps.
  // Default link budget: 1.5s ready + 30s first write + 30s response;
  // caps: 30s admission + 10s first write + 30s response (DeviceLinkClient).
  // An availability horizon is not a request deadline: a peer can recover while
  // the breaker still holds a stale probe or cooldown. Reserve one final cycle
  // to observe recovery at that horizon, without renewing either fixed bound.
  const compositeProbeMs = 1_500 + 30_000 + 30_000 + 30_000 + 10_000 + 30_000;
  const observationGraceMs = 2 * compositeProbeMs + BREAKER_PROBE_BACKOFF_MAX_MS + 5_000 + 25_000;
  const outageToleranceMs = observationGraceMs;
  const windowMs = outageToleranceMs + observationGraceMs;
  const deadline = performance.now() + windowMs;
  const maxDelayMs = 20_000;
  const minJitter = 0.75;
  // One immediate and five ramp retries, then the shortest capped delay.
  // Derive the count from the window so it cannot cut the window short.
  const retryLimit = 6 + Math.ceil(windowMs / (maxDelayMs * minJitter));
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    assertCurrent();
    try {
      const value = await probe();
      signal?.throwIfAborted();
      assertCurrent();
      return value;
    } catch (error) {
      signal?.throwIfAborted();
      assertCurrent();
      const remaining = deadline - performance.now();
      if (attempt < retryLimit && remaining > 0 && canRetrySharedTaskRecovery(error)) {
        const base = attempt === 0 ? 0 : Math.min(1_000 * 2 ** (attempt - 1), maxDelayMs);
        // Keep a final probe at the deadline instead of abandoning the last
        // partial delay. Never bypass the shared breaker's single-flight slot.
        const delay = Math.min(Math.round(base * (minJitter + Math.random() * 0.5)), maxDelayMs, remaining);
        if (delay) await new Promise<void>((resolve, reject) => {
          const finish = () => {
            signal?.removeEventListener('abort', abort);
            resolve();
          };
          const timer = setTimeout(finish, delay);
          const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            reject(signal?.reason);
          };
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
        signal?.throwIfAborted();
        assertCurrent();
        // A delayed timer must not start a stale request. An RPC started within
        // the budget keeps its own timeout and real outcome, including at its end.
        if (performance.now() > deadline) throw sharedTaskRecoveryError(stage, sharedTaskFailureReason(error), error);
        continue;
      }
      throw sharedTaskRecoveryError(stage, sharedTaskFailureReason(error), error);
    }
  }
}

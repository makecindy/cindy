/** Read-only, owner-scoped directory continuity. Never used for execution grants or mutations. */
import { createHash } from 'node:crypto';
import { MetadataContinuityReader, PROVIDER_GROUP_REMOTE_CHANNEL, readProviderMetadataContinuity, isProviderAccessDeniedError,
  type InvokeResultPayload, type MetadataContinuityScope } from '@cindy/device-link';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { MODEL_CATALOG_READ_CHANNELS } from '../../shared/controlledModelCatalog.js';

const READ_CHANNELS = new Set<string>(MODEL_CATALOG_READ_CHANNELS);

const TEMPORARY_CODES = new Set([
  'NETWORK_ERROR', 'NOT_CONNECTED', 'DEVICE_LINK_NOT_CONNECTED', 'DEVICE_OFFLINE',
  'DEVICE_UNRESPONSIVE', 'TIMEOUT', 'INVOKE_TIMEOUT', 'BACKPRESSURE', 'PEER_RESET',
  'LINK_CLOSED', 'LINK_NOT_OPEN', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE',
]);

export function isTemporaryProviderMetadataFailure(error: unknown): boolean {
  const row = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown } : {};
  const code = row.code === undefined || row.code === 'IPC_ERROR'
    ? typeof row.message === 'string' ? /^\[([A-Z_]+)\]/.exec(row.message)?.[1] : undefined : row.code;
  if (typeof code === 'string' && /REVOKED|DENIED|REMOVED|PAUSED|DISABLED|UNAUTHORIZED|FORBIDDEN|INVALID|SCOPE_CHANGED/.test(code)) return false;
  if (typeof code === 'string' && TEMPORARY_CODES.has(code)) return true;
  const status = row.statusCode ?? row.status;
  return status === 0 || status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
}

const reader = new MetadataContinuityReader({ retryable: isTemporaryProviderMetadataFailure });
let generation = 0;
const targetGenerations = new Map<string, number>();
const denialListeners = new Set<(target: string) => void>();
/** A late denial must retire displays which already received the bounded fallback. */
export function onProviderMetadataDenied(listener: (target: string) => void): () => void {
  denialListeners.add(listener);
  return () => { denialListeners.delete(listener); };
}

/** Known denials/permission edits invalidate even in-flight snapshots. Presence loss does not. */
export function invalidateProviderMetadataContinuity(target?: string): void {
  if (target !== undefined && targetGenerations.size < 1024) {
    targetGenerations.set(target, (targetGenerations.get(target) ?? 0) + 1);
  } else { generation++; targetGenerations.clear(); reader.clear(); }
}

function scope(allowed: () => boolean = () => true, target?: string): MetadataContinuityScope {
  const owner = activeOwnerScopeKey();
  const endpoint = getClientEndpoint('deviceLinkApiBaseUrl');
  const epoch = generation;
  const targetEpoch = target === undefined ? 0 : targetGenerations.get(target) ?? 0;
  return {
    key: JSON.stringify([owner, endpoint, epoch, target, targetEpoch]),
    current: () => !isAppSessionBoundaryPending() && activeOwnerScopeKey() === owner
      && getClientEndpoint('deviceLinkApiBaseUrl') === endpoint && generation === epoch
      && (target === undefined || (targetGenerations.get(target) ?? 0) === targetEpoch) && allowed(),
    // Live direct RPCs should refresh metadata even when cloud signaling is down.
    signalingAvailable: () => true,
  };
}

export async function readProviderDirectoryContinuity<T>(request: () => Promise<T>) {
  // handleListDevices already owns its 300ms coalescing and latest-response
  // ordering; a later explicit refresh must not join a superseded directory.
  return reader.read({ ...scope(), joinPending: false }, 'device-directory', request);
}

/** Other bounded routing snapshots share the same known-permission invalidation fence. */
export function captureProviderMetadataContinuityScope(target: string): () => boolean {
  return scope(() => true, target).current;
}

/** Only the two explicit metadata reads below may use a snapshot. In particular caps, pick,
 * delegation checks, usage writes and Agent operations always reach their real authority. */
export async function invokeProviderMetadataContinuity(
  target: string, channel: string, args: unknown[], request: () => Promise<InvokeResultPayload>,
  allowed: () => boolean = () => true,
): Promise<InvokeResultPayload> {
  const groupView = channel === PROVIDER_GROUP_REMOTE_CHANNEL && args.length === 1
    && !!args[0] && typeof args[0] === 'object' && (args[0] as { action?: unknown }).action === 'view';
  if (!READ_CHANNELS.has(channel) && !groupView) return request();
  const capturedScope = scope(allowed, target);
  capturedScope.remainingTrustMs = (value: unknown): number => {
    // Legacy array/scalar replies cannot carry a forwarding budget without
    // changing their shape. Keep those live rather than accidentally refreshing trust at every hop.
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
    return readProviderMetadataContinuity(value)?.remainingMs ?? 30 * 60_000;
  };
  let failure: InvokeResultPayload | undefined;
  try {
    const resource = createHash('sha256').update(JSON.stringify([target, channel, args])).digest('hex');
    const result = await reader.read(capturedScope, resource, async () => {
      try {
        const result = await request();
        if (!result.ok) {
          failure = result;
          throw Object.assign(new Error(result.error.message), { code: result.error.code });
        }
        const forwarded = readProviderMetadataContinuity(result.result);
        if (forwarded && forwarded.remainingMs <= 0) {
          throw Object.assign(new Error('[MODEL_VISIBILITY_NOT_READY] Provider directory snapshot expired'), { code: 'MODEL_VISIBILITY_NOT_READY' });
        }
        return result.result;
      } catch (error) {
        // This physical read can finish after reader.read returned its 2s fallback.
        // Fence the captured owner/realm/permission generation before touching any target.
        const status = error && typeof error === 'object'
          ? (error as { status?: unknown; statusCode?: unknown }).statusCode ?? (error as { status?: unknown }).status : undefined;
        if (capturedScope.current() && (isProviderAccessDeniedError(error) || status === 401 || status === 403)) {
          invalidateProviderMetadataContinuity(target);
          for (const listener of denialListeners) {
            try { listener(target); } catch { /* Notification cannot undo the permission fence. */ }
          }
        }
        throw error;
      }
    });
    return { ok: true, result: result.value && typeof result.value === 'object' && !Array.isArray(result.value)
      ? { ...result.value, providerContinuity: { stale: result.stale
        || (result.value as { providerContinuity?: { stale?: unknown } }).providerContinuity?.stale === true,
      remainingMs: result.remainingMs } } : result.value };
  } catch (error) {
    if (capturedScope.current() && !isTemporaryProviderMetadataFailure(error)) invalidateProviderMetadataContinuity(target);
    if (failure) return failure;
    throw error;
  }
}

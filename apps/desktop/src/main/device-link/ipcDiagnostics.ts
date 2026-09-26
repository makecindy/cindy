import { createHmac, randomBytes } from 'node:crypto';
import { REMOTE_INVOKE_ALLOWLIST, type DeviceLinkErrorCode } from '@cindy/device-link';
import type { DeviceLinkIpcDeps } from './ipc';

// Explicit vocabulary: never copy remote error messages/codes or IPC arguments
// into diagnostics. Unknown errors still propagate unchanged to the caller.
const ERROR_CODES = {
  DEVICE_OFFLINE: true,
  REMOTE_DISABLED: true,
  VERSION_MISMATCH: true,
  PAYLOAD_TOO_LARGE: true,
  RATE_LIMITED: true,
  BAD_REQUEST: true,
  INTERNAL: true,
  CHANNEL_NOT_ALLOWED: true,
  ACCESS_REVOKED: true,
  INVOKE_TIMEOUT: true,
  PEER_RESET: true,
  LINK_NOT_OPEN: true,
  NOT_CONNECTED: true,
  BACKPRESSURE: true,
  MEDIA_FETCH_FAILED: true,
  VOICE_TRANSCRIBE_FAILED: true,
  VOICE_CREDENTIAL_SYNC_FAILED: true,
  VOICE_CREDENTIAL_SYNC_REMOVED: true,
  VOICE_DICTIONARY_LEARNING_FAILED: true,
  VOICE_DICTIONARY_GET_FAILED: true,
  IPC_ERROR: true,
  // responsivenessTracker emits this Desktop-local code outside the wire union.
  DEVICE_UNRESPONSIVE: true,
} satisfies Record<DeviceLinkErrorCode | 'IPC_ERROR' | 'DEVICE_UNRESPONSIVE', true>;

function errorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && Object.hasOwn(ERROR_CODES, code)) return code;
  // The uninitialized main client already throws this mapped code. Do not
  // misreport it as a known raw NOT_CONNECTED / BACKPRESSURE cause.
  if (error instanceof Error && error.message.startsWith('[DEVICE_LINK_NOT_CONNECTED]')) {
    return 'MAPPED_NOT_CONNECTED';
  }
  return 'UNKNOWN';
}

type Operation = 'open-link' | 'invoke' | 'subscribe' | 'unsubscribe';
interface Bucket {
  windowId: number;
  peer: string;
  operation: Operation;
  channel: string;
  code: string;
  completed: number;
}

/** Local diagnostics for completed transport calls originating at renderer IPC.
 * Counts before IPC error remapping; not wire sends or all main background work.
 * First failure per bucket is immediate; 30s summaries include that first event
 * and successes for a baseline. Bounded cardinality and no payloads/peer IDs.
 */
export function createDeviceLinkIpcDiagnostics(
  emit: (event: string, fields: Record<string, unknown>) => void,
) {
  const salt = randomBytes(32);
  const buckets = new Map<string, Bucket>();
  const maxBuckets = 64;
  let overflowCompleted = 0;
  let overflowFailures = 0;
  let startedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function safeEmit(event: string, fields: Record<string, unknown>): void {
    try {
      emit(event, fields);
    } catch {
      /* Diagnostics cannot change request behavior. */
    }
  }

  function flush(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const elapsedMs = Date.now() - startedAt;
    for (const bucket of buckets.values()) safeEmit('transport summary', { ...bucket, elapsedMs });
    if (overflowCompleted)
      safeEmit('transport summary overflow', { overflowCompleted, overflowFailures, elapsedMs });
    buckets.clear();
    overflowCompleted = 0;
    overflowFailures = 0;
  }

  function record(
    windowId: number,
    deviceId: string,
    operation: Operation,
    channel: string,
    code: string,
  ): void {
    if (!timer) {
      startedAt = Date.now();
      timer = setTimeout(flush, 30_000);
      timer.unref?.();
    }
    const peer = createHmac('sha256', salt).update(deviceId).digest('hex').slice(0, 16);
    const safeChannel =
      operation === 'invoke'
        ? REMOTE_INVOKE_ALLOWLIST.has(channel)
          ? channel
          : 'UNKNOWN'
        : operation;
    const key = JSON.stringify([windowId, peer, operation, safeChannel, code]);
    const existing = buckets.get(key);
    if (existing) {
      existing.completed++;
      return;
    }
    if (buckets.size >= maxBuckets) {
      overflowCompleted++;
      if (code !== 'OK') overflowFailures++;
      return;
    }
    const bucket: Bucket = { windowId, peer, operation, channel: safeChannel, code, completed: 1 };
    buckets.set(key, bucket);
    if (code !== 'OK') safeEmit('transport first failure', { ...bucket });
  }

  async function observe<T>(
    windowId: number,
    deviceId: string,
    operation: Operation,
    channel: string,
    call: () => Promise<T>,
  ): Promise<T> {
    let code = 'OK';
    try {
      const result = await call();
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        code = errorCode('error' in result ? result.error : undefined);
      }
      return result;
    } catch (error) {
      code = errorCode(error);
      throw error;
    } finally {
      try {
        record(windowId, deviceId, operation, channel, code);
      } catch {
        /* Best effort. */
      }
    }
  }

  return {
    flush,
    forWindow(deps: DeviceLinkIpcDeps, windowId: number): DeviceLinkIpcDeps {
      return {
        ...deps,
        openLink: (peer) => observe(windowId, peer, 'open-link', '', () => deps.openLink(peer)),
        invoke: (peer, channel, args) =>
          observe(windowId, peer, 'invoke', channel, () => deps.invoke(peer, channel, args)),
        subscribe: (peer, topics) =>
          observe(windowId, peer, 'subscribe', '', () => deps.subscribe(peer, topics)),
        unsubscribe: (peer, topics) =>
          observe(windowId, peer, 'unsubscribe', '', () => deps.unsubscribe(peer, topics)),
      };
    },
  };
}

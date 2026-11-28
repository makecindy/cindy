/** Optional v1 request envelope. An object in the first argument fails closed on older hosts. */
export interface ForkTarget {
  agentKind: 'claude-code' | 'codex' | 'pi' | 'acp';
  model: string;
  providerId: string | null;
  /** null explicitly means the computer holding the task and its files. */
  agentDeviceId: string | null;
  effort?: string;
  fastMode?: boolean | 'ultrafast';
}

export interface ForkRequest {
  version: 1;
  action: 'create' | 'status';
  requestId: string;
  sourceSessionId: string;
  messageClientId: string;
  /** Present only after an explicit history-handoff choice. Native IDs never cross locations. */
  target?: ForkTarget;
}

export type ForkOutcome = 'native' | 'history-handoff';
export interface ForkReceipt<T> {
  state: 'not-sent' | 'pending' | 'unknown' | 'failed' | 'complete';
  session?: T;
  outcome?: ForkOutcome;
}

/** getRandomValues also works on Cindy's custom renderer origin, unlike randomUUID. */
export function createForkRequestId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

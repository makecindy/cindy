import type { AuthState } from '../authManager.js';
import type { ModelAccessStatus } from '../../shared/modelAccess.js';

// Process-local readiness only: persisted credentials never count as a successful
// sync in this process. No keys or endpoint values leave the main process.
let owner: string | null = null;
let endpoint: string | null = null;
let source: ModelAccessStatus['source'] = null;
let ready = false;
let synchronized = false;
let generation = 0;
const listeners = new Set<(ownerKey: string | null) => void>();

export function noteQuotaCredentialStatus(ownerKey: string | null, status: ModelAccessStatus): void {
  const nextEndpoint = status.endpoint?.trim().replace(/\/+$/, '') || null;
  const reset = owner !== ownerKey || status.state === 'idle';
  const nextReady = status.state === 'ok' && status.source === 'server' && !!nextEndpoint;
  const sourceChanged = source !== status.source || endpoint !== nextEndpoint;
  if (reset || sourceChanged) synchronized = false;
  const changed = sourceChanged || (!synchronized && nextReady);
  if (nextReady) synchronized = true;
  owner = ownerKey;
  ready = nextReady;
  source = status.source;
  endpoint = nextEndpoint;
  if (reset || changed) {
    generation++;
    for (const listener of listeners) listener(ownerKey);
  }
}

export function quotaCredentialsReady(ownerKey: string, effectiveEndpoint: string): boolean {
  return ready && owner === ownerKey && endpoint === effectiveEndpoint.trim().replace(/\/+$/, '');
}
export function quotaCredentialGeneration(): number { return generation; }
export function onQuotaCredentialSourceChanged(listener: (ownerKey: string | null) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Owner generation also fences same-membership realm switches and repairs. */
export function cloudQuotaOwnerKey(auth: Pick<AuthState, 'mode' | 'dataOwnerId' | 'ownerGeneration'>): string | null {
  return auth.mode === 'cloud' && auth.dataOwnerId
    ? `cloud:${auth.dataOwnerId}:${auth.ownerGeneration}` : null;
}

// The sync owner must still match both membership and realm. The reader is wired
// by Model Access; quota reads do not import its runtime or start credential sync.
let readCurrentCredentialStatus: (() => ModelAccessStatus | null) | null = null;
export function setQuotaCredentialStatusReader(reader: () => ModelAccessStatus | null): void {
  readCurrentCredentialStatus = reader;
}

/** Reset the process-local credential snapshot without notifying production listeners. */
export function __resetQuotaCredentialStateForTesting(
  ownerKey: string | null,
  status: ModelAccessStatus,
): void {
  owner = ownerKey;
  endpoint = status.endpoint?.trim().replace(/\/+$/, '') || null;
  source = status.source;
  ready = status.state === 'ok' && status.source === 'server' && !!endpoint;
  synchronized = ready;
  generation = 0;
  readCurrentCredentialStatus = null;
}

export function refreshQuotaCredentialOwner(ownerKey: string): void {
  if (owner === ownerKey) return;
  const status = readCurrentCredentialStatus?.();
  if (status) noteQuotaCredentialStatus(ownerKey, status);
}

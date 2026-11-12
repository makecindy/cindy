export type CredentialSwitchOutcome =
  | { deviceId: string; sessionId: string; kind: 'applied' }
  | { deviceId: string; sessionId: string; kind: 'failed'; reason: 'apply-failed' | 'rollback-failed' };

const listeners = new Set<(outcome: CredentialSwitchOutcome) => void>();

/** Live outcome notifications accompany the durable sessions:patched route projection. */
export function subscribeCredentialSwitchOutcome(listener: (outcome: CredentialSwitchOutcome) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function dispatchCredentialSwitchOutcome(deviceId: string, channel: string, payload: unknown): void {
  if (!deviceId || !payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  const value = payload as Record<string, unknown>;
  const sessionId = value.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return;
  let outcome: CredentialSwitchOutcome;
  if (channel === 'maker:session-credential-switch-applied') {
    outcome = { deviceId, sessionId, kind: 'applied' };
  } else if (channel === 'maker:session-credential-switch-failed' &&
    (value.reason === 'apply-failed' || value.reason === 'rollback-failed')) {
    outcome = { deviceId, sessionId, kind: 'failed', reason: value.reason };
  } else {
    return;
  }
  for (const listener of listeners) listener(outcome);
}

import type { SessionControllerEvent, SessionControllerSnapshot, SessionTarget } from '@cindy/maker-shared/session-controller';

export type SessionSubscriptionUpdate =
  | { event: SessionControllerEvent; snapshot: SessionControllerSnapshot }
  | { error: unknown; event?: SessionControllerEvent };

/** Per-subscriber read fence only, no second runtime/projection store. An old
 * read is allowed to settle normally; a signal received during it forces a
 * fresh read afterwards. Unsubscribe/revocation invalidates emission immediately. */
export function createSessionSubscription(deps: {
  target: SessionTarget;
  authorize(): Promise<void>;
  read(): Promise<SessionControllerSnapshot>;
  listen(invalidate: (kind?: SessionControllerEvent['kind'], inputId?: string) => void): () => void;
  emit(update: SessionSubscriptionUpdate): void;
  onClose?(): void;
}) {
  let active = true;
  let revision = 0;
  let requestedKind: SessionControllerEvent['kind'] = 'snapshot-resync';
  let reading: Promise<void> | null = null;
  let settledRevision = -1;
  let inputId: string | undefined;
  let lastOwnerEpoch = 'unobserved';
  const emit = (update: SessionSubscriptionUpdate) => {
    try { deps.emit(update); } catch { /* A consumer cannot break the read fence. */ }
  };
  const drain = async () => {
    while (active) {
      const started = revision;
      const kind = requestedKind;
      const changedInput = inputId;
      try {
        await deps.authorize();
        if (!active) return;
        const snapshot = await deps.read();
        await deps.authorize();
        if (!active) return;
        if (started !== revision) continue;
        if (snapshot.target.deviceId !== deps.target.deviceId || snapshot.target.sessionId !== deps.target.sessionId) {
          throw new Error('Session snapshot target mismatch');
        }
        lastOwnerEpoch = snapshot.ownerEpoch;
        emit({ snapshot, event: {
          target: snapshot.target, ownerEpoch: snapshot.ownerEpoch, observedAtMs: snapshot.observedAtMs,
          connection: snapshot.connection, freshness: snapshot.freshness, kind,
          ...(snapshot.execution ? { execution: snapshot.execution } : {}),
          ...(changedInput ? { inputId: changedInput } : {}),
        } });
      } catch (error) {
        const code = (error as { code?: string })?.code;
        const revoked = ['NOT_AUTHORIZED', 'OWNER_SCOPE_CHANGED', 'CONTROL_DISABLED'].includes(code ?? '');
        if (active && (revoked || started === revision)) emit({ error,
          ...(['DEVICE_OFFLINE', 'DEVICE_UNRESPONSIVE'].includes(code ?? '') ? { event: {
            target: deps.target, ownerEpoch: lastOwnerEpoch, observedAtMs: Date.now(),
            connection: code === 'DEVICE_OFFLINE' ? 'offline' as const : 'unresponsive' as const,
            freshness: 'stale' as const, kind: 'connection-invalidated' as const,
          } } : {}),
        });
        if (revoked) { close(); return; }
      }
      settledRevision = started;
      if (started === revision) return;
    }
  };
  const invalidate = (kind: SessionControllerEvent['kind'] = 'snapshot-resync', changedInput?: string) => {
    if (!active) return;
    revision++; requestedKind = kind; inputId = changedInput;
    startRead();
  };
  const startRead = () => {
    if (!active || reading) return;
    reading = drain().finally(() => {
      reading = null;
      if (active && settledRevision !== revision) startRead();
    });
  };
  const unlisten = deps.listen(invalidate);
  const close = () => { if (!active) return; active = false; revision++; unlisten(); deps.onClose?.(); };
  invalidate();
  return { ready: () => reading ?? Promise.resolve(), resync: () => invalidate(),
    close };
}

import { createHash } from 'node:crypto';

export interface ExistingSessionDeliveryInput {
  callerSessionId: string;
  targetSessionId: string;
  message: string;
  idempotencyKey: string;
}
export type ExistingSessionDeliveryResult =
  | { ok: true; targetSessionId: string; wakeKind: 'queued'; reused: boolean }
  | { ok: false; errorCode: string; message: string };

export class ExistingSessionDeliveryError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** A Host-created lease, never reconstructed from model input or quoted history. */
export interface ExistingSessionDeliveryContext {
  ownerScope: string;
  assertCurrent(): void;
  validate(): Promise<void>;
  confirm(): Promise<boolean>;
  dispose(): void;
}
export interface ExistingSessionDeliveryDeps {
  capture(input: ExistingSessionDeliveryInput): Promise<ExistingSessionDeliveryContext>;
  withTargetLock<T>(targetSessionId: string, action: () => Promise<T>): Promise<T>;
  /** Reads the restored queue and persisted transcript, including cleared/rewound receipts. */
  readAccepted(targetSessionId: string, clientId: string, callerSessionId: string): Promise<{ message: string } | null>;
  /** Prepare has no dispatch side effects. commit only appends to the existing target queue. */
  prepare(input: ExistingSessionDeliveryInput, clientId: string): Promise<() => void>;
  flush(targetSessionId: string): Promise<void>;
}

export function existingSessionDeliveryClientId(input: ExistingSessionDeliveryInput): string {
  const identity = JSON.stringify([input.callerSessionId, input.targetSessionId, input.idempotencyKey]);
  return `bot-existing-session:${createHash('sha256').update(identity).digest('hex')}`;
}

/** The general send API accepts unknown options; this flag only tightens its target checks. */
export function isExistingSessionDeliverySendOptions(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const receipt = (value as { persistUserMessage?: unknown }).persistUserMessage;
  if (!receipt || typeof receipt !== 'object') return false;
  const clientId = (receipt as { clientId?: unknown }).clientId;
  return typeof clientId === 'string' && clientId.startsWith('bot-existing-session:');
}

/** No session factory, runtime overrides or unrestricted handoff capability is injected here. */
export function createBotExistingSessionDelivery(deps: ExistingSessionDeliveryDeps) {
  const flights = new Map<string, { message: string; promise: Promise<ExistingSessionDeliveryResult> }>();
  const conflict = (): ExistingSessionDeliveryResult => ({ ok: false, errorCode: 'IDEMPOTENCY_CONFLICT', message: 'This delivery key was already used for a different message.' });
  return {
    async send(input: ExistingSessionDeliveryInput): Promise<ExistingSessionDeliveryResult> {
      if (!input.callerSessionId || !input.targetSessionId || input.callerSessionId === input.targetSessionId ||
          !input.idempotencyKey || input.idempotencyKey.length > 128 || !input.message.trim() || input.message.length > 4_000) {
        return { ok: false, errorCode: 'INVALID_ARGS', message: 'An existing target, message and delivery key are required.' };
      }
      let context: ExistingSessionDeliveryContext | undefined;
      let admitted = false;
      const failure = (error: unknown): ExistingSessionDeliveryResult => {
        if (admitted) return { ok: false, errorCode: 'DELIVERY_UNVERIFIED', message: 'Queue admission may have occurred. Retry only with the same delivery key and message.' };
        if (error instanceof ExistingSessionDeliveryError) return { ok: false, errorCode: error.code, message: error.message };
        return { ok: false, errorCode: 'HOST_NOT_READY', message: 'The Host could not verify the existing Session delivery context.' };
      };
      try {
        context = await deps.capture(input);
        context.assertCurrent();
        const clientId = existingSessionDeliveryClientId(input);
        const key = `${context.ownerScope}:${clientId}`;
        const previous = flights.get(key);
        if (previous) {
          if (previous.message !== input.message) return conflict();
          const result = await previous.promise;
          context.assertCurrent();
          return result;
        }
        const lease = context;
        const accepted = async (): Promise<ExistingSessionDeliveryResult | null> => {
          const receipt = await deps.readAccepted(input.targetSessionId, clientId, input.callerSessionId);
          await lease.validate();
          lease.assertCurrent();
          if (!receipt) return null;
          if (receipt.message !== input.message) return conflict();
          admitted = true;
          await deps.flush(input.targetSessionId);
          lease.assertCurrent();
          return { ok: true, targetSessionId: input.targetSessionId, wakeKind: 'queued', reused: true };
        };
        const operation = async (): Promise<ExistingSessionDeliveryResult> => {
          const old = await deps.withTargetLock(input.targetSessionId, accepted);
          if (old) return old;
          // Never hold the target's send lock while the user is deciding.
          if (!await lease.confirm()) return { ok: false, errorCode: 'TARGET_NOT_AUTHORIZED', message: 'The user did not authorize this delivery.' };
          lease.assertCurrent();
          return deps.withTargetLock(input.targetSessionId, async () => {
            const raced = await accepted();
            if (raced) return raced;
            const commit = await deps.prepare(input, clientId);
            await lease.validate();
            lease.assertCurrent();
            // No await separates the final lease check from queue admission.
            admitted = true;
            commit();
            await deps.flush(input.targetSessionId);
            lease.assertCurrent();
            return { ok: true, targetSessionId: input.targetSessionId, wakeKind: 'queued', reused: false };
          });
        };
        // Share the classified outcome too: coalesced callers must not mistake an
        // uncertain admission for a pre-dispatch failure and retry with a new key.
        const promise = operation().catch(failure);
        flights.set(key, { message: input.message, promise });
        try { return await promise; }
        finally { if (flights.get(key)?.promise === promise) flights.delete(key); }
      } catch (error) {
        return failure(error);
      } finally { context?.dispose(); }
    },
  };
}

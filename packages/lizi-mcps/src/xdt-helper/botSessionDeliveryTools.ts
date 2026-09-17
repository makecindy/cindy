import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';

export interface BotSessionDeliveryCallbacks {
  /** Host validates live Bot ownership and target authorization before dispatch. */
  send(input: {
    callerSessionId: string;
    targetSessionId: string;
    message: string;
    idempotencyKey: string;
  }): Promise<
    | { ok: true; targetSessionId: string; wakeKind: 'queued' | 'resumed' | 'already-active'; reused?: boolean }
    | { ok: false; errorCode: string; message: string }
  >;
}

function response(value: Record<string, unknown>) {
  if (value.ok === false) return errorPayload(String(value.errorCode), String(value.message));
  return okPayload(value);
}

/** Not a general handoff: no creation, execution overrides or caller-supplied authority. */
export function registerBotSessionDeliveryTools(
  registry: XdtHelperToolRegistry,
  callbacks: BotSessionDeliveryCallbacks,
  getCallerSessionId: () => string | undefined,
): void {
  registry.register({
    name: 'send_to_existing_session',
    category: 'bots',
    description: 'Send one message to an existing Session managed by this Host, authorized through confirmation of the target, execution location and message. Never creates or replaces a Session or changes its model. Reuse idempotency_key for the same delivery. A queued receipt does not prove the model consumed the message. Unauthorized targets are rejected; do not retry through other tools.',
    inputShape: {
      target_session_id: z.string().min(1).max(128),
      message: z.string().trim().min(1).max(4_000),
      idempotency_key: z.string().min(1).max(128),
    },
    handler: async ({ target_session_id, message, idempotency_key }) => {
      const callerSessionId = getCallerSessionId();
      if (!callerSessionId) return response({ ok: false, errorCode: 'NOT_A_BOT_SESSION', message: 'Caller Session is not bound.' });
      if (callerSessionId === target_session_id) return response({ ok: false, errorCode: 'INVALID_TARGET', message: 'Self-delivery is not supported.' });
      const result = await callbacks.send({ callerSessionId, targetSessionId: target_session_id,
        message, idempotencyKey: idempotency_key });
      if (!result.ok) return response(result);
      if (result.targetSessionId !== target_session_id) {
        return response({ ok: false, errorCode: 'DELIVERY_RESULT_MISMATCH', message: 'Host returned a different target; delivery is unverified. Do not retry automatically.' });
      }
      return response({ ok: true, target_session_id: result.targetSessionId, wake_kind: result.wakeKind, reused: result.reused === true, idempotency_key });
    },
  });
}

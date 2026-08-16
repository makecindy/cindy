import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, isNull, lte, or } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { botChannels, botDeliveryOutbox, botProfiles, botRoutes } from '../localDb/schema.js';
import type { BotDeliveryView } from '../../shared/botDelivery.js';
import { parseBotDeliveryDiagnostic } from '../../shared/botDeliveryDiagnostic.js';

const RETRYABLE_STATUSES = ['pending', 'failed'] as const;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_SENDING_LEASE_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const MAX_PAYLOAD_BYTES = 256 * 1024;

export interface BotDeliveryEnvelope {
  version: 1;
  kind: string;
  [key: string]: unknown;
}

export interface BotDeliveryRow {
  id: string;
  botId: string;
  channelId: string | null;
  routeId: string | null;
  sessionId: string | null;
  idempotencyKey: string;
  ownerGeneration: number;
  attempts: number;
}

export type BotDeliveryAttemptResult =
  | { ok: true; receipt?: Record<string, unknown> }
  | { ok: false; retryable: boolean; errorCode: string; message: string };

export interface BotDeliveryOutboxServiceDeps {
  deliver: (
    row: BotDeliveryRow,
    payload: BotDeliveryEnvelope,
    attempt: {
      /**
       * Persist the exact point at which an adapter call may have crossed the
       * process boundary.  A provider-idempotent transport can be replayed
       * after a crash; a local adapter cannot be retried automatically because
       * the provider may have accepted the message before the process died.
       */
      recordExternalDispatch(input: {
        retrySafe: boolean;
        transport: string;
      }): Promise<void>;
      /** Persist provider acknowledgements as a multipart send advances. */
      recordProgress(receipt: Record<string, unknown>): Promise<void>;
    },
  ) => Promise<BotDeliveryAttemptResult>;
  now?: () => number;
  createId?: () => string;
  maxAttempts?: number;
  sendingLeaseMs?: number;
  onChanged?: (payload: { botId: string; deliveryId?: string }) => void;
  /** Release payload-owned resources after the row becomes non-retryable. */
  releaseResources?: (
    row: Pick<BotDeliveryRow, 'id' | 'botId' | 'idempotencyKey'>,
    payload: BotDeliveryEnvelope,
  ) => Promise<void>;
}

export interface EnqueueBotDeliveryInput {
  botId: string;
  channelId?: string | null;
  routeId?: string | null;
  sessionId?: string | null;
  idempotencyKey: string;
  ownerGeneration?: number;
  payload: BotDeliveryEnvelope;
}

export interface RecordUnknownBotDeliveryInput extends EnqueueBotDeliveryInput {
  errorCode: string;
  message: string;
  transport: string;
  progress?: Record<string, unknown>;
}

function parseEnvelope(value: string): BotDeliveryEnvelope | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || typeof record.kind !== 'string' || !record.kind.trim()) return null;
    return record as BotDeliveryEnvelope;
  } catch {
    return null;
  }
}

function parseReceipt(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function retryDelayMs(attempts: number): number {
  const schedule = [1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000];
  return schedule[Math.min(Math.max(0, attempts - 1), schedule.length - 1)]!;
}

export function createBotDeliveryOutboxService(deps: BotDeliveryOutboxServiceDeps) {
  const now = deps.now ?? Date.now;
  const createId = deps.createId ?? randomUUID;
  const maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const sendingLeaseMs = Math.max(1_000, deps.sendingLeaseMs ?? DEFAULT_SENDING_LEASE_MS);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let drainPromise: Promise<void> | null = null;
  let disposed = false;

  const emitChanged = (botId: string, deliveryId?: string): void => {
    deps.onChanged?.({ botId, ...(deliveryId ? { deliveryId } : {}) });
  };

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const scheduleDrain = (delayMs = 0): void => {
    if (disposed) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, delayMs)));
    timer.unref?.();
  };

  const markTerminal = async (
    id: string,
    status: 'delivered' | 'dead-letter' | 'cancelled',
    lastError: string | null,
    receipt?: Record<string, unknown>,
  ): Promise<void> => {
    const at = now();
    const [current] = await getDbClient()
      .drizzle.select({
        botId: botDeliveryOutbox.botId,
        idempotencyKey: botDeliveryOutbox.idempotencyKey,
        payloadRefJson: botDeliveryOutbox.payloadRefJson,
        deliveryReceiptJson: botDeliveryOutbox.deliveryReceiptJson,
      })
      .from(botDeliveryOutbox)
      .where(and(eq(botDeliveryOutbox.id, id), eq(botDeliveryOutbox.status, 'sending')))
      .limit(1);
    const existingReceipt = parseReceipt(current?.deliveryReceiptJson);
    const [updated] = await getDbClient()
      .drizzle.update(botDeliveryOutbox)
      .set({
        status,
        lastError,
        deliveryReceiptJson: status === 'delivered'
          ? JSON.stringify({ ...existingReceipt, ...(receipt ?? {}) })
          : current?.deliveryReceiptJson ?? null,
        nextAttemptAt: null,
        updatedAt: at,
        deliveredAt: status === 'delivered' ? at : null,
      })
      .where(and(eq(botDeliveryOutbox.id, id), eq(botDeliveryOutbox.status, 'sending')))
      .returning({ botId: botDeliveryOutbox.botId });
    if (updated) {
      emitChanged(updated.botId, id);
      if ((status === 'delivered' || status === 'cancelled') && current) {
        const payload = parseEnvelope(current.payloadRefJson);
        if (payload) {
          try {
            await deps.releaseResources?.(
              { id, botId: current.botId, idempotencyKey: current.idempotencyKey },
              payload,
            );
          } catch {
            // A retained managed-media reference is safer than rolling back a
            // provider delivery that already reached a terminal state.
          }
        }
      }
    }
  };

  const markFailure = async (
    row: BotDeliveryRow,
    result: Extract<BotDeliveryAttemptResult, { ok: false }>,
  ): Promise<void> => {
    const at = now();
    const exhausted = row.attempts >= maxAttempts;
    const terminal = !result.retryable || exhausted;
    const [updated] = await getDbClient()
      .drizzle.update(botDeliveryOutbox)
      .set({
        status: terminal ? 'dead-letter' : 'failed',
        lastError: `${result.errorCode}: ${result.message}`.slice(0, 4_000),
        nextAttemptAt: terminal ? null : at + retryDelayMs(row.attempts),
        updatedAt: at,
        deliveredAt: null,
      })
      .where(and(eq(botDeliveryOutbox.id, row.id), eq(botDeliveryOutbox.status, 'sending')))
      .returning({ botId: botDeliveryOutbox.botId });
    if (updated) emitChanged(updated.botId, row.id);
  };

  const validateRouteOwnership = async (row: BotDeliveryRow): Promise<boolean> => {
    if (!row.routeId) return true;
    const [route] = await getDbClient()
      .drizzle.select({
        ownerGeneration: botRoutes.ownerGeneration,
        status: botRoutes.status,
      })
      .from(botRoutes)
      .where(eq(botRoutes.id, row.routeId))
      .limit(1);
    if (!route) {
      await markTerminal(row.id, 'cancelled', 'ROUTE_NOT_FOUND: delivery route no longer exists');
      return false;
    }
    if (route.ownerGeneration !== row.ownerGeneration) {
      await markTerminal(
        row.id,
        'cancelled',
        `STALE_ROUTE_OWNER: expected generation ${row.ownerGeneration}, current ${route.ownerGeneration}`,
      );
      return false;
    }
    if (route.status === 'active') return true;
    if (route.status === 'archived') {
      await markTerminal(row.id, 'cancelled', 'ROUTE_ARCHIVED: delivery route is archived');
      return false;
    }
    await markFailure(row, {
      ok: false,
      retryable: true,
      errorCode: 'ROUTE_UNAVAILABLE',
      message: `delivery route is ${route.status}`,
    });
    return false;
  };

  const requeueExpiredSending = async (): Promise<void> => {
    const at = now();
    const db = getDbClient().drizzle;
    const stale = await db
      .select({
        id: botDeliveryOutbox.id,
        deliveryReceiptJson: botDeliveryOutbox.deliveryReceiptJson,
      })
      .from(botDeliveryOutbox)
      .where(
        and(
          eq(botDeliveryOutbox.status, 'sending'),
          lte(botDeliveryOutbox.updatedAt, at - sendingLeaseMs),
        ),
      );
    for (const row of stale) {
      let retrySafe = true;
      try {
        const marker = row.deliveryReceiptJson
          ? JSON.parse(row.deliveryReceiptJson) as Record<string, unknown>
          : null;
        const dispatch = marker?.externalDispatch;
        if (dispatch && typeof dispatch === 'object' && !Array.isArray(dispatch)) {
          retrySafe = (dispatch as Record<string, unknown>).retrySafe !== false;
        }
      } catch {
        // A malformed diagnostic marker must not turn an otherwise recoverable
        // pre-dispatch lease into permanent message loss.
      }
      await db
        .update(botDeliveryOutbox)
        .set(
          retrySafe
            ? { status: 'failed', nextAttemptAt: at, updatedAt: at }
            : {
                status: 'dead-letter',
                nextAttemptAt: null,
                lastError:
                  'DELIVERY_OUTCOME_UNKNOWN: local adapter may have delivered before the host stopped; automatic retry was suppressed to prevent a duplicate',
                updatedAt: at,
              },
        )
        .where(
          and(
            eq(botDeliveryOutbox.id, row.id),
            eq(botDeliveryOutbox.status, 'sending'),
            lte(botDeliveryOutbox.updatedAt, at - sendingLeaseMs),
          ),
        );
    }
  };

  const claimNext = async (): Promise<{
    row: BotDeliveryRow;
    payloadRefJson: string;
  } | null> => {
    const db = getDbClient().drizzle;
    const at = now();
    const [candidate] = await db
      .select({
        id: botDeliveryOutbox.id,
        botId: botDeliveryOutbox.botId,
        channelId: botDeliveryOutbox.channelId,
        routeId: botDeliveryOutbox.routeId,
        sessionId: botDeliveryOutbox.sessionId,
        idempotencyKey: botDeliveryOutbox.idempotencyKey,
        ownerGeneration: botDeliveryOutbox.ownerGeneration,
        attempts: botDeliveryOutbox.attempts,
        payloadRefJson: botDeliveryOutbox.payloadRefJson,
      })
      .from(botDeliveryOutbox)
      .where(
        and(
          inArray(botDeliveryOutbox.status, [...RETRYABLE_STATUSES]),
          or(isNull(botDeliveryOutbox.nextAttemptAt), lte(botDeliveryOutbox.nextAttemptAt, at)),
        ),
      )
      .orderBy(asc(botDeliveryOutbox.createdAt))
      .limit(1);
    if (!candidate) return null;
    const [claimed] = await db
      .update(botDeliveryOutbox)
      .set({ status: 'sending', attempts: candidate.attempts + 1, updatedAt: at })
      .where(
        and(
          eq(botDeliveryOutbox.id, candidate.id),
          inArray(botDeliveryOutbox.status, [...RETRYABLE_STATUSES]),
          eq(botDeliveryOutbox.attempts, candidate.attempts),
        ),
      )
      .returning({ id: botDeliveryOutbox.id });
    if (!claimed) return null;
    return {
      row: {
        id: candidate.id,
        botId: candidate.botId,
        channelId: candidate.channelId,
        routeId: candidate.routeId,
        sessionId: candidate.sessionId,
        idempotencyKey: candidate.idempotencyKey,
        ownerGeneration: candidate.ownerGeneration,
        attempts: candidate.attempts + 1,
      },
      payloadRefJson: candidate.payloadRefJson,
    };
  };

  const scheduleNextDue = async (): Promise<void> => {
    if (disposed) return;
    const [next] = await getDbClient()
      .drizzle.select({ nextAttemptAt: botDeliveryOutbox.nextAttemptAt })
      .from(botDeliveryOutbox)
      .where(inArray(botDeliveryOutbox.status, [...RETRYABLE_STATUSES]))
      .orderBy(asc(botDeliveryOutbox.nextAttemptAt), asc(botDeliveryOutbox.createdAt))
      .limit(1);
    if (!next) return;
    scheduleDrain(Math.max(0, (next.nextAttemptAt ?? now()) - now()));
  };

  const runDrain = async (): Promise<void> => {
    await requeueExpiredSending();
    let processed = 0;
    while (!disposed && processed < 100) {
      const claimed = await claimNext();
      if (!claimed) break;
      processed += 1;
      const payload = parseEnvelope(claimed.payloadRefJson);
      if (!payload) {
        await markTerminal(claimed.row.id, 'dead-letter', 'INVALID_PAYLOAD: malformed envelope');
        continue;
      }
      if (!(await validateRouteOwnership(claimed.row))) continue;
      let result: BotDeliveryAttemptResult;
      const attemptState: {
        externalDispatch: { retrySafe: boolean; transport: string; startedAt: number } | null;
        progress: Record<string, unknown>;
      } = { externalDispatch: null, progress: {} };
      const persistAttemptReceipt = async (): Promise<void> => {
        const [updated] = await getDbClient()
          .drizzle.update(botDeliveryOutbox)
          .set({
            deliveryReceiptJson: JSON.stringify({
              ...(attemptState.externalDispatch
                ? {
                    externalDispatch: {
                      ...attemptState.externalDispatch,
                    },
                  }
                : {}),
              progress: attemptState.progress,
            }),
            updatedAt: now(),
          })
          .where(
            and(
              eq(botDeliveryOutbox.id, claimed.row.id),
              eq(botDeliveryOutbox.status, 'sending'),
            ),
          )
          .returning({ id: botDeliveryOutbox.id });
        if (!updated) throw new Error('Bot delivery claim was lost during external dispatch');
      };
      try {
        result = await deps.deliver(claimed.row, payload, {
          recordExternalDispatch: async (input) => {
            attemptState.externalDispatch = {
              retrySafe: input.retrySafe,
              transport: input.transport.trim() || 'unknown',
              startedAt: now(),
            };
            await persistAttemptReceipt();
          },
          recordProgress: async (receipt) => {
            attemptState.progress = { ...attemptState.progress, ...receipt };
            await persistAttemptReceipt();
          },
        });
      } catch (error) {
        result = {
          ok: false,
          retryable: true,
          errorCode: 'DELIVERY_EXCEPTION',
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (
        !result.ok
        && attemptState.externalDispatch?.retrySafe === false
        && result.retryable
      ) {
        result = {
          ok: false,
          retryable: false,
          errorCode: 'DELIVERY_OUTCOME_UNKNOWN',
          message:
            `${result.errorCode}: ${result.message}; local adapter may already have delivered, so automatic retry was suppressed`,
        };
      }
      if (result.ok) await markTerminal(claimed.row.id, 'delivered', null, result.receipt);
      else await markFailure(claimed.row, result);
    }
    await scheduleNextDue();
    if (processed >= 100) scheduleDrain(0);
  };

  function drain(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (drainPromise) return drainPromise;
    drainPromise = runDrain().finally(() => {
      drainPromise = null;
    });
    return drainPromise;
  }

  const enqueue = async (input: EnqueueBotDeliveryInput): Promise<{ id: string }> => {
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) throw new Error('Bot delivery idempotencyKey is required');
    const payloadRefJson = JSON.stringify(input.payload);
    if (Buffer.byteLength(payloadRefJson, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new Error(`Bot delivery payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    }
    const db = getDbClient().drizzle;
    const at = now();
    const id = createId();
    await db
      .insert(botDeliveryOutbox)
      .values({
        id,
        botId: input.botId,
        channelId: input.channelId ?? null,
        routeId: input.routeId ?? null,
        sessionId: input.sessionId ?? null,
        idempotencyKey,
        payloadRefJson,
        ownerGeneration: input.ownerGeneration ?? 0,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: at,
        lastError: null,
        deliveryReceiptJson: null,
        createdAt: at,
        updatedAt: at,
        deliveredAt: null,
      })
      .onConflictDoNothing({ target: botDeliveryOutbox.idempotencyKey });
    const [row] = await db
      .select({
        id: botDeliveryOutbox.id,
        botId: botDeliveryOutbox.botId,
        channelId: botDeliveryOutbox.channelId,
        routeId: botDeliveryOutbox.routeId,
        sessionId: botDeliveryOutbox.sessionId,
        ownerGeneration: botDeliveryOutbox.ownerGeneration,
        payloadRefJson: botDeliveryOutbox.payloadRefJson,
      })
      .from(botDeliveryOutbox)
      .where(eq(botDeliveryOutbox.idempotencyKey, idempotencyKey))
      .limit(1);
    if (!row) throw new Error('Bot delivery enqueue failed');
    if (
      row.botId !== input.botId
      || row.channelId !== (input.channelId ?? null)
      || row.routeId !== (input.routeId ?? null)
      || row.sessionId !== (input.sessionId ?? null)
      || row.ownerGeneration !== (input.ownerGeneration ?? 0)
      || row.payloadRefJson !== payloadRefJson
    ) {
      throw new Error(`Bot delivery idempotency conflict for ${idempotencyKey}`);
    }
    scheduleDrain(0);
    emitChanged(row.botId, row.id);
    return { id: row.id };
  };

  const recordUnknown = async (
    input: RecordUnknownBotDeliveryInput,
  ): Promise<{ id: string }> => {
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) throw new Error('Bot delivery idempotencyKey is required');
    const payloadRefJson = JSON.stringify(input.payload);
    if (Buffer.byteLength(payloadRefJson, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new Error(`Bot delivery payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    }
    const at = now();
    const id = createId();
    const deliveryReceiptJson = JSON.stringify({
      externalDispatch: {
        retrySafe: false,
        transport: input.transport.trim() || 'unknown',
        startedAt: at,
      },
      progress: input.progress ?? {},
    });
    const db = getDbClient().drizzle;
    await db
      .insert(botDeliveryOutbox)
      .values({
        id,
        botId: input.botId,
        channelId: input.channelId ?? null,
        routeId: input.routeId ?? null,
        sessionId: input.sessionId ?? null,
        idempotencyKey,
        payloadRefJson,
        ownerGeneration: input.ownerGeneration ?? 0,
        status: 'dead-letter',
        attempts: 1,
        nextAttemptAt: null,
        lastError: `${input.errorCode}: ${input.message}`.slice(0, 4_000),
        deliveryReceiptJson,
        createdAt: at,
        updatedAt: at,
        deliveredAt: null,
      })
      .onConflictDoNothing({ target: botDeliveryOutbox.idempotencyKey });
    const [row] = await db
      .select({
        id: botDeliveryOutbox.id,
        botId: botDeliveryOutbox.botId,
        channelId: botDeliveryOutbox.channelId,
        routeId: botDeliveryOutbox.routeId,
        sessionId: botDeliveryOutbox.sessionId,
        ownerGeneration: botDeliveryOutbox.ownerGeneration,
        payloadRefJson: botDeliveryOutbox.payloadRefJson,
      })
      .from(botDeliveryOutbox)
      .where(eq(botDeliveryOutbox.idempotencyKey, idempotencyKey))
      .limit(1);
    if (!row) throw new Error('Bot delivery recovery record failed');
    if (
      row.botId !== input.botId
      || row.channelId !== (input.channelId ?? null)
      || row.routeId !== (input.routeId ?? null)
      || row.sessionId !== (input.sessionId ?? null)
      || row.ownerGeneration !== (input.ownerGeneration ?? 0)
      || row.payloadRefJson !== payloadRefJson
    ) {
      throw new Error(`Bot delivery idempotency conflict for ${idempotencyKey}`);
    }
    emitChanged(row.botId, row.id);
    return { id: row.id };
  };

  const retry = async (
    id: string,
    botId: string,
    opts: { allowDuplicateRisk?: boolean } = {},
  ): Promise<{ id: string }> => {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select({
        id: botDeliveryOutbox.id,
        botId: botDeliveryOutbox.botId,
        routeId: botDeliveryOutbox.routeId,
        sessionId: botDeliveryOutbox.sessionId,
        ownerGeneration: botDeliveryOutbox.ownerGeneration,
        status: botDeliveryOutbox.status,
        deliveryReceiptJson: botDeliveryOutbox.deliveryReceiptJson,
      })
      .from(botDeliveryOutbox)
      .where(eq(botDeliveryOutbox.id, id))
      .limit(1);
    if (!row || row.botId !== botId) throw new Error('Bot delivery is unavailable');
    if (row.status === 'pending' || row.status === 'sending' || row.status === 'delivered') {
      return { id: row.id };
    }
    if (row.status !== 'failed' && row.status !== 'dead-letter') {
      throw new Error(`Bot delivery in status ${row.status} cannot be retried`);
    }
    const [profile] = await db
      .select({
        canonicalSessionId: botProfiles.canonicalSessionId,
        status: botProfiles.status,
      })
      .from(botProfiles)
      .where(eq(botProfiles.id, botId))
      .limit(1);
    if (!profile || profile.status !== 'active') {
      throw new Error('Restore the Bot before retrying this delivery');
    }
    const priorReceipt = parseReceipt(row.deliveryReceiptJson);
    const priorDispatch = priorReceipt.externalDispatch;
    const duplicateRisk = priorDispatch
      && typeof priorDispatch === 'object'
      && !Array.isArray(priorDispatch)
      && (priorDispatch as Record<string, unknown>).retrySafe === false;
    if (duplicateRisk && opts.allowDuplicateRisk !== true) {
      throw new Error(
        'Bot delivery may already be partially visible; explicit duplicate-risk confirmation is required',
      );
    }
    if (row.routeId) {
      const [route] = await db
        .select({
          botId: botRoutes.botId,
          currentSessionId: botRoutes.currentSessionId,
          ownerGeneration: botRoutes.ownerGeneration,
          status: botRoutes.status,
        })
        .from(botRoutes)
        .where(eq(botRoutes.id, row.routeId))
        .limit(1);
      if (!route || route.botId !== botId) throw new Error('Bot delivery route is unavailable');
      if (route.status !== 'active') {
        throw new Error(`Bot delivery route is ${route.status}`);
      }
      if (row.sessionId && route.currentSessionId !== row.sessionId) {
        throw new Error('Bot delivery route now points to a different task');
      }
      if (route.ownerGeneration !== row.ownerGeneration) {
        throw new Error('Bot delivery route ownership changed; create a new delivery instead');
      }
    } else if (row.sessionId && profile.canonicalSessionId !== row.sessionId) {
      throw new Error('Bot canonical task changed; create a new delivery instead');
    }
    const at = now();
    const [updated] = await db
      .update(botDeliveryOutbox)
      .set({
        status: 'pending',
        attempts: 0,
        nextAttemptAt: at,
        lastError: null,
        deliveryReceiptJson: null,
        deliveredAt: null,
        updatedAt: at,
      })
      .where(
        and(
          eq(botDeliveryOutbox.id, id),
          eq(botDeliveryOutbox.botId, botId),
          inArray(botDeliveryOutbox.status, ['failed', 'dead-letter']),
        ),
      )
      .returning({ id: botDeliveryOutbox.id });
    if (!updated) return retry(id, botId);
    scheduleDrain(0);
    emitChanged(botId, id);
    return updated;
  };

  const listForBot = async (botId: string, limit = 100): Promise<BotDeliveryView[]> => {
    const rows = await getDbClient()
      .drizzle.select({
        id: botDeliveryOutbox.id,
        botId: botDeliveryOutbox.botId,
        channelId: botDeliveryOutbox.channelId,
        channelKind: botChannels.kind,
        routeId: botDeliveryOutbox.routeId,
        routeKey: botRoutes.routeKey,
        routeStatus: botRoutes.status,
        sessionId: botDeliveryOutbox.sessionId,
        payloadRefJson: botDeliveryOutbox.payloadRefJson,
        ownerGeneration: botDeliveryOutbox.ownerGeneration,
        attempts: botDeliveryOutbox.attempts,
        status: botDeliveryOutbox.status,
        lastError: botDeliveryOutbox.lastError,
        deliveryReceiptJson: botDeliveryOutbox.deliveryReceiptJson,
        createdAt: botDeliveryOutbox.createdAt,
        updatedAt: botDeliveryOutbox.updatedAt,
        deliveredAt: botDeliveryOutbox.deliveredAt,
      })
      .from(botDeliveryOutbox)
      .leftJoin(botChannels, eq(botDeliveryOutbox.channelId, botChannels.id))
      .leftJoin(botRoutes, eq(botDeliveryOutbox.routeId, botRoutes.id))
      .where(eq(botDeliveryOutbox.botId, botId))
      .orderBy(desc(botDeliveryOutbox.updatedAt), desc(botDeliveryOutbox.createdAt))
      .limit(Math.min(500, Math.max(1, Math.floor(limit))));
    return rows.map((row) => ({
      id: row.id,
      botId: row.botId,
      channelId: row.channelId,
      channelKind: row.channelKind,
      routeId: row.routeId,
      routeKey: row.routeKey,
      routeStatus: row.routeStatus,
      sessionId: row.sessionId,
      payloadKind: parseEnvelope(row.payloadRefJson)?.kind ?? 'invalid',
      ownerGeneration: row.ownerGeneration,
      attempts: row.attempts,
      status: row.status,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deliveredAt: row.deliveredAt,
      diagnostic: parseBotDeliveryDiagnostic(row.deliveryReceiptJson),
    }));
  };

  /**
   * Stop every non-terminal delivery owned by a paused Bot. A row that was
   * already claimed as `sending` may finish its adapter call, but its later
   * CAS write no longer matches and therefore cannot resurrect the row.
   */
  const suspendForBot = async (botId: string): Promise<number> => {
    const at = now();
    const rows = await getDbClient()
      .drizzle.update(botDeliveryOutbox)
      .set({
        status: 'suspended',
        nextAttemptAt: null,
        lastError: 'BOT_PAUSED: delivery is suspended until the Bot resumes',
        deliveryReceiptJson: null,
        updatedAt: at,
        deliveredAt: null,
      })
      .where(
        and(
          eq(botDeliveryOutbox.botId, botId),
          inArray(botDeliveryOutbox.status, ['pending', 'sending', 'failed']),
        ),
      )
      .returning({ id: botDeliveryOutbox.id });
    if (rows.length > 0) emitChanged(botId);
    return rows.length;
  };

  const resumeForBot = async (botId: string): Promise<number> => {
    const at = now();
    const rows = await getDbClient()
      .drizzle.update(botDeliveryOutbox)
      .set({
        status: 'pending',
        nextAttemptAt: at,
        lastError: null,
        deliveryReceiptJson: null,
        updatedAt: at,
        deliveredAt: null,
      })
      .where(
        and(
          eq(botDeliveryOutbox.botId, botId),
          eq(botDeliveryOutbox.status, 'suspended'),
        ),
      )
      .returning({ id: botDeliveryOutbox.id });
    if (rows.length > 0) {
      scheduleDrain(0);
      emitChanged(botId);
    }
    if (rows.length > 0) emitChanged(botId);
    return rows.length;
  };

  const cancelForBot = async (botId: string, reason: string): Promise<number> => {
    const at = now();
    const rows = await getDbClient()
      .drizzle.update(botDeliveryOutbox)
      .set({
        status: 'cancelled',
        nextAttemptAt: null,
        lastError: reason.slice(0, 4_000),
        deliveryReceiptJson: null,
        updatedAt: at,
        deliveredAt: null,
      })
      .where(
        and(
          eq(botDeliveryOutbox.botId, botId),
          inArray(botDeliveryOutbox.status, ['pending', 'sending', 'suspended', 'failed']),
        ),
      )
      .returning({ id: botDeliveryOutbox.id });
    return rows.length;
  };

  const restore = async (): Promise<void> => {
    const db = getDbClient().drizzle;
    const at = now();
    await requeueExpiredSending();
    const [leased] = await db
      .select({ updatedAt: botDeliveryOutbox.updatedAt })
      .from(botDeliveryOutbox)
      .where(eq(botDeliveryOutbox.status, 'sending'))
      .orderBy(asc(botDeliveryOutbox.updatedAt))
      .limit(1);
    if (leased) scheduleDrain(Math.max(0, leased.updatedAt + sendingLeaseMs - at));
    await drain();
  };

  const dispose = (): void => {
    disposed = true;
    clearTimer();
  };

  return {
    enqueue,
    recordUnknown,
    listForBot,
    retry,
    drain,
    restore,
    suspendForBot,
    resumeForBot,
    cancelForBot,
    dispose,
  };
}

export type BotDeliveryOutboxService = ReturnType<typeof createBotDeliveryOutboxService>;

import { randomUUID } from 'node:crypto';
import { retainDbClient } from '../localDb/client/pendingOperations.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { auxiliaryUsageReceipts } from '../localDb/schema.js';
import { localDayKey } from '../localDb/dailySpend.js';
import { createLogger } from '../logger.js';

import type {
  AuxiliaryTokens,
  AuxiliaryAttribution,
  AuxiliaryUsageRecorder,
} from '../../shared/auxiliaryUsage.js';
const log = createLogger('auxiliary-usage');
let notifyUsageChanged: (() => void) | undefined;
export function setAuxiliaryUsageChangedListener(listener: () => void): void {
  notifyUsageChanged = listener;
}

/** Capture the owner and client before dispatch; a late response must never use the new account. */
export function createAuxiliaryUsageRecorder(
  attribution: AuxiliaryAttribution = {},
): AuxiliaryUsageRecorder {
  const snapshot = getCurrentDbClientSnapshot();
  const release = snapshot ? retainDbClient(snapshot.client) : () => {};
  const record = async (
    tokens: AuxiliaryTokens,
    route: AuxiliaryAttribution = {},
    receiptId: string = randomUUID(),
  ) => {
    if (!snapshot) return;
    const clean = (n: number | undefined) =>
      typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
    const facts = {
      inputTokens: clean(tokens.inputTokens),
      outputTokens: clean(tokens.outputTokens),
      cacheReadTokens: clean(tokens.cacheReadTokens),
      cacheCreateTokens: clean(tokens.cacheCreateTokens),
    };
    if (Object.values(facts).every((n) => n === null)) return;
    const metadata = { ...attribution, ...route };
    const now = Date.now();
    try {
      await snapshot.client.drizzle
        .insert(auxiliaryUsageReceipts)
        .values({
          receiptId,
          providerId: metadata.providerId ?? 'unknown',
          model: metadata.model ?? 'unknown',
          source: metadata.source ?? 'auxiliary',
          sessionId: metadata.sessionId ?? null,
          transport: metadata.transport ?? 'unknown',
          // Match the normal usage ledger: each received usage fact belongs to its settlement day.
          day: localDayKey(now),
          recordedAt: now,
          ...facts,
        })
        .onConflictDoNothing()
        .run();
      if (getCurrentDbClientSnapshot() === snapshot) notifyUsageChanged?.();
    } catch (error) {
      log.warn('auxiliary usage receipt could not be persisted', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  };
  return Object.assign(record, { close: release });
}

export function createOneShotUsageRecorder(
  _agentKind: string,
  opts?: { source?: string; sessionId?: string; providerId?: string; model?: string },
) {
  const record = createAuxiliaryUsageRecorder({
    source: opts?.source ?? 'auxiliary',
    sessionId: opts?.sessionId,
    providerId: opts?.providerId,
    model: opts?.model,
    transport: 'agent-one-shot',
  });
  return {
    onUsage: (usage: AuxiliaryTokens & { model?: string }) =>
      record(usage, {
        ...(usage.model ? { model: usage.model } : {}),
      }),
    close: record.close,
  };
}

export async function withAuxiliaryUsage<T>(
  attribution: AuxiliaryAttribution,
  run: (record: AuxiliaryUsageRecorder) => Promise<T>,
): Promise<T> {
  const record = createAuxiliaryUsageRecorder(attribution);
  try {
    return await run(record);
  } finally {
    record.close();
  }
}

import { shareAvailabilityRequest } from './providerShareAvailabilityTransport.js';
import fs from 'node:fs';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { captureProviderManagementScope } from '../provider-group/managementScope.js';
import { createLogger } from '../logger.js';
import type { GuestUsageSample } from '../remote-agent/host/guestUsage.js';
import { getProviderShareUsageStore, providerUsageLocalDay } from './providerShareUsageStore.js';

const COUNTERS = ['turns', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreateTokens', 'sdkCostUsd'] as const;
export interface StandbyUsageTotal {
  id: string; memberId: string; guestDeviceId: string; sessionId: string; generation: string;
  executorDeviceId: string; providerId: string; memberKey?: string; kind: string; day: string; model: string; sequence: number;
  totals: Record<(typeof COUNTERS)[number], number>;
}
type Pending = StandbyUsageTotal & { shareId: string; sent?: number };
const log = createLogger('provider-share-standby-usage');
const filePath = () => ownerScopedUserDataPath('provider-share-standby-usage.json');
const outbox = createOverrideSettingsFile<{ entries: Record<string, Pending> | null }>({
  filePath, scopeKey: activeOwnerScopeKey,
  defaults: () => {
    try { fs.statSync(filePath()); return { entries: null }; }
    catch (error) { return { entries: (error as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null }; }
  },
  normalize(raw) {
    const entries = (raw as { entries?: Record<string, Pending> })?.entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)
      || Object.values(entries).some(row => !row || !Number.isSafeInteger(row.sequence)
        || !row.totals || COUNTERS.some(key => !Number.isFinite(row.totals[key]) || row.totals[key] < 0))) return { entries: null };
    return { entries };
  },
  log, label: 'provider-share-standby-usage', maxBytes: 32 * 1024 * 1024, preserveUnreadableFile: true, logLoadedValue: false,
});
/** Local cumulative totals survive an unavailable owner/server and ambiguous acknowledgements. */
export async function recordStandbyUsage(identity: Pick<Pending, 'shareId' | 'memberId' | 'guestDeviceId' | 'sessionId' | 'generation'>,
  samples: readonly GuestUsageSample[]): Promise<void> {
  const assertCurrent = captureProviderManagementScope();
  const day = providerUsageLocalDay(Date.now());
  await outbox.updateAtomic(({ value }) => {
    assertCurrent();
    if (!value.entries) throw new Error('Standby usage history is unavailable');
    const entries = { ...value.entries };
    const cutoff = providerUsageLocalDay(Date.now() - 400 * 86400_000);
    for (const [key, row] of Object.entries(entries)) if (row.day < cutoff) delete entries[key];
    for (const sample of samples) {
      const key = JSON.stringify([identity.shareId, identity.generation, day, sample.model]);
      const old = entries[key];
      if (!old && Object.keys(entries).length >= 20_000) throw new Error('Standby usage history is full');
      const totals = Object.fromEntries(COUNTERS.map(counter => [counter, (old?.totals[counter] ?? 0) + sample[counter]])) as Pending['totals'];
      entries[key] = { ...identity, day, model: sample.model, totals, sequence: (old?.sequence ?? 0) + 1,
        id: '', kind: '', providerId: '', executorDeviceId: '', sent: old?.sent };
    }
    return { entries };
  });
}
let flushing: Promise<void> | undefined;
export function flushStandbyUsage(): Promise<void> {
  if (flushing) return flushing;
  const assertCurrent = captureProviderManagementScope();
  const work = (async () => {
    assertCurrent();
    outbox.invalidateIfChanged();
    const entries = outbox.read().entries;
    if (!entries) throw new Error('Standby usage history is unavailable');
    // Bound one background pass. New/changed totals remain pending for the next pass.
    for (const [key, row] of Object.entries(entries).filter(([, row]) => row.sent !== row.sequence).slice(0, 100)) {
      assertCurrent();
      await shareAvailabilityRequest(row.shareId, 'usage-report', { usage: row });
      assertCurrent();
      await outbox.updateAtomic(({ value }) => {
        assertCurrent();
        if (!value.entries) throw new Error('Standby usage history is unavailable');
        const current = value.entries[key];
        return { entries: { ...value.entries, ...(current ? { [key]: { ...current, sent: row.sequence } } : {}) } };
      });
    }
  })();
  flushing = work;
  return work.finally(() => { if (flushing === work) flushing = undefined; });
}
export async function importStandbyUsage(shareId: string): Promise<void> {
  const assertCurrent = captureProviderManagementScope();
  const usage = getProviderShareUsageStore();
  if (!usage) return;
  let cursor = '';
  // Pages are bounded server-side. Re-reading is idempotent, including after restart.
  for (;;) {
    const rows = await shareAvailabilityRequest<StandbyUsageTotal[]>(shareId, 'usage-read', { cursor });
    assertCurrent();
    for (const row of rows) await usage.importStandbyTotal(shareId, row);
    assertCurrent();
    if (rows.length < 100) return;
    const next = rows.at(-1)!.id;
    if (next <= cursor) throw new Error('Invalid standby usage cursor');
    cursor = next;
  }
}

import type { AgentEvent } from '@cindy/maker-core';
import { randomUUID } from 'node:crypto';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { ownerScopedPath, ownerGeneration, isOwnerBoundaryPending } from '../ownerContext.js';

const log = desktopMakerLogger.child('scheduler-billing');
type Hold = { version: string; notified: boolean };
type Holds = { holds: Record<string, Hold> };
const file = createOverrideSettingsFile<Holds>({
  filePath: () => ownerScopedPath('scheduled-billing-holds.json'),
  scopeKey: () => String(ownerGeneration()),
  defaults: { holds: {} },
  normalize(raw) {
    const value = (raw as Partial<Holds> | null)?.holds;
    const holds: Record<string, Hold> = Object.create(null);
    for (const [id, entry] of Object.entries(value ?? {})) {
      if (typeof entry?.version === 'string' && /^[a-f0-9-]{36}$/.test(entry.version) && typeof entry.notified === 'boolean') {
        holds[id] = { version: entry.version, notified: entry.notified };
      }
    }
    return { holds };
  },
  label: 'scheduled billing holds', log, logLoadedValue: false, preserveUnreadableFile: true,
  maxBytes: 256 * 1024,
});

// Publish a rejection synchronously, including while its durable write is taking the file lock.
const pending = new Map<string, { hold: Hold | null }>();
let writes = Promise.resolve();

export function scheduledBillingHold(providerId: string): Hold | null {
  const change = pending.get(ownerGeneration() + ':' + providerId);
  if (change) return change.hold;
  file.invalidateIfChanged();
  const holds = file.read().holds;
  return Object.hasOwn(holds, providerId) ? holds[providerId] : null;
}

function update(providerId: string, hold: Hold | null, expected?: string) {
  const generation = ownerGeneration();
  const key = generation + ':' + providerId;
  const change = { hold };
  pending.set(key, change);
  writes = writes.then(async () => {
    if (generation !== ownerGeneration() || isOwnerBoundaryPending()) return;
    await file.updateAtomic(({ value }) => {
      if (expected && value.holds[providerId]?.version !== expected) return null;
      const holds = { ...value.holds };
      if (hold) return { holds: { ...holds, [providerId]: hold } };
      delete holds[providerId];
      return { holds };
    });
  }).then(() => {
    if (pending.get(key) === change) pending.delete(key);
  }).catch(() => log.warn('could not persist scheduled billing state'));
}

/** Each rejection invalidates success evidence from requests already in flight. */
export function rejectScheduledBilling(providerId: string): void {
  const previous = scheduledBillingHold(providerId);
  update(providerId, { version: randomUUID(), notified: previous?.notified ?? false });
}

export function claimScheduledBillingNotice(providerId: string): boolean {
  const hold = scheduledBillingHold(providerId);
  if (!hold || hold.notified) return false;
  update(providerId, { ...hold, notified: true }, hold.version);
  return true;
}

export function captureScheduledBillingRecovery(providerId: string): (() => void) | undefined {
  const generation = ownerGeneration();
  const version = scheduledBillingHold(providerId)?.version;
  if (!version) return;
  return () => {
    if (!isOwnerBoundaryPending() && generation === ownerGeneration() && scheduledBillingHold(providerId)?.version === version) {
      update(providerId, null, version);
    }
  };
}

export function captureManualPiBillingRecovery(providerId: string) {
  const recover = captureScheduledBillingRecovery(providerId);
  if (!recover) return;
  return (event: AgentEvent) => {
    const result = event.data as { status?: string; result?: string; silentStop?: boolean; cancelled?: boolean } | null;
    if (event.type === 'done' && event.source === 'pi' && result?.status === 'completed' &&
        !result.silentStop && !result.cancelled && typeof result.result === 'string' && result.result.trim()) recover();
  };
}

export function flushScheduledBillingWrites(): Promise<void> { return writes; }

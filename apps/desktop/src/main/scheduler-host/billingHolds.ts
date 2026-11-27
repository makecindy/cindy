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
interface PendingChange {
  hold: Hold | null;
  // Shared by successive mutations for this connection. Advance only after an actual commit.
  durable: { version: string | null };
  retry?: () => void;
}
const pending = new Map<string, PendingChange>();
let writes = Promise.resolve();

export function scheduledBillingHold(providerId: string): Hold | null {
  const change = pending.get(ownerGeneration() + ':' + providerId);
  if (change) {
    change.retry?.();
    return change.hold;
  }
  file.invalidateIfChanged();
  const holds = file.read().holds;
  return Object.hasOwn(holds, providerId) ? holds[providerId] : null;
}

function update(providerId: string, hold: Hold | null, previous: Hold | null, newRejection = false) {
  const generation = ownerGeneration();
  const key = generation + ':' + providerId;
  const durable = pending.get(key)?.durable ?? { version: previous?.version ?? null };
  const change: PendingChange = { hold, durable };
  pending.set(key, change);

  function enqueue(compareVersion: boolean) {
    change.retry = undefined;
    writes = writes.then(async () => {
      if (generation === ownerGeneration() && !isOwnerBoundaryPending()) {
        let applied = false;
        await file.updateAtomic(({ value }) => {
          const storedVersion = value.holds[providerId]?.version ?? null;
          if (compareVersion && storedVersion !== durable.version) return null;
          applied = true;
          if (hold) return { holds: { ...value.holds, [providerId]: hold } };
          const holds = { ...value.holds };
          delete holds[providerId];
          return { holds };
        });
        if (applied) durable.version = hold?.version ?? null;
      }
      // A CAS miss exposes the other writer's state. Later queued writes still compare
      // against our last real commit, so an old recovery cannot clear that other rejection.
      if (pending.get(key) === change) pending.delete(key);
    }).catch(() => {
      // Keep blocking in memory on I/O failure. Retry on the next access, at most once
      // while that write is in flight. The notification can also persist the full hold.
      change.retry = () => enqueue(true);
      log.warn('could not persist scheduled billing state');
    });
  }
  enqueue(!newRejection);
}

/** Each rejection invalidates success evidence from requests already in flight. */
export function rejectScheduledBilling(providerId: string): void {
  const previous = scheduledBillingHold(providerId);
  update(providerId, { version: randomUUID(), notified: previous?.notified ?? false }, previous, true);
}

export function claimScheduledBillingNotice(providerId: string): boolean {
  const hold = scheduledBillingHold(providerId);
  if (!hold || hold.notified) return false;
  update(providerId, { ...hold, notified: true }, hold);
  return true;
}

export function captureScheduledBillingRecovery(providerId: string): (() => void) | undefined {
  const generation = ownerGeneration();
  const hold = scheduledBillingHold(providerId);
  if (!hold) return;
  return () => {
    if (!isOwnerBoundaryPending() && generation === ownerGeneration() && scheduledBillingHold(providerId)?.version === hold.version) {
      update(providerId, null, hold);
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

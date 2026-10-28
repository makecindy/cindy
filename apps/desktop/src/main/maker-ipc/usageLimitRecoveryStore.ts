import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import { sanitizeQueuedMessageForPersistence } from '../../shared/agentInputQueue.js';
import { isRestorableQueuedMessage } from '../localDb/agentInputQueueSnapshots.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';

export interface UsageLimitRecoverySnapshot {
  kind: 'active-turn' | 'queue-head';
  item: AgentInputQueuedMessage;
  error: string;
}

export interface SavedUsageLimitWait extends UsageLimitRecoverySnapshot {
  id: string;
  sessionId: string;
  resumeAt: number;
  attempts: number;
  groupQuota?: boolean;
  savedAt: number;
  route: string;
}

/** Reuse the owner-scoped atomic file store, including its cross-process lock. */
export function createUsageLimitRecoveryStore(options: {
  filePath(): string;
  scopeKey(): string;
  log: { info(message: string, meta?: Record<string, unknown>): void; warn(message: string, meta?: Record<string, unknown>): void };
}) {
  const writes = new Set<Promise<unknown>>();
  function track<T>(write: Promise<T>): Promise<T> {
    writes.add(write);
    void write.then(() => writes.delete(write), () => writes.delete(write));
    return write;
  }
  const file = createOverrideSettingsFile<{ waits: Record<string, SavedUsageLimitWait> }>({
    ...options,
    label: 'usage-limit-recovery',
    defaults: { waits: {} },
    maxBytes: 16 * 1024 * 1024,
    preserveUnreadableFile: true,
    logLoadedValue: false,
    logReadErrorDetails: false,
    normalize(raw) {
      const source = (raw as { waits?: unknown } | null)?.waits;
      const waits: Record<string, SavedUsageLimitWait> = {};
      if (source && typeof source === 'object' && !Array.isArray(source)) {
        for (const [sid, value] of Object.entries(source)) {
          const v = value as SavedUsageLimitWait | null;
          if (!v || v.sessionId !== sid || typeof v.id !== 'string' || !v.id ||
            !['active-turn', 'queue-head'].includes(v.kind) || typeof v.error !== 'string' ||
            typeof v.route !== 'string' || !Number.isFinite(v.resumeAt) || v.resumeAt <= 0 ||
            !Number.isFinite(v.savedAt) || !Number.isInteger(v.attempts) || v.attempts < 0 ||
            !isRestorableQueuedMessage(v.item) || v.item.sharedTaskAuthor) continue;
          Object.defineProperty(waits, sid, { enumerable: true, configurable: true, writable: true,
            value: { ...v, item: sanitizeQueuedMessageForPersistence(v.item) } });
        }
      }
      return { waits };
    },
  });
  return {
    async flush() { await Promise.all([...writes]); },
    readAll() { file.invalidateIfChanged(); return Object.values(file.read().waits); },
    async save(value: SavedUsageLimitWait, isCurrent = () => true): Promise<boolean> {
      let saved = false;
      await track(file.updateAtomic(current => {
        if (!isCurrent()) return { waits: current.value.waits };
        saved = true;
        return { waits: { ...current.value.waits,
          [value.sessionId]: { ...value, item: sanitizeQueuedMessageForPersistence(value.item) },
        } };
      }));
      return saved;
    },
    /** Delete before dispatch: a second instance or restart cannot replay a claimed turn. */
    async take(sessionId: string, id: string): Promise<boolean> {
      let taken = false;
      await track(file.updateAtomic(current => {
        const waits = { ...current.value.waits };
        if (waits[sessionId]?.id === id) { delete waits[sessionId]; taken = true; }
        return { waits };
      }));
      return taken;
    },
  };
}

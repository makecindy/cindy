import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { ChipWindowSlot } from './quotaResetRollup';

interface Observation {
  full: boolean;
  updatedAt: number | null;
}

/** View-only history shared across task mounts for the lifetime of this renderer. */
export class QuotaFullCelebrations {
  private ownerId = getDataOwnerGeneration().dataOwnerId;
  private readonly providers = new Map<
    string,
    {
      celebrated: boolean;
      windows: Map<string, Observation>;
    }
  >();

  observe(
    provider: string,
    windows: readonly (Pick<ChipWindowSlot, 'key' | 'remainingPercent'> & {
      resetPending: boolean;
    })[],
    snapshotUpdatedAt?: number | null,
  ): string | null {
    const ownerId = getDataOwnerGeneration().dataOwnerId;
    if (ownerId !== this.ownerId) {
      this.providers.clear();
      this.ownerId = ownerId;
    }
    let history = this.providers.get(provider);
    if (!history) {
      history = { celebrated: false, windows: new Map() };
      this.providers.set(provider, history);
    }
    const updatedAt =
      typeof snapshotUpdatedAt === 'number' &&
      Number.isFinite(snapshotUpdatedAt) &&
      snapshotUpdatedAt > 0
        ? snapshotUpdatedAt
        : null;
    let celebratingKey: string | null = null;
    windows.forEach((window) => {
      // Pending windows show text, not a percentage. Missing data never rearms a burst.
      if (window.resetPending || !Number.isFinite(window.remainingPercent)) return;
      const previous = history.windows.get(window.key);
      // Snapshot timestamps only reject stale task data; reset deadlines play no role.
      if (previous?.updatedAt != null) {
        if (updatedAt === null || updatedAt <= previous.updatedAt) return;
      }
      const full = window.remainingPercent === 100;
      const recovered = full && (previous ? !previous.full : !history.celebrated);
      history.windows.set(window.key, {
        full,
        updatedAt,
      });
      if (recovered) {
        history.celebrated = true;
        celebratingKey ??= window.key;
      }
    });
    // Consume all full windows together: one supplier update produces at most one burst.
    return celebratingKey;
  }
}

export const quotaFullCelebrations = new QuotaFullCelebrations();

import {
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import type { ModelVisibilityInitializationFailure } from '@/state/modelVisibilityPrefs';

export type LocalCatalogFailureReason = ModelVisibilityInitializationFailure
  | 'preferences-unavailable' | 'catalog-unavailable';

export interface LocalCatalogFailure {
  readonly reason: LocalCatalogFailureReason;
}

// Error state is separate from the last complete catalog: a failed refresh must
// neither erase usable models nor show another account's failure after a switch.
let failure: { owner: DataOwnerGeneration; value: LocalCatalogFailure } | null = null;
const listeners = new Set<() => void>();

export function getLocalCatalogFailure(): LocalCatalogFailure | null {
  return failure && isDataOwnerGenerationCurrent(failure.owner) ? failure.value : null;
}

export function subscribeLocalCatalogFailure(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setLocalCatalogFailure(owner: DataOwnerGeneration, reason: LocalCatalogFailureReason | null): void {
  if (!isDataOwnerGenerationCurrent(owner)) return;
  if (getLocalCatalogFailure()?.reason === reason || (!failure && reason === null)) return;
  failure = reason === null ? null : { owner, value: { reason } };
  for (const listener of listeners) listener();
}

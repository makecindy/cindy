import {
  isDataOwnerPushStamp,
  type DataOwnerPushStamp,
} from '../../shared/dataOwnerPush';

export interface DataOwnerGeneration {
  readonly dataOwnerId: string | null;
  readonly generation: number;
}

let current: DataOwnerGeneration = {
  dataOwnerId: null,
  generation: 0,
};

/** Publish the renderer data owner synchronously, before React state updates settle. */
export function setDataOwnerGeneration(dataOwnerId: string | null, generation?: number): void {
  const nextGeneration =
    typeof generation === 'number' && Number.isInteger(generation) && generation >= 0
      ? generation
      : current.generation + 1;
  if (current.dataOwnerId === dataOwnerId && current.generation === nextGeneration) return;
  current = {
    dataOwnerId,
    generation: nextGeneration,
  };
}

export function getDataOwnerGeneration(): DataOwnerGeneration {
  return current;
}

export function isDataOwnerGenerationCurrent(
  owner: DataOwnerGeneration,
): boolean {
  return (
    current.dataOwnerId === owner.dataOwnerId
    && current.generation === owner.generation
  );
}

/**
 * Whether `owner` still names the active data owner, regardless of generation.
 *
 * A same-owner re-commit (Ghost projection repair, account-free repair) advances
 * `generation` without changing the owner or its renderer-side storage
 * namespaces, and nothing remounts. Long-lived UI that persists into the owner's
 * namespace (a mounted composer editor) must keep working across such bumps, so
 * it qualifies by owner id only. In-flight async work that must not span a
 * runtime teardown keeps using {@link isDataOwnerGenerationCurrent}.
 */
export function isDataOwnerIdCurrent(owner: DataOwnerGeneration): boolean {
  return current.dataOwnerId === owner.dataOwnerId;
}

/** Validate a main-process live push against the renderer's current owner. */
export function isDataOwnerPushStampCurrent(stamp: unknown): stamp is DataOwnerPushStamp {
  if (!isDataOwnerPushStamp(stamp)) return false;
  return (
    current.dataOwnerId === stamp.dataOwnerId &&
    current.generation === stamp.ownerGeneration
  );
}

/**
 * Accept legacy unstamped broadcasts, but fail closed when a sender provides
 * an owner stamp that does not match the renderer's current auth boundary.
 */
export function isDataOwnerPushCurrent(ownerStamp: unknown): boolean {
  return ownerStamp === undefined || isDataOwnerPushStampCurrent(ownerStamp);
}

export const __testing = {
  reset(): void {
    current = { dataOwnerId: null, generation: 0 };
  },
};

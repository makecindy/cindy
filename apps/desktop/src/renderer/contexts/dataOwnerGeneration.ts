export interface DataOwnerGeneration {
  readonly dataOwnerId: string | null;
  readonly generation: number;
}

let current: DataOwnerGeneration = {
  dataOwnerId: null,
  generation: 0,
};

/** Publish the renderer data owner synchronously, before React state updates settle. */
export function setDataOwnerGeneration(dataOwnerId: string | null): void {
  if (current.dataOwnerId === dataOwnerId) return;
  current = {
    dataOwnerId,
    generation: current.generation + 1,
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

export const __testing = {
  reset(): void {
    current = { dataOwnerId: null, generation: 0 };
  },
};

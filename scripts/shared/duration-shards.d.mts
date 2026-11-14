export interface WeightedKey {
  key: string;
  weight: number;
}

export function medianWeight(weights: Iterable<number>): number;

export function assignByDuration<T extends WeightedKey>(items: readonly T[], count: number): T[][];

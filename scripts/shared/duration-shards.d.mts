export interface WeightedKey {
  key: string;
  weight: number;
}

export function medianWeight(weights: Iterable<number>): number;

export function assignByDuration(items: readonly WeightedKey[], count: number): string[][];

export function orderByDuration(items: readonly WeightedKey[]): string[];

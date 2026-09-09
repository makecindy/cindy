import type { Effort } from './types.js';

export function piSupportedEfforts(model: {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>> | null;
}): Effort[];

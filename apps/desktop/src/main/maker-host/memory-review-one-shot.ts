import { requestUtilityText } from '../utility-model/oneShotCandidates.js';
import { getMakerIfReady } from './index.js';
import { createMemoryReviewOneShotCore, type MemoryReviewOneShotDeps, type MemoryReviewOneShot } from './memory-review-one-shot-core.js';

export type { MemoryReviewOneShot, MemoryReviewOneShotDeps } from './memory-review-one-shot-core.js';

const DEFAULT_DEPS: MemoryReviewOneShotDeps = {
  getMaker: getMakerIfReady,
  requestText: requestUtilityText,
};

export function createMemoryReviewOneShot(
  deps: Partial<MemoryReviewOneShotDeps> = {},
): MemoryReviewOneShot {
  const resolved: MemoryReviewOneShotDeps = { ...DEFAULT_DEPS, ...deps };
  return createMemoryReviewOneShotCore(resolved);
}

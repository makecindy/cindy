export * from '@cindy/maker-core/auto-review-model-router';
import { createAutoReviewModelRouter as createRouter, type AutoReviewModelRouterDeps } from '@cindy/maker-core/auto-review-model-router';
import { requestDedicatedAutoReviewCandidateText } from '../utility-model/oneShotCandidates.js';

/** Desktop keeps its owner-bound runtime; shared routing never imports a host singleton. */
export function createAutoReviewModelRouter(deps: Omit<AutoReviewModelRouterDeps, 'requestCandidate'> & Partial<Pick<AutoReviewModelRouterDeps, 'requestCandidate'>>) {
  return createRouter({ ...deps, requestCandidate: deps.requestCandidate ?? requestDedicatedAutoReviewCandidateText });
}

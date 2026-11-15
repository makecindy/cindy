// The router itself lives in autoReviewModelRouterCore.ts (shared with the Node Host). This
// module keeps the Desktop defaults: the dedicated candidate table and the Desktop instance
// of the one-shot candidate request (utility-model/oneShotCandidates.ts).
import {
  DEDICATED_AUTO_REVIEW_CANDIDATES,
  requestDedicatedAutoReviewCandidateText,
} from '../utility-model/oneShotCandidates.js';
import {
  createAutoReviewModelRouter as createAutoReviewModelRouterCore,
  type AutoReviewModelRouterDeps as AutoReviewModelRouterCoreDeps,
} from './autoReviewModelRouterCore.js';

export {
  AUTO_REVIEW_AUXILIARY_TIMEOUT_MS,
  AUTO_REVIEW_CANDIDATE_TIMEOUT_MS,
  AUTO_REVIEW_CHAIN_TIMEOUT_MS,
  AUTO_REVIEW_ROUTER_GUARD_TIMEOUT_MS,
  AUTO_REVIEW_TOTAL_TIMEOUT_MS,
} from './autoReviewModelRouterCore.js';

type AutoReviewModelRouterDeps = Omit<AutoReviewModelRouterCoreDeps, 'candidates' | 'requestCandidate'>
  & Partial<Pick<AutoReviewModelRouterCoreDeps, 'candidates' | 'requestCandidate'>>;

/** The Desktop router: the core with the former defaults for the candidates and their request. */
export function createAutoReviewModelRouter(
  deps: AutoReviewModelRouterDeps,
): (prompt: string, signal?: AbortSignal) => Promise<string | null> {
  // The spread copies deps when the router is created; the core used to read deps.logger and
  // deps.createAuxiliaryFallback at call time. Every caller passes a fresh literal it never
  // changes afterwards, so the two are the same.
  return createAutoReviewModelRouterCore({
    ...deps,
    candidates: deps.candidates ?? DEDICATED_AUTO_REVIEW_CANDIDATES,
    requestCandidate: deps.requestCandidate ?? requestDedicatedAutoReviewCandidateText,
  });
}

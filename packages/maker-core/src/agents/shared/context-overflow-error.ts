/**
 * Agent compatibility entry point; provider diagnostics use the same shared matcher.
 * The stable reason lets translators mark overflow even when a rejected request has
 * no usage data (#1429), so recovery need not rely on a stale context-token ratio.
 */
export {
  CONTEXT_OVERFLOW_REASON,
  isContextOverflowErrorMessage,
} from '@cindy/maker-shared/context-overflow-error';

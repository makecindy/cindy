/**
 * Internal A/B switch: set false and restart the desktop Main process to use
 * local exit rules only. No UI, persisted preference or catalog change needed.
 * Disabling this skips the model request; idle exit and local commands remain.
 * Either setting dispatches ordinary messages immediately, without awaiting the
 * classifier. Its result can only close the call after input acceptance.
 * Keep this bypass for A/B testing and rollback when evaluating a future
 * lightweight classifier. It must not disable ordinary companion requests.
 */
export const SEMANTIC_VOICE_EXIT_ENABLED = true;

// Skip long utterances whole: truncation could drop a negation or a work request.
export const SEMANTIC_VOICE_EXIT_MAX_CHARACTERS = 512;

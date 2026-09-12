/**
 * The native turn was accepted and entered context compaction before its
 * response stream became indeterminate. Recovery must continue that accepted
 * turn instead of replaying the original user request and possible effects.
 */
export const CODEX_COMPACTION_TRANSPORT_INTERRUPTED_REASON =
  "codex_compaction_transport_interrupted";

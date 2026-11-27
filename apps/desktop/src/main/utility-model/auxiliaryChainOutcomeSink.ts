/**
 * Dependency-free hand-off of auxiliary-chain request results.
 *
 * The one-shot request module loads early and widely (tests included); the
 * health service pulls in settings, auth and window modules. Keeping this sink
 * free of imports lets the request path report without loading those, and the
 * service attaches when its IPC is registered at startup.
 */

export type AuxiliaryChainOutcome = 'success' | 'no_candidate' | 'failed';

let listener: ((outcome: AuxiliaryChainOutcome) => void) | null = null;

export function setAuxiliaryChainOutcomeListener(next: ((outcome: AuxiliaryChainOutcome) => void) | null): void {
  listener = next;
}

export function reportAuxiliaryChainOutcome(outcome: AuxiliaryChainOutcome): void {
  listener?.(outcome);
}

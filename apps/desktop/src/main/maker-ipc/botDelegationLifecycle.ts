type ParentCancellationHandler = (parentSessionId: string, reason: string) => Promise<number>;

let activeHandler: ParentCancellationHandler | null = null;

/**
 * Small process-local bridge from Bot lifecycle writers to the delegation
 * runtime. Keeping this holder dependency-free avoids importing maker-ipc's
 * full register graph from localDb/route code (which also keeps tests and
 * Electron startup free of a circular side effect).
 */
export function registerBotDelegationParentCancellation(
  handler: ParentCancellationHandler,
): () => void {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) activeHandler = null;
  };
}

export async function cancelBotDelegationsForParentIfReady(
  parentSessionId: string,
  reason: string,
): Promise<number> {
  return activeHandler ? activeHandler(parentSessionId, reason) : 0;
}

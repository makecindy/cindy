


export function createGeneratedImageRecovery() {

/** Read-side recovery hook; registered by the Maker Host, without a localDb → Maker cycle. */
let reconcile: (() => Promise<void>) | undefined;
let recover: ((sessionId: string) => Promise<void>) | undefined;
function setGeneratedImageRecovery(
  callback: (sessionId: string) => Promise<void>,
  cleanup?: () => Promise<void>,
): void {
  recover = callback;
  reconcile = cleanup;
}
async function recoverGeneratedImagesForHistory(sessionId: string): Promise<void> {
  await recover?.(sessionId);
}

/** Resume owner-scoped cleanup receipts after restart; never starts generation. */
async function reconcileGeneratedImageRecovery(): Promise<void> {
  await reconcile?.();
}
return {
  setGeneratedImageRecovery,
  recoverGeneratedImagesForHistory,
  reconcileGeneratedImageRecovery
};
}

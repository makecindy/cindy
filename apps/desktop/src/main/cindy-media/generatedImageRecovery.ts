/** Read-side recovery hook; registered by the Maker Host, without a localDb → Maker cycle. */
let reconcile: (() => Promise<void>) | undefined;
let recover: ((sessionId: string) => Promise<void>) | undefined;
export function setGeneratedImageRecovery(
  callback: (sessionId: string) => Promise<void>,
  cleanup?: () => Promise<void>,
): void {
  recover = callback;
  reconcile = cleanup;
}
export async function recoverGeneratedImagesForHistory(sessionId: string): Promise<void> {
  await recover?.(sessionId);
}

/** Resume owner-scoped cleanup receipts after restart; never starts generation. */
export async function reconcileGeneratedImageRecovery(): Promise<void> {
  await reconcile?.();
}

/** One-shot pre-send preparation for queued scheduler prompts. */
export interface SchedulerQueuedPreparation {
  onPreparing: () => Promise<void>;
  onPreparationFailed?: (error: unknown) => void;
}

export async function runSchedulerQueuedPreparation(
  clientId: string | undefined,
  preparations: Map<string, SchedulerQueuedPreparation>,
  onFailure: () => void,
): Promise<void> {
  const preparation = clientId ? preparations.get(clientId) : undefined;
  if (!preparation) return;
  preparations.delete(clientId!);
  try {
    await preparation.onPreparing();
  } catch (error) {
    onFailure();
    try { preparation.onPreparationFailed?.(error); } catch { /* Preserve the preparation error. */ }
    throw error;
  }
}

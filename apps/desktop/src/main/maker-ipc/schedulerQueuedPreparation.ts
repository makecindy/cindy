/** One-shot pre-send preparation for queued scheduler prompts. */
export interface SchedulerQueuedPreparation {
  onPreparing: () => Promise<void>;
  onPreparationFailed?: (error: unknown) => void;
}

/** This scheduled run has already failed; its unpersisted prompt must not retry. */
export class SchedulerQueuedPreparationError extends Error {
  constructor(cause: unknown) {
    super('Scheduled prompt preparation failed', { cause });
    this.name = 'SchedulerQueuedPreparationError';
  }
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
    throw new SchedulerQueuedPreparationError(error);
  }
}

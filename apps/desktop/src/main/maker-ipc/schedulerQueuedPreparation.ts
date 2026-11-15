/** Host-only dispatch guidance; never replaces the queued/persisted user input. */
export type SchedulerQueuedPreparationResult = {
  getAppendText: () => string | undefined | Promise<string | undefined>;
} | void;

/** One-shot pre-send preparation for queued scheduler prompts. */
export interface SchedulerQueuedPreparation {
  onPreparing: () => Promise<SchedulerQueuedPreparationResult>;
  onPreparationFailed?: (error: unknown) => void;
  /** Retained through pre-persistence retries; accepted/discard hooks release it. */
  preparing?: Promise<SchedulerQueuedPreparationResult>;
}

/** This scheduled run has already failed; its unpersisted prompt must not retry. */
export class SchedulerQueuedPreparationError extends Error {
  constructor(cause: unknown) {
    super('Scheduled prompt preparation failed', { cause });
    this.name = 'SchedulerQueuedPreparationError';
  }
}

export async function runSchedulerQueuedPreparation<Message>(
  clientId: string | undefined,
  preparations: Map<string, SchedulerQueuedPreparation>,
  onFailure: () => void,
  message: Message,
): Promise<Message | string> {
  const preparation = clientId ? preparations.get(clientId) : undefined;
  if (!preparation) return message;
  try {
    // Defer invocation until this promise is stored, including synchronous re-entry.
    // A fulfilled void result is still prepared; never repeat preparation on retry.
    const result = await (preparation.preparing ??= Promise.resolve().then(() => preparation.onPreparing()));
    const appendText = await result?.getAppendText();
    if (appendText) {
      // Each retry gets a fresh copy of the original queued text. Resolve guidance
      // against its final route, preserving Continue/attachments and same-message
      // re-entry without ever changing the queue or persisted user input.
      // This boundary precedes normal message validation, so retain raw strings.
      if (typeof message === 'string') return message.endsWith(appendText) ? message : message + appendText;
      if (message && typeof message === 'object' && 'content' in message) {
        const content = message.content;
        if (typeof content === 'string' && !content.endsWith(appendText)) message.content = content + appendText;
        else if (Array.isArray(content)) {
          const last = content.at(-1);
          if (last?.type !== 'text' || last.text !== appendText) {
            message.content = [...content, { type: 'text', text: appendText }];
          }
        }
      }
    }
    return message;
  } catch (error) {
    if (preparations.get(clientId!) === preparation) {
      preparations.delete(clientId!);
      onFailure();
      try { preparation.onPreparationFailed?.(error); } catch { /* Preserve the preparation error. */ }
    }
    throw new SchedulerQueuedPreparationError(error);
  }
}

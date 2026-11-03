import { randomUUID } from 'node:crypto';
import type { AskUserQuestionItem, InteractionDecision, InteractionRequest } from '../../types/events.js';

interface PendingQuestion {
  generation: number;
  abort: AbortController;
  answered: boolean;
}

/** Optional questions never own a continuation or a blocking interaction. */
export class AsyncUserQuestions {
  private readonly pending = new Map<string, PendingQuestion>();

  constructor(private readonly deps: {
    isActive(generation: number): boolean;
    resolve(request: InteractionRequest): Promise<InteractionDecision>;
    deliver(text: string, signal: AbortSignal): Promise<void>;
    dismiss(requestId: string, reason: string): void;
    reportError(error: unknown): void;
  }) {}

  ask(questions: AskUserQuestionItem[], generation: number): string {
    if (!this.deps.isActive(generation)) throw new Error('No active turn for an async question');
    // The existing question UI has one active card per task.
    this.expire('superseded');
    const requestId = `async-question:${randomUUID()}`;
    const entry = { generation, abort: new AbortController(), answered: false };
    this.pending.set(requestId, entry);
    void this.waitForAnswer(requestId, entry, questions);
    return requestId;
  }

  expire(reason: string, generation?: number): void {
    for (const [requestId, entry] of this.pending) {
      if (generation !== undefined && entry.generation !== generation) continue;
      this.pending.delete(requestId);
      entry.abort.abort();
      if (!entry.answered) this.deps.dismiss(requestId, reason);
    }
  }

  private async waitForAnswer(requestId: string, entry: PendingQuestion, questions: AskUserQuestionItem[]): Promise<void> {
    let onAbort!: () => void;
    const cancelled = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      entry.abort.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const answer = await Promise.race([
        this.deps.resolve({ kind: 'ask_user_question', requestId, questions, delivery: 'async' }), cancelled,
      ]);
      if (!answer || answer.kind !== 'ask_user_question' || answer.dismissed
        || entry.abort.signal.aborted || !this.deps.isActive(entry.generation)) return;
      // Keep delivery cancellable without expiring the card already resolved by the host.
      entry.answered = true;
      const answered = questions.flatMap(({ question, header }) => {
        const value = answer.answers[question] ?? (header ? answer.answers[header] : undefined);
        return typeof value === 'string' && value.trim() ? [{ question, answer: value }] : [];
      });
      if (answered.length === 0) return;
      // A user reply is ordinary same-turn input, never a new send or an inferred choice.
      await this.deps.deliver(
        `The user answered the asynchronous question:\n${JSON.stringify(answered)}`,
        entry.abort.signal,
      );
    } catch (error) {
      if (!entry.abort.signal.aborted && this.deps.isActive(entry.generation)) this.deps.reportError(error);
    } finally {
      entry.abort.signal.removeEventListener('abort', onAbort);
      this.pending.delete(requestId);
    }
  }
}

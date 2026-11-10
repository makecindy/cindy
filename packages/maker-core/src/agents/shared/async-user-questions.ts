import { randomUUID } from 'node:crypto';
import { formatAsyncQuestionSupplement } from '@cindy/maker-shared';
import type { AskUserQuestionItem, InteractionDecision, InteractionRequest } from '../../types/events.js';

interface PendingQuestion {
  abort: AbortController;
  answered: boolean;
  generation: number;
  question: AskUserQuestionItem;
  submission?: Promise<void>;
  delivered?: boolean;
  submissionText?: string;
  deliveryMessage?: { answerText: string; text: string };
}

/** Session-owned questions outlive provider turns; each question is independently answerable. */
export class AsyncUserQuestions {
  private readonly pending = new Map<string, PendingQuestion>();
  private sendTail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: {
    isActive(generation: number): boolean;
    isLateAnswer(generation: number): boolean;
    resolve(request: InteractionRequest): Promise<InteractionDecision>;
    deliver(text: string, signal: AbortSignal, requestId: string): Promise<void>;
    dismiss(requestId: string, reason: string, withdrawalReason?: string): void;
    reportError(error: unknown): void;
  }) {}

  ask(questions: AskUserQuestionItem[], generation: number, nativeRequestId?: string) {
    if (!this.deps.isActive(generation)) throw new Error('No active session for an async question');
    const batchId = nativeRequestId ?? `async-question:${randomUUID()}`;
    const receipts: Array<{ request_id: string; question: string }> = [];
    questions.forEach((question, index) => {
      const requestId = questions.length === 1 ? batchId : `${batchId}:${index}`;
      receipts.push({ request_id: requestId, question: question.question });
      if (this.pending.has(requestId)) return;
      const entry: PendingQuestion = { abort: new AbortController(), answered: false, generation, question: { ...question, id: question.id ?? requestId } };
      this.pending.set(requestId, entry);
      void this.waitForAnswer(requestId, entry, entry.question);
    });
    return { request_id: batchId, questions: receipts, pending_count: this.pending.size };
  }

  /** Admit an explicit UI answer before consuming its card. Failed admission is retryable. */
  async submit(requestId: string, decision: InteractionDecision): Promise<boolean> {
    const entry = this.pending.get(requestId);
    if (!entry || entry.abort.signal.aborted || decision.kind !== 'ask_user_question') return false;
    if (decision.inProgress) return true;
    if (decision.dismissed) return !entry.submission;
    const text = formatAsyncQuestionSupplement([entry.question], decision.answers);
    if (entry.submissionText !== undefined && entry.submissionText !== text) return false;
    if (!text || entry.delivered) return true;
    if (!entry.submission) {
      entry.submissionText = text;
      const answers = { ...decision.answers };
      entry.submission = this.sendTail.then(async () => {
        if (entry.abort.signal.aborted) throw new Error('Question was dismissed');
        // Retry identity must survive a turn ending after an uncertain receipt.
        if (entry.deliveryMessage?.answerText !== text) entry.deliveryMessage = {
          answerText: text, text: formatAsyncQuestionSupplement([entry.question], answers,
            { late: this.deps.isLateAnswer(entry.generation) }),
        };
        await this.deps.deliver(entry.deliveryMessage.text, entry.abort.signal, requestId);
        entry.delivered = true;
      });
      this.sendTail = entry.submission.catch(() => undefined);
    }
    try { await entry.submission; return true; }
    catch (error) { entry.submission = undefined; entry.submissionText = undefined; throw error; }
  }

  snapshot(): Set<string> { return new Set(this.pending.keys()); }

  list() {
    return [...this.pending].map(([requestId, entry]) => ({
      request_id: requestId, question: entry.question.question,
      status: entry.submission || entry.answered ? 'answer_in_flight' as const : 'pending' as const,
    }));
  }

  withdraw(requestIds: string[], reason: string) {
    if (!reason.trim()) throw new Error('A withdrawal reason is required');
    return [...new Set(requestIds)].map((requestId) => {
      const entry = this.pending.get(requestId);
      if (!entry) return { request_id: requestId, status: 'not_pending' as const };
      // An explicit answer already being admitted wins over model cleanup.
      if (entry.submission || entry.answered || entry.delivered) {
        return { request_id: requestId, status: 'answer_in_flight' as const };
      }
      this.pending.delete(requestId);
      entry.abort.abort();
      this.deps.dismiss(requestId, 'question_withdrawn', reason.trim());
      return { request_id: requestId, status: 'withdrawn' as const };
    });
  }

  expire(reason: string, requests: ReadonlySet<string> = this.snapshot()): void {
    for (const requestId of requests) {
      const entry = this.pending.get(requestId);
      if (!entry) continue;
      this.pending.delete(requestId);
      entry.abort.abort();
      if (!entry.answered) this.deps.dismiss(requestId, reason);
    }
  }

  private async waitForAnswer(requestId: string, entry: PendingQuestion, question: AskUserQuestionItem): Promise<void> {
    let onAbort!: () => void;
    const cancelled = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      entry.abort.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const answer = await Promise.race([
        this.deps.resolve({ kind: 'ask_user_question', requestId, questions: [question], delivery: 'async' }), cancelled,
      ]);
      if (!answer || answer.kind !== 'ask_user_question' || answer.dismissed || entry.abort.signal.aborted) return;
      entry.answered = true;
      await this.submit(requestId, answer);
    } catch (error) {
      if (!entry.abort.signal.aborted) this.deps.reportError(error);
    } finally {
      entry.abort.signal.removeEventListener('abort', onAbort);
      this.pending.delete(requestId);
    }
  }
}

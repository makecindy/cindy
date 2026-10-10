import type { InteractionDecision, InteractionRequest } from '@cindy/maker-core';

type Questionnaire = Extract<InteractionRequest, { kind: 'ask_user_question' }>;

/** One presentation sequence, shared by direct channel routing and Desktop takeover. */
export async function presentChannelQuestionnaire(
  request: Questionnaire,
  present: (page: Questionnaire, signal?: AbortSignal) => Promise<InteractionDecision>,
  signal?: AbortSignal,
  onPage?: (requestId: string) => void,
): Promise<InteractionDecision> {
  let answers: Record<string, string> = {};
  const dismissed = (): InteractionDecision => ({ kind: 'ask_user_question', answers, dismissed: true });
  // These card surfaces cannot collect free text. Never substitute a blank
  // "continue" answer, or partially dispatch a questionnaire we cannot finish.
  if (request.questions.some(question => !question.options?.length) || signal?.aborted) return dismissed();

  let abort!: () => void;
  const cancelled = new Promise<InteractionDecision>(resolve => {
    abort = () => resolve(dismissed());
  });
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (const [index, question] of request.questions.entries()) {
      if (signal?.aborted) return dismissed();
      const requestId = `${request.requestId}:question:${index}`;
      onPage?.(requestId);
      const decision = await Promise.race([
        present({ ...request, requestId, questions: [question] }, signal),
        cancelled,
      ]);
      if (signal?.aborted || decision.kind !== 'ask_user_question') return dismissed();
      answers = { ...answers, ...decision.answers };
      if (decision.dismissed) return { ...decision, answers };
    }
    return { kind: 'ask_user_question', answers };
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

import type { InteractionDecision } from '../../types/events.js';
import type {
  DynamicToolCallResponse,
  ToolRequestUserInputQuestion,
  ToolRequestUserInputResponse,
} from './app-server/protocol.js';

export const MAX_REQUEST_USER_INPUT_QUESTIONS = 3;
export const MAX_REQUEST_USER_INPUT_OPTIONS = 10;
const ASK_USER_CONTINUATION_INTRO = 'The user answered the pending question.';
const ASK_USER_CONTINUATION_OUTRO = 'Continue from the previous turn. Do not ask the same question again.';

export function emptyUserInputResponse(questions: readonly Pick<ToolRequestUserInputQuestion, 'id'>[]): ToolRequestUserInputResponse {
  const answers: ToolRequestUserInputResponse['answers'] = Object.create(null);
  for (const q of questions) {
    if (q.id) answers[q.id] = { answers: [] };
  }
  return { answers };
}

export function normalizeRequestUserInputQuestions(
  questions: readonly ToolRequestUserInputQuestion[],
): ToolRequestUserInputQuestion[] {
  return questions.map((q, index) => ({
    id: q.id || `question-${index + 1}`,
    header: q.header || '',
    question: q.question || q.header || `Question ${index + 1}`,
    isOther: q.isOther === true,
    isSecret: q.isSecret === true,
    options: Array.isArray(q.options)
      ? q.options.map((option) => ({
          label: option.label || '',
          description: option.description || '',
        })).filter((option) => option.label.trim().length > 0)
      : null,
  }));
}

export function normalizeDynamicAskUserQuestions(args: unknown): ToolRequestUserInputQuestion[] {
  const input = args && typeof args === 'object' ? args as { questions?: unknown } : {};
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  const questions: ToolRequestUserInputQuestion[] = rawQuestions.map((raw, index) => {
    const q = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const rawOptions = Array.isArray(q.options) ? q.options : null;
    return {
      id: typeof q.id === 'string' && q.id.trim() ? q.id : `question-${index + 1}`,
      header: typeof q.header === 'string' ? q.header : '',
      question: typeof q.question === 'string' ? q.question : '',
      isOther: q.isOther === true,
      // Dynamic fallback is a business-choice tool. It must not collect secrets.
      isSecret: false,
      options: rawOptions
        ? rawOptions.map((rawOption) => {
            const option = rawOption && typeof rawOption === 'object'
              ? rawOption as Record<string, unknown>
              : {};
            return {
              label: typeof option.label === 'string' ? option.label : '',
              description: typeof option.description === 'string' ? option.description : '',
            };
          })
        : null,
    };
  });
  return normalizeRequestUserInputQuestions(questions);
}

export function questionsToAskUserItems(questions: readonly ToolRequestUserInputQuestion[]) {
  return questions.map((q) => ({
    id: q.id,
    question: q.question,
    header: q.header || undefined,
    options: q.options?.map((option) => ({
      label: option.label,
      description: option.description || undefined,
    })),
    multiSelect: false,
  }));
}

export function responseFromAskUserAnswers(
  questions: readonly ToolRequestUserInputQuestion[],
  answers: Record<string, string>,
): ToolRequestUserInputResponse {
  const out: ToolRequestUserInputResponse['answers'] = Object.create(null);
  for (const q of questions) {
    const raw = [answers[q.id], answers[q.question], answers[q.header]].find((value) => typeof value === 'string') ?? '';
    if (!raw) {
      out[q.id] = { answers: [] };
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        out[q.id] = { answers: parsed.filter((v): v is string => typeof v === 'string') };
        continue;
      }
    } catch {
      // Single-select answers are plain labels, not JSON.
    }
    out[q.id] = { answers: [raw] };
  }
  return { answers: out };
}

export function responseFromPermissionDecision(
  questions: readonly ToolRequestUserInputQuestion[],
  decision: Extract<InteractionDecision, { kind: 'permission' }>,
): ToolRequestUserInputResponse {
  if (decision.behavior === 'deny') return emptyUserInputResponse(questions);
  const out: ToolRequestUserInputResponse['answers'] = Object.create(null);
  for (const q of questions) {
    const positiveOption = q.options?.find((option) =>
      /^(allow|approve|accept|yes|continue|confirm)$/i.test(option.label.trim()),
    );
    const option = positiveOption?.label ?? q.options?.[0]?.label ?? 'allow';
    out[q.id] = { answers: [option] };
  }
  return { answers: out };
}

export function dynamicToolResponseFromUserInput(response: ToolRequestUserInputResponse): DynamicToolCallResponse {
  return {
    success: true,
    contentItems: [{ type: 'inputText', text: JSON.stringify(response.answers) }],
  };
}

export function userInputQuestionsFingerprint(
  questions: readonly ToolRequestUserInputQuestion[],
): string {
  return JSON.stringify(questions.map((question) => ({
    header: question.header,
    question: question.question,
    isOther: question.isOther === true,
    options: (question.options ?? []).map((option) => ({
      label: option.label,
      description: option.description,
    })),
  })));
}

export type UserInputAnswersByPosition = string[][];

export function userInputAnswersByPosition(
  questions: readonly ToolRequestUserInputQuestion[],
  response: ToolRequestUserInputResponse,
): UserInputAnswersByPosition {
  return questions.map((question) =>
    response.answers[question.id]?.answers.slice() ?? [],
  );
}

export function responseFromUserInputAnswersByPosition(
  questions: readonly ToolRequestUserInputQuestion[],
  answersByPosition: readonly (readonly string[])[],
): ToolRequestUserInputResponse {
  const answers: ToolRequestUserInputResponse['answers'] = Object.create(null);
  questions.forEach((question, index) => {
    answers[question.id] = { answers: [...(answersByPosition[index] ?? [])] };
  });
  return { answers };
}

export function hasSubmittedUserInput(answersByPosition: readonly (readonly string[])[]): boolean {
  return answersByPosition.some((answers) =>
    answers.some((value) => value.trim().length > 0),
  );
}

export function formatAskUserContinuationMessage(
  questions: readonly ToolRequestUserInputQuestion[],
  answers: Record<string, string>,
): string {
  if (questions.every((q) => q.id.startsWith('["request_user_input_async",'))) {
    const replies = questions.flatMap((q) => {
      const answer = answers[q.id] ?? answers[q.question] ?? '';
      return answer.trim() ? [{ questionItemId: q.id, question: q.question, answer }] : [];
    });
    return `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`;
  }
  const lines = [ASK_USER_CONTINUATION_INTRO, ''];
  for (const question of questions) {
    const raw = answers[question.id] ?? answers[question.question] ?? answers[question.header] ?? '';
    lines.push(`Q: ${question.question}`);
    lines.push(`A: ${raw.trim() || '(no answer)'}`);
    lines.push('');
  }
  lines.push(ASK_USER_CONTINUATION_OUTRO);
  return lines.join('\n');
}

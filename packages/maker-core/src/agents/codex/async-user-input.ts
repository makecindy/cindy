import type { ItemEnvelope, ToolRequestUserInputQuestion } from './app-server/protocol.js';

/** Codex 0.159 async questions arrive as messages, not server requests. */
export function asyncUserInputQuestions(item: ItemEnvelope): ToolRequestUserInputQuestion[] | null {
  if (item.type !== 'agentMessage' || item.delivery !== 'async' || !item.id?.trim()
    || !Array.isArray(item.questions) || item.questions.length === 0) return null;
  const questions: ToolRequestUserInputQuestion[] = [];
  for (const raw of item.questions) {
    if (!raw || typeof raw !== 'object' || typeof raw.title !== 'string' || !raw.title.trim()
      || (raw.options != null && (!Array.isArray(raw.options)
        || raw.options.some((option: unknown) => typeof option !== 'string')))) return null;
    questions.push({
      id: `${item.id}-question-${questions.length + 1}`,
      header: '',
      question: raw.title,
      isOther: true,
      isSecret: false,
      options: raw.options?.map((label: string) => ({ label, description: null })) ?? null,
    });
  }
  return questions;
}

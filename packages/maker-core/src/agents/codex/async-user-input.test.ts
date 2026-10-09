import { describe, expect, it } from 'vitest';
import { asyncUserInputQuestions } from './async-user-input.js';

describe('Codex async user input message', () => {
  const message = { type: 'agentMessage', id: 'call-1', delivery: 'async', text: 'Fallback text' };

  it('keeps choices and free-form questions in order with stable distinct answer ids', () => {
    const questions = asyncUserInputQuestions({ ...message, questions: [
      { title: 'Which bot?', options: ['Personal', 'Official', 'Both'] },
      { title: 'Any constraints?', options: null },
    ] });
    expect(questions).toEqual([
      { id: 'call-1-question-1', header: '', question: 'Which bot?', isOther: true, isSecret: false,
        options: ['Personal', 'Official', 'Both'].map((label) => ({ label, description: null })) },
      { id: 'call-1-question-2', header: '', question: 'Any constraints?', isOther: true, isSecret: false, options: null },
    ]);
  });

  it.each([
    {}, { delivery: null }, { id: '' }, { questions: [] },
    { questions: [{ title: '' }] }, { questions: [{ title: 'Question', options: [42] }] },
    { questions: [{ title: 'Question' }, null] },
  ])('leaves ordinary or malformed messages on the existing text path: %j', (override) => {
    expect(asyncUserInputQuestions({ ...message, ...override })).toBeNull();
  });
});

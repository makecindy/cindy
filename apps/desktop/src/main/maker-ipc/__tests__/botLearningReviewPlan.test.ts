import { it, expect } from 'vitest';
import { hasLearningEvidence, learningReviewSchema } from '../botLearningReviewPlan.js';
it('requires exact source evidence and user evidence for memories', () => {
  const evidence = { messageId: 'a', quote: 'I have verified the output' };
  const messages = [{ id: 'a', role: 'assistant', text: evidence.quote }];
  expect(hasLearningEvidence({ evidence }, messages, true)).toBe(false);
  expect(hasLearningEvidence({ evidence }, messages, false)).toBe(false);
  expect(hasLearningEvidence({ evidence }, [{ ...messages[0], role: 'tool_result' }], false)).toBe(
    true,
  );
  expect(
    hasLearningEvidence({ evidence: { ...evidence, quote: 'invented quote' } }, messages, false),
  ).toBe(false);
});
it('accepts an empty review and rejects unsafe names or unbounded plans', () => {
  expect(learningReviewSchema.parse({ memories: [], skills: [] })).toEqual({
    memories: [],
    skills: [],
  });
  expect(
    learningReviewSchema.safeParse({ memories: [], skills: [{ slug: '../escape' }] }).success,
  ).toBe(false);
});

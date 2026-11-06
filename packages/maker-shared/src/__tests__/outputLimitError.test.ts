import { describe, expect, it } from 'vitest';
import { isReasoningDominatedOutputLimit, parseOutputLimitDetails } from '../outputLimitError.js';

describe('output limit details', () => {
  it('keeps only safe usage fields and treats reasoning as an output subset', () => {
    expect(
      parseOutputLimitDetails({
        outputTokens: 131072,
        reasoningTokens: 131064,
        secret: 'discard',
      }),
    ).toEqual({ outputTokens: 131072, reasoningTokens: 131064 });
    expect(
      isReasoningDominatedOutputLimit({
        outputTokens: 131072,
        reasoningTokens: 131064,
      }),
    ).toBe(true);
    expect(
      isReasoningDominatedOutputLimit({
        outputTokens: 100,
        reasoningTokens: 89,
      }),
    ).toBe(false);
    expect(isReasoningDominatedOutputLimit({ outputTokens: 100 })).toBe(false);
  });

  it.each([
    null,
    [],
    {},
    { outputTokens: -1 },
    { outputTokens: Infinity },
    { outputTokens: 1.5 },
    { outputTokens: '100' },
  ])('ignores invalid or legacy details: %j', (value) => {
    expect(parseOutputLimitDetails(value)).toBeUndefined();
  });

  it.each([-1, 101, NaN, 0.5, '90'])(
    'does not invent reasoning usage from invalid data: %j',
    (reasoningTokens) => {
      expect(parseOutputLimitDetails({ outputTokens: 100, reasoningTokens })).toEqual({
        outputTokens: 100,
      });
    },
  );
});

import { describe, expect, it } from 'vitest';

import { isStreamInterruptedErrorMessage } from './stream-interrupt-error.js';

describe('isStreamInterruptedErrorMessage', () => {
  it('matches the observed Pi + LiteLLM envelope', () => {
    expect(
      isStreamInterruptedErrorMessage(
        'OpenAI API error (500): {"message":"litellm.APIError: Response API in-stream error","type":null,"param":null,"code":"500"}',
      ),
    ).toBe(true);
    expect(
      isStreamInterruptedErrorMessage('litellm.APIError: Response API in-stream error'),
    ).toBe(true);
  });

  it('does not treat ordinary 5xx / overload / overflow as a stream interrupt', () => {
    expect(isStreamInterruptedErrorMessage('provider 500 from upstream')).toBe(false);
    expect(isStreamInterruptedErrorMessage('HTTP status 529: overloaded')).toBe(false);
    expect(
      isStreamInterruptedErrorMessage(
        "This model's maximum prompt length is 500000 but the request contains 978177 tokens.",
      ),
    ).toBe(false);
    expect(isStreamInterruptedErrorMessage('OpenAI API error (400): invalid_prompt')).toBe(false);
    expect(isStreamInterruptedErrorMessage('')).toBe(false);
  });
});

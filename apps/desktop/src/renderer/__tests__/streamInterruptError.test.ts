import { describe, expect, it } from 'vitest';

import {
  UPSTREAM_STREAM_INTERRUPTED_REASON,
  isStreamInterruptedErrorMessage,
  unwrapProviderErrorDisplay,
} from '@/utils/streamInterruptError';

describe('isStreamInterruptedErrorMessage', () => {
  it('accepts the classified reason even when the message has been rewritten', () => {
    expect(
      isStreamInterruptedErrorMessage('anything', UPSTREAM_STREAM_INTERRUPTED_REASON),
    ).toBe(true);
  });

  it('matches the observed LiteLLM envelope without a reason', () => {
    expect(
      isStreamInterruptedErrorMessage(
        'OpenAI API error (500): {"message":"litellm.APIError: Response API in-stream error","type":null,"param":null,"code":"500"}',
      ),
    ).toBe(true);
  });
});

describe('unwrapProviderErrorDisplay', () => {
  it('strips the OpenAI protocol prefix and LiteLLM JSON envelope', () => {
    expect(
      unwrapProviderErrorDisplay(
        'OpenAI API error (500): {"message":"litellm.APIError: Response API in-stream error","type":null,"param":null,"code":"500"}',
      ),
    ).toBe('Response API in-stream error');
  });

  it('unwraps a Grok overflow that was branded as OpenAI', () => {
    expect(
      unwrapProviderErrorDisplay(
        'OpenAI API error (400): {"message":"litellm.BadRequestError: XaiException - too long"}',
      ),
    ).toBe('XaiException - too long');
  });

  it('leaves unrelated messages alone', () => {
    expect(unwrapProviderErrorDisplay('Network error: fetch failed')).toBe(
      'Network error: fetch failed',
    );
  });

  it('does not strip a bare LiteLLM quota error used by ErrorBanner classification', () => {
    expect(
      unwrapProviderErrorDisplay('litellm.BadRequestError: insufficient_quota for this key'),
    ).toBe('litellm.BadRequestError: insufficient_quota for this key');
  });

  it('keeps genuine OpenAI / Azure OpenAI provenance and HTTP status', () => {
    expect(unwrapProviderErrorDisplay('OpenAI API error (400): invalid_prompt')).toBe(
      'OpenAI API error (400): invalid_prompt',
    );
    expect(
      unwrapProviderErrorDisplay('Azure OpenAI API error (401): invalid_api_key'),
    ).toBe('Azure OpenAI API error (401): invalid_api_key');
    expect(
      unwrapProviderErrorDisplay('OpenAI API error (400): {"message":"invalid_prompt"}'),
    ).toBe('OpenAI API error (400): {"message":"invalid_prompt"}');
  });
});

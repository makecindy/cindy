import { describe, expect, it } from 'vitest';
import {
  createAuxiliaryUsageAccumulator,
  parseAuxiliaryTokens,
  parseAuxiliaryResponse,
} from '../auxiliaryUsage.js';

describe('auxiliary protocol usage', () => {
  it('merges cumulative raw prompt totals before splitting changing cache counters', () => {
    const usage = createAuxiliaryUsageAccumulator('openai-chat');
    usage.observe({
      model: 'actual',
      usage: {
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 20 },
        completion_tokens: 1,
      },
    });
    usage.observe({
      usage: {
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 40 },
        completion_tokens: 2,
      },
    });
    expect(usage.snapshot()).toEqual({
      model: 'actual',
      tokens: {
        inputTokens: 60,
        cacheReadTokens: 40,
        outputTokens: 2,
        cacheCreateTokens: undefined,
      },
    });
  });
  it('keeps sparse late cache facts attached to their original prompt total', () => {
    const usage = createAuxiliaryUsageAccumulator('openai-chat');
    usage.observe({ usage: { prompt_tokens: 100, completion_tokens: 2 } });
    usage.observe({ usage: { prompt_tokens_details: { cached_tokens: 40 } } });
    expect(usage.snapshot().tokens).toMatchObject({
      inputTokens: 60,
      cacheReadTokens: 40,
      outputTokens: 2,
    });
  });
  it('counts cached OpenAI input once, including reasoning already in output', () => {
    expect(
      parseAuxiliaryTokens(
        {
          usage: {
            prompt_tokens: 1086,
            completion_tokens: 14,
            prompt_tokens_details: { cached_tokens: 384 },
          },
        },
        'chat-completions',
      ),
    ).toEqual({
      inputTokens: 702,
      outputTokens: 14,
      cacheReadTokens: 384,
      cacheCreateTokens: undefined,
    });
  });
  it('preserves the disjoint Messages input/cache counters across sparse SSE frames', () => {
    const raw = [
      {
        type: 'message_start',
        message: {
          model: 'served',
          usage: {
            input_tokens: 25,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 10,
            output_tokens: 0,
          },
        },
      },
      { type: 'message_delta', usage: { output_tokens: 7 } },
      { type: 'error', error: { type: 'overloaded_error' } },
    ]
      .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
      .join('');
    expect(parseAuxiliaryResponse(raw, 'anthropic-messages')).toEqual({
      model: 'served',
      tokens: {
        inputTokens: 25,
        outputTokens: 7,
        cacheReadTokens: 100,
        cacheCreateTokens: 10,
      },
    });
  });
  it('uses usage carried by a failed or incomplete Responses terminal event', () => {
    const raw =
      'data: ' +
      JSON.stringify({
        type: 'response.incomplete',
        response: {
          model: 'actual',
          usage: {
            input_tokens: 120,
            output_tokens: 9,
            input_tokens_details: { cached_tokens: 20 },
          },
        },
      });
    expect(parseAuxiliaryResponse(raw, 'responses').tokens).toMatchObject({
      inputTokens: 100,
      outputTokens: 9,
      cacheReadTokens: 20,
    });
  });
  it('does not fabricate zero usage from empty, missing, invalid or truncated fields', () => {
    for (const body of [{}, { usage: {} }, { usage: { input_tokens: -1, output_tokens: '2' } }])
      expect(parseAuxiliaryTokens(body, 'responses')).toBeNull();
    expect(
      parseAuxiliaryResponse('data: {"usage":{"input_tokens":10}', 'responses').tokens,
    ).toBeNull();
    expect(
      parseAuxiliaryTokens({ usage: { input_tokens: 0, output_tokens: 0 } }, 'responses'),
    ).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });
  it('counts Gemini thinking and cached input without counting them twice', () => {
    expect(
      parseAuxiliaryTokens(
        {
          usageMetadata: {
            promptTokenCount: 100,
            cachedContentTokenCount: 30,
            candidatesTokenCount: 4,
            thoughtsTokenCount: 6,
          },
        },
        'google-generative-ai',
      ),
    ).toEqual({ inputTokens: 70, outputTokens: 10, cacheReadTokens: 30 });
  });
});

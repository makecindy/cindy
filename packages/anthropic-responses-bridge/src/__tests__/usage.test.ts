import { describe, expect, it } from 'vitest';
import { mapUsage } from '../usage.js';

describe('Responses cache accounting', () => {
  it('keeps ordinary input, cache reads and cache writes disjoint', () => {
    const usage = mapUsage({
      input_tokens: 15_000,
      input_tokens_details: { cached_tokens: 10_000, cache_write_tokens: 3_000 },
      output_tokens: 200,
    });
    expect(usage).toEqual({
      input_tokens: 2_000,
      cache_read_input_tokens: 10_000,
      cache_creation_input_tokens: 3_000,
      output_tokens: 200,
    });
    expect(usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens).toBe(15_000);
  });

  it('preserves accounting for older providers without cache writes', () => {
    expect(mapUsage({ input_tokens: 100, input_tokens_details: { cached_tokens: 30 } })).toMatchObject({
      input_tokens: 70,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 0,
    });
  });
});

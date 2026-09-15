import { describe, expect, it } from 'vitest';
import { trimTrailingSlashes } from '../url';

describe('trimTrailingSlashes', () => {
  it.each([
    ['', ''], ['/', ''], ['///', ''],
    ['https://example.test/v1///', 'https://example.test/v1'],
    ['https://example.test/a//b', 'https://example.test/a//b'],
    ['https://example.test/v1/ ', 'https://example.test/v1/ '],
  ])('preserves endpoint contents while trimming the suffix of %j', (input, expected) => {
    expect(trimTrailingSlashes(input)).toBe(expected);
  });
  it('handles long slash runs with and without a non-slash terminator', () => {
    const endpoint = `https://example.test/${'/'.repeat(100_000)}`;
    expect(trimTrailingSlashes(endpoint)).toBe('https://example.test');
    expect(trimTrailingSlashes(`${endpoint}x`)).toBe(`${endpoint}x`);
  });
});

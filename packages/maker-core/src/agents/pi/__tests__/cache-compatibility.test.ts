import { describe, expect, it } from 'vitest';
import { piCacheRouteKey } from '../cache-compatibility.js';
describe('cache route identities', () => {
  it('separates protocol, effective path, port and query routing', () => {
    const a = piCacheRouteKey('https://example.test/v1?route=a', 'openai-completions');
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    for (const url of ['https://example.test/v2?route=a', 'https://example.test:444/v1?route=a', 'https://example.test/v1?route=b']) {
      expect(piCacheRouteKey(url, 'openai-completions')).not.toBe(a);
    }
    expect(piCacheRouteKey('https://example.test/v1?route=a', 'openai-responses')).not.toBe(a);
    expect(piCacheRouteKey('https://example.test/v1?route=a#fragment', 'openai-completions')).toBe(a);
    expect(piCacheRouteKey('not a URL', 'openai-completions')).toBeUndefined();
  });
});

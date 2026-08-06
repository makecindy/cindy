import { describe, expect, it } from 'vitest';

import { defaultOneShotModel } from '../model-route-guard-live.js';

describe('model route guard one-shot defaults', () => {
  it('matches the agents actual defaults when callers omit opts.model', () => {
    expect(defaultOneShotModel('claude-code')).toBe('claude-haiku-4-5');
    expect(defaultOneShotModel('codex')).toBe('gpt-5.4-mini');
    expect(defaultOneShotModel('pi')).toBe('claude-haiku-4-5');
  });
});

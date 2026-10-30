import { describe, expect, it } from 'vitest';
import { reconcileOutboundReasoningEffort } from '../outbound-reasoning-effort.js';

describe('outbound reasoning capability boundary', () => {
  it('does not create a preference for missing or unrecognized input', () => {
    for (const requested of [undefined, null, '', 'none', 'invalid', 42]) {
      expect(reconcileOutboundReasoningEffort(requested, ['high'])).toBeUndefined();
    }
  });

  it('uses shared nearest-supported ordering, independently of declaration order', () => {
    expect(reconcileOutboundReasoningEffort('xhigh', ['max', 'low', 'high'])).toBe('high');
    expect(reconcileOutboundReasoningEffort('minimal', ['high', 'low'])).toBe('low');
    expect(reconcileOutboundReasoningEffort('low', ['low', 'high'])).toBe('low');
    expect(reconcileOutboundReasoningEffort('max', [])).toBeUndefined();
  });
});

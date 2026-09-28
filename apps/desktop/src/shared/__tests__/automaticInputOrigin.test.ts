import { describe, expect, it } from 'vitest';

import { isAutomaticInputOriginKind } from '../agentInputQueue';

describe('isAutomaticInputOriginKind', () => {
  it('treats scheduler, goal, Orca and tool-sent session inputs as automatic', () => {
    for (const kind of ['scheduler', 'goal', 'orca', 'session']) {
      expect(isAutomaticInputOriginKind(kind)).toBe(true);
    }
  });

  it('treats composer input and unknown kinds as human intervention', () => {
    for (const kind of [undefined, null, 'desktop', 'user', 42]) {
      expect(isAutomaticInputOriginKind(kind)).toBe(false);
    }
  });
});

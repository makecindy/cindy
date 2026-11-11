import { describe, expect, it } from 'vitest';

import { isWorkbenchTaskSource } from '../botWorkbench';

describe('helpers', () => {
  it('accepts only project task sources', () => {
    expect(isWorkbenchTaskSource('desktop')).toBe(true);
    expect(isWorkbenchTaskSource('plugin')).toBe(true);
    expect(isWorkbenchTaskSource(undefined)).toBe(true);
    for (const source of ['bot', 'scheduler', 'telegram', 'learn', 'review', 'shared']) {
      expect(isWorkbenchTaskSource(source)).toBe(false);
    }
  });
});

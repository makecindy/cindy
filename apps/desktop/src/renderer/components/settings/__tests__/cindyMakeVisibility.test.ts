import { describe, expect, it } from 'vitest';

import { canAccessCindyMakeSettings } from '../cindyMakeVisibility';

describe('cindyMakeVisibility', () => {
  it('shows the settings tab only in development builds', () => {
    expect(canAccessCindyMakeSettings(true)).toBe(true);
    expect(canAccessCindyMakeSettings(false)).toBe(false);
  });
});

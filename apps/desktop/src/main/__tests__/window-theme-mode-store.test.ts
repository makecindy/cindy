import { describe, expect, it } from 'vitest';

import { __testing } from '../window-theme-mode-store';

describe('window theme mode store', () => {
  it('normalizes supported modes and falls back to system', () => {
    expect(__testing.normalize({ mode: 'light', resolvedIsDark: false })).toEqual({
      mode: 'light',
      resolvedIsDark: false,
    });
    expect(__testing.normalize({ mode: 'dark', resolvedIsDark: true })).toEqual({
      mode: 'dark',
      resolvedIsDark: true,
    });
    expect(__testing.normalize({ mode: 'system' })).toEqual({ mode: 'system' });
    expect(__testing.normalize({ mode: 'auto', resolvedIsDark: 'dark' })).toEqual({
      mode: 'system',
    });
    expect(__testing.normalize(null)).toEqual({ mode: 'system' });
  });
});

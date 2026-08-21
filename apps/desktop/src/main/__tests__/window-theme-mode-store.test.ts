import { describe, expect, it } from 'vitest';

import { __testing } from '../window-theme-mode-store';

describe('window theme mode store', () => {
  it('normalizes supported modes and falls back to system', () => {
    expect(__testing.normalize({ mode: 'light' })).toEqual({ mode: 'light' });
    expect(__testing.normalize({ mode: 'dark' })).toEqual({ mode: 'dark' });
    expect(__testing.normalize({ mode: 'system' })).toEqual({ mode: 'system' });
    expect(__testing.normalize({ mode: 'auto' })).toEqual({ mode: 'system' });
    expect(__testing.normalize(null)).toEqual({ mode: 'system' });
  });
});

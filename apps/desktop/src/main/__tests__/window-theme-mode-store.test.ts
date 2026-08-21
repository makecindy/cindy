import { describe, expect, it } from 'vitest';

import { __testing } from '../window-theme-mode-store';

describe('window theme mode store', () => {
  it('normalizes supported modes and falls back to system', () => {
    expect(__testing.normalize({
      mode: 'light',
      resolvedIsDark: false,
      systemIsDark: true,
    })).toEqual({
      mode: 'light',
      resolvedIsDark: false,
      systemIsDark: true,
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

  it('reuses a system-mode fallback only while the system preference still matches', () => {
    const snapshot = { mode: 'system' as const, resolvedIsDark: true, systemIsDark: false };

    expect(__testing.resolveSnapshotForSystem(snapshot, false)).toEqual({
      mode: 'dark',
      resolvedIsDark: true,
      systemIsDark: false,
    });
    expect(__testing.resolveSnapshotForSystem(snapshot, true)).toEqual({
      mode: 'system',
      systemIsDark: false,
    });
    expect(__testing.resolveSnapshotForSystem({ mode: 'system', resolvedIsDark: true }, true))
      .toEqual({ mode: 'system' });
  });
});

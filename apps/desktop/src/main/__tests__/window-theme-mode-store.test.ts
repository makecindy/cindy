import { describe, expect, it } from 'vitest';

import { __testing, parseWindowThemeVibrancyPayload } from '../window-theme-mode-store';

describe('window theme mode store', () => {
  it('normalizes supported modes and falls back to system', () => {
    expect(__testing.normalize({
      mode: 'light',
      resolvedIsDark: false,
      systemIsDark: true,
      familyId: 'cindy',
      systemModeFollowsSystem: true,
    })).toEqual({
      mode: 'light',
      resolvedIsDark: false,
      systemIsDark: true,
      familyId: 'cindy',
      systemModeFollowsSystem: true,
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

  it('runtime-validates the complete vibrancy payload before any theme side effect', () => {
    expect(parseWindowThemeVibrancyPayload({
      familyId: 'eclipse',
      isDark: true,
      mode: 'system',
      systemModeFollowsSystem: false,
    })).toEqual({
      familyId: 'eclipse',
      isDark: true,
      mode: 'system',
      systemModeFollowsSystem: false,
    });
    expect(parseWindowThemeVibrancyPayload({ familyId: 'cindy', isDark: false })).toEqual({
      familyId: 'cindy',
      isDark: false,
    });

    for (const invalid of [
      null,
      [],
      { familyId: '', isDark: false },
      { familyId: 'x'.repeat(513), isDark: false },
      { familyId: 'cindy', isDark: 'false' },
      { familyId: 'cindy', isDark: false, mode: 'auto' },
      { familyId: 'cindy', isDark: false, systemModeFollowsSystem: 'yes' },
    ]) {
      expect(parseWindowThemeVibrancyPayload(invalid)).toBeNull();
    }
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

  it('keeps a single-variant family resolved across a system preference change', () => {
    const snapshot = {
      mode: 'system' as const,
      resolvedIsDark: true,
      systemIsDark: true,
      familyId: 'eclipse',
      systemModeFollowsSystem: false,
    };

    expect(__testing.resolveSnapshotForSystem(snapshot, false)).toEqual({
      ...snapshot,
      mode: 'dark',
    });
  });
});

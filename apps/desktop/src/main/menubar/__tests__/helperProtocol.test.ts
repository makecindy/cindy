import { describe, expect, it } from 'vitest';

import { DEFAULT_MENUBAR_SETTINGS, isMenubarSupportedPlatform } from '../../../shared/menubarQuota';
import { parseHelperMessage } from '../MacMenubarNativeHost';
import { normalizeMenubarSettings, sanitizeMenubarSettingsPatch } from '../settingsStore';

describe('parseHelperMessage', () => {
  it('accepts well-formed messages', () => {
    expect(parseHelperMessage({ type: 'panel', open: true })).toEqual({ type: 'panel', open: true });
    expect(parseHelperMessage({ type: 'open-session', sessionId: 's1' })).toEqual({ type: 'open-session', sessionId: 's1' });
    expect(parseHelperMessage({ type: 'refresh', extra: 1 })).toEqual({ type: 'refresh' });
    expect(parseHelperMessage({ type: 'open-remote-control-settings' })).toEqual({ type: 'open-remote-control-settings' });
  });

  it('rejects malformed or unknown messages', () => {
    expect(parseHelperMessage(null)).toBeNull();
    expect(parseHelperMessage({ type: 'panel', open: 'yes' })).toBeNull();
    expect(parseHelperMessage({ type: 'open-session', sessionId: '' })).toBeNull();
    expect(parseHelperMessage({ type: 'exec', command: 'rm' })).toBeNull();
    expect(parseHelperMessage({ type: 'quit' })).toBeNull();
  });

  it('keeps only valid settings keys from the helper', () => {
    expect(
      parseHelperMessage({ type: 'settings', patch: { privacy: true, statusText: 'bogus', enabled: false, order: ['a', 1] } }),
    ).toEqual({ type: 'settings', patch: { privacy: true, order: ['a'] } });
  });
});

describe('menu bar settings', () => {
  it('falls back to defaults for invalid stored values', () => {
    expect(normalizeMenubarSettings({ statusText: 'nope', scope: 'world', hidden: 'x' })).toEqual(DEFAULT_MENUBAR_SETTINGS);
  });

  it('dedupes and bounds id lists', () => {
    const ids = Array.from({ length: 300 }, (_, i) => `id-${i}`);
    const settings = normalizeMenubarSettings({ order: ['a', 'a', '', 'x'.repeat(201), ...ids] });
    expect(settings.order[0]).toBe('a');
    expect(settings.order).toHaveLength(200);
  });

  it('sanitizes patches to recognised keys', () => {
    expect(sanitizeMenubarSettingsPatch({ lowAlert: false, scope: 'local', junk: 1, statusText: 'x' })).toEqual({
      lowAlert: false,
      scope: 'local',
    });
  });
});

describe('isMenubarSupportedPlatform', () => {
  it('requires macOS 14 (Darwin 23) or later', () => {
    expect(isMenubarSupportedPlatform('darwin', '23.0.0')).toBe(true);
    expect(isMenubarSupportedPlatform('darwin', '22.6.0')).toBe(false);
    expect(isMenubarSupportedPlatform('win32', '10.0.22631')).toBe(false);
  });
});

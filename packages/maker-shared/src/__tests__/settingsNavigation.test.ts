import { describe, expect, it, vi } from 'vitest';
import { buildSettingsNavigationUrl, parseSettingsNavigationUrl, settingsNavigationRoute, navigateRemoteSettings } from '../settingsNavigation';
// Unit: message links must retain their computer and reject commands/ambiguous targets.
describe('settings navigation', () => {
  it('round trips a setting query without moving it to the viewing device', () => {
    const target = { tab: 'voice-input' as const, deviceId: 'computer-a', query: '语音 & 字典', section: 'voice-dictionary' };
    expect(parseSettingsNavigationUrl(buildSettingsNavigationUrl(target))).toEqual(target);
    expect(settingsNavigationRoute(target)).toContain('tab=voice-input');
    expect(settingsNavigationRoute(target)).not.toContain('device');
  });
  it.each([
    'cindy://settings-link/slack?device=a', 'cindy://settings-link/general',
    'cindy://settings-link/general?device=a&device=b', 'cindy://settings-link/general?device=a&command=run',
    'cindy://settings-link/general/other?device=a', 'cindy://settings-link/general?device=a#run',
    'cindy://settings-link/general?device=a&query=%0a', 'https://settings/general?device=a',
  ])('rejects invalid or invented destination %s', url => expect(parseSettingsNavigationUrl(url)).toBeNull());
  it('opens the viewer only after the exact computer acknowledges navigation', async () => {
    const target = { tab: 'general' as const, deviceId: 'a' };
    const open = vi.fn();
    for (const response of [undefined, { ok: false }, { ok: true, deviceId: 'b' }]) {
      await expect(navigateRemoteSettings(target, async () => response, open)).rejects.toThrow();
    }
    expect(open).not.toHaveBeenCalled();
    const invoke = vi.fn(async () => ({ ok: true, deviceId: 'a' }));
    await navigateRemoteSettings(target, invoke, open);
    expect(invoke).toHaveBeenCalledWith('a', 'maker:settings:navigate', [target]);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

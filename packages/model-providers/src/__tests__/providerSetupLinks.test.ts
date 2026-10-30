import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG } from '../catalog.js';
import { providerSetupLink } from '../providerSetupLinks.js';
import { providerPresetOAuth } from '../providerPresetOAuth.js';

describe('provider account entry points', () => {
  it('every shipped provider has an actionable official destination', () => {
    for (const preset of BUNDLED_CATALOG.presets ?? []) {
      const link = providerSetupLink(preset);
      expect(link, preset.id).toBeDefined();
      const url = new URL(link!.url);
      expect(url.protocol, preset.id).toBe('https:');
      expect(url.username + url.password).toBe('');
      if (preset.authMethod === 'none') expect(link!.kind).toBe('setup');
    }
  });
  it('keeps mainland and global accounts distinct', () => {
    expect(providerSetupLink({ id: 'moonshot-kimi-global' })?.url).toContain('platform.kimi.ai');
    expect(providerSetupLink({ id: 'moonshot-kimi-cn' })?.url).toContain('platform.moonshot.cn');
    expect(providerSetupLink({ id: 'minimax-cn' })?.url).not.toBe(providerSetupLink({ id: 'minimax-global' })?.url);
  });
  it('does not guess account or login endpoints for arbitrary providers', () => {
    expect(providerSetupLink({ id: 'custom', docsUrl: 'https://example.com/docs' })).toBeUndefined();
    expect(providerPresetOAuth('custom')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { isAntigravityPluginId, isAntigravityProviderId } from '../branding.js';

// Unit: the display matchers power installed plugin cards and engine/quota rows.
// PR #12735 missed modern root and namespaced installation keys, leaving the
// generic icon in those views. Bare IDs alone could not reproduce this fallback.
describe('Antigravity display identity', () => {
  it.each(['agy-plugin', '_root__agy-plugin', '_ns__local__agy-plugin', '_ns__example-org__agy-plugin'])(
    'recognizes the installed plugin and its provider for %s',
    (id) => {
      expect(isAntigravityPluginId(id)).toBe(true);
      expect(isAntigravityProviderId(`acp-plugin:${id}:agy`)).toBe(true);
      expect(isAntigravityProviderId(`remote:computer:acp-plugin:${id}:antigravity~second`)).toBe(true);
    },
  );

  it('keeps unrelated plugin and harness IDs on their own icon paths', () => {
    expect(isAntigravityPluginId('_root__agy-plugin-preview')).toBe(false);
    expect(isAntigravityProviderId('acp-plugin:_ns__local__other:agy')).toBe(false);
    expect(isAntigravityProviderId('acp-plugin:_root__agy-plugin:other')).toBe(false);
  });
});

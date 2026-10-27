import { describe, expect, it } from 'vitest';
import { PLUGIN_API_SCHEMA_VERSION, parseGetPluginResponse, parseListPluginsResponse, PluginProtocolError } from '../delivery.js';

function plugin(displayAuthor?: string | null) {
  return {
    id: `c${'p'.repeat(24)}`, ghostId: 'example', name: 'Example', description: null,
    author: null, ...(displayAuthor === undefined ? {} : { displayAuthor }),
    scope: 'public', organizationId: null, defaultInstall: false,
    currentRelease: { id: 'release', version: '1.0.0', sha256: 'a'.repeat(64), sizeBytes: 42,
      publishedAt: '2026-10-19T00:00:00.000Z', icon: null,
      manifest: { schemaVersion: 3, minCindyVersion: '1.0.0', id: 'example', name: 'Example', version: '1.0.0', kind: 'chip', entry: 'main.js' } },
  };
}

describe('workflow display author transport', () => {
  it('preserves public publisher identity independently from the displayed nickname', () => {
    for (const publisherKind of ['official', 'personal'] as const) {
      const value = { ...plugin('Cindy'), publisherKind };
      const response = parseGetPluginResponse({ schemaVersion: PLUGIN_API_SCHEMA_VERSION, plugin: value });
      expect(response.plugin.scope).toBe('public');
      expect(response.plugin.publisherKind).toBe(publisherKind);
      const list = parseListPluginsResponse({ schemaVersion: PLUGIN_API_SCHEMA_VERSION, plugins: [value], nextCursor: null });
      expect(list.plugins[0].publisherKind).toBe(publisherKind);
    }
    expect(() => parseGetPluginResponse({ schemaVersion: PLUGIN_API_SCHEMA_VERSION, plugin: { ...plugin(), publisherKind: 'forged' } })).toThrow(PluginProtocolError);
  });
  it('preserves the complete nickname without changing the legacy manifest author', () => {
    const value = plugin('名'.repeat(100));
    const response = parseGetPluginResponse({ schemaVersion: PLUGIN_API_SCHEMA_VERSION, plugin: value });
    expect(response.plugin.displayAuthor).toBe('名'.repeat(100));
    expect(response.plugin.author).toBeNull();
    expect(response.plugin.currentRelease.manifest.author).toBeUndefined();
    const list = parseListPluginsResponse({ schemaVersion: PLUGIN_API_SCHEMA_VERSION, plugins: [value], nextCursor: null });
    expect(list.plugins[0].displayAuthor).toBe('名'.repeat(100));
  });
  it('keeps old-server responses valid and preserves explicit missing attribution', () => {
    const old = parseGetPluginResponse({ schemaVersion: PLUGIN_API_SCHEMA_VERSION, plugin: plugin() });
    expect(old.plugin).not.toHaveProperty('displayAuthor');
    const missing = parseGetPluginResponse({ schemaVersion: PLUGIN_API_SCHEMA_VERSION, plugin: plugin(null) });
    expect(missing.plugin.displayAuthor).toBeNull();
  });
  it('still checks legacy manifest consistency instead of weakening that contract', () => {
    expect(() => parseGetPluginResponse({ schemaVersion: PLUGIN_API_SCHEMA_VERSION, plugin: { ...plugin('Verified account'), author: 'Package claim' } })).toThrow('author 与 currentRelease.manifest.author 不一致');
  });
  it('rejects a malformed extended display name', () => {
    expect(() => parseGetPluginResponse({ schemaVersion: PLUGIN_API_SCHEMA_VERSION, plugin: plugin('x'.repeat(101)) })).toThrow(PluginProtocolError);
  });
});

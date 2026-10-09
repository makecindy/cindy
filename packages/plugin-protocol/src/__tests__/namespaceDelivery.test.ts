import { describe, expect, it } from 'vitest';
import { parseGetPluginResponse, parseListPluginsResponse, parsePluginDownloadResponse } from '../delivery.js';
import { namespaceFixtures } from './fixtures/namespace.js';

describe('namespace delivery contract', () => {
  it.each(namespaceFixtures)('preserves $plugin.scope identity without changing schema 2', ({ plugin, download }) => {
    const parsed = parseGetPluginResponse({ schemaVersion: 2, plugin }).plugin;
    expect(parsed.namespace).toBe(plugin.namespace);
    expect(parsed.currentRelease.manifest.namespace).toBe(plugin.namespace);
    expect(parsePluginDownloadResponse(download)).toEqual(download);
    expect(parseListPluginsResponse({ schemaVersion: 2, plugins: [plugin], nextCursor: null }).plugins[0]?.namespace).toBe(plugin.namespace);
  });

  it('rejects manifest and scope identity contradictions', () => {
    const { plugin } = namespaceFixtures[1]!;
    expect(() => parseGetPluginResponse({ schemaVersion: 2, plugin: { ...plugin, namespace: null } })).toThrow();
    expect(() => parseGetPluginResponse({ schemaVersion: 2, plugin: { ...plugin, namespace: 'different' } })).toThrow();
    expect(() => parseGetPluginResponse({ schemaVersion: 2, plugin: { ...plugin, namespace: '' } })).toThrow();
  });

  it('preserves missing fields as legacy, not root', () => {
    const { plugin } = namespaceFixtures[1]!;
    const { namespace: _namespace, ...legacy } = plugin;
    const { namespace: _manifestNamespace, ...manifest } = plugin.currentRelease.manifest;
    const parsed = parseGetPluginResponse({
      schemaVersion: 2,
      plugin: { ...legacy, currentRelease: { ...legacy.currentRelease, manifest } },
    }).plugin;
    expect(parsed).not.toHaveProperty('namespace');
    expect(parsed.currentRelease.manifest).not.toHaveProperty('namespace');
    expect(() => parseGetPluginResponse({ schemaVersion: 2, plugin: legacy })).toThrow();
  });

  it('rejects contradictory current organization facts', () => {
    expect(() => parseListPluginsResponse({
      schemaVersion: 2,
      plugins: [namespaceFixtures[1]!.plugin],
      nextCursor: null,
      currentOrganization: { organizationId: 'org-example', orgSlug: 'different', pluginPrefix: 'oldprefix' },
    })).toThrow();
  });

  it('rejects omitted organization namespace when currentOrganization.orgSlug is present', () => {
    const { namespace: _namespace, ...legacy } = namespaceFixtures[1]!.plugin;
    expect(() => parseListPluginsResponse({
      schemaVersion: 2,
      plugins: [legacy],
      nextCursor: null,
      currentOrganization: { organizationId: 'org-example', orgSlug: 'acme', pluginPrefix: 'oldprefix' },
    })).toThrow();
    expect(parseListPluginsResponse({
      schemaVersion: 2,
      plugins: [legacy],
      nextCursor: null,
      currentOrganization: { organizationId: 'org-example', pluginPrefix: 'oldprefix' },
    }).plugins[0]).not.toHaveProperty('namespace');
  });

  it('does not accept incomplete download identity', () => {
    const { namespace: _namespace, ...missing } = namespaceFixtures[0]!.download;
    expect(() => parsePluginDownloadResponse(missing)).toThrow();
  });

  it('keeps orgSlug separate from prefix and binds purge to pluginId', () => {
    const parsed = parseListPluginsResponse({
      schemaVersion: 2,
      plugins: [],
      nextCursor: null,
      currentOrganization: { organizationId: 'org-example', orgSlug: 'acme', pluginPrefix: 'oldprefix' },
      removals: [{
        pluginId: namespaceFixtures[1]!.plugin.id,
        ghostId: 'x-manager',
        scope: 'organization',
        organizationId: 'org-example',
        namespace: 'acme',
        action: 'purge',
        removedAt: '2026-09-07T00:00:00.000Z',
      }],
    });
    expect(parsed.currentOrganization).toEqual({
      organizationId: 'org-example',
      orgSlug: 'acme',
      pluginPrefix: 'oldprefix',
    });
    expect(parsed.removals[0]?.namespace).toBe('acme');
  });
});

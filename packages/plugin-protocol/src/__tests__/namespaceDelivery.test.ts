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

  it.each([
    'PLUGIN_NAMESPACE_CLIENT_REQUIRED',
    'PLUGIN_ORGANIZATION_CONTEXT_UNAVAILABLE',
    'PLUGIN_NAMESPACE_CONFIG_REQUIRED',
  ] as const)('preserves public results when enterprise access fails with %s', (code) => {
    const response = {
      schemaVersion: 2,
      plugins: [namespaceFixtures[0]!.plugin],
      nextCursor: null,
      currentOrganization: { organizationId: 'org-example', orgSlug: 'acme', pluginPrefix: null },
      organizationAccessError: { code, message: '请升级 Cindy' },
    };
    expect(parseListPluginsResponse(response)).toMatchObject({
      plugins: [{ id: namespaceFixtures[0]!.plugin.id, scope: 'public' }],
      organizationAccessError: response.organizationAccessError,
      removals: [],
    });
  });

  it('rejects an enterprise access error that still carries enterprise data', () => {
    const currentOrganization = { organizationId: 'org-example', orgSlug: 'acme', pluginPrefix: null };
    const organizationAccessError = { code: 'PLUGIN_NAMESPACE_CLIENT_REQUIRED', message: '请升级 Cindy' };
    const base = { schemaVersion: 2, nextCursor: null, currentOrganization, organizationAccessError };
    expect(() => parseListPluginsResponse({
      ...base,
      plugins: [namespaceFixtures[1]!.plugin],
    })).toThrow('企业准入拒绝');
    expect(() => parseListPluginsResponse({
      ...base,
      plugins: [],
      removals: [{
        pluginId: namespaceFixtures[1]!.plugin.id,
        ghostId: 'x-manager',
        scope: 'organization',
        organizationId: 'org-example',
        namespace: 'acme',
        action: 'purge',
        removedAt: '2026-09-07T00:00:00.000Z',
      }],
    })).toThrow('企业准入拒绝');
    expect(() => parseListPluginsResponse({
      ...base,
      plugins: [],
      currentOrganization: null,
    })).toThrow('企业准入拒绝');
    expect(parseListPluginsResponse({
      ...base,
      plugins: [namespaceFixtures[0]!.plugin],
      organizationAccessError: { code: 'PLUGIN_FUTURE_REASON', message: '以后再说' },
    }).organizationAccessError).toEqual({ code: 'PLUGIN_FUTURE_REASON', message: '以后再说' });
    expect(() => parseListPluginsResponse({
      ...base,
      plugins: [],
      organizationAccessError: { code: 'not-a-code', message: 'bad' },
    })).toThrow('organizationAccessError.code');
    expect(() => parseListPluginsResponse({
      ...base,
      plugins: [],
      organizationAccessError: { code: 'PLUGIN_NAMESPACE_CLIENT_REQUIRED' },
    })).toThrow('organizationAccessError.message');
  });
});

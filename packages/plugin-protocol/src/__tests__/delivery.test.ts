import { describe, expect, it } from 'vitest';
import {
  PLUGIN_API_SCHEMA_VERSION,
  parseGetPluginResponse,
  parseListPluginsResponse,
  parsePluginDownloadResponse,
  PluginProtocolError,
} from '../delivery.js';
import { GHOST_MANIFEST_SCHEMA_VERSION } from '../manifest.js';

const validManifest = {
  schemaVersion: GHOST_MANIFEST_SCHEMA_VERSION,
  id: 'acme-helper',
  name: 'Acme Helper',
  version: '1.0.0',
  kind: 'chip',
  entry: 'index.js',
  slots: ['tool'],
  tools: [{ name: 'help', description: 'Help with Acme tasks' }],
} as const;
const pluginId = `c${'p'.repeat(24)}`;
const validIcon = {
  mimeType: 'image/png',
  sha256: 'c'.repeat(64),
  sizeBytes: 2048,
  url: 'https://cdn.example.com/plugin-icon.png?signature=example',
  expiresAt: '2026-07-19T00:05:00.000Z',
} as const;
const oidcManifest = {
  ...validManifest,
  tools: undefined,
  slots: ['network'],
  network: {
    hosts: ['api.example.com'],
    secrets: [
      {
        key: 'cindy_identity',
        label: 'Cindy organization identity',
        source: 'oidc-token',
        inject: {
          header: 'Authorization',
          format: 'Bearer {value}',
          hosts: ['api.example.com'],
        },
      },
    ],
  },
} as const;

describe('plugin delivery contract', () => {
  it('parses a paginated visible Plugin summary without requiring a manifest', () => {
    const response = parseListPluginsResponse({
      schemaVersion: PLUGIN_API_SCHEMA_VERSION,
      plugins: [
        {
          id: pluginId,
          ghostId: validManifest.id,
          name: validManifest.name,
          description: null,
          author: null,
          scope: 'public',
          organizationId: null,
          defaultInstall: true,
          currentRelease: {
            id: 'release-1',
            version: validManifest.version,
            sha256: 'a'.repeat(64),
            sizeBytes: 1024,
            publishedAt: '2026-07-19T00:00:00.000Z',
            icon: validIcon,
          },
        },
      ],
      nextCursor: pluginId,
    });
    expect(response.plugins[0]?.name).toBe(validManifest.name);
    expect(response.plugins[0]?.currentRelease.version).toBe(validManifest.version);
    expect(response.plugins[0]?.currentRelease.icon).toEqual(validIcon);
    expect(response.nextCursor).toBe(pluginId);
  });

  it('accepts legacy v2 releases without icon metadata', () => {
    const response = parseListPluginsResponse({
      schemaVersion: PLUGIN_API_SCHEMA_VERSION,
      plugins: [
        {
          id: pluginId,
          ghostId: validManifest.id,
          name: validManifest.name,
          description: null,
          author: null,
          scope: 'public',
          organizationId: null,
          defaultInstall: false,
          currentRelease: {
            id: 'release-legacy',
            version: validManifest.version,
            sha256: 'a'.repeat(64),
            sizeBytes: 1024,
            publishedAt: '2026-07-19T00:00:00.000Z',
          },
        },
      ],
      nextCursor: null,
    });
    expect(response.plugins[0]?.currentRelease.icon).toBeNull();
  });

  it('rejects non-HTTPS icon URLs and invalid icon hashes', () => {
    const plugin = {
      id: pluginId,
      ghostId: validManifest.id,
      name: validManifest.name,
      description: null,
      author: null,
      scope: 'public',
      organizationId: null,
      defaultInstall: false,
      currentRelease: {
        id: 'release-icon',
        version: validManifest.version,
        sha256: 'a'.repeat(64),
        sizeBytes: 1024,
        publishedAt: '2026-07-19T00:00:00.000Z',
        icon: { ...validIcon, url: 'http://localhost:3391/icon.png' },
      },
    };
    expect(() =>
      parseListPluginsResponse({
        schemaVersion: PLUGIN_API_SCHEMA_VERSION,
        plugins: [plugin],
        nextCursor: null,
      }),
    ).toThrow(PluginProtocolError);
    expect(() =>
      parseListPluginsResponse({
        schemaVersion: PLUGIN_API_SCHEMA_VERSION,
        plugins: [
          {
            ...plugin,
            currentRelease: { ...plugin.currentRelease, icon: { ...validIcon, sha256: 'bad' } },
          },
        ],
        nextCursor: null,
      }),
    ).toThrow(PluginProtocolError);
  });

  it('parses a visible Plugin detail and validates its manifest', () => {
    const detailManifest = {
      ...validManifest,
      minCindyVersion: '1.2.3',
      slots: ['tool', 'panel', 'badge', 'confirm', 'agent', 'session-context'],
      panel: { html: 'panel.html' },
      agent: { errand: true, schedule: true, sessionMessage: true },
    } as const;
    const response = parseGetPluginResponse({
      schemaVersion: PLUGIN_API_SCHEMA_VERSION,
      plugin: {
        id: pluginId,
        ghostId: detailManifest.id,
        name: detailManifest.name,
        description: null,
        author: null,
        scope: 'public',
        organizationId: null,
        defaultInstall: true,
        currentRelease: {
          id: 'release-1',
          version: detailManifest.version,
          sha256: 'a'.repeat(64),
          sizeBytes: 1024,
          publishedAt: '2026-07-19T00:00:00.000Z',
          manifest: detailManifest,
        },
      },
    });
    expect(response.plugin.currentRelease.manifest.id).toBe(detailManifest.id);
    expect(response.plugin.currentRelease.manifest.slots).toEqual([
      'tool',
      'panel',
      'badge',
      'confirm',
      'agent',
      'session-context',
    ]);
    expect(response.plugin.currentRelease.manifest.agent).toEqual({
      errand: true,
      schedule: true,
      sessionMessage: true,
    });
  });

  it('preserves the version-gated ios-simulator slot in Plugin details', () => {
    const manifest = {
      ...validManifest,
      id: 'simulator-workflow',
      name: 'Simulator Workflow',
      minCindyVersion: '1.2.3',
      slots: ['ios-simulator'],
      tools: undefined,
    } as const;
    const response = parseGetPluginResponse({
      schemaVersion: PLUGIN_API_SCHEMA_VERSION,
      plugin: {
        id: pluginId,
        ghostId: manifest.id,
        name: manifest.name,
        description: null,
        author: null,
        scope: 'public',
        organizationId: null,
        defaultInstall: false,
        currentRelease: {
          id: 'release-simulator',
          version: manifest.version,
          sha256: 'a'.repeat(64),
          sizeBytes: 1024,
          publishedAt: '2026-07-19T00:00:00.000Z',
          manifest,
        },
      },
    });

    expect(response.plugin.currentRelease.manifest.slots).toEqual(['ios-simulator']);
    expect(response.plugin.currentRelease.manifest.minCindyVersion).toBe('1.2.3');
  });

  it('allows oidc-token only in organization Plugin details', () => {
    const plugin = {
      id: pluginId,
      ghostId: oidcManifest.id,
      name: oidcManifest.name,
      description: null,
      author: null,
      defaultInstall: false,
      currentRelease: {
        id: 'release-oidc',
        version: oidcManifest.version,
        sha256: 'a'.repeat(64),
        sizeBytes: 1024,
        publishedAt: '2026-07-19T00:00:00.000Z',
        manifest: oidcManifest,
      },
    };

    expect(
      parseGetPluginResponse({
        schemaVersion: PLUGIN_API_SCHEMA_VERSION,
        plugin: { ...plugin, scope: 'organization', organizationId: 'org-1' },
      }).plugin.scope,
    ).toBe('organization');
    for (const scope of ['public', 'personal'] as const) {
      expect(() =>
        parseGetPluginResponse({
          schemaVersion: PLUGIN_API_SCHEMA_VERSION,
          plugin: { ...plugin, scope, organizationId: null },
        }),
      ).toThrow(/currentRelease\.manifest.*oidc-token.*organization scope/);
    }
  });

  it('keeps availability separate from default installation', () => {
    const response = parseListPluginsResponse({
      schemaVersion: PLUGIN_API_SCHEMA_VERSION,
      plugins: [
        {
          id: pluginId,
          ghostId: validManifest.id,
          name: validManifest.name,
          description: null,
          author: null,
          scope: 'organization',
          organizationId: 'org-1',
          defaultInstall: false,
          currentRelease: {
            id: 'release-1',
            version: validManifest.version,
            sha256: 'b'.repeat(64),
            sizeBytes: 1024,
            publishedAt: '2026-07-19T00:00:00.000Z',
          },
        },
      ],
      nextCursor: null,
    });
    expect(response.plugins).toHaveLength(1);
    expect(response.plugins[0]?.defaultInstall).toBe(false);
  });

  it('parses a personal Plugin without exposing its owner identity', () => {
    const response = parseListPluginsResponse({
      schemaVersion: PLUGIN_API_SCHEMA_VERSION,
      plugins: [
        {
          id: pluginId,
          ghostId: validManifest.id,
          name: validManifest.name,
          description: null,
          author: null,
          scope: 'personal',
          organizationId: null,
          ownerPassportId: 'passport-example',
          defaultInstall: false,
          currentRelease: {
            id: 'release-1',
            version: validManifest.version,
            sha256: 'b'.repeat(64),
            sizeBytes: 1024,
            publishedAt: '2026-07-19T00:00:00.000Z',
          },
        },
      ],
      nextCursor: null,
    });
    expect(response.plugins[0]?.scope).toBe('personal');
    expect(response.plugins[0]?.organizationId).toBeNull();
    expect(response.plugins[0]).not.toHaveProperty('ownerPassportId');
  });

  it('rejects organization ownership metadata that disagrees with scope', () => {
    const plugin = {
      id: pluginId,
      ghostId: validManifest.id,
      name: validManifest.name,
      description: null,
      author: null,
      defaultInstall: false,
      currentRelease: {
        id: 'release-1',
        version: validManifest.version,
        sha256: 'b'.repeat(64),
        sizeBytes: 1024,
        publishedAt: '2026-07-19T00:00:00.000Z',
      },
    };

    expect(() =>
      parseListPluginsResponse({
        schemaVersion: PLUGIN_API_SCHEMA_VERSION,
        plugins: [{ ...plugin, scope: 'public', organizationId: 'org-1' }],
        nextCursor: null,
      }),
    ).toThrow(PluginProtocolError);
    expect(() =>
      parseListPluginsResponse({
        schemaVersion: PLUGIN_API_SCHEMA_VERSION,
        plugins: [{ ...plugin, scope: 'personal', organizationId: 'org-1' }],
        nextCursor: null,
      }),
    ).toThrow(PluginProtocolError);
    expect(() =>
      parseListPluginsResponse({
        schemaVersion: PLUGIN_API_SCHEMA_VERSION,
        plugins: [{ ...plugin, scope: 'organization', organizationId: null }],
        nextCursor: null,
      }),
    ).toThrow(PluginProtocolError);
  });

  it('parses the signed download response used by staging installation', () => {
    expect(
      parsePluginDownloadResponse({
        url: 'https://example.com/plugin.cindy?signature=example',
        expiresAt: '2026-07-19T00:05:00.000Z',
        sha256: 'c'.repeat(64),
        sizeBytes: 1024,
      }),
    ).toEqual({
      url: 'https://example.com/plugin.cindy?signature=example',
      expiresAt: '2026-07-19T00:05:00.000Z',
      sha256: 'c'.repeat(64),
      sizeBytes: 1024,
    });
    expect(() =>
      parsePluginDownloadResponse({
        url: 'http://example.com/plugin.cindy',
        expiresAt: '2026-07-19T00:05:00.000Z',
        sha256: 'c'.repeat(64),
        sizeBytes: 1024,
      }),
    ).toThrow(PluginProtocolError);
    expect(() =>
      parsePluginDownloadResponse({
        url: 'https://example.com/plugin.cindy',
        expiresAt: '0',
        sha256: 'c'.repeat(64),
        sizeBytes: 1024,
      }),
    ).toThrow(PluginProtocolError);
  });

  it('round-trips an opaque list cursor and rejects an empty cursor', () => {
    const cursor = Buffer.from(JSON.stringify({ sortOrder: 7, id: 'plugin-1' })).toString(
      'base64url',
    );
    expect(
      parseListPluginsResponse({
        schemaVersion: PLUGIN_API_SCHEMA_VERSION,
        plugins: [],
        nextCursor: cursor,
      }).nextCursor,
    ).toBe(cursor);
    expect(() =>
      parseListPluginsResponse({
        schemaVersion: PLUGIN_API_SCHEMA_VERSION,
        plugins: [],
        nextCursor: '',
      }),
    ).toThrow(PluginProtocolError);
  });

  it('rejects a detail manifest mismatch', () => {
    expect(() =>
      parseGetPluginResponse({
        schemaVersion: PLUGIN_API_SCHEMA_VERSION,
        plugin: {
          id: pluginId,
          ghostId: validManifest.id,
          name: validManifest.name,
          description: null,
          author: null,
          scope: 'public',
          organizationId: null,
          defaultInstall: true,
          currentRelease: {
            id: 'release-1',
            version: '2.0.0',
            sha256: 'a'.repeat(64),
            sizeBytes: 1024,
            publishedAt: '2026-07-19T00:00:00.000Z',
            manifest: validManifest,
          },
        },
      }),
    ).toThrow(PluginProtocolError);
  });

  it('normalizes missing removals to an empty array', () => {
    const legacy = parseListPluginsResponse({
      schemaVersion: PLUGIN_API_SCHEMA_VERSION,
      plugins: [],
      nextCursor: null,
    });
    expect(legacy.removals).toEqual([]);
    const explicitNull = parseListPluginsResponse({
      schemaVersion: PLUGIN_API_SCHEMA_VERSION,
      plugins: [],
      nextCursor: null,
      removals: null,
    });
    expect(explicitNull.removals).toEqual([]);
  });

  it('parses organization removal notices', () => {
    const removal = {
      pluginId: `c${'r'.repeat(24)}`,
      ghostId: validManifest.id,
      scope: 'organization',
      organizationId: 'org-1',
      action: 'purge',
      removedAt: '2026-08-03T08:00:00.000Z',
    } as const;
    const response = parseListPluginsResponse({
      schemaVersion: PLUGIN_API_SCHEMA_VERSION,
      plugins: [],
      nextCursor: null,
      removals: [removal],
    });
    expect(response.removals).toEqual([removal]);
  });

  it('skips removal notices with unknown actions while keeping known ones', () => {
    const removal = {
      pluginId: `c${'r'.repeat(24)}`,
      ghostId: validManifest.id,
      scope: 'organization',
      organizationId: 'org-1',
      action: 'purge',
      removedAt: '2026-08-03T08:00:00.000Z',
    } as const;
    const response = parseListPluginsResponse({
      schemaVersion: PLUGIN_API_SCHEMA_VERSION,
      plugins: [],
      nextCursor: null,
      removals: [{ ...removal, pluginId: `c${'d'.repeat(24)}`, action: 'disable' }, removal],
    });
    expect(response.removals).toEqual([removal]);
  });

  it('rejects malformed removal notices', () => {
    const removal = {
      pluginId: `c${'r'.repeat(24)}`,
      ghostId: validManifest.id,
      scope: 'organization',
      organizationId: 'org-1',
      action: 'purge',
      removedAt: '2026-08-03T08:00:00.000Z',
    } as const;
    const withRemovals = (removals: unknown) => () =>
      parseListPluginsResponse({
        schemaVersion: PLUGIN_API_SCHEMA_VERSION,
        plugins: [],
        nextCursor: null,
        removals,
      });
    expect(withRemovals({})).toThrow(PluginProtocolError);
    expect(withRemovals([{ ...removal, pluginId: 'INVALID' }])).toThrow(PluginProtocolError);
    expect(withRemovals([{ ...removal, ghostId: 'Bad Ghost Id' }])).toThrow(PluginProtocolError);
    expect(withRemovals([{ ...removal, organizationId: null }])).toThrow(PluginProtocolError);
    expect(withRemovals([{ ...removal, scope: 'public' }])).toThrow(PluginProtocolError);
    expect(withRemovals([{ ...removal, action: 42 }])).toThrow(PluginProtocolError);
    // action 的结构形状是 1–64 字符:超长按坏帧拒绝,不落入"未知取值跳过"分支。
    expect(withRemovals([{ ...removal, action: 'x'.repeat(65) }])).toThrow(PluginProtocolError);
    // 动作未知但其余字段不合法的通告仍然整体拒绝:跳过只发生在结构校验通过之后。
    expect(withRemovals([{ ...removal, action: 'disable', removedAt: 'soon' }])).toThrow(
      PluginProtocolError,
    );
  });

  it('rejects detail metadata that differs from its manifest', () => {
    expect(() =>
      parseGetPluginResponse({
        schemaVersion: PLUGIN_API_SCHEMA_VERSION,
        plugin: {
          id: pluginId,
          ghostId: validManifest.id,
          name: 'Stale name',
          description: null,
          author: null,
          scope: 'public',
          organizationId: null,
          defaultInstall: true,
          currentRelease: {
            id: 'release-1',
            version: validManifest.version,
            sha256: 'a'.repeat(64),
            sizeBytes: 1024,
            publishedAt: '2026-07-19T00:00:00.000Z',
            manifest: validManifest,
          },
        },
      }),
    ).toThrow(PluginProtocolError);
  });
});

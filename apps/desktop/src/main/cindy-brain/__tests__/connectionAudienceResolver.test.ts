import { describe, expect, it, vi } from 'vitest';
import type { GhostManifest } from '../../../shared/ghost.js';
import {
  ghostManifestDigest,
  type PluginMarketInstallationRecord,
} from '../../plugin-market/ledger.js';
import {
  isConnectionSecretReady,
  isReservedConnectionPluginSlug,
  loadConnectionAudienceResolver,
} from '../connectionAudienceResolver.js';

const manifest: GhostManifest = {
  schemaVersion: 2,
  id: 'plugin-a',
  name: 'Plugin A',
  version: '1.0.0',
  kind: 'chip' as const,
  entry: 'index.js',
  network: {
    hosts: ['service-a.x.test'],
    secrets: [
      {
        key: 'cindy_identity',
        label: 'Cindy organization identity',
        source: 'oidc-token' as const,
        inject: {
          header: 'Authorization',
          format: 'Bearer {value}',
          hosts: ['service-a.x.test'],
        },
      },
    ],
  },
};

const identity = {
  membershipId: 'membership-1',
  membershipKind: 'org' as const,
  orgId: 'org-id-1',
  orgSlug: 'org-example',
};

const marketInstallation: PluginMarketInstallationRecord = {
  pluginId: 'plugin-market-1',
  ghostId: manifest.id,
  releaseId: 'release-1',
  version: manifest.version,
  sha256: 'a'.repeat(64),
  scope: 'organization',
  organizationId: identity.orgId,
  source: 'market',
  installed: true,
  updatedAt: '2026-08-04T00:00:00.000Z',
  manifestDigest: ghostManifestDigest(manifest),
  rawManifestSha256: ghostManifestDigest(manifest),
};

function resolverOptions(
  installedManifest: GhostManifest | null = manifest,
  installation: PluginMarketInstallationRecord | null = marketInstallation,
) {
  return {
    readInstalledManifestIdentity: () =>
      installedManifest
        ? {
            manifest: installedManifest,
            rawManifestSha256: ghostManifestDigest(installedManifest),
            legacyManifestDigest: ghostManifestDigest(installedManifest),
            legacyManifestDigests: [ghostManifestDigest(installedManifest)],
          }
        : null,
    readMarketInstallation: () => installation,
  };
}

describe('installed Plugin Connection audience resolver', () => {
  it('names cindy-publisher and xd-publisher as reserved connection slugs', () => {
    expect(isReservedConnectionPluginSlug('cindy-publisher')).toBe(true);
    expect(isReservedConnectionPluginSlug('xd-publisher')).toBe(true);
    expect(isReservedConnectionPluginSlug('cindy-art')).toBe(false);
  });

  it('derives audience and hosts from the installed manifest and current organization', () => {
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(),
    });
    expect(resolver.resolve('plugin-a', identity)).toEqual({
      membershipId: 'membership-1',
      audience: 'org-example:plugin-a',
      pluginSlug: 'plugin-a',
      allowedHosts: ['service-a.x.test'],
    });
  });

  it('reads the installed manifest and byte identity only once', () => {
    const readInstalledManifestIdentity = vi.fn(
      resolverOptions().readInstalledManifestIdentity,
    );
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(),
      readInstalledManifestIdentity,
    });

    expect(resolver.resolve('plugin-a', identity)).not.toBeNull();
    expect(readInstalledManifestIdentity).toHaveBeenCalledTimes(1);
  });

  it('requires a current organization market installation record', () => {
    const resolver = loadConnectionAudienceResolver(
      resolverOptions(manifest, { ...marketInstallation, source: 'local-market' }),
    );
    expect(resolver.resolve('plugin-a', identity)).toBeNull();
    expect(
      loadConnectionAudienceResolver(
        resolverOptions(manifest, { ...marketInstallation, source: 'legacy-adopted' }),
      ).resolve('plugin-a', identity),
    ).toBeNull();

    expect(
      loadConnectionAudienceResolver(
        resolverOptions(manifest, { ...marketInstallation, scope: 'public', organizationId: null }),
      ).resolve('plugin-a', identity),
    ).toBeNull();
    expect(
      loadConnectionAudienceResolver(
        resolverOptions(manifest, { ...marketInstallation, organizationId: 'org-other' }),
      ).resolve('plugin-a', identity),
    ).toBeNull();
    expect(
      loadConnectionAudienceResolver(
        resolverOptions(manifest, {
          ...marketInstallation,
          manifestDigest: undefined,
          rawManifestSha256: undefined,
        }),
      ).resolve('plugin-a', identity),
    ).toBeNull();
  });

  it('uses raw manifest bytes when the legacy digest is absent', () => {
    const resolver = loadConnectionAudienceResolver(
      resolverOptions(manifest, { ...marketInstallation, manifestDigest: undefined }),
    );

    expect(resolver.resolve('plugin-a', identity)).not.toBeNull();
  });

  it('rejects a changed installed manifest digest', () => {
    const changedManifest = { ...manifest, version: '2.0.0' };
    const resolver = loadConnectionAudienceResolver(resolverOptions(changedManifest));
    expect(resolver.resolve('plugin-a', identity)).toBeNull();
  });

  it('does not fall back to a matching legacy digest after raw identity mismatches', () => {
    const resolver = loadConnectionAudienceResolver(
      resolverOptions(manifest, {
        ...marketInstallation,
        rawManifestSha256: 'f'.repeat(64),
      }),
    );

    expect(resolver.resolve('plugin-a', identity)).toBeNull();
  });

  it('rejects reserved publisher identity slugs even with a matching market install', () => {
    for (const ghostId of ['cindy-publisher', 'xd-publisher'] as const) {
      const reservedManifest = { ...manifest, id: ghostId };
      const reservedInstallation = {
        ...marketInstallation,
        ghostId,
        manifestDigest: ghostManifestDigest(reservedManifest),
      };
      const resolver = loadConnectionAudienceResolver(
        resolverOptions(reservedManifest, reservedInstallation),
      );
      expect(resolver.resolve(ghostId, identity)).toBeNull();
    }
  });

  it('requires an organization identity and an installed oidc-token declaration', () => {
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(),
    });
    expect(
      resolver.resolve('plugin-a', {
        membershipId: 'membership-1',
        membershipKind: 'personal',
        orgId: null,
        orgSlug: null,
      }),
    ).toBeNull();
    expect(resolver.resolve('plugin-b', identity)).toBeNull();
    expect(
      loadConnectionAudienceResolver({
        ...resolverOptions({ ...manifest, network: { hosts: ['service-a.x.test'] } }),
      }).resolve('plugin-a', identity),
    ).toBeNull();
  });

  it('resolves explicit Forge OIDC before a stale or foreign market row', () => {
    const forgeManifest: GhostManifest = { ...manifest, id: 'acme-tool' };
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(forgeManifest, {
        ...marketInstallation,
        installed: false,
        organizationId: 'org-other',
      }),
      readInstallOrigin: () => 'agent-forge',
      readApprovedPackageSha256: () => 'a'.repeat(64),
      lookupOrganizationPrefix: () => ({ kind: 'known', pluginPrefix: 'acme' }),
    });
    expect(resolver.resolve('acme-tool', identity)).toEqual({
      membershipId: 'membership-1',
      audience: 'org-example:acme-tool',
      pluginSlug: 'acme-tool',
      allowedHosts: ['service-a.x.test'],
    });
  });

  it('does not extend Forge OIDC to a manual install or another prefix', () => {
    const forgeManifest: GhostManifest = { ...manifest, id: 'acme-tool' };
    for (const options of [
      { readInstallOrigin: () => 'manual' as const, pluginPrefix: 'acme' },
      { readInstallOrigin: () => 'agent-forge' as const, pluginPrefix: 'other' },
    ]) {
      const resolver = loadConnectionAudienceResolver({
        ...resolverOptions(forgeManifest, null),
        readInstallOrigin: options.readInstallOrigin,
        readApprovedPackageSha256: () => 'a'.repeat(64),
        lookupOrganizationPrefix: () => ({ kind: 'known', pluginPrefix: options.pluginPrefix }),
      });
      expect(resolver.resolve('acme-tool', identity)).toBeNull();
    }
  });

  it('resolves a named local mivo-canvas install without a market record', () => {
    const localManifest: GhostManifest = {
      ...manifest,
      id: 'mivo-canvas',
      network: {
        hosts: ['mivo-canvas.dsworks.cn'],
        secrets: [
          {
            key: 'cindy_identity',
            label: 'Cindy organization identity',
            source: 'oidc-token' as const,
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['mivo-canvas.dsworks.cn'],
            },
          },
        ],
      },
    };
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(localManifest, null),
      readInstallOrigin: () => 'manual',
    });
    expect(resolver.resolve('mivo-canvas', identity)).toEqual({
      membershipId: 'membership-1',
      audience: 'org-example:mivo-canvas',
      pluginSlug: 'mivo-canvas',
      allowedHosts: ['mivo-canvas.dsworks.cn'],
    });
    expect(
      loadConnectionAudienceResolver({
        ...resolverOptions(localManifest, null),
        readMarketInstallation: () => ({ kind: 'absent' }),
        readInstallOrigin: () => 'manual',
      }).resolve('mivo-canvas', identity),
    ).toEqual({
      membershipId: 'membership-1',
      audience: 'org-example:mivo-canvas',
      pluginSlug: 'mivo-canvas',
      allowedHosts: ['mivo-canvas.dsworks.cn'],
    });
  });

  it('does not extend the local mivo-canvas exception past an exact id and org membership', () => {
    const localManifest: GhostManifest = {
      ...manifest,
      id: 'mivo-canvas',
      network: {
        hosts: ['mivo-canvas.dsworks.cn'],
        secrets: [
          {
            key: 'cindy_identity',
            label: 'Cindy organization identity',
            source: 'oidc-token' as const,
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['mivo-canvas.dsworks.cn'],
            },
          },
        ],
      },
    };
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(localManifest, null),
      readInstallOrigin: () => 'manual',
    });
    expect(resolver.resolve('plugin-a', identity)).toBeNull();
    expect(resolver.resolve('mivo-canvas-x', identity)).toBeNull();
    expect(resolver.resolve('Mivo-Canvas', identity)).toBeNull();
    expect(
      resolver.resolve('mivo-canvas', {
        membershipId: 'membership-1',
        membershipKind: 'personal',
        orgId: null,
        orgSlug: null,
      }),
    ).toBeNull();
  });

  it('rejects a local mivo-canvas install whose exact oidc host is not the allowlisted host', () => {
    const forgedManifest: GhostManifest = {
      ...manifest,
      id: 'mivo-canvas',
      network: {
        hosts: ['attacker.example.com'],
        secrets: [
          {
            key: 'cindy_identity',
            label: 'Cindy organization identity',
            source: 'oidc-token' as const,
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['attacker.example.com'],
            },
          },
        ],
      },
    };
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(forgedManifest, null),
      readInstallOrigin: () => 'manual',
    });
    expect(resolver.resolve('mivo-canvas', identity)).toBeNull();
  });

  it('rejects a local mivo-canvas install that declares an extra exact oidc host', () => {
    const extraHostManifest: GhostManifest = {
      ...manifest,
      id: 'mivo-canvas',
      network: {
        hosts: ['mivo-canvas.dsworks.cn', 'attacker.example.com'],
        secrets: [
          {
            key: 'cindy_identity',
            label: 'Cindy organization identity',
            source: 'oidc-token' as const,
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['mivo-canvas.dsworks.cn', 'attacker.example.com'],
            },
          },
        ],
      },
    };
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(extraHostManifest, null),
      readInstallOrigin: () => 'manual',
    });
    expect(resolver.resolve('mivo-canvas', identity)).toBeNull();
  });

  it('rejects a local mivo-canvas install whose oidc host is only a wildcard', () => {
    const wildcardManifest: GhostManifest = {
      ...manifest,
      id: 'mivo-canvas',
      network: {
        hosts: ['*.x.test'],
        secrets: [
          {
            key: 'cindy_identity',
            label: 'Cindy organization identity',
            source: 'oidc-token' as const,
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['*.x.test'],
            },
          },
        ],
      },
    };
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(wildcardManifest, null),
      readInstallOrigin: () => 'manual',
    });
    expect(resolver.resolve('mivo-canvas', identity)).toBeNull();
  });

  it('still requires digest match when mivo-canvas has an organization market record', () => {
    const localManifest: GhostManifest = {
      ...manifest,
      id: 'mivo-canvas',
      version: '2.0.0',
      network: {
        hosts: ['mivo-canvas.dsworks.cn'],
        secrets: [
          {
            key: 'cindy_identity',
            label: 'Cindy organization identity',
            source: 'oidc-token' as const,
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['mivo-canvas.dsworks.cn'],
            },
          },
        ],
      },
    };
    const marketRecord: PluginMarketInstallationRecord = {
      ...marketInstallation,
      ghostId: 'mivo-canvas',
      manifestDigest: ghostManifestDigest({ ...localManifest, version: '1.0.0' }),
    };
    const resolver = loadConnectionAudienceResolver(
      resolverOptions(localManifest, marketRecord),
    );
    expect(resolver.resolve('mivo-canvas', identity)).toBeNull();
  });

  it('does not take the local exception when the market ledger is invalid', () => {
    const localManifest: GhostManifest = {
      ...manifest,
      id: 'mivo-canvas',
      network: {
        hosts: ['mivo-canvas.dsworks.cn'],
        secrets: [
          {
            key: 'cindy_identity',
            label: 'Cindy organization identity',
            source: 'oidc-token' as const,
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['mivo-canvas.dsworks.cn'],
            },
          },
        ],
      },
    };
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(localManifest, null),
      readMarketInstallation: () => ({ kind: 'invalid' }),
      readInstallOrigin: () => 'manual',
    });
    expect(resolver.resolve('mivo-canvas', identity)).toBeNull();
  });

  it('does not skip digest when a mivo-canvas market record is marked uninstalled', () => {
    const localManifest: GhostManifest = {
      ...manifest,
      id: 'mivo-canvas',
      version: '2.0.0',
      network: {
        hosts: ['mivo-canvas.dsworks.cn'],
        secrets: [
          {
            key: 'cindy_identity',
            label: 'Cindy organization identity',
            source: 'oidc-token' as const,
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['mivo-canvas.dsworks.cn'],
            },
          },
        ],
      },
    };
    const marketRecord: PluginMarketInstallationRecord = {
      ...marketInstallation,
      ghostId: 'mivo-canvas',
      installed: false,
      manifestDigest: ghostManifestDigest({ ...localManifest, version: '1.0.0' }),
    };
    const resolver = loadConnectionAudienceResolver(
      resolverOptions(localManifest, marketRecord),
    );
    expect(resolver.resolve('mivo-canvas', identity)).toBeNull();
  });

  it('requires the managed secret target to match a declared exact host', () => {
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(),
    });
    const resolution = resolver.resolve('plugin-a', identity);
    expect(isConnectionSecretReady(['service-a.x.test'], resolution)).toBe(true);
    expect(isConnectionSecretReady(['service-b.x.test'], resolution)).toBe(false);
    expect(isConnectionSecretReady(['service-a.x.test'], null)).toBe(false);
  });
});

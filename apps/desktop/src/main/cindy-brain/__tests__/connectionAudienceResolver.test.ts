import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GhostManifest } from '../../../shared/ghost.js';
import {
  ghostManifestDigest,
  PluginMarketLedger,
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

  it('does not authorize a root twin through an uninstalled root row and a live organization row', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-connection-identity-'));
    try {
      const ledger = new PluginMarketLedger(path.join(directory, 'ledger.v1.json'));
      ledger.upsertInstallation({ ...marketInstallation, namespace: null, installed: false });
      ledger.upsertInstallation({
        ...marketInstallation,
        pluginId: 'plugin-market-org',
        namespace: identity.orgSlug,
      });
      const options = {
        ...resolverOptions(),
        readMarketInstallation: (id: string) => ledger.lookupInstallationForOidc(id),
        readInstallNamespace: (id: string) =>
          id === 'plugin-a' ? null : identity.orgSlug,
        readApprovedPackageSha256: (id: string) =>
          id === 'plugin-a' ? 'b'.repeat(64) : marketInstallation.sha256,
      };
      expect(ledger.lookupInstallationForOidc('plugin-a')).toMatchObject({
        kind: 'found',
        record: { namespace: identity.orgSlug, installed: true },
      });
      expect(loadConnectionAudienceResolver(options).resolve('plugin-a', identity)).toBeNull();
      expect(loadConnectionAudienceResolver({
        ...options,
        readInstallNamespace: () => undefined,
      }).resolve('plugin-a', identity)).toBeNull();
      expect(loadConnectionAudienceResolver({
        ...options,
        readInstallNamespace: () => 'other-org',
      }).resolve('plugin-a', identity)).toBeNull();
      expect(loadConnectionAudienceResolver({
        ...options,
        readMarketInstallation: () => ({
          kind: 'found' as const,
          record: { ...marketInstallation, namespace: 'other-org' },
        }),
        readInstallNamespace: () => 'other-org',
      }).resolve('plugin-a', identity)).toBeNull();
      expect(loadConnectionAudienceResolver({
        ...options,
        readInstallNamespace: () => { throw new Error('receipt unavailable'); },
      }).resolve('plugin-a', identity)).toBeNull();
      expect(loadConnectionAudienceResolver({
        ...options,
        readMarketInstallation: () => ({
          kind: 'found' as const,
          record: { ...marketInstallation, namespace: null },
        }),
        readInstallNamespace: () => identity.orgSlug,
      }).resolve('plugin-a', identity)).toBeNull();
      expect(loadConnectionAudienceResolver({
        ...options,
        readInstallNamespace: () => identity.orgSlug,
      }).resolve('plugin-a', identity)).toMatchObject({ audience: 'org-example:plugin-a' });
      expect(loadConnectionAudienceResolver(options).resolve('_ns__org-example__plugin-a', identity))
        .toMatchObject({ audience: 'org-example:plugin-a' });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
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
      readInstallNamespace: () => 'org-example',
    });
    expect(resolver.resolve('acme-tool', identity)).toEqual({
      membershipId: 'membership-1',
      audience: 'org-example:acme-tool',
      pluginSlug: 'acme-tool',
      allowedHosts: ['service-a.x.test'],
    });
  });

  it('preserves OIDC for a verified pending legacy Forge receipt in the current organization', () => {
    const forgeManifest: GhostManifest = { ...manifest, id: 'acme-tool' };
    const options = {
      ...resolverOptions(forgeManifest, null),
      readInstallOrigin: () => 'agent-forge' as const,
      readInstallNamespace: () => undefined,
      readApprovedPackageSha256: () => 'a'.repeat(64),
      isPendingLegacyForge: () => true,
      lookupOrganizationPrefix: () => ({ kind: 'known' as const, pluginPrefix: 'acme' }),
    };
    expect(loadConnectionAudienceResolver(options).resolve('acme-tool', identity)).toMatchObject({
      audience: 'org-example:acme-tool',
    });
    expect(loadConnectionAudienceResolver({ ...options, isPendingLegacyForge: () => false })
      .resolve('acme-tool', identity)).toBeNull();
    expect(loadConnectionAudienceResolver({ ...options, lookupOrganizationPrefix: () => ({
      kind: 'known' as const, pluginPrefix: 'other',
    }) }).resolve('acme-tool', identity)).toBeNull();
    expect(loadConnectionAudienceResolver({ ...options, lookupOrganizationPrefix: () => ({
      kind: 'known' as const, pluginPrefix: null,
    }) }).resolve('acme-tool', identity)).toBeNull();
    expect(loadConnectionAudienceResolver({ ...options, readInstallNamespace: () => null })
      .resolve('acme-tool', identity)).toBeNull();
    expect(loadConnectionAudienceResolver({ ...options, lookupOrganizationPrefix: () => ({
      kind: 'unavailable' as const,
    }) }).resolve('acme-tool', identity)).toBeNull();
  });

  it('does not extend Forge OIDC to a manual install or another organization', () => {
    const forgeManifest: GhostManifest = { ...manifest, id: 'helper' };
    for (const options of [
      { readInstallOrigin: () => 'manual' as const, namespace: 'org-example' as string | null },
      { readInstallOrigin: () => 'agent-forge' as const, namespace: 'other' as string | null },
    ]) {
      const resolver = loadConnectionAudienceResolver({
        ...resolverOptions(forgeManifest, null),
        readInstallOrigin: options.readInstallOrigin,
        readApprovedPackageSha256: () => 'a'.repeat(64),
        readInstallNamespace: () => options.namespace,
      });
      expect(resolver.resolve('helper', identity)).toBeNull();
    }
  });

  it('resolves a prefix-free Forge helper bound to the current organization', () => {
    const forgeManifest: GhostManifest = { ...manifest, id: 'helper' };
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(forgeManifest, null),
      readInstallOrigin: () => 'agent-forge',
      readApprovedPackageSha256: () => 'a'.repeat(64),
      readInstalledManifestIdentity: (id) =>
        id === '_ns__org-example__helper' || id === 'helper'
          ? {
              manifest: forgeManifest,
              rawManifestSha256: ghostManifestDigest(forgeManifest),
              legacyManifestDigest: ghostManifestDigest(forgeManifest),
              legacyManifestDigests: [ghostManifestDigest(forgeManifest)],
            }
          : null,
    });
    expect(resolver.resolve('_ns__org-example__helper', identity)).toEqual({
      membershipId: 'membership-1',
      audience: 'org-example:helper',
      pluginSlug: 'helper',
      allowedHosts: ['service-a.x.test'],
    });
  });

  it('resolves a root local mivo-canvas install without a market record', () => {
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
    const allowed = {
      membershipId: 'membership-1',
      audience: 'org-example:mivo-canvas',
      pluginSlug: 'mivo-canvas',
      allowedHosts: ['mivo-canvas.dsworks.cn'],
    };
    expect(loadConnectionAudienceResolver({
      ...resolverOptions(localManifest, null),
      readInstallOrigin: () => 'manual',
    }).resolve('mivo-canvas', identity)).toEqual(allowed);
    expect(loadConnectionAudienceResolver({
      ...resolverOptions(localManifest, null),
      readMarketInstallation: () => ({ kind: 'absent' }),
      readInstallOrigin: () => 'manual',
      readInstallNamespace: () => null,
    }).resolve('_root__mivo-canvas', identity)).toEqual(allowed);
  });

  it('does not apply the local mivo-canvas exception to an organization instance', () => {
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
    for (const instanceId of ['_ns/xd/mivo-canvas', '_ns/acme/mivo-canvas', '_ns__xd__mivo-canvas']) {
      expect(loadConnectionAudienceResolver({
        ...resolverOptions(localManifest, null),
        readInstallOrigin: () => 'manual',
      }).resolve(instanceId, identity)).toBeNull();
    }
    expect(loadConnectionAudienceResolver({
      ...resolverOptions(localManifest, null),
      readInstallOrigin: () => 'manual',
      readInstallNamespace: () => 'xd',
    }).resolve('mivo-canvas', identity)).toBeNull();
  });

  it('does not apply the local mivo-canvas exception to a different plugin id', () => {
    for (const id of ['mivo-canvas2', 'xd-mivo-canvas']) {
      const localManifest: GhostManifest = {
        ...manifest,
        id,
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
      expect(loadConnectionAudienceResolver({
        ...resolverOptions(localManifest, null),
        readInstallOrigin: () => 'manual',
      }).resolve(id, identity)).toBeNull();
    }
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

  it('resolves a namespaced instance id to the plugin slug audience', () => {
    const readInstalledManifestIdentity = vi.fn((id: string) =>
      id === '_ns__org-example__plugin-a'
        ? {
            manifest,
            rawManifestSha256: ghostManifestDigest(manifest),
            legacyManifestDigest: ghostManifestDigest(manifest),
            legacyManifestDigests: [ghostManifestDigest(manifest)],
          }
        : null,
    );
    const readMarketInstallation = vi.fn((id: string) =>
      id === '_ns__org-example__plugin-a'
        ? { kind: 'found' as const, record: { ...marketInstallation, namespace: 'org-example' } }
        : { kind: 'absent' as const },
    );
    const readInstallOrigin = vi.fn(() => 'manual' as const);
    const resolver = loadConnectionAudienceResolver({
      readInstalledManifestIdentity,
      readMarketInstallation,
      readInstallOrigin,
      readInstallNamespace: () => 'org-example',
    });
    expect(resolver.resolve('_ns__org-example__plugin-a', identity)).toEqual({
      membershipId: 'membership-1',
      audience: 'org-example:plugin-a',
      pluginSlug: 'plugin-a',
      allowedHosts: ['service-a.x.test'],
    });
    expect(readInstalledManifestIdentity).toHaveBeenCalledWith('_ns__org-example__plugin-a');
    expect(readMarketInstallation).toHaveBeenCalledWith('_ns__org-example__plugin-a');
    expect(readInstallOrigin).toHaveBeenCalledWith('_ns__org-example__plugin-a');
  });

  it('resolves a pending legacy xd-mivo-canvas after the market row gains namespace xd', () => {
    const canvasManifest: GhostManifest = { ...manifest, id: 'xd-mivo-canvas' };
    const xdIdentity = { ...identity, orgId: 'org-xd', orgSlug: 'xd' };
    const record: PluginMarketInstallationRecord = {
      ...marketInstallation,
      pluginId: 'cb163dbadea776c1b9ce9be38',
      ghostId: 'xd-mivo-canvas',
      organizationId: 'org-xd',
      namespace: 'xd',
      manifestDigest: ghostManifestDigest(canvasManifest),
      rawManifestSha256: ghostManifestDigest(canvasManifest),
    };
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(canvasManifest, record),
      readInstallNamespace: () => undefined,
      isPendingLegacyNamespace: () => true,
    });
    expect(resolver.resolve('xd-mivo-canvas', xdIdentity)).toEqual({
      membershipId: 'membership-1',
      audience: 'xd:xd-mivo-canvas',
      pluginSlug: 'xd-mivo-canvas',
      allowedHosts: ['service-a.x.test'],
    });
  });


  it('resolves xd-mivo-canvas after the pending install is confirmed in place', () => {
    const canvasManifest: GhostManifest = { ...manifest, id: 'xd-mivo-canvas' };
    const xdIdentity = { ...identity, orgId: 'org-xd', orgSlug: 'xd' };
    const record: PluginMarketInstallationRecord = {
      ...marketInstallation,
      pluginId: 'cb163dbadea776c1b9ce9be38',
      ghostId: 'xd-mivo-canvas',
      organizationId: 'org-xd',
      namespace: 'xd',
      manifestDigest: ghostManifestDigest(canvasManifest),
      rawManifestSha256: ghostManifestDigest(canvasManifest),
    };
    expect(loadConnectionAudienceResolver({
      ...resolverOptions(canvasManifest, record),
      readInstallNamespace: () => 'xd',
    }).resolve('xd-mivo-canvas', xdIdentity)).toMatchObject({ audience: 'xd:xd-mivo-canvas' });
  });

  it('resolves a newly installed namespaced xd-mivo-canvas', () => {
    const canvasManifest: GhostManifest = { ...manifest, id: 'xd-mivo-canvas' };
    const xdIdentity = { ...identity, orgId: 'org-xd', orgSlug: 'xd' };
    const record: PluginMarketInstallationRecord = {
      ...marketInstallation,
      pluginId: 'cb163dbadea776c1b9ce9be38',
      ghostId: 'xd-mivo-canvas',
      organizationId: 'org-xd',
      namespace: 'xd',
      manifestDigest: ghostManifestDigest(canvasManifest),
      rawManifestSha256: ghostManifestDigest(canvasManifest),
    };
    expect(loadConnectionAudienceResolver({
      ...resolverOptions(canvasManifest, record),
      readInstallNamespace: () => 'xd',
    }).resolve('_ns__xd__xd-mivo-canvas', xdIdentity)).toMatchObject({
      audience: 'xd:xd-mivo-canvas',
      pluginSlug: 'xd-mivo-canvas',
    });
  });

  it('rejects a pending legacy install whose catalog namespace is another org', () => {
    const canvasManifest: GhostManifest = { ...manifest, id: 'xd-mivo-canvas' };
    const xdIdentity = { ...identity, orgId: 'org-xd', orgSlug: 'xd' };
    const record: PluginMarketInstallationRecord = {
      ...marketInstallation,
      ghostId: 'xd-mivo-canvas',
      organizationId: 'org-xd',
      namespace: 'other-org',
      manifestDigest: ghostManifestDigest(canvasManifest),
      rawManifestSha256: ghostManifestDigest(canvasManifest),
    };
    expect(loadConnectionAudienceResolver({
      ...resolverOptions(canvasManifest, record),
      readInstallNamespace: () => undefined,
      isPendingLegacyNamespace: () => true,
    }).resolve('xd-mivo-canvas', xdIdentity)).toBeNull();
  });

  it('rejects a pending legacy install for a different organization id', () => {
    const canvasManifest: GhostManifest = { ...manifest, id: 'xd-mivo-canvas' };
    const xdIdentity = { ...identity, orgId: 'org-xd', orgSlug: 'xd' };
    const record: PluginMarketInstallationRecord = {
      ...marketInstallation,
      ghostId: 'xd-mivo-canvas',
      organizationId: 'org-other',
      namespace: 'xd',
      manifestDigest: ghostManifestDigest(canvasManifest),
      rawManifestSha256: ghostManifestDigest(canvasManifest),
    };
    expect(loadConnectionAudienceResolver({
      ...resolverOptions(canvasManifest, record),
      readInstallNamespace: () => undefined,
      isPendingLegacyNamespace: () => true,
    }).resolve('xd-mivo-canvas', xdIdentity)).toBeNull();
  });

  it('does not authorize an unconfirmed install just because the catalog namespace was backfilled', () => {
    const canvasManifest: GhostManifest = { ...manifest, id: 'xd-mivo-canvas' };
    const xdIdentity = { ...identity, orgId: 'org-xd', orgSlug: 'xd' };
    const record: PluginMarketInstallationRecord = {
      ...marketInstallation,
      ghostId: 'xd-mivo-canvas',
      organizationId: 'org-xd',
      namespace: 'xd',
      manifestDigest: ghostManifestDigest(canvasManifest),
      rawManifestSha256: ghostManifestDigest(canvasManifest),
    };
    expect(loadConnectionAudienceResolver({
      ...resolverOptions(canvasManifest, record),
      readInstallNamespace: () => undefined,
      isPendingLegacyNamespace: () => false,
    }).resolve('xd-mivo-canvas', xdIdentity)).toBeNull();
  });

  it('resolves a local mivo-canvas and a pending xd-mivo-canvas independently', () => {
    const localManifest: GhostManifest = {
      ...manifest,
      id: 'mivo-canvas',
      network: {
        hosts: ['mivo-canvas.dsworks.cn'],
        secrets: [{
          key: 'cindy_identity',
          label: 'Cindy organization identity',
          source: 'oidc-token' as const,
          inject: {
            header: 'Authorization',
            format: 'Bearer {value}',
            hosts: ['mivo-canvas.dsworks.cn'],
          },
        }],
      },
    };
    const canvasManifest: GhostManifest = { ...manifest, id: 'xd-mivo-canvas' };
    const xdIdentity = { ...identity, orgId: 'org-xd', orgSlug: 'xd' };
    const record: PluginMarketInstallationRecord = {
      ...marketInstallation,
      pluginId: 'cb163dbadea776c1b9ce9be38',
      ghostId: 'xd-mivo-canvas',
      organizationId: 'org-xd',
      namespace: 'xd',
      manifestDigest: ghostManifestDigest(canvasManifest),
      rawManifestSha256: ghostManifestDigest(canvasManifest),
    };
    const resolver = loadConnectionAudienceResolver({
      readInstalledManifestIdentity: (id: string) => {
        const chosen = id === 'mivo-canvas' ? localManifest : canvasManifest;
        return {
          manifest: chosen,
          rawManifestSha256: ghostManifestDigest(chosen),
          legacyManifestDigest: ghostManifestDigest(chosen),
          legacyManifestDigests: [ghostManifestDigest(chosen)],
        };
      },
      readMarketInstallation: (id: string) => (id === 'mivo-canvas' ? null : record),
      readInstallOrigin: () => 'manual',
      readInstallNamespace: () => undefined,
      isPendingLegacyNamespace: (id: string) => id !== 'mivo-canvas',
    });
    expect(resolver.resolve('mivo-canvas', xdIdentity)).toMatchObject({
      audience: 'xd:mivo-canvas',
      pluginSlug: 'mivo-canvas',
    });
    expect(resolver.resolve('xd-mivo-canvas', xdIdentity)).toMatchObject({
      audience: 'xd:xd-mivo-canvas',
      pluginSlug: 'xd-mivo-canvas',
    });
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

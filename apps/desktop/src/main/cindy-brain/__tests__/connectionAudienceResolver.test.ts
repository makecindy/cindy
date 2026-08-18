import { describe, expect, it } from 'vitest';
import type { GhostManifest } from '../../../shared/ghost.js';
import {
  ghostManifestDigest,
  type PluginMarketInstallationRecord,
} from '../../plugin-market/ledger.js';
import {
  isConnectionSecretReady,
  loadConnectionAudienceResolver,
} from '../connectionAudienceResolver.js';

const manifest: GhostManifest = {
  schemaVersion: 2,
  id: 'plugin-a',
  name: 'Plugin A',
  version: '1.0.0',
  kind: 'chip' as const,
  entry: 'index.js',
  slots: ['network'],
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
};

function resolverOptions(
  installedManifest: GhostManifest | null = manifest,
  installation: PluginMarketInstallationRecord | null = marketInstallation,
) {
  return {
    readInstalledManifest: () => installedManifest,
    readInstalledManifestDigest: () =>
      installedManifest ? ghostManifestDigest(installedManifest) : null,
    readMarketInstallation: () => installation,
  };
}

describe('installed Plugin Connection audience resolver', () => {
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
        resolverOptions(manifest, { ...marketInstallation, manifestDigest: undefined }),
      ).resolve('plugin-a', identity),
    ).toBeNull();
  });

  it('rejects a changed installed manifest digest', () => {
    const changedManifest = { ...manifest, version: '2.0.0' };
    const resolver = loadConnectionAudienceResolver(resolverOptions(changedManifest));
    expect(resolver.resolve('plugin-a', identity)).toBeNull();
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

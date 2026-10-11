/**
 * Copied from cindy-server packages/plugin-protocol/src/__tests__/fixtures/namespace.ts
 * at 57850ca2 (S1 merge). The repos do not share this package; keep the sample in sync by hand.
 */
/** Reusable wire examples: same ghostId remains distinct by pluginId and namespace. */
export const namespaceFixtures = (['public', 'organization', 'personal'] as const).map((scope, index) => {
  const namespace = scope === 'organization' ? 'acme' : null;
  const id = `c${String(index + 1).repeat(24)}`;
  const releaseId = `release-${index}`;
  const sha256 = 'a'.repeat(64);
  const sizeBytes = 1024;
  return {
    plugin: {
      id, ghostId: 'x-manager', namespace, scope,
      organizationId: scope === 'organization' ? 'org-example' : null,
      name: 'Example', description: null, author: null, defaultInstall: false,
      currentRelease: { id: releaseId, version: '1.0.0', sha256, sizeBytes, publishedAt: '2026-09-07T00:00:00.000Z', icon: null,
        manifest: { schemaVersion: 2 as const, id: 'x-manager', name: 'Example', version: '1.0.0', kind: 'chip' as const, entry: 'index.js', slots: [], namespace },
      },
    },
    download: { pluginId: id, releaseId, ghostId: 'x-manager', namespace, sha256, sizeBytes, url: 'https://packages.example.test/package.cindy', expiresAt: '2026-09-07T00:05:00.000Z' },
  };
});

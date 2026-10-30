import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import type { InstalledGhost } from '../../../../../shared/ghost';
import type { PluginMarketItem } from '../../../../../shared/pluginMarket';
import { localPublishingUnavailableKey } from '../ghostPluginDetailModel';

const installed: InstalledGhost = {
  manifest: { schemaVersion: 2, id: 'author-plugin', name: 'Author Plugin', version: '1.0.0', kind: 'chip', entry: 'main.js' },
  dir: path.join(os.tmpdir(), 'author-plugin'),
  namespace: null,
  publishingSource: { kind: 'local', source: 'manual' },
  namespaceState: 'confirmed',
  enabled: true,
  approval: { state: 'approved', revision: 'approved-content' },
};

describe('local publishing availability shared by details and selection', () => {
  it('explains the GitHub requirement for verified official public plugins', () => {
    const market = { scope: 'public' as const, organizationId: null, sourceType: 'server' as const, publisherKind: 'official' as const };
    expect(localPublishingUnavailableKey(installed, market)).toBe('officialGithubRequired');
    const trusted: InstalledGhost = { ...installed, publishingSource: { kind: 'public-market', pluginId: 'official-id' },
      trust: { level: 'cindy-official', publisherSigned: true, publisherVerified: true, reviewed: true } };
    expect(localPublishingUnavailableKey(trusted, null)).toBe('officialGithubRequired');
    expect(localPublishingUnavailableKey(installed, { ...market, sourceType: 'local-market' })).toBeNull();
    expect(localPublishingUnavailableKey({ ...installed, manifest: { ...installed.manifest, author: 'Cindy' } }, { ...market, publisherKind: 'personal' })).toBeNull();
  });
  it('keeps UI publishing unavailable for downloaded or unverified sources', () => {
    expect(localPublishingUnavailableKey({ ...installed, publishingSource: undefined })).toBe('sourceUnverified');
    const downloaded: InstalledGhost = { ...installed, publishingSource: { kind: 'public-market', pluginId: 'public-id' } };
    expect(localPublishingUnavailableKey(downloaded)).toBe('publishingPermissionRequired');
    expect(localPublishingUnavailableKey({ ...downloaded, publishingSource: { kind: 'unavailable' } })).toBe('sourceUnverified');
  });
  it.each([
    { ghost: null, reason: 'installationUnavailable' },
    { ghost: { ...installed, manifest: { ...installed.manifest, id: 'cindy-art' } }, reason: 'reservedId' },
    { ghost: { ...installed, builtin: true }, reason: 'reservedId' },
    { ghost: { ...installed, namespace: 'org' }, reason: 'privatePlugin' },
    { ghost: { ...installed, namespace: undefined }, reason: 'privatePlugin' },
    { ghost: { ...installed, namespaceState: undefined }, reason: 'identityPending' },
    { ghost: { ...installed, namespaceState: 'pending' as const }, reason: 'identityPending' },
    { ghost: { ...installed, namespaceState: 'unconfirmed' as const }, reason: 'identityPending' },
    { ghost: { ...installed, approval: { state: 'legacy-unapproved' as const } }, reason: 'approvalRequired' },
    { ghost: { ...installed, approval: { state: 'invalid' as const } }, reason: 'approvalRequired' },
  ])('excludes a locally unavailable installation ($reason)', ({ ghost, reason }) => {
    expect(localPublishingUnavailableKey(ghost)).toBe(reason);
  });

  it.each([
    { scope: 'personal', organizationId: null },
    { scope: 'organization', organizationId: 'org' },
    { scope: 'public', organizationId: 'org' },
  ] satisfies Pick<PluginMarketItem, 'scope' | 'organizationId'>[])(
    'excludes a private market association even for an approved root ($scope)', (market) => {
      expect(localPublishingUnavailableKey(installed, market)).toBe('privatePlugin');
    },
  );

  it('keeps ordinary approved roots available without inferring author rights or requiring enabled state', () => {
    expect(localPublishingUnavailableKey(installed)).toBeNull();
    expect(localPublishingUnavailableKey({ ...installed, enabled: false }, { scope: 'public', organizationId: null })).toBeNull();
  });
});

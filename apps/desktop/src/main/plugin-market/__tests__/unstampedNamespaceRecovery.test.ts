import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GhostManifest } from '../../../shared/ghost.js';
import { createNamespaceMigrationHost } from '../../cindy-brain/pluginNamespaceMigrationHost.js';
import { type NamespaceClassification } from '../../cindy-brain/pluginNamespaceMigration.js';
import { ghostManifestDigest, type PluginMarketInstallationRecord } from '../ledger.js';

const manifest = {
  schemaVersion: 2, id: 'hello', name: 'Hello', version: '1.0.0', kind: 'chip', entry: 'main.js',
} as GhostManifest;
const digest = ghostManifestDigest(manifest);
const packageSha256 = 'b'.repeat(64);
const record: PluginMarketInstallationRecord = {
  pluginId: 'plugin', ghostId: 'hello', releaseId: 'release', version: '1.0.0',
  sha256: packageSha256, scope: 'organization', organizationId: 'org-acme',
  namespace: 'acme', source: 'market', installed: true, updatedAt: '2026-01-01T00:00:00Z',
  rawManifestSha256: digest,
};
const evidence = { packageSha256, approvedManifest: manifest, legacyMigrated: false };
afterEach(() => vi.useRealTimers());

const pending = { kind: 'pending', reason: 'awaiting-market-facts' } as const;
const root = { kind: 'commit', namespace: null, basis: 'manual-after-sync' } as const;
const disconnected = { ...record, installed: false };
const disconnectedWithoutDigest = { ...disconnected, rawManifestSha256: undefined };
const legacyEvidence = { ...evidence, packageSha256: null, legacyMigrated: true };
const migrationCases: Array<{
  name: string;
  record: PluginMarketInstallationRecord;
  additionalRecords?: PluginMarketInstallationRecord[];
  evidence: { packageSha256: string | null; approvedManifest: GhostManifest; legacyMigrated: boolean } | null;
  expected: NamespaceClassification;
  unreadable?: boolean;
  user?: { membershipKind: string; orgId?: string; orgSlug?: string | null };
}> = [
  { name: 'approved organization', record: disconnected, evidence, expected: pending },
  { name: 'changed current organization', record: disconnected, evidence, user: { membershipKind: 'org', orgId: 'org-other', orgSlug: 'other' }, expected: pending },
  { name: 'missing current organization slug', record: disconnected, evidence, user: { membershipKind: 'org', orgId: 'org-acme' }, expected: pending },
  { name: 'current personal account', record: disconnected, evidence, user: { membershipKind: 'personal' }, expected: pending },
  { name: 'pre-namespace organization', record: { ...disconnected, namespace: undefined }, evidence, expected: pending },
  { name: 'migrated legacy digest', record: { ...disconnectedWithoutDigest, manifestDigest: digest }, evidence: legacyEvidence, expected: pending },
  { name: 'migrated legacy without stored identity', record: disconnectedWithoutDigest, evidence: legacyEvidence, expected: pending },
  { name: 'changed package', record: disconnected, evidence: { ...evidence, packageSha256: 'c'.repeat(64) }, expected: root },
  { name: 'changed approved manifest', record: disconnected, evidence: { ...evidence, approvedManifest: { ...manifest, name: 'Other' } }, expected: root },
  { name: 'changed raw identity', record: { ...disconnected, rawManifestSha256: 'c'.repeat(64) }, evidence, expected: root },
  { name: 'changed version', record: { ...disconnected, version: '0.9.0' }, evidence, expected: root },
  { name: 'ordinary removed public record', record: { ...disconnected, scope: 'public' as const, namespace: null, organizationId: null }, evidence, expected: root },
  { name: 'custom source record', record: { ...disconnected, source: 'git-market' as const }, evidence, expected: root },
  { name: 'unavailable approval evidence', record: disconnected, evidence: null, expected: pending },
  { name: 'unreadable installed manifest', record: disconnected, evidence, unreadable: true, expected: pending },
  { name: 'successfully recovered record', record, evidence, expected: { kind: 'commit', namespace: 'acme', basis: 'market-organization' } as const },
  { name: 'active root beside same-byte disconnected organization', record: { ...record, scope: 'public', namespace: null, organizationId: null }, additionalRecords: [disconnected], evidence, expected: { kind: 'commit', namespace: null, basis: 'explicit-root' } },
];

describe.each([
  { entry: 'classification', cases: migrationCases },
  { entry: 'resident-timer', cases: migrationCases.filter((fixture) =>
    fixture.name === 'approved organization' || fixture.name === 'changed package') },
])('production namespace gate via $entry', ({ entry, cases }) => {
  it.each(cases)('$name', async (fixture) => {
    vi.useFakeTimers();
    const records = [structuredClone(fixture.record), ...structuredClone(fixture.additionalRecords ?? [])];
    if (records[0].namespace === undefined) delete records[0].namespace;
    const originalRecords = structuredClone(records);
    const observed: NamespaceClassification[] = [];
    const manager = {
      list: () => [{ manifest, namespaceState: 'pending' }],
      approvedInstallEvidence: vi.fn(() => fixture.evidence),
      readApprovedInstallOriginStrict: (): 'manual' => 'manual',
      reconcilePendingRootNamespaces: vi.fn(async (syncCompleted: boolean) => {
        observed.push(callbacks.classifyPendingNamespaceForGhost('hello', syncCompleted));
      }),
    };
    const callbacks = createNamespaceMigrationHost({
      getPluginMarketLedger: () => ({ lookupInstallationsForNamespaceMigration: () => ({ kind: 'found', records }) }),
      getGhostManager: () => manager,
      getAuthState: () => ({ isAuthenticated: true, user: fixture.user ?? { membershipKind: 'org', orgId: 'org-acme', orgSlug: 'acme' } }),
      createOrganizationPrefixStore: () => ({ lookup: () => ({ kind: 'absent' }) }),
      ownerScopedUserDataPath: (...parts: string[]) => path.join('owner', ...parts),
      brainRootDir: () => path.resolve('brain-root'),
      readInstalledGhostManifestSnapshot: () => fixture.unreadable
        ? { ok: false }
        : { ok: true, snapshot: { manifest, legacyManualIgnored: false, rawManifestSha256: digest, releasedLegacyDigestFormat: manifest, legacyDigestFormats: [manifest] } },
      isAppSessionBoundaryPending: () => false,
      activeOwnerScopeKey: () => 'owner',
      offlineResidentIdsForActiveScope: () => new Set(['hello']),
      pendingResidentMigrationRetryTimers: new Map(),
      pendingResidentMigrationRetryAttempts: new Map(),
      captureGhostMutationOwner: () => ({}),
      beginGhostMutation: () => () => {},
      setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
      oauthLockExists: () => false,
      hasPendingWork: () => false,
      runtimeState: () => null,
      nodeRuntimeRunning: () => false,
      stopRuntime: () => {},
      stopNodeRuntime: async () => {},
      log: { warn: vi.fn() },
    });
    if (entry === 'resident-timer') {
      callbacks.schedulePendingResidentMigrationRetry('hello');
      await vi.advanceTimersByTimeAsync(1000);
      expect(manager.reconcilePendingRootNamespaces).toHaveBeenCalledExactlyOnceWith(true);
    } else {
      observed.push(callbacks.classifyPendingNamespaceForGhost('hello', true));
    }
    expect(observed).toEqual([fixture.expected]);
    expect(callbacks.canResumePendingResidentOffline('hello')).toBe(fixture.expected === root);
    expect(records).toEqual(originalRecords);
  });
});

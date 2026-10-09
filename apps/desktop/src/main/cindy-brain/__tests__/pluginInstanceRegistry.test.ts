import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  adoptContentInstall,
  confirmInstanceNamespace,
  confirmUnconfirmedInstance,
  createPluginInstanceRegistryStore,
  emptyPluginInstanceRegistry,
  findReusableInstance,
  parsePluginInstanceRegistryDocument,
  reconcileInstanceReceipt,
  upsertInstance,
  type PluginInstanceRecord,
} from '../pluginInstanceRegistry.js';

function record(overrides: Partial<PluginInstanceRecord> = {}): PluginInstanceRecord {
  return {
    instanceKey: 'helper',
    contentRelId: 'helper',
    ghostId: 'helper',
    namespace: 'xd',
    namespaceState: 'confirmed',
    pluginId: 'plugin-1',
    source: 'market',
    receiptRevision: 'rev-1',
    packageSha256: 'sha-1',
    active: true,
    ...overrides,
  };
}

describe('plugin instance registry', () => {
  it('adopts an old directory under its existing storage key and does not invent a namespace', () => {
    const adopted = adoptContentInstall({ relId: 'helper', ghostId: 'helper', receipt: null, pendingMigration: true });
    expect(adopted).toMatchObject({
      instanceKey: 'helper',
      contentRelId: 'helper',
      namespace: null,
      namespaceState: 'pending',
    });
  });

  it('keeps the encoded storage key for an already-migrated directory', () => {
    const adopted = adoptContentInstall({
      relId: '_ns/xd/helper',
      ghostId: 'helper',
      receipt: {
        ghostId: 'helper',
        hasNamespace: true,
        namespace: 'xd',
        revision: 'rev-1',
        packageSha256: 'sha-1',
      },
    });
    expect(adopted).toMatchObject({
      instanceKey: '_ns__xd__helper',
      namespace: 'xd',
      namespaceState: 'confirmed',
    });
  });

  it('drops confirmation when an old client strips the receipt field, without a new key', () => {
    const next = reconcileInstanceReceipt(record(), {
      directoryPresent: true,
      receipt: {
        ghostId: 'helper',
        hasNamespace: false,
        namespace: null,
        revision: 'rev-1',
        packageSha256: 'sha-1',
      },
    });
    expect(next.instanceKey).toBe('helper');
    expect(next.namespaceState).toBe('unconfirmed');
    expect(next.namespace).toBe('xd');
  });

  it('does not confirm a pending install just because a receipt field appeared', () => {
    const pending = record({ namespace: null, namespaceState: 'pending', receiptRevision: null, packageSha256: null });
    const next = reconcileInstanceReceipt(pending, {
      directoryPresent: true,
      receipt: {
        ghostId: 'helper',
        hasNamespace: true,
        namespace: 'xd',
        revision: 'rev-2',
        packageSha256: 'sha-2',
      },
    });
    expect(next.namespaceState).toBe('pending');
    expect(next.instanceKey).toBe('helper');
  });

  it('reuses the inactive instance key on reinstall and refuses a second confirmed identity', () => {
    const inactive = record({ active: false });
    const registry = upsertInstance(emptyPluginInstanceRegistry(), inactive);
    expect(findReusableInstance(registry, { ghostId: 'helper', namespace: 'xd' })?.instanceKey).toBe('helper');
    const confirmed = confirmInstanceNamespace(registry, 'helper', 'xd', { revision: 'rev-2', packageSha256: 'sha-2' });
    const other = record({ instanceKey: '_ns__other__helper', active: true, namespaceState: 'pending', namespace: null });
    const withOther = upsertInstance(confirmed, other);
    const blocked = confirmInstanceNamespace(withOther, other.instanceKey, 'xd', { revision: 'rev-3', packageSha256: 'sha-3' });
    expect(blocked.instances[other.instanceKey]?.namespaceState).toBe('pending');
  });

  it('does not treat a directory outside the upgrade census as pending', () => {
    const adopted = adoptContentInstall({ relId: 'helper', ghostId: 'helper', receipt: null });
    expect(adopted).toMatchObject({
      instanceKey: 'helper',
      namespaceState: 'unconfirmed',
      namespace: null,
    });
  });

  it('does not confirm an unconfirmed install just because the receipt namespace comes back', () => {
    const stripped = record({ namespaceState: 'unconfirmed', namespace: 'xd' });
    const next = reconcileInstanceReceipt(stripped, {
      directoryPresent: true,
      receipt: {
        ghostId: 'helper',
        hasNamespace: true,
        namespace: 'xd',
        revision: 'rev-2',
        packageSha256: 'sha-2',
      },
    });
    expect(next).toMatchObject({
      instanceKey: 'helper',
      namespaceState: 'unconfirmed',
      namespace: 'xd',
      receiptRevision: 'rev-2',
      packageSha256: 'sha-2',
    });
  });

  it('does not reuse another source when the caller names one', () => {
    const registry = upsertInstance(emptyPluginInstanceRegistry(), record({ active: false, source: 'agent-forge' }));
    expect(findReusableInstance(registry, { ghostId: 'helper', namespace: 'xd', source: 'manual' })).toBeNull();
    expect(findReusableInstance(registry, { ghostId: 'helper', namespace: 'xd', source: 'agent-forge' })?.instanceKey).toBe('helper');
    const legacy = upsertInstance(emptyPluginInstanceRegistry(), record({ active: false, source: 'legacy', pluginId: null }));
    expect(findReusableInstance(legacy, { ghostId: 'helper', namespace: 'xd', source: 'manual' })?.instanceKey).toBe('helper');
    expect(findReusableInstance(legacy, { ghostId: 'helper', namespace: 'xd', source: 'market', pluginId: 'plugin-a' })?.instanceKey).toBe('helper');
    const marketA = record({ active: false, source: 'market', pluginId: 'plugin-a', instanceKey: 'helper', contentRelId: 'helper' });
    const marketB = record({
      active: false, source: 'market', pluginId: 'plugin-b',
      instanceKey: '_root__helper', contentRelId: '_ns/_root/helper',
    });
    const markets = upsertInstance(upsertInstance(emptyPluginInstanceRegistry(), marketA), marketB);
    expect(findReusableInstance(markets, { ghostId: 'helper', namespace: 'xd', source: 'market', pluginId: 'plugin-a' })?.instanceKey).toBe('helper');
    expect(findReusableInstance(markets, { ghostId: 'helper', namespace: 'xd', source: 'market', pluginId: 'plugin-b' })?.instanceKey).toBe('_root__helper');
    const manual = record({ active: false, source: 'manual', pluginId: null, instanceKey: 'helper', contentRelId: 'helper' });
    const alsoLegacy = record({ active: false, source: 'legacy', pluginId: null, instanceKey: '_root__helper', contentRelId: '_ns/_root/helper' });
    const ambiguous = upsertInstance(upsertInstance(emptyPluginInstanceRegistry(), manual), alsoLegacy);
    expect(findReusableInstance(ambiguous, { ghostId: 'helper', namespace: 'xd', source: 'market', pluginId: 'plugin-a' })).toBeNull();
  });
});

const sha = 'ab'.repeat(32);

describe('confirmUnconfirmedInstance', () => {
  const org = { organizationId: 'org-xd', orgSlug: 'xd' };
  const market = {
    namespace: 'xd' as string | null,
    organizationId: 'org-xd',
    packageSha256: sha,
    scope: 'organization' as const,
    installed: true,
  };

  it('confirms the last known namespace when market, organization, and package sha agree', () => {
    const stripped = record({ namespaceState: 'unconfirmed', packageSha256: sha });
    expect(confirmUnconfirmedInstance(stripped, {
      marketRecords: [market],
      currentOrganization: org,
      packageSha256: sha,
    })).toEqual({ namespace: 'xd' });
  });

  it('does not invent a namespace the registry does not already hold', () => {
    const root = record({ namespaceState: 'unconfirmed', namespace: null, packageSha256: sha });
    expect(confirmUnconfirmedInstance(root, {
      marketRecords: [market],
      currentOrganization: org,
      packageSha256: sha,
    })).toBeNull();
  });

  it.each([
    ['sha mismatch', { packageSha256: 'cd'.repeat(32) }],
    ['other organization', { currentOrganization: { organizationId: 'org-other', orgSlug: 'other' } }],
    ['ambiguous market rows', { marketRecords: [market, market] }],
    ['market facts not ready', { marketRecords: undefined, forgeSelfTest: false }],
    ['missing market namespace field', { marketRecords: [{ ...market, namespace: undefined }] }],
  ] as const)('refuses %s', (_name, patch) => {
    const stripped = record({ namespaceState: 'unconfirmed', packageSha256: sha });
    expect(confirmUnconfirmedInstance(stripped, {
      marketRecords: [market],
      currentOrganization: org,
      packageSha256: sha,
      ...patch,
    })).toBeNull();
  });

  it('confirms a forge self-test only when the last namespace is the current org slug', () => {
    const stripped = record({ namespaceState: 'unconfirmed', source: 'agent-forge', packageSha256: sha });
    expect(confirmUnconfirmedInstance(stripped, {
      marketRecords: [],
      currentOrganization: org,
      packageSha256: sha,
      forgeSelfTest: true,
    })).toEqual({ namespace: 'xd' });
    expect(confirmUnconfirmedInstance(stripped, {
      currentOrganization: { organizationId: 'org-other', orgSlug: 'other' },
      packageSha256: sha,
      forgeSelfTest: true,
    })).toBeNull();
    expect(confirmUnconfirmedInstance(
      record({ namespaceState: 'unconfirmed', namespace: null }),
      { currentOrganization: org, forgeSelfTest: true },
    )).toBeNull();
  });

  it('confirms an explicit public root when the market package sha matches', () => {
    const root = record({
      namespaceState: 'unconfirmed', namespace: null, pluginId: null, source: 'manual', packageSha256: sha,
    });
    expect(confirmUnconfirmedInstance(root, {
      marketRecords: [{
        namespace: null, organizationId: null, packageSha256: sha, scope: 'public', installed: true,
      }],
      packageSha256: sha,
    })).toEqual({ namespace: null });
  });

  it('does not confirm a pending or inactive record', () => {
    const evidence = { marketRecords: [market], currentOrganization: org, packageSha256: sha };
    expect(confirmUnconfirmedInstance(record({ namespaceState: 'pending', namespace: 'xd' }), evidence)).toBeNull();
    expect(confirmUnconfirmedInstance(record({ namespaceState: 'unconfirmed', active: false }), evidence)).toBeNull();
  });
});

describe('plugin instance registry schema', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('treats another integer schema as unknown and leaves the file in place', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-registry-'));
    const filePath = path.join(dir, 'plugin-instances.v2.json');
    const original = '{"schemaVersion":3,"census":null,"instances":{"future":true}}\n';
    fs.writeFileSync(filePath, original);
    const store = createPluginInstanceRegistryStore(filePath);
    expect(store.read().kind).toBe('unknown-schema');
    expect(parsePluginInstanceRegistryDocument({ schemaVersion: 3, census: null, instances: {} }).kind).toBe('unknown-schema');
    expect(parsePluginInstanceRegistryDocument({ schemaVersion: 2, instances: {} }).kind).toBe('corrupt');
    expect(parsePluginInstanceRegistryDocument({ schemaVersion: 1.5, instances: {} }).kind).toBe('corrupt');
    expect(parsePluginInstanceRegistryDocument({ instances: {} }).kind).toBe('corrupt');
    expect(store.discardCorrupt()).toBe(false);
    expect(() => store.write(emptyPluginInstanceRegistry())).toThrow(/unknown-schema/);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
  });

  it('upgrades a v1 file into v2 and leaves the v1 file in place', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-registry-'));
    const v1Path = path.join(dir, 'plugin-instances.v1.json');
    const row = record({ instanceKey: 'helper', contentRelId: 'helper' });
    fs.writeFileSync(v1Path, JSON.stringify({ schemaVersion: 1, instances: { helper: row } }) + String.fromCharCode(10));
    const v1Text = fs.readFileSync(v1Path, 'utf8');
    const store = createPluginInstanceRegistryStore(path.join(dir, 'plugin-instances.v2.json'));
    const read = store.read();
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.registry).toMatchObject({ schemaVersion: 2, census: null });
    expect(read.registry.instances.helper.namespace).toBe('xd');
    store.write({ ...read.registry, census: { completedAt: '2026-01-01T00:00:00.000Z', pendingRelIds: [] } });
    expect(fs.readFileSync(v1Path, 'utf8')).toBe(v1Text);
    const again = store.read();
    expect(again.kind).toBe('ok');
    if (again.kind !== 'ok') return;
    expect(again.registry.census?.completedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(again.registry.instances.helper.active).toBe(true);
  });
});

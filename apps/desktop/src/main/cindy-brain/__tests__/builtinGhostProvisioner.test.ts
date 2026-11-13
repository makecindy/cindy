import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fingerprintDirContent,
  isTrustedBuiltinSeedSource,
  PROVISIONING_STATE_FILE,
  provisionBuiltinGhosts,
  readBuiltinTombstones,
  recordBuiltinTombstone,
  renameBuiltinTombstone,
} from '../builtinGhostProvisioner.js';
import { isGhostInstallLockHeld } from '../ghostInstallLock.js';
import { builtinSeedStoreInstall, isRetainedSeedMarketTarget } from '../builtinSeedStoreInstall.js';
import { GhostManager, CINDY_OFFICIAL_GHOST_TRUST } from '../GhostManager.js';
import { createGhostInstallReceipt, GhostInstallReceiptStore } from '../ghostInstallReceipt.js';
import { PluginMarketLedger } from '../../plugin-market/ledger.js';
import { validateGhostManifest, ghostInstallApprovalToken } from '../../../shared/ghost.js';
import { writeTestCindyPackage } from './cindyPackageFixture.js';
import { createPluginInstanceRegistryStore, pluginInstanceRegistryPath, emptyPluginInstanceRegistry } from '../pluginInstanceRegistry.js';
import { pluginInstallStoragePart } from '../../../shared/pluginIdentity.js';
import { createHash } from 'node:crypto';

const tempDirs: string[] = [];
const managers: GhostManager[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-builtin-locale-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.disposeNotificationIndex();
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

// #10296, unit: existing tests inject the store verdict and miss the root-only
// production adapter. Use real legacy directories, receipts, registry and ledger;
// assert unchanged bytes/approval/storage identity after restart and seed removal.
describe('builtin provisioning physical market identity', () => {
  async function harness(namespace: string | null = 'xd', relId = 'builtin-test') {
    const root = fs.realpathSync.native(await makeTempDir());
    const repoRoot = path.join(root, 'installed');
    const stateRoot = path.join(root, 'installed-install-state');
    const seedRoot = path.join(root, 'seeds');
    const seedDir = await writeMinimalSeed(seedRoot, 'builtin-test');
    const installedDir = await writeMinimalSeed(path.dirname(path.join(repoRoot, ...relId.split('/'))), 'builtin-test');
    await fs.promises.writeFile(path.join(installedDir, 'main.js'), '// market content');
    const manifestBytes = fs.readFileSync(path.join(installedDir, 'ghost.json'));
    const validated = validateGhostManifest(JSON.parse(manifestBytes.toString('utf8')));
    if (!validated.ok) throw new Error(validated.reason);
    const receipt = createGhostInstallReceipt({ manifest: validated.manifest, localeResources: {},
      enabled: false, trust: CINDY_OFFICIAL_GHOST_TRUST, skillContentSha256: {},
      packageSha256: 'b'.repeat(64), namespace });
    const receipts = new GhostInstallReceiptStore(() => stateRoot);
    await receipts.write(receipt, { relId });
    const ledger = new PluginMarketLedger(path.join(root, 'market', 'ledger.v1.json'));
    ledger.upsertInstallation({ pluginId: `c${'a'.repeat(24)}`, ghostId: 'builtin-test',
      namespace, releaseId: 'release-1', version: '1.0.0', sha256: 'b'.repeat(64),
      scope: namespace === null ? 'public' : 'organization', organizationId: namespace === null ? null : 'org-1',
      source: 'market', installed: true, updatedAt: '2026-11-13T00:00:00.000Z',
      rawManifestSha256: createHash('sha256').update(manifestBytes).digest('hex') });
    const registry = emptyPluginInstanceRegistry();
    registry.instances[pluginInstallStoragePart(relId)] = { instanceKey: pluginInstallStoragePart(relId),
      contentRelId: relId, ghostId: 'builtin-test', namespace, namespaceState: 'confirmed',
      pluginId: `c${'a'.repeat(24)}`, source: 'market', receiptRevision: receipt.revision,
      packageSha256: receipt.packageSha256!, active: true };
    const registryStore = createPluginInstanceRegistryStore(pluginInstanceRegistryPath(stateRoot));
    registryStore.write(registry);
    const manager = new GhostManager({ getRootDir: () => repoRoot,
      isTrustedBundledId: id => id === 'builtin-test',
      isTrustedBundledSource: (id, source) => id === 'builtin-test' && path.resolve(source) === seedDir,
      readUnconfirmedConfirmationEvidence: instance => ({
        marketRecords: [{ namespace, organizationId: 'org-1', scope: 'organization',
          packageSha256: ledger.installationForAuthorization({ ghostId: instance.ghostId, namespace })?.sha256 }],
        currentOrganization: { organizationId: 'org-1', orgSlug: 'xd' }, packageSha256: instance.packageSha256,
      }),
    });
    managers.push(manager);
    fs.writeFileSync(path.join(repoRoot, PROVISIONING_STATE_FILE), JSON.stringify({ removed: [], seeded: ['builtin-test'] }));
    const deps = { seedRootDirs: [seedRoot], repoRootDir: repoRoot,
      storeInstall: (id: string, dir: string) => builtinSeedStoreInstall(id, dir, { rootDir: repoRoot, manager, ledger }) };
    return { ...deps, deps, seedRoot, seedDir, repoRoot, installedDir, stateRoot, registryStore, registry, manager, ledger, receipt, receipts, relId };
  }

  it.each(['0.9.0', '1.0.0', 'not-semver', '2.0.0'])('preserves a legacy organization install against seed %s', async version => {
    const fixture = await harness();
    const seed = JSON.parse(fs.readFileSync(path.join(fixture.seedDir, 'ghost.json'), 'utf8'));
    fs.writeFileSync(path.join(fixture.seedDir, 'ghost.json'), JSON.stringify({ ...seed, version }));
    const before = fixture.receipts.read(fixture.relId);
    expect((await provisionBuiltinGhosts(fixture.deps)).updated).toEqual([]);
    expect(fs.readFileSync(path.join(fixture.installedDir, 'main.js'), 'utf8')).toBe('// market content');
    expect(fixture.receipts.read(fixture.relId)).toEqual(before);
    expect(fixture.manager.list()).toEqual([expect.objectContaining({ instanceKey: 'builtin-test', namespace: 'xd',
      namespaceState: 'confirmed', enabled: false, approval: expect.objectContaining({ state: 'approved', revision: fixture.receipt.revision }) })]);
    expect((await provisionBuiltinGhosts(fixture.deps)).approved).toEqual([]);
  });

  it.each(['audience', 'orphan'])('does not reclaim a legacy organization install after %s changes', async mode => {
    const fixture = await harness();
    if (mode === 'audience') fs.writeFileSync(path.join(fixture.seedRoot, 'provisioning.json'),
      JSON.stringify({ ghosts: { 'builtin-test': { audience: { userIds: ['someone-else'] } } } }));
    else {
      await writeMinimalSeed(fixture.seedRoot, 'another-seed');
      fs.renameSync(fixture.seedDir, path.join(path.dirname(fixture.seedRoot), 'withdrawn-seed'));
    }
    expect((await provisionBuiltinGhosts(fixture.deps)).removed).toEqual([]);
    expect(fs.readFileSync(path.join(fixture.installedDir, 'main.js'), 'utf8')).toBe('// market content');
    expect(fixture.receipts.read(fixture.relId)).toMatchObject({ state: 'approved', receipt: { namespace: 'xd', enabled: false } });
  });

  it('keeps new-layout organization bytes separate while a newer root seed updates', async () => {
    const fixture = await harness(null, '_ns/_root/builtin-test');
    const orgDir = await writeMinimalSeed(path.join(fixture.repoRoot, '_ns', 'xd'), 'builtin-test');
    fs.writeFileSync(path.join(orgDir, 'main.js'), '// independent organization');
    const seed = JSON.parse(fs.readFileSync(path.join(fixture.seedDir, 'ghost.json'), 'utf8'));
    fs.writeFileSync(path.join(fixture.seedDir, 'ghost.json'), JSON.stringify({ ...seed, version: '2.0.0' }));
    expect((await provisionBuiltinGhosts(fixture.deps)).updated).toHaveLength(1);
    expect(fs.readFileSync(path.join(fixture.installedDir, 'main.js'), 'utf8')).toBe('// brain');
    expect(fs.readFileSync(path.join(orgDir, 'main.js'), 'utf8')).toBe('// independent organization');
  });

  it.each(['ledger', 'binding', 'pending'])('keeps bytes and approval when %s evidence is unavailable', async failure => {
    const fixture = await harness();
    if (failure === 'ledger') fs.writeFileSync(path.join(path.dirname(fixture.stateRoot), 'market', 'ledger.v1.json'), '{broken');
    else {
      const instance = fixture.registry.instances['builtin-test']!;
      if (failure === 'binding') instance.pluginId = `c${'c'.repeat(24)}`;
      else instance.namespaceState = 'pending';
      fixture.registryStore.write(fixture.registry);
    }
    const outcome = await provisionBuiltinGhosts(fixture.deps);
    expect(outcome.updated).toEqual([]);
    expect(outcome.approved).toEqual([]);
    expect(outcome.retryPending).toBe(true);
    expect(fixture.receipts.read(fixture.relId)).toMatchObject({ state: 'approved', receipt: { revision: fixture.receipt.revision } });
    expect(fs.readFileSync(path.join(fixture.installedDir, 'main.js'), 'utf8')).toBe('// market content');
  });

  // An absent/uninstalled ledger is not positive root evidence. Exercise all
  // destructive seed paths with the pre-namespace receipt and actual registry.
  it.each([
    ['absent', 'replace'], ['uninstalled', 'replace'],
    ['absent', 'audience'], ['uninstalled', 'audience'],
    ['absent', 'orphan'], ['uninstalled', 'orphan'],
  ])('preserves pending identity with %s ledger during %s', async (ledgerState, action) => {
    const fixture = await harness();
    const legacyReceipt = { ...fixture.receipt };
    delete legacyReceipt.namespace;
    await fixture.receipts.write(legacyReceipt, { relId: fixture.relId });
    Object.assign(fixture.registry.instances['builtin-test']!, {
      namespace: null, namespaceState: 'pending', source: 'legacy', pluginId: null,
    });
    fixture.registryStore.write(fixture.registry);
    if (ledgerState === 'absent') {
      await fs.promises.unlink(path.join(path.dirname(fixture.stateRoot), 'market', 'ledger.v1.json'));
    } else {
      const record = fixture.ledger.installationForAuthorization({ ghostId: 'builtin-test', namespace: 'xd' })!;
      fixture.ledger.upsertInstallation({ ...record, installed: false });
    }
    if (action === 'audience') fs.writeFileSync(path.join(fixture.seedRoot, 'provisioning.json'),
      JSON.stringify({ ghosts: { 'builtin-test': { audience: { userIds: ['someone-else'] } } } }));
    if (action === 'orphan') {
      await writeMinimalSeed(fixture.seedRoot, 'another-seed');
      fs.renameSync(fixture.seedDir, path.join(path.dirname(fixture.seedRoot), 'withdrawn-seed'));
    }
    const before = fixture.receipts.read(fixture.relId);
    const outcome = await provisionBuiltinGhosts(fixture.deps);
    expect(outcome.updated).not.toContain('builtin-test');
    expect(outcome.approved).not.toContain('builtin-test');
    expect(outcome.removed).not.toContain('builtin-test');
    expect(outcome.retryPending).toBe(true);
    expect(fs.readFileSync(path.join(fixture.installedDir, 'main.js'), 'utf8')).toBe('// market content');
    expect(fixture.receipts.read(fixture.relId)).toEqual(before);
    expect(fixture.manager.readInstanceForContent(fixture.relId)).toMatchObject({
      namespace: null, namespaceState: 'pending', instanceKey: 'builtin-test',
    });
  });

  it.each(['restore', 'wrong-source', 'changed-bytes'])('a retained organization overwritten by a root seed: %s', async mode => {
    const fixture = await harness();
    fixture.manager.list();
    const seed = validateGhostManifest(JSON.parse(fs.readFileSync(path.join(fixture.seedDir, 'ghost.json'), 'utf8')));
    if (!seed.ok) throw new Error('bad seed fixture');
    // Reproduce the released publisher, including its root receipt rewrite.
    await fixture.manager.runExclusiveMutation(async mutation => {
      await mutation.publishTrustedBundledSeed('builtin-test', fixture.seedDir, { disabled: true });
      await mutation.approveTrustedBundledInstall(seed.manifest, false, { sourceDir: fixture.seedDir });
    });
    const [overwritten] = fixture.manager.list();
    expect(overwritten).toMatchObject({ namespace: 'xd', namespaceState: 'unconfirmed', enabled: false });
    const record = fixture.ledger.installationForAuthorization({ ghostId: 'builtin-test', namespace: 'xd' })!;
    expect(isRetainedSeedMarketTarget(overwritten!, record, fixture.manager)).toBe(true);
    expect((await provisionBuiltinGhosts(fixture.deps)).approved).toEqual([]);
    const packageFile = await writeTestCindyPackage(path.join(fixture.repoRoot, '..', 'restore.cindy'),
      JSON.parse(fs.readFileSync(path.join(fixture.seedDir, 'ghost.json'), 'utf8')), { 'main.js': '// restored market' });
    const inspected = await fixture.manager.inspect(packageFile, 'stored-release');
    if ('rejection' in inspected) throw new Error(inspected.rejection.reason);
    if (mode === 'changed-bytes') fs.writeFileSync(path.join(fixture.installedDir, 'main.js'), '// changed after approval');
    const result = await fixture.manager.update(packageFile, {
      namespace: 'xd', expectedInstalledInstanceId: 'builtin-test', manifestSource: 'stored-release',
      expectedInstalledApproval: ghostInstallApprovalToken(overwritten!.approval),
      expectedPackageSha256: inspected.packageSha256,
      seededMarketRecovery: { pluginId: mode === 'wrong-source' ? 'another-plugin' : record.pluginId, sourceDir: fixture.seedDir },
    });
    if (mode !== 'restore') {
      expect(result).toMatchObject({ rejection: { code: 'state-changed' } });
      expect(fixture.receipts.read(fixture.relId)).toMatchObject({ state: 'approved', receipt: { namespace: null } });
      return;
    }
    if ('rejection' in result) throw new Error(result.rejection.reason);
    expect(result.ghost).toMatchObject({ dir: fixture.installedDir, instanceKey: 'builtin-test', enabled: false });
    fixture.ledger.upsertInstallation({ ...record, sha256: inspected.packageSha256 });
    const confirmed = await fixture.manager.confirmUpdatedInstanceNamespace(result.ghost);
    expect(confirmed).toMatchObject({ namespace: 'xd', namespaceState: 'confirmed', instanceKey: 'builtin-test', enabled: false });
    expect(fs.readFileSync(path.join(fixture.installedDir, 'main.js'), 'utf8')).toBe('// restored market');
  });
});

async function writeMinimalSeed(seedRoot: string, id: string): Promise<string> {
  const seedDir = path.join(seedRoot, id);
  await fs.promises.mkdir(seedDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(seedDir, 'ghost.json'),
    JSON.stringify({
      schemaVersion: 2,
      id,
      name: id,
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['tool'],
      tools: [{ name: 'run', description: 'Run it' }],
    }),
  );
  await fs.promises.writeFile(path.join(seedDir, 'main.js'), '// brain');
  return seedDir;
}

describe('builtin provisioning durable state', () => {
  it('writes tombstones through an atomic replacement without leaving temp files', async () => {
    const repoRoot = await makeTempDir();

    recordBuiltinTombstone(repoRoot, 'builtin-test');

    expect(readBuiltinTombstones(repoRoot)).toEqual(['builtin-test']);
    expect((await fs.promises.readdir(repoRoot)).filter((name) => name.includes('.tmp-'))).toEqual(
      [],
    );
  });

  it('reports tombstone replacement failure instead of claiming the uninstall intent persisted', async () => {
    const repoRoot = await makeTempDir();
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      const error = new Error('access denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    });

    expect(() => recordBuiltinTombstone(repoRoot, 'builtin-test')).toThrow(
      'builtin provisioning state write failed',
    );
    expect(fs.existsSync(path.join(repoRoot, PROVISIONING_STATE_FILE))).toBe(false);
    rename.mockRestore();
  });

  it('moves renamed tombstones in one atomic state update', async () => {
    const repoRoot = await makeTempDir();
    recordBuiltinTombstone(repoRoot, 'builtin-old');

    expect(renameBuiltinTombstone(repoRoot, 'builtin-old', 'builtin-new')).toBe(true);
    expect(readBuiltinTombstones(repoRoot)).toEqual(['builtin-new']);
  });

  it('preserves the old tombstone when an atomic rename update cannot commit', async () => {
    const repoRoot = await makeTempDir();
    recordBuiltinTombstone(repoRoot, 'builtin-old');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      const error = new Error('access denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    });

    expect(() => renameBuiltinTombstone(repoRoot, 'builtin-old', 'builtin-new')).toThrow(
      'builtin provisioning state write failed',
    );
    expect(readBuiltinTombstones(repoRoot)).toEqual(['builtin-old']);
    rename.mockRestore();
  });

  it('fails closed on a corrupt ledger instead of overwriting it or reseeding', async () => {
    const root = await makeTempDir();
    const seedRoot = path.join(root, 'seeds');
    const repoRoot = path.join(root, 'installed');
    await writeMinimalSeed(seedRoot, 'builtin-test');
    await fs.promises.mkdir(repoRoot, { recursive: true });
    const stateFile = path.join(repoRoot, PROVISIONING_STATE_FILE);
    await fs.promises.writeFile(stateFile, '{broken');
    const warn = vi.fn();

    const outcome = await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      log: { info: vi.fn(), warn },
    });

    expect(outcome.skipped).toEqual(['builtin-test']);
    expect(fs.existsSync(path.join(repoRoot, 'builtin-test'))).toBe(false);
    expect(await fs.promises.readFile(stateFile, 'utf8')).toBe('{broken');
    expect(() => readBuiltinTombstones(repoRoot)).toThrow(
      'builtin provisioning state is unreadable',
    );
    expect(warn).toHaveBeenCalledWith(
      'builtin provisioning state unreadable',
      expect.objectContaining({ file: stateFile }),
    );
  });

  it('fails closed on path-traversal ids in the seeded ledger', async () => {
    const root = await makeTempDir();
    const seedRoot = path.join(root, 'seeds');
    const repoRoot = path.join(root, 'installed');
    const outside = path.join(root, 'outside');
    await writeMinimalSeed(seedRoot, 'builtin-test');
    await fs.promises.mkdir(repoRoot, { recursive: true });
    const stateFile = path.join(repoRoot, PROVISIONING_STATE_FILE);
    await fs.promises.writeFile(
      stateFile,
      JSON.stringify({ removed: [], seeded: ['..\\outside'] }),
    );
    const warn = vi.fn();

    const outcome = await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      log: { info: vi.fn(), warn },
    });

    expect(outcome.installed).toEqual([]);
    expect(fs.existsSync(outside)).toBe(false);
    expect(await fs.promises.readFile(stateFile, 'utf8')).toContain('..\\\\outside');
    expect(warn).toHaveBeenCalledWith(
      'builtin provisioning state contains invalid ghost id',
      expect.objectContaining({ file: stateFile }),
    );
  });

  it('retains seeded ownership when audience cleanup fails so the next pass retries', async () => {
    const root = await makeTempDir();
    const seedRoot = path.join(root, 'seeds');
    const repoRoot = path.join(root, 'installed');
    await writeMinimalSeed(seedRoot, 'builtin-test');
    await writeMinimalSeed(repoRoot, 'builtin-test');
    await fs.promises.writeFile(
      path.join(seedRoot, 'provisioning.json'),
      JSON.stringify({
        ghosts: { 'builtin-test': { audience: { userIds: ['allowed-user'] } } },
      }),
    );
    const stateFile = path.join(repoRoot, PROVISIONING_STATE_FILE);
    await fs.promises.writeFile(
      stateFile,
      JSON.stringify({ removed: [], seeded: ['builtin-test'] }),
    );
    const beforeRemove = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('journal temporarily unavailable'))
      .mockResolvedValueOnce(undefined);

    const first = await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      identity: { userId: 'denied-user', email: null },
      beforeRemove,
    });

    expect(first.removed).toEqual([]);
    expect(fs.existsSync(path.join(repoRoot, 'builtin-test'))).toBe(true);
    expect(JSON.parse(await fs.promises.readFile(stateFile, 'utf8'))).toMatchObject({
      seeded: ['builtin-test'],
    });

    const second = await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      identity: { userId: 'denied-user', email: null },
      beforeRemove,
    });

    expect(beforeRemove).toHaveBeenCalledTimes(2);
    expect(second.removed).toEqual(['builtin-test']);
    expect(fs.existsSync(path.join(repoRoot, 'builtin-test'))).toBe(false);
    expect(JSON.parse(await fs.promises.readFile(stateFile, 'utf8'))).toMatchObject({ seeded: [] });
  });

  it('keeps orphan removal failures retryable for the stable-owner pass', async () => {
    const root = await makeTempDir();
    const seedRoot = path.join(root, 'seeds');
    const repoRoot = path.join(root, 'installed');
    await writeMinimalSeed(seedRoot, 'current-builtin');
    await writeMinimalSeed(repoRoot, 'current-builtin');
    await writeMinimalSeed(repoRoot, 'retired-builtin');
    await fs.promises.writeFile(
      path.join(repoRoot, PROVISIONING_STATE_FILE),
      JSON.stringify({ removed: [], seeded: ['current-builtin', 'retired-builtin'] }),
    );
    const beforeRemove = vi.fn().mockRejectedValue(new Error('mutation journal unavailable'));

    const outcome = await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      beforeRemove,
    });

    expect(outcome.retryPending).toBe(true);
    expect(outcome.removed).toEqual([]);
    expect(fs.existsSync(path.join(repoRoot, 'retired-builtin'))).toBe(true);
    expect(JSON.parse(await fs.promises.readFile(
      path.join(repoRoot, PROVISIONING_STATE_FILE),
      'utf8',
    ))).toMatchObject({ seeded: ['current-builtin', 'retired-builtin'] });
  });

  it('keeps a failed final seeded-ledger update retryable for the stable-owner pass', async () => {
    const root = await makeTempDir();
    const seedRoot = path.join(root, 'seeds');
    const repoRoot = path.join(root, 'installed');
    await writeMinimalSeed(seedRoot, 'current-builtin');
    await writeMinimalSeed(repoRoot, 'current-builtin');
    await writeMinimalSeed(repoRoot, 'retired-builtin');
    await fs.promises.writeFile(
      path.join(repoRoot, PROVISIONING_STATE_FILE),
      JSON.stringify({ removed: [], seeded: ['current-builtin', 'retired-builtin'] }),
    );
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      const error = new Error('state root temporarily busy') as NodeJS.ErrnoException;
      error.code = 'EBUSY';
      throw error;
    });

    const outcome = await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
    });

    expect(outcome.retryPending).toBe(true);
    expect(outcome.removed).toEqual(['retired-builtin']);
    expect(fs.existsSync(path.join(repoRoot, 'retired-builtin'))).toBe(false);
    expect(JSON.parse(await fs.promises.readFile(
      path.join(repoRoot, PROVISIONING_STATE_FILE),
      'utf8',
    ))).toMatchObject({ seeded: ['current-builtin', 'retired-builtin'] });
  });

  it('persists seeded ownership before replacing installed bytes', async () => {
    const root = await makeTempDir();
    const seedRoot = path.join(root, 'seeds');
    const repoRoot = path.join(root, 'installed');
    await writeMinimalSeed(seedRoot, 'builtin-test');
    const installedDir = await writeMinimalSeed(repoRoot, 'builtin-test');
    await fs.promises.writeFile(path.join(installedDir, 'main.js'), '// old bytes');
    const beforeReplace = vi.fn(() => {
      const state = JSON.parse(
        fs.readFileSync(path.join(repoRoot, PROVISIONING_STATE_FILE), 'utf8'),
      ) as { seeded?: string[] };
      expect(state.seeded).toContain('builtin-test');
    });

    await provisionBuiltinGhosts({ seedRootDirs: [seedRoot], repoRootDir: repoRoot, beforeReplace });
    expect(beforeReplace).toHaveBeenCalledTimes(1);
  });

  it('keeps transient publish failures retryable for the stable-owner pass', async () => {
    const root = await makeTempDir();
    const seedRoot = path.join(root, 'seeds');
    const repoRoot = path.join(root, 'installed');
    await writeMinimalSeed(seedRoot, 'builtin-test');
    const publishSeed = vi.fn().mockRejectedValue(new Error('state root temporarily busy'));

    const outcome = await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      publishSeed,
    });

    expect(outcome.retryPending).toBe(true);
    expect(outcome.installed).toEqual([]);
    expect(publishSeed).toHaveBeenCalledTimes(1);
  });
});

describe('builtin seed source boundary', () => {
  it('accepts the exact link-free seed directory', async () => {
    const root = await makeTempDir();
    const seedRoot = path.join(root, 'seeds');
    const seedDir = await writeMinimalSeed(seedRoot, 'builtin-test');

    expect(isTrustedBuiltinSeedSource([seedRoot], 'builtin-test', seedDir)).toBe(true);
  });

  it('rejects a seed root reached through a symlink or junction', async () => {
    const root = await makeTempDir();
    const realRoot = path.join(root, 'real-seeds');
    await writeMinimalSeed(realRoot, 'builtin-test');
    const linkedRoot = path.join(root, 'linked-seeds');
    try {
      await fs.promises.symlink(
        realRoot,
        linkedRoot,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return;
    }

    expect(
      isTrustedBuiltinSeedSource(
        [linkedRoot],
        'builtin-test',
        path.join(linkedRoot, 'builtin-test'),
      ),
    ).toBe(false);
    const outcome = await provisionBuiltinGhosts({
      seedRootDirs: [linkedRoot],
      repoRootDir: path.join(root, 'installed'),
    });
    expect(outcome.installed).toEqual([]);
  });
});

describe('fingerprintDirContent', () => {
  /** 建链接;该环境无权限时返回 false 让调用方跳过(判定逻辑与其他平台同源)。 */
  async function tryLink(target: string, linkPath: string): Promise<boolean> {
    try {
      await fs.promises.symlink(
        target,
        linkPath,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      return true;
    } catch {
      return false;
    }
  }

  it('flags a planted link instead of folding it into the content hash', async () => {
    const root = await makeTempDir();
    const installed = path.join(root, 'installed');
    const outside = path.join(root, 'outside');
    await fs.promises.mkdir(installed, { recursive: true });
    await fs.promises.mkdir(outside, { recursive: true });
    await fs.promises.writeFile(path.join(installed, 'main.js'), '// brain');
    await fs.promises.writeFile(path.join(outside, 'leak.txt'), 'outside bytes');

    const before = await fingerprintDirContent(installed);
    expect(before.hasNonRegularEntry).toBe(false);

    if (!(await tryLink(outside, path.join(installed, 'linked')))) return;

    const after = await fingerprintDirContent(installed);
    // 类型状态独立于哈希:内容哈希不变(链接没有内容),但状态位翻过来。
    expect(after.hasNonRegularEntry).toBe(true);
    expect(after.hash).toBe(before.hash);
  });

  it('keeps type out of the hash so a sentinel-valued regular file stays distinguishable', async () => {
    // **这是契约/文档用例,不是回归用例**:它无法表达修复前的状态(那时没有
    // hasNonRegularEntry 字段,代码都编译不过),已实测在"sentinel 进哈希 + 有状态位"
    // 的混合态下同样会绿。真正的回归点是本文件下面那条端到端用例
    // (`re-seeds when a seed file was replaced by a link...`)—— 判据落在 provisioner
    // 的决策上,才能在旧实现下变红。
    // 这里只钉住契约:类型信息不掺进字节流,所以"内容恰为 sentinel 的普通文件"与
    // "同名链接"始终可区分。
    const root = await makeTempDir();
    const withFile = path.join(root, 'with-file');
    const withLink = path.join(root, 'with-link');
    const target = path.join(root, 'target');
    await fs.promises.mkdir(withFile, { recursive: true });
    await fs.promises.mkdir(withLink, { recursive: true });
    await fs.promises.mkdir(target, { recursive: true });
    await fs.promises.writeFile(path.join(withFile, 'entry'), 'non-regular');

    if (!(await tryLink(target, path.join(withLink, 'entry')))) return;

    const fileSide = await fingerprintDirContent(withFile);
    const linkSide = await fingerprintDirContent(withLink);
    expect(fileSide.hasNonRegularEntry).toBe(false);
    expect(linkSide.hasNonRegularEntry).toBe(true);
    // 即便两侧哈希相同也不会被误判为一致 —— 判定还要看类型状态。
    expect(
      fileSide.hash === linkSide.hash &&
        fileSide.hasNonRegularEntry === linkSide.hasNonRegularEntry,
    ).toBe(false);
  });

  it('matches identical link-free directories under the v2 encoding', async () => {
    // 同一套 v2 编码下，内容相同的普通目录必须得到相同指纹；这个用例不主张与旧版
    // 摘要兼容（v2 framing 本来就会主动改变旧摘要）。
    const root = await makeTempDir();
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    for (const dir of [a, b]) {
      await fs.promises.mkdir(path.join(dir, 'nested'), { recursive: true });
      await fs.promises.writeFile(path.join(dir, 'main.js'), '// brain');
      await fs.promises.writeFile(path.join(dir, 'nested', 'x.txt'), 'x');
      await fs.promises.writeFile(path.join(dir, '.disabled'), '');
    }
    const fa = await fingerprintDirContent(a);
    const fb = await fingerprintDirContent(b);
    expect(fa.hash).toBe(fb.hash);
    expect(fa.hasNonRegularEntry).toBe(false);
  });
});

describe('builtinGhostProvisioner 安装目录被塞入链接时重新播种', () => {
  it('re-seeds when a seed file was replaced by a link, even if its bytes could spoof a hash sentinel', async () => {
    // 决定性用例:判定必须落在 provisioner 的**决策**上,而不是指纹结构上。
    // 把非普通条目当 sentinel 喂进哈希的实现里,种子文件 `entry` 内容恰为该 sentinel
    // 时,同名链接与它的摘要完全相等(已实测),于是安装目录被判成"逐字节一致"而跳过
    // 重新播种 —— 目录永远修不回来,随后批准又必然失败,插件卡在不可用。
    const root = await makeTempDir();
    const seedRoot = path.join(root, 'seeds');
    const repoRoot = path.join(root, 'installed');
    const seedDir = path.join(seedRoot, 'linked-seed');
    const installedDir = path.join(repoRoot, 'linked-seed');
    const outside = path.join(root, 'outside');
    const manifest = JSON.stringify({
      schemaVersion: 2,
      id: 'linked-seed',
      name: 'Linked seed',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['tool'],
      tools: [{ name: 'run', description: 'Run it' }],
    });
    await fs.promises.mkdir(seedDir, { recursive: true });
    await fs.promises.mkdir(installedDir, { recursive: true });
    await fs.promises.mkdir(outside, { recursive: true });
    await fs.promises.writeFile(path.join(outside, 'leak.txt'), 'outside bytes');
    for (const dir of [seedDir, installedDir]) {
      await fs.promises.writeFile(path.join(dir, 'ghost.json'), manifest);
      await fs.promises.writeFile(path.join(dir, 'main.js'), '// brain');
      // 内容刻意等于旧实现的 sentinel 字符串。
      await fs.promises.writeFile(path.join(dir, 'entry'), 'non-regular');
    }

    // 安装侧把这个普通文件换成同名链接。
    await fs.promises.rm(path.join(installedDir, 'entry'));
    try {
      await fs.promises.symlink(
        outside,
        path.join(installedDir, 'entry'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return; // 该环境建不了链接(无权限),跳过;判定逻辑与其他平台同源。
    }

    const beforeReplace = vi.fn();
    const outcome = await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      beforeReplace,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    expect(outcome.updated.map((m) => m.id)).toContain('linked-seed');
    expect(beforeReplace).toHaveBeenCalledWith('linked-seed');
    expect(outcome.skipped).not.toContain('linked-seed');
    // 重新播种后安装目录回到随包字节:链接消失,普通文件回来。
    expect((await fs.promises.lstat(path.join(installedDir, 'entry'))).isFile()).toBe(true);
  });
});

describe('builtinGhostProvisioner 安装目录被塞入点开头链接时重新播种', () => {
  it('re-seeds when a dot-named link was planted, even though dot entries stay out of the hash', async () => {
    // 回归点:指纹跳过点开头条目(`.disabled` 是用户状态不是内容),上一版对它们
    // 直接 continue —— 于是名为 `.x` 的链接既不进指纹也不翻类型状态位,安装目录被
    // 塞进链接却判成"与种子逐字节相同"而跳过播种。现在类型判定排在点开头过滤之前。
    const root = await makeTempDir();
    const seedRoot = path.join(root, 'seeds');
    const repoRoot = path.join(root, 'installed');
    const seedDir = path.join(seedRoot, 'dotlink');
    const installedDir = path.join(repoRoot, 'dotlink');
    const outside = path.join(root, 'outside');
    const manifest = JSON.stringify({
      schemaVersion: 2,
      id: 'dotlink',
      name: 'Dot link',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['tool'],
      tools: [{ name: 'run', description: 'Run it' }],
    });
    await fs.promises.mkdir(seedDir, { recursive: true });
    await fs.promises.mkdir(installedDir, { recursive: true });
    await fs.promises.mkdir(outside, { recursive: true });
    for (const dir of [seedDir, installedDir]) {
      await fs.promises.writeFile(path.join(dir, 'ghost.json'), manifest);
      await fs.promises.writeFile(path.join(dir, 'main.js'), '// brain');
    }
    // 内容字节完全一致,唯一差别是安装侧多了一条点开头链接。
    try {
      await fs.promises.symlink(
        outside,
        path.join(installedDir, '.sneaky'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return; // 该环境建不了链接(无权限),跳过;判定逻辑与其他平台同源。
    }

    const outcome = await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    expect(outcome.updated.map((m) => m.id)).toContain('dotlink');
    expect(outcome.skipped).not.toContain('dotlink');
    // 重新播种后链接消失(点开头条目不随种子复制),下一轮启动即判一致、不再反复播种。
    expect(fs.existsSync(path.join(installedDir, '.sneaky'))).toBe(false);
  });
});

describe('builtinGhostProvisioner 坏种子 fail closed', () => {
  it('种子含非普通条目时跳过，不交换目录也不申请批准', async () => {
    const root = await makeTempDir();
    const seedRoot = path.join(root, 'seeds');
    const repoRoot = path.join(root, 'installed');
    const seedDir = path.join(seedRoot, 'bad-seed');
    const outside = path.join(root, 'outside');
    await fs.promises.mkdir(seedDir, { recursive: true });
    await fs.promises.mkdir(outside, { recursive: true });
    await fs.promises.writeFile(
      path.join(seedDir, 'ghost.json'),
      JSON.stringify({
        schemaVersion: 2,
        id: 'bad-seed',
        name: 'Bad seed',
        version: '1.0.0',
        kind: 'chip',
        entry: 'main.js',
        slots: ['tool'],
        tools: [{ name: 'run', description: 'Run it' }],
      }),
    );
    await fs.promises.writeFile(path.join(seedDir, 'main.js'), '// brain');
    try {
      await fs.promises.symlink(
        outside,
        path.join(seedDir, '.linked'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return;
    }
    const warn = vi.fn();

    const outcome = await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      log: { info: vi.fn(), warn },
    });

    expect(outcome.skipped).toContain('bad-seed');
    expect(outcome.retryPending).toBeUndefined();
    expect(outcome.installed).toEqual([]);
    expect(outcome.approved).toEqual([]);
    expect(fs.existsSync(path.join(repoRoot, 'bad-seed'))).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'builtin ghost provisioning failed',
      expect.objectContaining({
        id: 'bad-seed',
        error: expect.stringContaining('non-regular'),
      }),
    );
  });
});

describe('builtinGhostProvisioner locale validation', () => {
  it('locale 资源翻译错位时跳过官方种子，不把损坏翻译播种给用户', async () => {
    const root = await makeTempDir();
    const seedRoot = path.join(root, 'seeds');
    const repoRoot = path.join(root, 'installed');
    const seedDir = path.join(seedRoot, 'localized-seed');
    await fs.promises.mkdir(path.join(seedDir, 'locales'), { recursive: true });
    await fs.promises.writeFile(path.join(seedDir, 'main.js'), '// brain');
    await fs.promises.writeFile(
      path.join(seedDir, 'ghost.json'),
      JSON.stringify({
        schemaVersion: 2,
        id: 'localized-seed',
        name: 'Base',
        version: '1.0.0',
        entry: 'main.js',
        slots: ['tool'],
        tools: [{ name: 'run', description: 'Base tool' }],
        locales: { en: 'locales/en.json' },
      }),
    );
    await fs.promises.writeFile(
      path.join(seedDir, 'locales', 'en.json'),
      JSON.stringify({ name: 'English', tools: { nope: { description: 'x' } } }),
    );
    const warn = vi.fn();

    const outcome = await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      log: { info: vi.fn(), warn },
    });

    expect(outcome).toMatchObject({
      installed: [],
      updated: [],
      skipped: ['localized-seed'],
    });
    expect(fs.existsSync(path.join(repoRoot, 'localized-seed'))).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'builtin seed skipped: invalid locale resources',
      expect.objectContaining({ reason: expect.stringContaining('locale.tools 含未知工具') }),
    );
  });

  it('cindy-github 内置种子首装和旧安装回填都写入官方 Host trust', async () => {
    const root = await makeTempDir();
    const seedRoot = path.join(root, 'seeds');
    const repoRoot = path.join(root, 'installed');
    const seedDir = path.join(seedRoot, 'cindy-github');
    await fs.promises.mkdir(seedDir, { recursive: true });
    await fs.promises.writeFile(path.join(seedDir, 'main.js'), '// github');
    await fs.promises.writeFile(
      path.join(seedDir, 'ghost.json'),
      JSON.stringify({
        schemaVersion: 2,
        id: 'cindy-github',
        name: 'Cindy GitHub',
        version: '1.0.0',
        entry: 'main.js',
        slots: ['tool'],
        tools: [{ name: 'github', description: 'GitHub' }],
      }),
    );

    await provisionBuiltinGhosts({ seedRootDirs: [seedRoot], repoRootDir: repoRoot });
    const trustPath = path.join(repoRoot, 'cindy-github', '.cindy-trust.json');
    expect(JSON.parse(await fs.promises.readFile(trustPath, 'utf8'))).toMatchObject({
      level: 'cindy-official',
      publisherName: 'Cindy Plugin Market',
    });

    await fs.promises.writeFile(path.join(repoRoot, 'cindy-github', '.disabled'), '');
    // level 看似正确但其余必填字段缺失：GhostManager 会把它判坏，播种器也必须自愈。
    await fs.promises.writeFile(trustPath, JSON.stringify({ level: 'cindy-official' }));
    const second = await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      onApplyStart: () => {
        expect(isGhostInstallLockHeld('cindy-github')).toBe(true);
      },
    });
    expect(second.skipped).toContain('cindy-github');
    expect(JSON.parse(await fs.promises.readFile(trustPath, 'utf8'))).toMatchObject({
      level: 'cindy-official',
      publisherSigned: true,
      publisherVerified: true,
      reviewed: true,
      publisherName: 'Cindy Plugin Market',
    });
    expect(fs.existsSync(path.join(repoRoot, 'cindy-github', '.disabled'))).toBe(true);
    expect(await fs.promises.readFile(path.join(repoRoot, 'cindy-github', 'main.js'), 'utf8'))
      .toBe('// github');
  });
});

// 测试价值
// - 生产入口与可观察结果：provisionBuiltinGhosts 对同 id 商店安装的处理——已装字节是否被种子覆盖、
//   写在哪个目录、seeded 台账是否摘除、孤儿回收是否删掉商店安装。
// - 规则依据：种子与商店按版本取新、相同取商店（2026-11）；新布局商店安装位于 `_ns/_root/<id>`。
// - 现有覆盖缺口：既有用例只覆盖旧布局 `<id>` 和不看版本的指纹覆盖。
// - 最小失败输入：`_ns/_root/<id>` 已装商店 1.0.0、种子 1.0.0（旧逻辑当作未装并覆盖）；
//   种子 2.0.0（旧逻辑在根目录另装一份、丢掉 `.disabled`）；种子消失的台账 id 有商店安装（旧逻辑删除）。
// - tier：unit（临时目录 + 注入的商店事实）。
describe('builtinGhostProvisioner 与同名商店安装按版本取新', () => {
  async function setVersion(dir: string, version: string): Promise<void> {
    const file = path.join(dir, 'ghost.json');
    const manifest = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Record<string, unknown>;
    await fs.promises.writeFile(file, JSON.stringify({ ...manifest, version }));
  }

  async function storeInstalledLayout(seedVersion: string) {
    const root = await makeTempDir();
    const seedRoot = path.join(root, 'seeds');
    const repoRoot = path.join(root, 'installed');
    await setVersion(await writeMinimalSeed(seedRoot, 'builtin-test'), seedVersion);
    const storeDir = await writeMinimalSeed(path.join(repoRoot, '_ns', '_root'), 'builtin-test');
    await fs.promises.writeFile(path.join(storeDir, 'main.js'), '// store bytes');
    await fs.promises.writeFile(path.join(storeDir, '.disabled'), '');
    return { seedRoot, repoRoot, storeDir };
  }

  const readSeeded = (repoRoot: string): string[] =>
    (JSON.parse(fs.readFileSync(path.join(repoRoot, PROVISIONING_STATE_FILE), 'utf8')) as {
      seeded: string[];
    }).seeded;

  it.each([
    ['1.0.0', '相同版本'],
    ['0.9.0', '种子更旧'],
    ['not-a-version', '版本号不可比'],
  ])('种子 %s（%s）让给 _ns/_root 下的商店安装，不覆盖也不另装', async (seedVersion) => {
    const { seedRoot, repoRoot, storeDir } = await storeInstalledLayout(seedVersion);
    const beforeReplace = vi.fn();
    const outcome = await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      beforeReplace,
      storeInstall: () => ({ version: '1.0.0', ownsInstalledBytes: true }),
    });

    expect(outcome.skipped).toContain('builtin-test');
    expect(outcome.approved).toEqual([]);
    expect(beforeReplace).not.toHaveBeenCalled();
    expect(await fs.promises.readFile(path.join(storeDir, 'main.js'), 'utf8')).toBe('// store bytes');
    expect(fs.existsSync(path.join(repoRoot, 'builtin-test'))).toBe(false);
  });

  it('种子版本更新时原位覆盖 _ns/_root 下的商店安装并保留停用状态', async () => {
    const { seedRoot, repoRoot, storeDir } = await storeInstalledLayout('2.0.0');
    const beforeReplace = vi.fn();
    const outcome = await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      beforeReplace,
      storeInstall: () => ({ version: '1.0.0', ownsInstalledBytes: true }),
    });

    expect(outcome.updated.map((m) => m.id)).toEqual(['builtin-test']);
    expect(outcome.installed).toEqual([]);
    expect(beforeReplace).toHaveBeenCalledWith('builtin-test');
    expect(await fs.promises.readFile(path.join(storeDir, 'main.js'), 'utf8')).toBe('// brain');
    expect(fs.existsSync(path.join(storeDir, '.disabled'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, 'builtin-test'))).toBe(false);
    expect(readSeeded(repoRoot)).toEqual(['builtin-test']);
  });

  it('商店追上后：已装是商店字节就摘台账，仍是种子字节则留台账等商店更新', async () => {
    const { seedRoot, repoRoot } = await storeInstalledLayout('2.0.0');
    await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      storeInstall: () => ({ version: '1.0.0', ownsInstalledBytes: true }),
    });

    await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      storeInstall: () => ({ version: '2.0.0', ownsInstalledBytes: false }),
    });
    expect(readSeeded(repoRoot)).toEqual(['builtin-test']);

    await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      storeInstall: () => ({ version: '2.0.0', ownsInstalledBytes: true }),
    });
    expect(readSeeded(repoRoot)).toEqual([]);
  });

  it('种子消失时不把有商店安装的台账 id 当孤儿删除', async () => {
    const { seedRoot, repoRoot, storeDir } = await storeInstalledLayout('2.0.0');
    await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      storeInstall: () => ({ version: '1.0.0', ownsInstalledBytes: true }),
    });
    await fs.promises.rm(path.join(seedRoot, 'builtin-test'), { recursive: true });
    await writeMinimalSeed(seedRoot, 'other-seed');
    const beforeRemove = vi.fn();

    const outcome = await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      beforeRemove,
      storeInstall: (id) => (id === 'builtin-test' ? { version: '2.0.0', ownsInstalledBytes: true } : null),
    });

    expect(outcome.removed).toEqual([]);
    expect(beforeRemove).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(storeDir, 'ghost.json'))).toBe(true);
    expect(readSeeded(repoRoot)).toEqual(['other-seed']);
  });
  // 补充依据：Codex review（#9078）——商店账本记录损坏时，lookup 抛错，孤儿回收不能把商店安装当种子删掉。
  it('商店账本读不了时本轮不删除种子已撤的台账 id，并保持可重试', async () => {
    const { seedRoot, repoRoot, storeDir } = await storeInstalledLayout('2.0.0');
    await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      storeInstall: () => ({ version: '1.0.0', ownsInstalledBytes: true }),
    });
    await fs.promises.rm(path.join(seedRoot, 'builtin-test'), { recursive: true });
    await writeMinimalSeed(seedRoot, 'other-seed');
    const beforeRemove = vi.fn();

    const outcome = await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      beforeRemove,
      storeInstall: (id) => {
        if (id === 'builtin-test') throw new Error('Plugin market ledger is unreadable');
        return null;
      },
    });

    expect(outcome.removed).toEqual([]);
    expect(outcome.retryPending).toBe(true);
    expect(beforeRemove).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(storeDir, 'ghost.json'))).toBe(true);
    expect(readSeeded(repoRoot)).toContain('builtin-test');
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ghostInstallApprovalToken, validateGhostManifest } from '../../../shared/ghost.js';
import { GhostManager } from '../GhostManager.js';
import { createGhostInstallReceipt, GhostInstallReceiptStore } from '../ghostInstallReceipt.js';
import { writeTestCindyPackage } from './cindyPackageFixture.js';

const roots: string[] = [];
const PACKAGE_SHA256 = 'a'.repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(official = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-legacy-first-party-')));
  roots.push(root);
  const contentRoot = path.join(root, 'content');
  const stateRoot = path.join(root, 'state');
  const raw = {
    schemaVersion: 2, id: 'filo-helper', name: 'Helper', version: '1.0.0',
    kind: 'chip', entry: 'main.js', slots: [],
  };
  const parsed = validateGhostManifest(raw);
  if (!parsed.ok) throw new Error(parsed.reason);
  const store = new GhostInstallReceiptStore(() => stateRoot);
  const plant = async (id: string, packageSha256: string | undefined = PACKAGE_SHA256) => {
    const manifest = { ...parsed.manifest, id };
    fs.mkdirSync(path.join(contentRoot, id), { recursive: true });
    fs.writeFileSync(path.join(contentRoot, id, 'ghost.json'), JSON.stringify({ ...raw, id }));
    fs.writeFileSync(path.join(contentRoot, id, 'main.js'), 'module.exports = {};');
    const receipt = createGhostInstallReceipt({
      manifest, localeResources: {}, enabled: true, skillContentSha256: {}, packageSha256,
      trust: {
        level: official ? 'cindy-official' : 'unverified',
        publisherSigned: false, publisherVerified: false, reviewed: false,
      },
    });
    await store.write(receipt);
    return receipt;
  };
  const receipt = await plant('filo-helper');
  const packageFile = () => writeTestCindyPackage(
    path.join(root, 'update.cindy'), { ...raw, version: '2.0.0' },
    { 'main.js': 'module.exports = { version: 2 };' },
  );
  return { root, contentRoot, stateRoot, store, receipt, plant, packageFile };
}

describe('Host legacy first-party receipt capture', () => {
  it('reads the approved receipt only for the pinned instance revision', async () => {
    const setup = await fixture();
    const manager = new GhostManager({ getRootDir: () => setup.contentRoot, getStateDir: () => setup.stateRoot });
    expect(manager.readApprovedInstallReceipt('filo-helper', setup.receipt.revision)).toEqual(setup.receipt);
    expect(manager.readApprovedInstallReceipt('filo-helper', 'stale-revision')).toBeNull();
    expect(manager.readApprovedInstallReceipt('filo-missing')).toBeNull();
    expect(manager.readApprovedInstallReceipt('../filo-helper')).toBeNull();
  });

  it('does not expose legacy evidence from a damaged receipt or pending transaction', async () => {
    const setup = await fixture();
    const manager = new GhostManager({ getRootDir: () => setup.contentRoot, getStateDir: () => setup.stateRoot });
    expect(manager.readApprovedInstallReceipt('filo-helper')).not.toBeNull();
    await setup.store.writePendingMutation('filo-helper', {
      kind: 'update', packageSha256: PACKAGE_SHA256,
      backupDirName: '.cindy-updating-filo-helper-12345678',
    });
    expect(manager.readApprovedInstallReceipt('filo-helper')).toBeNull();
    fs.rmSync(path.join(setup.stateRoot, '.pending-filo-helper.json'));
    fs.writeFileSync(path.join(setup.stateRoot, 'filo-helper.json'), '{ damaged');
    expect(manager.readApprovedInstallReceipt('filo-helper')).toBeNull();
  });

  it('captures once, survives pending removal and restart, and never qualifies a later missing-namespace receipt', async () => {
    const setup = await fixture();
    const capture = vi.fn(() => true);
    const options = {
      getRootDir: () => setup.contentRoot, getStateDir: () => setup.stateRoot,
      captureLegacyFirstPartyEligibility: capture,
    };
    const manager = new GhostManager(options);
    manager.ensureNamespaceMigrationCensus();
    expect(capture).toHaveBeenCalledExactlyOnceWith('filo-helper', PACKAGE_SHA256);
    expect(manager.readLegacyFirstPartyEligible('filo-helper')).toBe(true);
    expect(setup.store.readForRecovery('filo-helper')).toMatchObject({
      state: 'approved', receipt: { legacyFirstPartyEligible: true, revision: setup.receipt.revision },
    });
    await expect(manager.commitPendingRootNamespace('filo-helper', 'market-public')).resolves.toEqual({ ok: true });
    expect(manager.readLegacyFirstPartyEligible('filo-helper')).toBe(true);
    await setup.plant('filo-later');
    const restarted = new GhostManager(options);
    restarted.ensureNamespaceMigrationCensus();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(restarted.readLegacyFirstPartyEligible('filo-helper')).toBe(true);
    expect(restarted.readLegacyFirstPartyEligible('filo-later')).toBe(false);
    expect(restarted.isPendingLegacyNamespace('filo-later')).toBe(false);
  });

  it('captures retired officially approved plugins without a seed roster or market ledger', async () => {
    const setup = await fixture(true);
    const manager = new GhostManager({ getRootDir: () => setup.contentRoot, getStateDir: () => setup.stateRoot });
    manager.ensureNamespaceMigrationCensus();
    expect(manager.readLegacyFirstPartyEligible('filo-helper')).toBe(true);
    expect(manager.list().find((ghost) => ghost.manifest.id === 'filo-helper')?.builtin === true).toBe(false);
  });

  it('does not retroactively qualify old receipts after an offline first census', async () => {
    const setup = await fixture();
    new GhostManager({ getRootDir: () => setup.contentRoot, getStateDir: () => setup.stateRoot })
      .ensureNamespaceMigrationCensus();
    const capture = vi.fn(() => true);
    const later = new GhostManager({
      getRootDir: () => setup.contentRoot, getStateDir: () => setup.stateRoot,
      captureLegacyFirstPartyEligibility: capture,
    });
    later.ensureNamespaceMigrationCensus();
    expect(capture).not.toHaveBeenCalled();
    expect(later.readLegacyFirstPartyEligible('filo-helper')).toBe(false);
  });

  it.each([false, true])('preserves same-source qualification and clears archive replacement=%s', async (sourceChanged) => {
    const setup = await fixture();
    const manager = new GhostManager({
      getRootDir: () => setup.contentRoot, getStateDir: () => setup.stateRoot,
      captureLegacyFirstPartyEligibility: () => true,
      onArchiveSourceState: async () => {},
    });
    manager.ensureNamespaceMigrationCensus();
    await manager.commitPendingRootNamespace('filo-helper', 'market-public');
    const installed = manager.list().find((ghost) => ghost.manifest.id === 'filo-helper');
    if (!installed) throw new Error('installed fixture unavailable');
    const result = await manager.update(await setup.packageFile(), {
      expectedInstalledApproval: ghostInstallApprovalToken(installed.approval),
      namespace: null,
      ...(sourceChanged ? { sourceStateArchiveId: '_ns__cindy-archive-00000000-0000-4000-8000-000000000002__filo-helper' } : {}),
    });
    expect(result).not.toHaveProperty('rejection');
    expect(manager.readLegacyFirstPartyEligible('filo-helper')).toBe(!sourceChanged);
  });

  it('does not capture damaged or hashless approval and does not read damaged flags', async () => {
    const setup = await fixture(true);
    const receiptPath = path.join(setup.stateRoot, 'filo-helper.json');
    fs.writeFileSync(receiptPath, JSON.stringify({ ...setup.receipt, packageSha256: undefined }));
    const manager = new GhostManager({ getRootDir: () => setup.contentRoot, getStateDir: () => setup.stateRoot });
    manager.ensureNamespaceMigrationCensus();
    expect(manager.readLegacyFirstPartyEligible('filo-helper')).toBe(false);
    fs.writeFileSync(receiptPath, JSON.stringify({ ...setup.receipt, legacyFirstPartyEligible: 'true' }));
    expect(manager.readLegacyFirstPartyEligible('filo-helper')).toBe(false);
  });
});

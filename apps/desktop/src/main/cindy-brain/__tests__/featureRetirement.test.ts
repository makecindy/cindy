import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GhostManager } from '../GhostManager';
import { GhostInstallReceiptStore, createGhostInstallReceipt } from '../ghostInstallReceipt';
import { FeatureRetirementStore } from '../featureRetirementStore';
import { findFeatureRetirement } from '../../../shared/featureRetirements';
import {
  validateGhostManifest,
  ghostPermissionItems,
  ghostManifestToAuthorFormat,
} from '../../../shared/ghost';
let dir: string;
let root: string;
let state: string;
const manifestFor = (id = 'ios-simulator', legacy = false) => ({
  schemaVersion: 3,
  id,
  name: 'Simulator',
  version: '1.0.0',
  minCindyVersion: '0.1.0',
  entry: 'main.js',
  ...(legacy ? { iosSimulator: true } : {}),
});
const manager = () => new GhostManager({ getRootDir: () => root, getStateDir: () => state });
async function seed(enabled = true, raw = manifestFor()) {
  const validated = validateGhostManifest(raw);
  if (!validated.ok) throw new Error(validated.reason);
  const install = path.join(root, raw.id);
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(install, 'ghost.json'), JSON.stringify(raw));
  const receipt = createGhostInstallReceipt({
    manifest: validated.manifest,
    localeResources: {},
    enabled,
    skillContentSha256: {},
    trust: {
      level: 'unverified',
      publisherSigned: false,
      publisherVerified: false,
      reviewed: false,
    },
  });
  await new GhostInstallReceiptStore(() => state).write(receipt);
  return { install, receipt };
}
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-retirement-')));
  root = path.join(dir, 'installed');
  state = path.join(dir, 'state');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
describe('feature retirement upgrade', () => {
  it('does not manufacture an entry or reminder for a new user', () => {
    expect(manager().list()).toEqual([]);
    expect(fs.existsSync(path.join(state, 'feature-retirements'))).toBe(false);
  });
  it('captures enabled install, disables execution and remembers acknowledgement across restart', async () => {
    const { receipt } = await seed();
    const m = manager();
    expect(m.list()[0]).toMatchObject({
      enabled: false,
      retirement: { eligible: true, unread: true },
    });
    expect(m.list()[0].approvedSkillRoot).toBeUndefined();
    m.acknowledgeRetirement(receipt.id);
    expect(manager().list()[0].retirement).toMatchObject({ eligible: true, unread: false });
    const saved = new GhostInstallReceiptStore(() => state).read(receipt.id);
    expect(saved.state === 'approved' && saved.receipt.enabled).toBe(true);
    expect(await m.setEnabled(receipt.id, true)).toMatchObject({
      rejection: { code: 'feature-retired' },
    });
  });
  it('does not recommend migration for a disabled plugin', async () => {
    await seed(false);
    expect(manager().list()[0]).toMatchObject({
      enabled: false,
      retirement: { eligible: false, unread: false },
    });
  });
  it('recognizes an enabled legacy installation when skipping the receipt-format release', async () => {
    const raw = manifestFor();
    const install = path.join(root, raw.id);
    fs.mkdirSync(install, { recursive: true });
    fs.writeFileSync(path.join(install, 'ghost.json'), JSON.stringify(raw));
    fs.writeFileSync(path.join(install, 'main.js'), '');
    const m = manager();
    await m.migrateLegacyApprovalsOnce();
    expect(m.list()[0]).toMatchObject({
      enabled: false,
      retirement: { eligible: true, unread: true },
    });
  });
  it('honors the legacy disabled marker', async () => {
    const { install } = await seed();
    fs.writeFileSync(path.join(install, '.disabled'), '');
    expect(manager().list()[0].retirement?.eligible).toBe(false);
  });
  it('ignores stale receipts after uninstall', async () => {
    const { install } = await seed();
    fs.rmSync(install, { recursive: true });
    expect(manager().list()).toEqual([]);
  });
  it('detects legacy consumers without confusing independent Baguette', async () => {
    await seed(true, manifestFor('custom-simulator', true));
    expect(manager().list()[0].retirement?.eligible).toBe(true);
    expect(findFeatureRetirement(manifestFor('baguette-simulator'))).toBeUndefined();
    expect(findFeatureRetirement({ id: 'legacy', slots: ['ios-simulator'] })?.id).toBe(
      'embedded-ios-simulator',
    );
  });
  it('round trips legacy receipt fields without granting permissions', () => {
    const v = validateGhostManifest(manifestFor('custom-simulator', true));
    if (!v.ok) throw new Error(v.reason);
    expect(ghostManifestToAuthorFormat(v.manifest)).toMatchObject({ iosSimulator: true });
    expect(ghostPermissionItems(v.manifest).some((p) => p.key === 'ios-simulator')).toBe(false);
  });
  it('retries failed persistence from the intact install receipt', async () => {
    await seed();
    fs.writeFileSync(path.join(state, 'feature-retirements'), 'temporarily unavailable');
    expect(manager().list()[0]).toMatchObject({
      enabled: false,
      retirement: { eligible: true, unread: false },
    });
    fs.unlinkSync(path.join(state, 'feature-retirements'));
    expect(manager().list()[0].retirement?.unread).toBe(true);
  });
  it('does not overwrite a corrupt record', () => {
    const store = new FeatureRetirementStore(() => state);
    store.observe('embedded-ios-simulator', 'ios-simulator', true);
    const file = path.join(state, 'feature-retirements/embedded-ios-simulator/ios-simulator.json');
    fs.writeFileSync(file, '{broken');
    expect(() => store.acknowledge('embedded-ios-simulator', 'ios-simulator')).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
  });
  it('isolates read status between accounts', async () => {
    await seed();
    const m = manager();
    m.list();
    m.acknowledgeRetirement('ios-simulator');
    root = path.join(dir, 'owner-b-installed');
    state = path.join(dir, 'owner-b-state');
    await seed();
    expect(m.list()[0].retirement?.unread).toBe(true);
  });
  it('rejects reinstall before runtime spawn', async () => {
    const zip = new JSZip();
    zip.file('ghost.json', JSON.stringify(manifestFor()));
    const file = path.join(dir, 'old.cindy');
    fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
    expect(await manager().install(file)).toMatchObject({
      rejection: { code: 'host-unsupported' },
    });
    expect(manager().list()).toEqual([]);
  });
});

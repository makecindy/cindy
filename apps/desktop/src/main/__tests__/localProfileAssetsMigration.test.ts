import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adoptLocalProfileAssets } from '../localProfileAssetsMigration.js';
import {
  reserveCommittedLocalProfileDataOwner,
  reserveLocalProfileDataOwner,
  recoverPendingLocalProfileDataOwner,
} from '../localProfileDataMigration.js';
import { dataOwnerStorageKey, ownerScopedPath } from '../dataOwnerPath.js';
import { GhostManager } from '../cindy-brain/GhostManager.js';
import {
  GhostInstallReceiptStore,
  createGhostInstallReceipt,
  hashApprovedSkillContent,
} from '../cindy-brain/ghostInstallReceipt.js';
import { runGhostSnapshotWorkerRequest } from '../cindy-brain/ghostSnapshotWorkerProcess.js';
import { pluginInstallStoragePart } from '../../shared/pluginIdentity.js';
import { validateGhostManifest } from '../../shared/ghost.js';
import { recordModelVisibilityAdoption } from '../localDb/modelVisibilityAdoption.js';

// Unit tier. #10334's existing database/native-auth tests never read migrated
// custom keys or installation receipts. Real temporary files, the durable owner
// claim and GhostManager's approval projection cover that missing result.
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(claim = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-local-assets-')));
  roots.push(root);
  const local = ownerScopedPath(root, 'local-v1');
  const cloud = ownerScopedPath(root, 'cloud-a');
  fs.mkdirSync(local, { recursive: true });
  if (claim)
    expect(reserveCommittedLocalProfileDataOwner('cloud-a', root, 'cindy')).toBe('claimed');
  const secret = (owner: string, key: string) =>
    path.join(root, 'safe-storage', `owner_${dataOwnerStorageKey(owner)}_${key}.enc`);
  const write = (file: string, value: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  const deps = { userDataDir: root, dbFilePrefix: 'cindy', hasExclusiveSourceAccess: () => true };
  return { root, local, cloud, secret, write, deps };
}

async function install(local: string, enabled = true, namespaced = false) {
  const raw = {
    schemaVersion: 2,
    id: 'opendesign-trial',
    name: 'OpenDesign',
    version: '0.4.27',
    ...(namespaced ? { namespace: null } : {}),
    kind: 'chip',
    entry: 'main.js',
    settingsHtml: 'settings.html',
    slots: ['network', 'skill', 'node'],
    skill: { items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }] },
    node: {
      entry: 'worker.cjs',
      protocol: 'json-rpc-stdio',
      secretBindings: [
        { key: 'manual_token', label: 'Manual token', methods: ['account/import'] },
        {
          key: 'oauth_token',
          label: 'OAuth token',
          methods: ['account/read'],
          oauthSecret: 'account',
        },
      ],
    },
    network: {
      hosts: ['api.example.com'],
      secrets: [
        {
          key: 'api_key',
          label: 'API key',
          inject: { header: 'Authorization', format: 'Bearer {value}' },
        },
        {
          key: 'account',
          label: 'Account',
          source: 'oauth',
          inject: { header: 'Authorization', format: 'Bearer {value}' },
          oauth: {
            authorizeUrl: 'https://api.example.com/auth',
            tokenUrl: 'https://api.example.com/token',
            scopes: ['account'],
          },
        },
      ],
    },
  };
  const parsed = validateGhostManifest(raw);
  if (!parsed.ok) throw new Error(parsed.reason);
  const relId = namespaced ? `_ns/_root/${raw.id}` : raw.id;
  const dir = path.join(local, 'cindy-brain', ...relId.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ghost.json'), JSON.stringify(raw));
  fs.writeFileSync(path.join(dir, 'main.js'), 'module.exports = {};');
  fs.writeFileSync(path.join(dir, 'worker.cjs'), 'module.exports = {};');
  fs.chmodSync(path.join(dir, 'main.js'), 0o444);
  fs.writeFileSync(path.join(dir, 'settings.html'), '<p>fixture</p>');
  fs.mkdirSync(path.join(dir, 'skills/demo'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'skills/demo/SKILL.md'),
    '---\nname: demo\ndescription: Demo skill\n---\nOriginal approved instructions.\n',
  );
  const receipt = createGhostInstallReceipt({
    ...(namespaced ? { namespace: null } : {}),
    manifest: parsed.manifest,
    enabled,
    localeResources: {},
    skillContentSha256: await hashApprovedSkillContent(parsed.manifest, dir),
    trust: {
      level: 'unverified',
      publisherSigned: false,
      publisherVerified: false,
      reviewed: false,
    },
  });
  const store = new GhostInstallReceiptStore(
    () => path.join(local, 'ghost-install-state'),
    async ({ parentDir, ...request }) => {
      await runGhostSnapshotWorkerRequest(request, parentDir);
    },
  );
  await store.write(receipt, { relId, skillSourceDir: dir });
  return { receipt, store, relId, instanceKey: pluginInstallStoragePart(relId) };
}

describe('first verified cloud owner adopts local assets', () => {
  it.each([true, false])(
    'preserves ciphertext, installation approval and enabled=%s through restart',
    async (enabled) => {
      const f = fixture();
      const { receipt, instanceKey, relId } = await install(f.local, enabled, enabled);
      const keys = [
        'provider_key_opendesign_codex',
        'provider_headers_opendesign_codex',
        `ghost_secret_${instanceKey}_api_key`,
        `ghost_hint_${instanceKey}_api_key`,
        `ghost_secret_${instanceKey}_manual_token`,
        `ghost_hint_${instanceKey}_manual_token`,
      ];
      const excluded = [
        'provider_oauth_opendesign',
        'provider_key_xai',
        'ghost_secret_opendesign-trial_api_key-rt-test-account',
        'ghost_secret_uninstalled_api_key',
        `ghost_secret_${instanceKey}_oauth_token`,
        `ghost_hint_${instanceKey}_oauth_token`,
        `ghost_secret_${instanceKey}_account`,
      ];
      for (const key of [...keys, ...excluded])
        f.write(f.secret('local-v1', key), `test-ciphertext:${key}`);
      f.write(
        path.join(f.local, 'plugin-market/ledger.v1.json'),
        '{"fixture":"original-market-facts"}',
      );
      f.write(path.join(f.local, 'ghost-kv/opendesign-trial.json'), '{"preference":true}');
      f.write(
        path.join(f.local, 'ghost-install-state/.oauth-locks/opendesign-trial.lock'),
        'old-lock',
      );
      expect(await adoptLocalProfileAssets('cloud-a', f.deps)).toBe('adopted');
      for (const key of keys) {
        expect(fs.readFileSync(f.secret('cloud-a', key), 'utf8')).toBe(`test-ciphertext:${key}`);
        expect(fs.existsSync(f.secret('local-v1', key))).toBe(true);
      }
      for (const key of excluded) expect(fs.existsSync(f.secret('cloud-a', key))).toBe(false);
      const manager = new GhostManager({
        getRootDir: () => path.join(f.cloud, 'cindy-brain'),
        getStateDir: () => path.join(f.cloud, 'ghost-install-state'),
      });
      const listed = (await manager.listAsync())[0]!;
      expect(listed).toMatchObject({ enabled });
      expect(manager.readApprovedInstallReceipt(instanceKey, receipt.revision)).toEqual(receipt);
      expect(
        fs.statSync(path.join(f.cloud, 'cindy-brain', ...relId.split('/'), 'main.js')).mode & 0o200,
      ).toBe(0);
      if (enabled)
        expect(
          fs.readFileSync(path.join(listed.approvedSkillRoot!, 'skills/demo/SKILL.md'), 'utf8'),
        ).toContain('Original approved instructions.');
      expect(fs.readFileSync(path.join(f.cloud, 'plugin-market/ledger.v1.json'), 'utf8')).toBe(
        '{"fixture":"original-market-facts"}',
      );
      expect(fs.existsSync(path.join(f.cloud, 'ghost-install-state/.oauth-locks'))).toBe(false);
      fs.unlinkSync(f.secret('cloud-a', keys[0]!));
      expect(await adoptLocalProfileAssets('cloud-a', f.deps)).toBe('complete');
      expect(fs.existsSync(f.secret('cloud-a', keys[0]!))).toBe(false);
      for (const key of keys.slice(1))
        expect(fs.readFileSync(f.secret('cloud-a', key), 'utf8')).toBe(`test-ciphertext:${key}`);
      for (const key of excluded) expect(fs.existsSync(f.secret('cloud-a', key))).toBe(false);
      expect(
        fs
          .readdirSync(f.cloud, { withFileTypes: true })
          .filter(
            (entry) => entry.isDirectory() && entry.name.startsWith('.local-profile-assets-'),
          ),
      ).toEqual([]);
    },
  );

  it('requires a finalized first-owner claim and never transfers to a second account', async () => {
    const f = fixture(false);
    const key = 'provider_key_opendesign_codex';
    f.write(f.secret('local-v1', key), 'test-ciphertext');
    expect(reserveLocalProfileDataOwner('cloud-a', f.root, 'cindy')).toBe('claimed');
    expect(await adoptLocalProfileAssets('cloud-a', f.deps)).toBe('not-owner');
    expect(fs.existsSync(f.secret('cloud-a', key))).toBe(false);
    recoverPendingLocalProfileDataOwner('cloud-a', f.root, 'cindy');
    expect(await adoptLocalProfileAssets('cloud-a', f.deps)).toBe('adopted');
    expect(await adoptLocalProfileAssets('cloud-b', f.deps)).toBe('not-owner');
    expect(fs.existsSync(f.secret('cloud-b', key))).toBe(false);
  });

  it('keeps existing cloud values and treats a cloud installation as one authoritative unit', async () => {
    const f = fixture();
    await install(f.local);
    const key = 'provider_key_opendesign_codex';
    f.write(f.secret('local-v1', key), 'local-test-ciphertext');
    f.write(f.secret('cloud-a', key), 'cloud-test-ciphertext');
    f.write(
      f.secret('local-v1', 'ghost_secret_opendesign-trial_api_key'),
      'local-plugin-ciphertext',
    );
    f.write(path.join(f.cloud, 'ghost-cindy-prefs.json'), '{"cloud":true}');
    expect(await adoptLocalProfileAssets('cloud-a', f.deps)).toBe('adopted');
    expect(fs.readFileSync(f.secret('cloud-a', key), 'utf8')).toBe('cloud-test-ciphertext');
    expect(fs.readFileSync(path.join(f.cloud, 'ghost-cindy-prefs.json'), 'utf8')).toBe(
      '{"cloud":true}',
    );
    expect(fs.existsSync(path.join(f.cloud, 'cindy-brain'))).toBe(false);
    expect(fs.existsSync(f.secret('cloud-a', 'ghost_secret_opendesign-trial_api_key'))).toBe(false);
  });

  it('recovers an interrupted publication only from its frozen snapshot', async () => {
    const f = fixture();
    await install(f.local);
    const key = 'provider_key_opendesign_codex';
    f.write(f.secret('local-v1', key), 'original-test-ciphertext');
    const link = fs.promises.link;
    const fault = vi
      .spyOn(fs.promises, 'link')
      .mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    await expect(adoptLocalProfileAssets('cloud-a', f.deps)).rejects.toThrow('disk full');
    fault.mockImplementation(link);
    f.write(f.secret('local-v1', key), 'changed-later-ciphertext');
    f.write(f.secret('local-v1', 'provider_key_later_codex'), 'later-ciphertext');
    expect(await adoptLocalProfileAssets('cloud-a', f.deps)).toBe('adopted');
    expect(fs.readFileSync(f.secret('cloud-a', key), 'utf8')).toBe('original-test-ciphertext');
    expect(fs.existsSync(f.secret('cloud-a', 'provider_key_later_codex'))).toBe(false);
    expect(fs.existsSync(path.join(f.local, 'cindy-brain/opendesign-trial/ghost.json'))).toBe(true);
  });

  it.each([false, true])(
    'only fills credentials for a previously adopted cloud DB (adopted: %s)',
    async (adopted) => {
      const f = fixture();
      const db = path.join(f.root, 'cindy-cloud-a.db');
      f.write(db, 'test-db-identity');
      if (adopted) recordModelVisibilityAdoption(db);
      const key = 'provider_key_opendesign_codex';
      f.write(f.secret('local-v1', key), 'test-ciphertext');
      await adoptLocalProfileAssets('cloud-a', f.deps);
      expect(fs.existsSync(f.secret('cloud-a', key))).toBe(adopted);
    },
  );

  it('retains the original install and releases the publication barrier when exclusivity is lost', async () => {
    const f = fixture();
    await install(f.local);
    const release = vi.fn(async () => {});
    await expect(
      adoptLocalProfileAssets('cloud-a', {
        ...f.deps,
        hasExclusiveSourceAccess: () => false,
        acquireSourcePublicationBarrier: async () => ({ isHeld: () => true, release }),
      }),
    ).rejects.toThrow('exclusive source access');
    expect(release).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(f.local, 'cindy-brain/opendesign-trial/ghost.json'))).toBe(true);
    expect(fs.readdirSync(f.cloud)).toEqual([]);
  });

  it('refuses unfinished plugin mutations and cleans its unpublished snapshot', async () => {
    const f = fixture();
    const { store } = await install(f.local);
    await store.writePendingMutation('opendesign-trial', {
      kind: 'update',
      packageSha256: 'a'.repeat(64),
      backupDirName: '.cindy-updating-opendesign-trial-12345678',
    });
    await expect(adoptLocalProfileAssets('cloud-a', f.deps)).rejects.toThrow(
      'recovery must finish',
    );
    expect(fs.readdirSync(f.cloud)).toEqual([]);
    expect(store.readPendingMutationSync('opendesign-trial').state).not.toBe('missing');
  });

  it('rejects linked source content without following or publishing it', async () => {
    const f = fixture();
    const outside = path.join(f.root, 'outside');
    fs.mkdirSync(outside);
    f.write(path.join(outside, 'ghost.json'), 'private-test-file');
    fs.symlinkSync(
      outside,
      path.join(f.local, 'cindy-brain'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(adoptLocalProfileAssets('cloud-a', f.deps)).rejects.toThrow('not regular');
    expect(fs.readFileSync(path.join(outside, 'ghost.json'), 'utf8')).toBe('private-test-file');
    expect(fs.readdirSync(f.cloud)).toEqual([]);
  });
});

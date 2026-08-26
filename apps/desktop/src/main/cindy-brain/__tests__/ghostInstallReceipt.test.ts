import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateGhostManifest } from '../../../shared/ghost';

import {
  createGhostInstallReceipt,
  effectiveInstallOrigin,
  type GhostInstallReceipt,
  GhostInstallReceiptStore,
} from '../ghostInstallReceipt';

describe('GhostInstallReceiptStore cleanup', () => {
  let workDir: string;
  let stateRoot: string;
  let store: GhostInstallReceiptStore;

  beforeEach(async () => {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-receipt-cleanup-'));
    const rawStateRoot = path.join(workDir, 'state');
    await fs.promises.mkdir(rawStateRoot);
    stateRoot = await fs.promises.realpath(rawStateRoot);
    store = new GhostInstallReceiptStore(() => stateRoot, async ({ parentDir, targetName, operation }) => {
      if (operation === 'remove') await fs.promises.rm(path.join(parentDir, targetName), { recursive: true, force: true });
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(workDir, { recursive: true, force: true });
  });

  function createSetupReceipt(): GhostInstallReceipt {
    const parsed = validateGhostManifest({
      schemaVersion: 2,
      id: 'hello',
      name: 'Hello',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      settingsHtml: 'settings.html',
      slots: ['tool', 'network'],
      tools: [{ name: 'do_thing', description: 'Do something' }],
      network: {
        hosts: ['api.example.com'],
        secrets: [
          {
            key: 'api_key',
            label: 'API Key',
            inject: { header: 'Authorization', format: 'Bearer {value}' },
          },
        ],
        connections: [
          {
            key: 'account',
            label: 'Account',
            inject: { header: 'X-Account', format: '{value}' },
          },
        ],
      },
      setup: {
        requires: [
          { anyOf: ['secret:api_key'] },
          { anyOf: ['connection:account', { kv: 'repoDir', label: '本机 cindy 项目目录' }] },
        ],
      },
    });
    if (!parsed.ok) throw new Error(parsed.reason);

    return createGhostInstallReceipt({
      manifest: parsed.manifest,
      localeResources: {},
      enabled: true,
      trust: {
        level: 'unverified',
        publisherSigned: false,
        publisherVerified: false,
        reviewed: false,
      },
      skillContentSha256: {},
    });
  }

  it('removes a regular receipt and managed snapshot tree', async () => {
    const receipt = path.join(stateRoot, 'hello.json');
    const snapshot = path.join(stateRoot, 'skill-snapshots', 'hello', 'revision');
    await fs.promises.mkdir(snapshot, { recursive: true });
    await fs.promises.writeFile(receipt, '{}');
    await fs.promises.writeFile(path.join(snapshot, 'SKILL.md'), 'approved');

    await store.remove('hello');

    expect(fs.existsSync(receipt)).toBe(false);
    expect(fs.existsSync(path.join(stateRoot, 'skill-snapshots', 'hello'))).toBe(false);
  });

  it('propagates transient snapshot-root IO failures so cleanup can be retried', async () => {
    const snapshotsRoot = path.join(stateRoot, 'skill-snapshots');
    const realLstat = fs.promises.lstat;
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (target, options) => {
      if (path.resolve(String(target)) === path.resolve(snapshotsRoot)) {
        throw Object.assign(new Error('state root unreadable'), { code: 'EACCES' });
      }
      return realLstat(target, options as never);
    });

    await expect(store.remove('hello')).rejects.toThrow('state root unreadable');
  });

  it('propagates transient snapshot-root IO failures from synchronous recovery', () => {
    const snapshotsRoot = path.join(stateRoot, 'skill-snapshots');
    const realLstatSync = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((target, options) => {
      if (path.resolve(String(target)) === path.resolve(snapshotsRoot)) {
        throw Object.assign(new Error('state root unreadable'), { code: 'EIO' });
      }
      return realLstatSync(target, options as never);
    });

    expect(() => store.removeSync('hello')).toThrow('state root unreadable');
  });

  it('treats an unreadable migration marker as present', () => {
    const marker = path.join(stateRoot, '.migrated-hello');
    const realLstatSync = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((target, options) => {
      if (path.resolve(String(target)) === path.resolve(marker)) {
        throw Object.assign(new Error('migration marker unreadable'), { code: 'EACCES' });
      }
      return realLstatSync(target, options as never);
    });

    expect(store.hasMigrationMarker('hello')).toBe(true);
  });

  it('does not publish a receipt when migration marker state is unavailable', async () => {
    const marker = path.join(stateRoot, '.migrated-hello');
    const realLstatSync = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((target, options) => {
      if (path.resolve(String(target)) === path.resolve(marker)) {
        throw Object.assign(new Error('migration marker unavailable'), { code: 'EIO' });
      }
      return realLstatSync(target, options as never);
    });

    const receipt = createGhostInstallReceipt({
      manifest: {
        schemaVersion: 2,
        id: 'hello',
        name: 'Hello',
        version: '1.0.0',
        kind: 'chip',
        entry: 'main.js',
        slots: ['tool'],
        tools: [{ name: 'do_thing', description: 'Do something' }],
      },
      localeResources: {},
      enabled: true,
      trust: {
        level: 'unverified',
        publisherSigned: false,
        publisherVerified: false,
        reviewed: false,
      },
      skillContentSha256: {},
    });

    await expect(store.write(receipt)).rejects.toThrow('migration marker unavailable');
    expect(fs.existsSync(path.join(stateRoot, 'hello.json'))).toBe(false);
  });

  it('writes setup in the author format accepted by the v0.1.48 receipt reader', async () => {
    const receipt = createSetupReceipt();
    await store.write(receipt);

    const persisted = JSON.parse(
      await fs.promises.readFile(path.join(stateRoot, 'hello.json'), 'utf8'),
    ) as { manifest: unknown };
    expect(persisted.manifest).toMatchObject({
      setup: {
        requires: [
          { anyOf: ['secret:api_key'] },
          {
            anyOf: [
              'connection:account',
              { kv: 'repoDir', label: '本机 cindy 项目目录' },
            ],
          },
        ],
      },
    });
    // v0.1.48 reads receipt manifests through this author-format validator.
    expect(validateGhostManifest(persisted.manifest).ok).toBe(true);

    expect(store.read('hello')).toMatchObject({
      state: 'approved',
      receipt: {
        manifest: {
          setup: {
            requires: [
              { anyOf: [{ kind: 'secret', key: 'api_key' }] },
              {
                anyOf: [
                  { kind: 'connection', key: 'account' },
                  { kind: 'kv', key: 'repoDir', label: '本机 cindy 项目目录' },
                ],
              },
            ],
          },
        },
      },
    });
  });

  it('still reads normalized setup receipts emitted by affected builds', async () => {
    const receipt = createSetupReceipt();
    await fs.promises.writeFile(
      path.join(stateRoot, 'hello.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
      'utf8',
    );

    expect(store.read('hello')).toMatchObject({
      state: 'approved',
      receipt: { manifest: receipt.manifest },
    });
  });

  it('recognizes only the Host-owned Forge origin as an effective authorization fact', async () => {
    await store.write(
      createGhostInstallReceipt({
        ...createSetupReceipt(),
        installOrigin: 'agent-forge',
      }),
    );

    const read = store.read('hello');
    expect(read.state).toBe('approved');
    if (read.state !== 'approved') return;
    expect(effectiveInstallOrigin(read.receipt)).toBe('agent-forge');
    expect(effectiveInstallOrigin({ installOrigin: 'future-origin' })).toBe('manual');
  });

  it('reads receipts through a state-root path with a linked ancestor', async () => {
    const realRoot = path.join(workDir, 'real-state');
    const linkedRoot = path.join(workDir, 'linked-state');
    await fs.promises.mkdir(realRoot);
    try {
      await fs.promises.symlink(
        realRoot,
        linkedRoot,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return;
    }
    const linkedStore = new GhostInstallReceiptStore(
      () => linkedRoot,
      async () => {},
    );

    await linkedStore.write(createSetupReceipt());

    expect(linkedStore.read('hello')).toMatchObject({ state: 'approved' });
  });

  it('treats only a missing migration marker as absent', () => {
    expect(store.hasMigrationMarker('hello')).toBe(false);
  });
  it('rejects a linked snapshot root without touching its target', async () => {
    const external = path.join(workDir, 'external');
    const sentinel = path.join(external, 'hello', 'sentinel.txt');
    await fs.promises.mkdir(path.dirname(sentinel), { recursive: true });
    await fs.promises.writeFile(sentinel, 'keep');
    try {
      await fs.promises.symlink(
        external,
        path.join(stateRoot, 'skill-snapshots'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return;
    }

    await expect(store.remove('hello')).rejects.toThrow(
      'skill snapshot path segment is not a real directory',
    );
    expect(await fs.promises.readFile(sentinel, 'utf8')).toBe('keep');
  });

  it('rejects a linked receipt instead of treating it as cleaned', async () => {
    const externalReceipt = path.join(workDir, 'external-receipt.json');
    await fs.promises.writeFile(externalReceipt, '{}');
    try {
      await fs.promises.symlink(externalReceipt, path.join(stateRoot, 'hello.json'), 'file');
    } catch {
      return;
    }

    await expect(store.remove('hello')).rejects.toThrow(
      'ghost receipt path is not a regular file',
    );
    expect(await fs.promises.readFile(externalReceipt, 'utf8')).toBe('{}');
  });

  it('retains stale snapshots instead of using unsafe pathname-based recursive cleanup', async () => {
    const parent = path.join(stateRoot, 'skill-snapshots', 'hello');
    const movedParent = path.join(stateRoot, 'skill-snapshots', 'hello-moved');
    const external = path.join(workDir, 'external-prune-target');
    await fs.promises.mkdir(path.join(parent, 'stale'), { recursive: true });
    await fs.promises.mkdir(path.join(external, 'stale'), { recursive: true });
    await fs.promises.writeFile(path.join(external, 'stale', 'sentinel.txt'), 'keep');
    const verifiedParent = await fs.promises.realpath(parent);

    const realReaddir = fs.promises.readdir;
    let swapped = false;
    vi.spyOn(fs.promises, 'readdir').mockImplementation(async (target, options) => {
      const entries = await realReaddir(target, options as never);
      if (!swapped && path.resolve(String(target)) === path.resolve(verifiedParent)) {
        swapped = true;
        await fs.promises.rename(parent, movedParent);
        await fs.promises.symlink(external, parent, process.platform === 'win32' ? 'junction' : 'dir');
      }
      return entries as never;
    });

    await (store as unknown as {
      pruneStaleSkillSnapshots(receipt: { id: string; revision: string }): Promise<void>;
    }).pruneStaleSkillSnapshots({ id: 'hello', revision: 'current' });

    expect(swapped).toBe(false);
    expect(await fs.promises.readFile(path.join(external, 'stale', 'sentinel.txt'), 'utf8')).toBe(
      'keep',
    );
    expect(fs.existsSync(path.join(parent, 'stale'))).toBe(true);
  });
});

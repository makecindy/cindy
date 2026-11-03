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
  isValidGhostSourceStateArchiveId,
} from '../ghostInstallReceipt';

describe('GhostInstallReceiptStore cleanup', () => {
  it('accepts only a canonical random archive namespace destination', () => {
    expect(isValidGhostSourceStateArchiveId('_ns__cindy-archive-00000000-0000-4000-8000-000000000002__hello')).toBe(true);
    for (const value of ['hello', '../hello', '_ns__acme__hello',
      'cindy-source-00000000-0000-4000-8000-000000000002',
      '_ns__cindy-archive-not-random__hello']) {
      expect(isValidGhostSourceStateArchiveId(value)).toBe(false);
    }
  });
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

  it('lists legacy, root and organization journals together', async () => {
    const ids = ['hello', '_ns/_root/hello', '_ns/acme/hello'];
    for (const id of ids) await store.writePendingMutation(id, { kind: 'uninstall' });
    expect(store.listPendingMutationIdsSync()).toEqual({ state: 'ok', ids: expect.arrayContaining(ids), blocked: false });
  });

  it.each(['_ns/_root', '_ns/acme'])('blocks cleanup for malformed journals under %s', async (parent) => {
    await store.writePendingMutation(parent + '/hello', { kind: 'uninstall' });
    await fs.promises.writeFile(path.join(stateRoot, parent, '.pending-BAD!.json'), '{}');
    expect(store.listPendingMutationIdsSync()).toEqual({
      state: 'ok', ids: [parent + '/hello'], blocked: true,
    });
  });

  it.each(['_ns/_root', '_ns/acme'])('does not ignore journals when %s disappears during scanning', async (parent) => {
    await store.writePendingMutation(parent + '/hello', { kind: 'uninstall' });
    const readdir = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation((...args) => {
      if (String(args[0]) === path.join(stateRoot, parent)) {
        throw Object.assign(new Error('journal parent disappeared'), { code: 'ENOENT' });
      }
      return readdir(...args);
    });
    expect(store.listPendingMutationIdsSync().state).toBe('unreadable');
  });

  // Receipt schema stays stable: an unknown/invalid optional capability is
  // ignored, not a reason to revoke the old plugin. Existing cases only covered
  // task/target grants. Minimal input is a malformed UI fact; tier: unit.
  it.each([true, 'invalid', false, undefined])('tolerates optional UI approval fact %j', async fact => {
    const receipt = createSetupReceipt();
    await store.write(receipt);
    const file = path.join(stateRoot, 'hello.json');
    const raw = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    raw.uiCapabilityApproved = fact;
    await fs.promises.writeFile(file, JSON.stringify(raw));
    const result = store.readForRecovery('hello');
    expect(result.state).toBe('approved');
    if (result.state === 'approved') expect(result.receipt.uiCapabilityApproved).toBe(fact === true ? true : undefined);
  });

  // Unit: main removed Harness grants. Existing optional-UI tests never load a
  // receipt written by that older Host. A legacy unknown Harness fact must not
  // revoke the plugin or grant UI; read/write must retain identity and setup.
  it.each([undefined, ['harness:read:tasks'], { obsolete: true }])(
    'round-trips legacy receipts without reviving removed grants: %j', async legacyGrant => {
      const original = createSetupReceipt();
      original.manifest.schemaVersion = 3;
      original.manifest.minCindyVersion = '0.1.61';
      await store.write(original);
      const file = path.join(stateRoot, 'hello.json');
      const raw = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      raw.harnessCapabilityApproved = legacyGrant;
      if (legacyGrant !== undefined) raw.manifest.harness = { read: ['tasks'] };
      await fs.promises.writeFile(file, JSON.stringify(raw));
      const loaded = store.readForRecovery('hello');
      expect(loaded.state).toBe('approved');
      if (loaded.state !== 'approved') throw new Error('legacy receipt rejected');
      expect(loaded.receipt).toMatchObject({ revision: original.revision, enabled: true,
        manifest: original.manifest, trust: original.trust });
      expect(loaded.receipt.uiCapabilityApproved).toBeUndefined();
      expect(loaded.receipt).not.toHaveProperty('harnessCapabilityApproved');
      await store.write(loaded.receipt);
      const reread = await store.readAsync('hello');
      expect(reread).toMatchObject({ state: 'approved', receipt: loaded.receipt });
      const persisted = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      expect(persisted).not.toHaveProperty('harnessCapabilityApproved');
      expect(persisted).not.toHaveProperty('uiCapabilityApproved');
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

  // Async discovery adds an await window: preserve the sync reader's no-follow
  // parent gate. A linked namespace must never become an approved installation.
  // Unit; one valid receipt behind a directory link (junction on Windows).
  it('async reading rejects a linked namespace parent', async () => {
    const outside = path.join(workDir, 'outside');
    await fs.promises.mkdir(outside);
    await fs.promises.writeFile(path.join(outside, 'hello.json'), JSON.stringify(createSetupReceipt()));
    await fs.promises.mkdir(path.join(stateRoot, '_ns'));
    await fs.promises.symlink(outside, path.join(stateRoot, '_ns', 'acme'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await store.readAsync('_ns/acme/hello')).toMatchObject({ state: 'invalid' });
  });

  // Unit regression: repeated store.read() must reuse only icon format validation.
  // Existing receipt tests do not cover unchanged revision/path with replaced icon
  // bytes. A same-length invalid replacement must fail, and enabled stays fresh.
  it('reuses unchanged icon validation while checking changed bytes and approval state', () => {
    const receipt = createSetupReceipt();
    const icon = 'data:image/png;base64,' + Buffer.from(workDir).toString('base64');
    const receiptPath = path.join(stateRoot, 'hello.json');
    const persist = (iconDataUrl: string, enabled = true) => {
      fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, iconDataUrl, enabled }));
    };
    const regexTest = vi.spyOn(RegExp.prototype, 'test');
    const iconChecks = (value: string) => regexTest.mock.calls.filter(([input]) => input === value).length;

    persist(icon);
    expect(store.read('hello')).toMatchObject({ state: 'approved', receipt: { iconDataUrl: icon } });
    expect(store.read('hello')).toMatchObject({ state: 'approved', receipt: { iconDataUrl: icon } });
    expect(iconChecks(icon)).toBe(1);

    const originalStat = fs.statSync(receiptPath);
    const invalidIcon = icon.slice(0, -1) + '!';
    persist(invalidIcon);
    fs.utimesSync(receiptPath, originalStat.atime, originalStat.mtime);
    expect(store.read('hello')).toMatchObject({ state: 'invalid' });
    expect(iconChecks(invalidIcon)).toBe(1);

    const replacement = icon.replace('image/png', 'image/gif');
    persist(replacement);
    expect(store.read('hello')).toMatchObject({ state: 'approved', receipt: { iconDataUrl: replacement } });
    persist(replacement, false);
    expect(store.read('hello')).toMatchObject({ state: 'approved', receipt: { enabled: false } });
    expect(iconChecks(replacement)).toBe(1);

    fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, iconDataUrl: replacement, trust: null }));
    expect(store.read('hello')).toMatchObject({ state: 'invalid' });
  });

  // Unit resource regression: read() must evict validated strings at both cache
  // budgets; eviction only causes revalidation, never changes approval results.
  it.each([
    { budget: 'entry count', count: 70, payloadSize: 32 },
    { budget: 'retained bytes', count: 7, payloadSize: 700 * 1024 },
  ])('revalidates evicted icons after exceeding the $budget budget', ({ count, payloadSize }) => {
    const receipt = createSetupReceipt();
    const receiptPath = path.join(stateRoot, 'hello.json');
    const prefix = 'data:image/png;base64,' + Buffer.from(workDir).toString('base64').replace(/=+$/, '');
    const firstIcon = prefix + 'A'.repeat(payloadSize) + '0';
    const regexTest = vi.spyOn(RegExp.prototype, 'test');
    for (let index = 0; index < count; index++) {
      fs.writeFileSync(receiptPath, JSON.stringify({
        ...receipt, iconDataUrl: prefix + 'A'.repeat(payloadSize) + index,
      }));
      expect(store.read('hello').state).toBe('approved');
    }
    fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, iconDataUrl: firstIcon }));
    expect(store.read('hello')).toMatchObject({ state: 'approved', receipt: { iconDataUrl: firstIcon } });
    expect(regexTest.mock.calls.filter(([input]) => input === firstIcon)).toHaveLength(2);
  });

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

  it.each(['future', { future: true }, null, false])('reads and rewrites old unknown tasks %j without changing approval evidence', async (tasks) => {
    const original = createSetupReceipt();
    await store.write(original);
    const file = path.join(stateRoot, 'hello.json');
    const raw = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    raw.manifest.slots.splice(1, 0, 'agent');raw.manifest.agent = { tasks };
    await fs.promises.writeFile(file, JSON.stringify(raw));
    const loaded = store.read('hello');
    expect(loaded.state).toBe('approved');
    if (loaded.state !== 'approved') throw new Error('fixture not approved');
    expect(loaded.receipt).toMatchObject({revision:original.revision,enabled:true,manifest:{agent:{tasks}},skillContentSha256:original.skillContentSha256});
    expect(loaded.receipt.taskCapabilityApproved).toBeUndefined();
    await store.write(loaded.receipt);
    const saved = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    expect(saved).toEqual(raw);
  });

  it('round trips independent target approval without inferring it from old tasks grants', async () => {
    const receipt = createSetupReceipt();
    receipt.manifest.agent = { tasks: true, targets: true };
    receipt.taskCapabilityApproved = true;
    await store.write(receipt);
    const old = store.read('hello');
    if (old.state !== 'approved') throw new Error('fixture not approved');
    expect(old.receipt.targetCapabilityApproved).toBeUndefined();
    await store.write({ ...old.receipt, targetCapabilityApproved: true });
    const approved = store.read('hello');
    expect(approved).toMatchObject({ state: 'approved', receipt: { taskCapabilityApproved: true, targetCapabilityApproved: true, revision: receipt.revision } });
  });

  // Rule: approved control points persist across reads, keep only names this manifest still declares,
  // and an older receipt without the field stays approved with no control point granted.
  it('round trips approved control points and keeps older receipts approved without them', async () => {
    const receipt = createSetupReceipt();
    receipt.manifest.subscribe = { hooks: ['will-routine-run', 'will-later-point'] as never };
    await store.write(receipt);
    const old = store.read('hello');
    if (old.state !== 'approved') throw new Error('fixture not approved');
    expect(old.receipt.approvedControlPoints).toBeUndefined();
    await store.write({ ...old.receipt, approvedControlPoints: ['will-routine-run', 'will-later-point', 'undeclared'] });
    const approved = store.read('hello');
    expect(approved).toMatchObject({
      state: 'approved',
      receipt: { approvedControlPoints: ['will-later-point', 'will-routine-run'], revision: receipt.revision },
    });
  });

  it('round trips independent observe approval without inferring it from tasks or targets grants', async () => {
    const receipt = createSetupReceipt();
    receipt.manifest.agent = { tasks: true, targets: true, observe: true };
    receipt.taskCapabilityApproved = true;
    receipt.targetCapabilityApproved = true;
    await store.write(receipt);
    const old = store.read('hello');
    if (old.state !== 'approved') throw new Error('fixture not approved');
    expect(old.receipt.observeCapabilityApproved).toBeUndefined();
    await store.write({ ...old.receipt, observeCapabilityApproved: true });
    expect(store.read('hello')).toMatchObject({ state: 'approved', receipt: { observeCapabilityApproved: true, revision: receipt.revision } });
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

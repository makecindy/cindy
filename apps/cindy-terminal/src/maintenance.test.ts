/** Behavior tier: stopped-host encrypted backup must retain task data without
 * transferring host credentials/identity, refuse a live writer or wrong key,
 * and recover an interrupted directory swap. Uses only synthetic profile data. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { backupProfile, restoreProfile, recoverProfileRestore, installTerminalPackage, verifyProfileBackup, rollbackTerminalPackage, checkTerminalUpdate, terminalInstallationStatus, profileStorage } from './maintenance.js';
import { atomicPrivateWrite, privateDirectory, profileLifecycleLockPath } from './platform.js';
import { TerminalTransportServer } from './transport.js';

describe('terminal offline maintenance', () => {
  let root: string;
  beforeAll(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-maintenance-test-')); });
  afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const passphrase = 'invalid-test-backup-passphrase';
  it('round-trips encrypted task data with a fresh identity and no host secrets', async () => {
    const profile = path.join(root, 'source'), owner = path.join(profile, 'owners', 'a'.repeat(32));
    await privateDirectory(path.join(owner, 'tasks', 'task-one'));
    await atomicPrivateWrite(path.join(profile, 'settings.json'), JSON.stringify({ version: 1, deviceId: 'old-device', overrides: { language: 'ja', remoteEnabled: true } }));
    await atomicPrivateWrite(path.join(profile, 'secrets.enc'), 'invalid-test-secret');
    await atomicPrivateWrite(path.join(profile, 'machine.key'), 'invalid-test-machine-key');
    await atomicPrivateWrite(path.join(owner, 'tasks', 'task-one', 'history.jsonl'), 'private-test-task-data');
    await privateDirectory(path.join(owner, 'engines'));
    await atomicPrivateWrite(path.join(owner, 'engines', 'auth.json'), 'invalid-test-provider-key');
    await privateDirectory(path.join(owner, 'cindy-media', 'blobs'));
    const Database = createRequire(import.meta.url)('better-sqlite3');
    const ledger = new Database(path.join(owner, 'cindy-media', 'ledger.sqlite'));
    ledger.exec("create table media(id text); insert into media values('media-test');"); ledger.close();
    await atomicPrivateWrite(path.join(owner, 'cindy-media', 'blobs', 'image-test'), 'private-media-test');
    await privateDirectory(path.join(owner, 'companions', 'cloud'));
    await atomicPrivateWrite(path.join(owner, 'companions', 'profiles.json'), '{"version":1,"profiles":[]}');
    await atomicPrivateWrite(path.join(owner, 'companions', 'cloud', 'installation'), 'old-device-installation');
    await atomicPrivateWrite(path.join(owner, 'companions', 'cloud', 'homes.json'), '{"selfDeviceId":"old-device"}');
    await atomicPrivateWrite(path.join(owner, 'companions', 'cloud', 'a'.repeat(64)+'.json'), '{"bots":{}}');
    await privateDirectory(path.join(owner, 'maker-memory'));
    await atomicPrivateWrite(path.join(owner, 'maker-memory', 'MEMORY.md'), 'retained-memory');
    await atomicPrivateWrite(path.join(owner, 'knowledge-settings.json'), '{"version":1}');
    await atomicPrivateWrite(path.join(owner, 'capabilities.json'), '{"version":1,"skills":[]}');
    await privateDirectory(path.join(owner, 'managed-agent-skills', 'example'));
    await atomicPrivateWrite(path.join(owner, 'managed-agent-skills', 'example', 'SKILL.md'), '# Retained skill');
    // Plugin data is user work too. Test actual encrypted export/restore, not
    // the path allowlist, and keep download caches out of the portable archive.
    const pluginData = {
      'companions/model-defaults.json': '{"version":1,"models":[{"agentKind":"pi","model":"retained-model","providerId":"owner-provider"}]}',
      'companions/profile-update.json': '{"version":1,"before":"pending-profile-update","profiles":[],"files":[]}',
      'orca/state.json': '{"version":1,"teams":[],"workers":[],"reservations":[],"remoteOpens":[],"taskJournal":[]}',
      'plugins/example/ghost.json': '{"id":"example"}',
      'plugin-approvals/example.json': '{"receipt":"synthetic"}',
      'plugin-kv/example.json': '{"preference":"retained"}',
      'libraries/example/works/note.txt': 'retained plugin work',
      'library-staging/example/pending/blob': 'uncommitted original',
      'plugin-market/ledger.v1.json': '{"version":1}',
      'ghost-workdir-prefs.json': '{"version":1}',
      'ghost-sidebar-prefs.json': '["_root__fixture"]',
      'ghost-errand-prefs.json': '{"errand":{"example":{"model":"retained-model"}},"sessions":{}}',
    };
    for (const [relative, body] of Object.entries(pluginData)) {
      const file = path.join(owner, relative); await privateDirectory(path.dirname(file)); await atomicPrivateWrite(file, body);
    }
    await privateDirectory(path.join(owner, 'plugin-tasks'));
    const taskReceipts = new Database(path.join(owner, 'plugin-tasks', 'receipts.sqlite'));
    taskReceipts.exec('CREATE TABLE plugin_task_requests(id TEXT PRIMARY KEY, payload TEXT)');
    taskReceipts.prepare('INSERT INTO plugin_task_requests VALUES (?, ?)').run('revoked-task', '{"ownershipRevoked":true}');
    taskReceipts.close();
    await privateDirectory(path.join(owner, 'plugin-market', 'downloads'));
    await atomicPrivateWrite(path.join(owner, 'plugin-market', 'downloads', 'cache'), 'discardable download');
    const outside = path.join(root, 'outside'); await fs.writeFile(outside, 'outside-test-data');
    if (process.platform !== 'win32') await fs.symlink(outside, path.join(owner, 'tasks', 'external'));
    const backup = path.join(root, 'portable.backup');
    const result = await backupProfile(profile, backup, passphrase);
    expect(result.bytes).toBeGreaterThan(50);
    expect(await verifyProfileBackup(backup, passphrase)).toMatchObject({ valid: true, owners: 1 });
    expect((await fs.readFile(backup)).includes(Buffer.from('private-test-task-data'))).toBe(false);
    const restored = path.join(root, 'restored');
    await restoreProfile(restored, backup, passphrase);
    expect(await fs.readFile(path.join(restored, 'owners', 'a'.repeat(32), 'tasks', 'task-one', 'history.jsonl'), 'utf8')).toBe('private-test-task-data');
    expect((await fs.readdir(restored)).sort()).toEqual(['owners', 'settings.json']);
    const restoredOwner = path.join(restored, 'owners', 'a'.repeat(32));
    expect((await fs.readdir(restoredOwner)).sort()).toEqual(['capabilities.json', 'cindy-media', 'companions', 'knowledge-settings.json', 'maker-memory', 'managed-agent-skills', 'tasks',
      'orca','plugins','plugin-approvals','plugin-kv','libraries','library-staging','plugin-market','ghost-workdir-prefs.json','ghost-sidebar-prefs.json','plugin-tasks','ghost-errand-prefs.json'].sort());
    for (const [relative, body] of Object.entries(pluginData)) expect(await fs.readFile(path.join(restoredOwner, relative), 'utf8')).toBe(body);
    expect(await fs.readdir(path.join(restoredOwner, 'plugin-market'))).toEqual(['ledger.v1.json']);
    expect(await fs.readdir(path.join(restoredOwner, 'companions', 'cloud'))).toEqual(['a'.repeat(64)+'.json']);
    expect(await fs.readFile(path.join(restoredOwner, 'maker-memory', 'MEMORY.md'), 'utf8')).toBe('retained-memory');
    expect(await fs.readFile(path.join(restoredOwner, 'managed-agent-skills', 'example', 'SKILL.md'), 'utf8')).toBe('# Retained skill');
    const restoredReceipts = new Database(path.join(restoredOwner, 'plugin-tasks', 'receipts.sqlite'), { readonly: true });
    try { expect(restoredReceipts.prepare('SELECT payload FROM plugin_task_requests WHERE id = ?').get('revoked-task')).toEqual({payload:'{"ownershipRevoked":true}'}); } finally { restoredReceipts.close(); }
    const restoredLedger = new Database(path.join(restoredOwner, 'cindy-media', 'ledger.sqlite'), { readonly: true });
    try { expect(restoredLedger.prepare('select id from media').get()).toEqual({ id: 'media-test' }); } finally { restoredLedger.close(); }
    expect(await fs.readFile(path.join(restoredOwner, 'cindy-media', 'blobs', 'image-test'), 'utf8')).toBe('private-media-test');
    const settings = JSON.parse(await fs.readFile(path.join(restored, 'settings.json'), 'utf8'));
    expect(settings.deviceId).not.toBe('old-device'); expect(settings.overrides).toEqual({ language: 'ja', remoteEnabled: false });
  }, process.platform === 'win32' ? 20_000 : 5_000);
  it('rejects a wrong backup passphrase without changing an existing profile', async () => {
    const profile = path.join(root, 'existing'); await privateDirectory(profile);
    await atomicPrivateWrite(path.join(profile, 'sentinel'), 'original-data');
    await expect(restoreProfile(profile, path.join(root, 'portable.backup'), 'wrong-test-passphrase')).rejects.toThrow('BACKUP_DECRYPT_FAILED');
    expect(await fs.readFile(path.join(profile, 'sentinel'), 'utf8')).toBe('original-data');
    expect(await fs.readdir(profile)).toEqual(['sentinel']);
  });
  it('refuses a live service and preserves the shared parent directory permissions', async () => {
    const profile = path.join(root, 'running');
    if (process.platform !== 'win32') await fs.chmod(root, 0o755);
    const server = new TerminalTransportServer(profile, async () => null);
    await server.listen();
    try { await expect(backupProfile(profile, path.join(root, 'running.backup'), passphrase)).rejects.toThrow('STOP_SERVICE_BEFORE_MAINTENANCE'); }
    finally { await server.close(); }
    if (process.platform !== 'win32') expect((await fs.stat(root)).mode & 0o777).toBe(0o755);
  });
  it('blocks startup on an interrupted swap and recovers the old profile atomically', async () => {
    const profile = path.join(root, 'interrupted'), rollback = `${profile}.rollback-test`, staging = `${profile}.restore-test`;
    await privateDirectory(profile); await privateDirectory(rollback); await privateDirectory(staging);
    await atomicPrivateWrite(path.join(rollback, 'original'), 'preserved');
    await atomicPrivateWrite(path.join(profile, 'replacement'), 'not-committed');
    await atomicPrivateWrite(`${profileLifecycleLockPath(profile)}.restore`, JSON.stringify({ profile, rollback, staging, hadOriginal: true }));
    const server = new TerminalTransportServer(profile, async () => null);
    await expect(server.listen()).rejects.toThrow('PROFILE_RECOVERY_REQUIRED');
    const result = await recoverProfileRestore(profile);
    expect(result.recovered).toBe(true);
    expect(await fs.readFile(path.join(profile, 'original'), 'utf8')).toBe('preserved');
    expect(await fs.readFile(path.join(result.retained!, 'replacement'), 'utf8')).toBe('not-committed');
  });
  it('rejects a bad package digest before modifying an installation directory', async () => {
    const target = path.join(root, 'not-terminal'); await privateDirectory(target);
    await atomicPrivateWrite(path.join(target, 'existing-app'), 'preserve');
    const archive = path.join(root, 'invalid.tar.gz'); await fs.writeFile(archive, 'invalid-archive');
    await expect(installTerminalPackage(archive, '0'.repeat(64), target)).rejects.toThrow('TERMINAL_PACKAGE_CHECKSUM_MISMATCH');
    expect(await fs.readdir(target)).toEqual(['existing-app']);
  });
  it('checks an explicit release manifest and rolls back to an executable retained release', async () => {
    const prefix = path.join(root, 'terminal-install'); await privateDirectory(prefix);
    const previous = `0.9.0-${'a'.repeat(16)}`, current = `1.0.0-${'b'.repeat(16)}`;
    await atomicPrivateWrite(path.join(prefix, '.cindy-terminal-installation'), 'cindy-terminal:1');
    await atomicPrivateWrite(path.join(prefix, 'current.json'), JSON.stringify({ version: '1.0.0', release: current, previousRelease: previous, sha256: 'b'.repeat(64) }));
    const release = path.join(prefix, 'releases', previous);
    await privateDirectory(path.join(release, 'runtime')); await privateDirectory(path.join(release, 'app', 'dist'));
    const node = path.join(release, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
    // Real local Node execution, no simulated subprocess success.
    try { await fs.link(process.execPath, node); } catch { await fs.copyFile(process.execPath, node); }
    await atomicPrivateWrite(path.join(release, 'runtime-manifest.json'), JSON.stringify({ version: '0.9.0', target: `${process.platform}-${process.arch}` }));
    await atomicPrivateWrite(path.join(release, 'app', 'package.json'), JSON.stringify({ name: 'cindy-terminal', type: 'module' }));
    await atomicPrivateWrite(path.join(release, 'app', 'dist', 'cli.js'), "console.log('0.9.0');");
    await atomicPrivateWrite(path.join(release, 'installation.json'), JSON.stringify({ version: '0.9.0', release: previous, sha256: 'a'.repeat(64) }));
    const fetcher = async () => new Response(JSON.stringify({ product: 'cindy-terminal', format: 1, version: '1.1.0', target: `${process.platform}-${process.arch}`, sha256: 'c'.repeat(64), url: 'https://example.com/terminal.tar.gz' }));
    expect(await checkTerminalUpdate(prefix, 'https://example.com/release.json', fetcher as typeof fetch)).toMatchObject({ status: 'update-available', installedVersion: '1.0.0' });
    expect(await rollbackTerminalPackage(prefix)).toMatchObject({ version: '0.9.0', previousRelease: current, restartRequired: true });
    expect((await terminalInstallationStatus(prefix)).current).toMatchObject({ version: '0.9.0', sha256: 'a'.repeat(64) });
    expect(await fs.readFile(path.join(prefix, process.platform === 'win32' ? 'cindy.cmd' : 'cindy'), 'utf8')).toContain(previous);
    await expect(rollbackTerminalPackage(prefix, '../foreign')).rejects.toThrow('TERMINAL_ROLLBACK_UNAVAILABLE');
  });
  it('inventories profile bytes without traversing an external symlink', async () => {
    const profile = path.join(root, 'inventory'); await privateDirectory(profile);
    await atomicPrivateWrite(path.join(profile, 'settings.json'), '{}');
    await privateDirectory(path.join(profile, 'owners'));
    await atomicPrivateWrite(path.join(profile, 'owners', 'data'), 'user-data');
    if (process.platform !== 'win32') await fs.symlink(path.join(root, 'source'), path.join(profile, 'outside'));
    expect(await profileStorage(profile)).toMatchObject({ bytes: 11, files: 2, symlinks: process.platform === 'win32' ? 0 : 1, categories: { 'host-state': 2, 'user-data': 9 } });
  });
});

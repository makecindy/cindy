import { constants, createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { withCrossProcessLock } from '@cindy/remote-agent/crossProcessLock';
import { atomicPrivateWrite, privateDirectory, profilePath, profileLifecycleLockPath, readPrivateFile, VERSION } from './platform.js';
import { connectTerminal } from './transport.js';
import { EngineManager } from './engines/manager.js';
import { extractEngineArchive } from './engines/archive.js';
import { runNative } from './engines/native.js';
import { terminalSettingsSchema } from './settings.js';

const derive = promisify(scrypt);
const MAGIC = Buffer.from('CINDY-BACKUP-1\n');
const EXCLUDED = ['sign-in tokens', 'provider credentials', 'plugin credentials', 'device identity', 'remote grants', 'installed engines', 'download caches', 'files outside the profile'];
const OWNER_PATHS = new Set(['models.json', 'projects.json', 'tasks', 'orca', 'schedules.json', 'workspaces', 'scheduled-workspaces', 'cindy-media', 'knowledge-settings.json', 'maker-memory', 'maker-contacts', 'companions', 'capabilities.json', 'managed-agent-skills',
  'plugins', 'plugin-approvals', 'plugin-kv', 'plugin-fs', 'plugin-market', 'plugin-cleanup.json', 'ghost-workdir-prefs.json', 'ghost-sidebar-prefs.json', 'plugin-tasks', 'ghost-errand-prefs.json', 'ghost-cindy-prefs.json',
  'libraries', 'libraries-binding.json', 'library-staging', 'libraries-trash']);
const PLUGIN_MARKET_FILES = new Set(['ledger.v1.json', 'organization.v1.json', 'current-organization.json', 'install.pending.json']);
const COMPANION_PATHS = new Set(['profiles.json', 'profile-update.json', 'model-defaults.json', 'homes', 'history', 'memory', 'backups', 'cloud']);
// Cloud installation / homes snapshots bind this machine to server identities.
// Keep only sync cursors and demotion history; fresh sign-in must resolve homes.
const portableCloudFile = (name: string) => name === 'shadows.json' || /^[a-f0-9]{64}\.json$/.test(name);
export interface DoctorCheck { id: string; status: 'ok' | 'warning' | 'error'; code: string; detail?: string }

export async function doctor(profileDir: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push({ id: 'node', status: Number(process.versions.node.split('.')[0]) >= 22 ? 'ok' : 'error', code: 'NODE_VERSION', detail: process.versions.node });
  try {
    const stat = await fs.lstat(profileDir);
    const safe = stat.isDirectory() && !stat.isSymbolicLink() && (process.platform === 'win32' || stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0);
    checks.push({ id: 'profile', status: !safe ? 'error' : process.platform === 'win32' ? 'warning' : 'ok', code: !safe ? 'PROFILE_PERMISSIONS' : process.platform === 'win32' ? 'PROFILE_ACL_NOT_VERIFIED' : 'PROFILE_PRIVATE' });
    await fs.access(profileDir, constants.R_OK | constants.W_OK);
  } catch (error) { checks.push({ id: 'profile', status: 'warning', code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'PROFILE_NOT_CREATED' : 'PROFILE_UNAVAILABLE' }); }
  if (await readPrivateFile(`${profileLifecycleLockPath(profileDir)}.restore`).catch(() => null)) checks.push({ id: 'restore', status: 'error', code: 'PROFILE_RECOVERY_REQUIRED' });
  try {
    const client = await connectTerminal(profileDir);
    try { await client.invoke('terminal:status'); checks.push({ id: 'service', status: 'ok', code: 'SERVICE_RESPONDING' }); }
    finally { client.close(); }
  } catch { checks.push({ id: 'service', status: 'warning', code: 'SERVICE_NOT_RESPONDING' }); }
  for (const engine of await new EngineManager({ profileDir }).allStatus()) {
    if (!engine.binary) { checks.push({ id: engine.kind, status: 'warning', code: 'ENGINE_NOT_INSTALLED' }); continue; }
    try {
      const actual = await runNative(engine.binary, ['--version']);
      const version = actual.stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
      const usable = actual.code === 0 && Boolean(version) && (!engine.version || version === engine.version);
      checks.push({ id: engine.kind, status: usable ? 'ok' : 'error', code: usable ? 'ENGINE_AVAILABLE' : 'ENGINE_REPAIR_REQUIRED', ...(version ? { detail: version } : {}) });
    } catch { checks.push({ id: engine.kind, status: 'error', code: 'ENGINE_REPAIR_REQUIRED' }); }
  }
  try {
    const raw = await readPrivateFile(path.join(profileDir, 'secrets.enc'));
    const envelope = raw ? JSON.parse(raw.toString()) : null;
    checks.push({ id: 'vault', status: envelope?.version === 1 ? 'ok' : 'warning', code: envelope?.version === 1 ? envelope.mode === 'machine' ? 'VAULT_MACHINE_BOUND' : 'VAULT_PASSPHRASE' : 'VAULT_NOT_INITIALIZED' });
  } catch { checks.push({ id: 'vault', status: 'error', code: 'VAULT_UNREADABLE' }); }
  const { TerminalBrowserRuntime } = await import('./plugins/browser.js');
  const browser=new TerminalBrowserRuntime({root:path.join(profileDir,'browser-runtime')});
  try{
    const result=await browser.check();
    checks.push({id:'browser',status:result.ok?'ok':result.code==='BROWSER_NOT_INSTALLED'?'warning':'error',code:result.code,...('executable' in result?{detail:result.executable}:{})});
  }catch{checks.push({id:'browser',status:'error',code:'BROWSER_RUNTIME_UNAVAILABLE'});}
  finally{await browser.close();}
  return checks;
}

async function stopped(profileDir: string): Promise<void> {
  const raw = await readPrivateFile(path.join(profileDir, 'service.json'));
  if (!raw) return;
  let pid: number;
  try { pid = JSON.parse(raw.toString()).pid; } catch { throw new Error('SERVICE_ENDPOINT_INVALID'); }
  if (!Number.isSafeInteger(pid!) || pid! <= 0) throw new Error('SERVICE_ENDPOINT_INVALID');
  try { process.kill(pid!, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw new Error('SERVICE_STATE_UNCERTAIN'); }
  throw new Error('STOP_SERVICE_BEFORE_MAINTENANCE');
}

async function exclusive<T>(profileDir: string, operation: () => Promise<T>): Promise<T> {
  if (!path.isAbsolute(profileDir) || path.resolve(profileDir) !== profileDir) throw new Error('PROFILE_PATH_INVALID');
  await fs.mkdir(path.dirname(profileDir), { recursive: true, mode: 0o700 });
  return withCrossProcessLock(profileLifecycleLockPath(profileDir), { label: 'terminal profile maintenance' }, async state => {
    if (!state.held) throw new Error('PROFILE_BUSY');
    const existing = await fs.lstat(profileDir).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('UNSAFE_PROFILE_DIRECTORY');
    await stopped(profileDir);
    return operation();
  });
}

async function copyTree(source: string, destination: string, counters: { bytes: number; externalLinks: number }, boundary: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) { counters.externalLinks++; return; }
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    const real = await fs.realpath(source);
    if (real !== boundary && !real.startsWith(`${boundary}${path.sep}`)) throw new Error('BACKUP_PATH_CHANGED');
    for (const entry of await fs.readdir(source)) await copyTree(path.join(source, entry), path.join(destination, entry), counters, boundary);
  } else if (stat.isFile()) {
    const handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      const actual = await handle.stat(), current = await fs.lstat(source), real = await fs.realpath(source);
      if (!actual.isFile() || current.isSymbolicLink() || actual.dev !== current.dev || actual.ino !== current.ino || (real !== boundary && !real.startsWith(`${boundary}${path.sep}`))) throw new Error('BACKUP_PATH_CHANGED');
      counters.bytes += actual.size;
      if (counters.bytes > 2 * 1024 ** 3) throw new Error('BACKUP_TOO_LARGE');
      let copied = 0;
      const bounded = new Transform({ transform(chunk: Buffer, _encoding, done) { copied += chunk.length; done(copied > actual.size ? new Error('BACKUP_SOURCE_CHANGED') : null, chunk); } });
      await pipeline(handle.createReadStream({ autoClose: false }), bounded, createWriteStream(destination, { flags: 'wx', mode: stat.mode & 0o111 ? 0o700 : 0o600 }));
      const after = await handle.stat();
      if (copied !== actual.size || after.size !== actual.size || after.mtimeMs !== actual.mtimeMs) throw new Error('BACKUP_SOURCE_CHANGED');
    } finally { await handle.close(); }
  } else throw new Error('BACKUP_SPECIAL_FILE');
}

/** Portable encrypted data backup omits host-managed credentials and device
 * identity. User workspaces may themselves contain sensitive files, so all
 * included data is encrypted. Owners sign in and reconnect after restore.
 * The host must be stopped; the startup lock also excludes a racing launch. */
export async function backupProfile(profileDir: string, destination: string, passphrase: string): Promise<{ file: string; bytes: number; externalLinksExcluded: number; excluded: string[] }> {
  if (passphrase.length < 12) throw new Error('BACKUP_PASSPHRASE_TOO_SHORT');
  if (!path.isAbsolute(destination) || destination === profileDir || destination.startsWith(`${profileDir}${path.sep}`)) throw new Error('BACKUP_DESTINATION_INVALID');
  return exclusive(profileDir, async () => {
    if (await readPrivateFile(`${profileLifecycleLockPath(profileDir)}.restore`)) throw new Error('PROFILE_RECOVERY_REQUIRED');
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-profile-backup-'));
    await privateDirectory(staging);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const keySalt = randomBytes(32), iv = randomBytes(12), header = Buffer.concat([MAGIC, keySalt, iv]);
    const key = await derive(passphrase, keySalt, 32) as Buffer;
    const counters = { bytes: 0, externalLinks: 0 };
    try {
      const settings = await readPrivateFile(path.join(profileDir, 'settings.json'));
      const overrides = settings ? terminalSettingsSchema.parse(JSON.parse(settings.toString()).overrides) : {};
      await fs.writeFile(path.join(staging, 'backup.json'), JSON.stringify({ product: 'cindy-terminal', format: 1, version: VERSION, createdAt: new Date().toISOString(), overrides, excluded: EXCLUDED }), { mode: 0o600 });
      const owners = path.join(profileDir, 'owners');
      for (const owner of await fs.readdir(owners, { withFileTypes: true }).catch(() => [])) {
        if (!owner.isDirectory() || !/^[a-f0-9]{32}$/.test(owner.name)) continue;
        const output = path.join(staging, 'owners', owner.name); await fs.mkdir(output, { recursive: true, mode: 0o700 });
        for (const entry of await fs.readdir(path.join(owners, owner.name))) if (OWNER_PATHS.has(entry)) {
          const source = path.join(owners, owner.name, entry), destination = path.join(output, entry);
          if (entry === 'plugin-market') {
            const market = await fs.lstat(source);
            if (!market.isDirectory() || market.isSymbolicLink()) { counters.externalLinks++; continue; }
            await fs.mkdir(destination, { mode: 0o700 });
            for (const file of await fs.readdir(source)) if (PLUGIN_MARKET_FILES.has(file))
              await copyTree(path.join(source, file), path.join(destination, file), counters, await fs.realpath(profileDir));
          } else if (entry !== 'companions') await copyTree(source, destination, counters, await fs.realpath(profileDir));
          else {
            const companions = await fs.lstat(source);
            if (!companions.isDirectory() || companions.isSymbolicLink()) { counters.externalLinks++; continue; }
            await fs.mkdir(destination, { mode: 0o700 });
            for (const child of await fs.readdir(source)) if (COMPANION_PATHS.has(child)) {
              if (child !== 'cloud') await copyTree(path.join(source, child), path.join(destination, child), counters, await fs.realpath(profileDir));
              else {
                const cloud = path.join(source, child), cloudStat = await fs.lstat(cloud);
                if (!cloudStat.isDirectory() || cloudStat.isSymbolicLink()) { counters.externalLinks++; continue; }
                await fs.mkdir(path.join(destination, child), { mode: 0o700 });
                for (const file of await fs.readdir(cloud)) if (portableCloudFile(file)) await copyTree(path.join(cloud, file), path.join(destination, child, file), counters, await fs.realpath(profileDir));
              }
            }
          }
        }
      }
      const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(header);
      const handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(header); await handle.close();
      await pipeline(tar.c({ gzip: true, cwd: staging, portable: true }, await fs.readdir(staging)), cipher, createWriteStream(temporary, { flags: 'a', mode: 0o600 }));
      const completed = await fs.open(temporary, 'a');
      try { await completed.writeFile(cipher.getAuthTag()); await completed.sync(); } finally { await completed.close(); }
      await fs.link(temporary, destination); // Never overwrite an existing backup.
      return { file: destination, bytes: (await fs.stat(destination)).size, externalLinksExcluded: counters.externalLinks, excluded: [...EXCLUDED] };
    } finally { key.fill(0); await fs.rm(staging, { recursive: true, force: true }); await fs.rm(temporary, { force: true }); }
  });
}

interface RestoreJournal { profile: string; staging: string; rollback: string; hadOriginal: boolean }
async function rollbackRestore(profileDir: string): Promise<{ recovered: boolean; retained?: string }> {
  const file = `${profileLifecycleLockPath(profileDir)}.restore`;
  const raw = await readPrivateFile(file); if (!raw) return { recovered: false };
  const journal = JSON.parse(raw.toString()) as RestoreJournal;
  if (journal.profile !== profileDir || typeof journal.hadOriginal !== 'boolean' || typeof journal.staging !== 'string' || typeof journal.rollback !== 'string' || !journal.staging.startsWith(`${profileDir}.restore-`) || !journal.rollback.startsWith(`${profileDir}.rollback-`) || [journal.staging, journal.rollback].some(value => path.dirname(value) !== path.dirname(profileDir))) throw new Error('RESTORE_JOURNAL_INVALID');
  let retained: string | undefined;
  if (await fs.lstat(journal.rollback).catch(() => null)) {
    if (await fs.lstat(profileDir).catch(() => null)) { retained = `${profileDir}.uncommitted-${randomUUID()}`; await fs.rename(profileDir, retained); }
    await fs.rename(journal.rollback, profileDir);
  } else if (!journal.hadOriginal && await fs.lstat(profileDir).catch(() => null)) {
    retained = `${profileDir}.uncommitted-${randomUUID()}`; await fs.rename(profileDir, retained);
  }
  await fs.rm(journal.staging, { recursive: true, force: true });
  await fs.rm(file, { force: true });
  return { recovered: true, ...(retained ? { retained } : {}) };
}

export async function recoverProfileRestore(profileDir: string) { return exclusive(profileDir, () => rollbackRestore(profileDir)); }

async function decodeBackup(backup: string, passphrase: string, staging: string): Promise<{version:string;createdAt:string;overrides:unknown}> {
  const decoding = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-backup-decode-'));
  await privateDirectory(decoding);
  const archive = path.join(decoding, 'payload.tar.gz');
  let key: Buffer | undefined;
  try {
    const input = await fs.open(backup, 'r');
    const header = Buffer.alloc(MAGIC.length + 44), tag = Buffer.alloc(16);
    let size: number;
    try { size = (await input.stat()).size; if (size < header.length + 16 || size > 2 * 1024 ** 3) throw new Error('BACKUP_INVALID'); await input.read(header, 0, header.length, 0); await input.read(tag, 0, 16, size - 16); }
    finally { await input.close(); }
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('BACKUP_INVALID');
    key = await derive(passphrase, header.subarray(MAGIC.length, MAGIC.length + 32), 32) as Buffer;
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length + 32)); decipher.setAAD(header); decipher.setAuthTag(tag);
    try { await pipeline(createReadStream(backup, { start: header.length, end: size - 17 }), decipher, createWriteStream(archive, { flags: 'wx', mode: 0o600 })); }
    catch { throw new Error('BACKUP_DECRYPT_FAILED'); }
    await extractEngineArchive(archive, staging, 'tar.gz');
    const metadata = JSON.parse(await fs.readFile(path.join(staging, 'backup.json'), 'utf8'));
    if (metadata.product !== 'cindy-terminal' || metadata.format !== 1) throw new Error('BACKUP_FORMAT_UNSUPPORTED');
    for (const entry of await fs.readdir(staging)) if (!['backup.json', 'owners'].includes(entry)) throw new Error('BACKUP_CONTENT_INVALID');
    const owners = path.join(staging, 'owners');
    for (const owner of await fs.readdir(owners, { withFileTypes: true }).catch(() => [])) {
      if (!owner.isDirectory() || !/^[a-f0-9]{32}$/.test(owner.name)) throw new Error('BACKUP_CONTENT_INVALID');
      if ((await fs.readdir(path.join(owners, owner.name))).some(entry => !OWNER_PATHS.has(entry))) throw new Error('BACKUP_CONTENT_INVALID');
      const market = path.join(owners, owner.name, 'plugin-market');
      for (const name of await fs.readdir(market).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; })) {
        if (!PLUGIN_MARKET_FILES.has(name)) throw new Error('BACKUP_CONTENT_INVALID');
      }
      const companions = path.join(owners, owner.name, 'companions');
      for (const name of await fs.readdir(companions).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; })) {
        if (!COMPANION_PATHS.has(name)) throw new Error('BACKUP_CONTENT_INVALID');
        if (name === 'cloud' && (await fs.readdir(path.join(companions, name))).some(file => !portableCloudFile(file))) throw new Error('BACKUP_CONTENT_INVALID');
      }
    }
    await fs.rm(archive);
    return metadata;
  } finally { key?.fill(0); await fs.rm(decoding, { recursive: true, force: true }); }
}

/** Authentication and archive-layout verification without changing a profile. */
export async function verifyProfileBackup(backup: string, passphrase: string): Promise<{ valid: true; version: string; createdAt: string; owners: number }> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-backup-verify-'));
  await privateDirectory(temporary);
  try {
    const metadata = await decodeBackup(backup, passphrase, temporary);
    const owners = await fs.readdir(path.join(temporary, 'owners')).catch(() => []);
    return { valid: true, version: metadata.version, createdAt: metadata.createdAt, owners: owners.length };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

export async function restoreProfile(profileDir: string, backup: string, passphrase: string): Promise<{ restored: true; rollbackPath?: string; requiresSignIn: true }> {
  return exclusive(profileDir, async () => {
    const journalFile = `${profileLifecycleLockPath(profileDir)}.restore`;
    if (await readPrivateFile(journalFile)) throw new Error('PROFILE_RECOVERY_REQUIRED');
    const staging = `${profileDir}.restore-${randomUUID()}`, rollback = `${profileDir}.rollback-${randomUUID()}`;
    await privateDirectory(staging);
    let swapping = false;
    try {
      const metadata = await decodeBackup(backup, passphrase, staging);
      const settings = { version: 1, deviceId: randomUUID(), overrides: { ...terminalSettingsSchema.parse(metadata.overrides), remoteEnabled: false } };
      await fs.rm(path.join(staging, 'backup.json'));
      await atomicPrivateWrite(path.join(staging, 'settings.json'), JSON.stringify(settings));
      const hadOriginal = Boolean(await fs.lstat(profileDir).catch(() => null));
      await atomicPrivateWrite(journalFile, JSON.stringify({ profile: profileDir, staging, rollback, hadOriginal } satisfies RestoreJournal));
      swapping = true;
      if (hadOriginal) await fs.rename(profileDir, rollback);
      await fs.rename(staging, profileDir);
      await fs.rm(journalFile);
      swapping = false;
      return { restored: true, ...(hadOriginal ? { rollbackPath: rollback } : {}), requiresSignIn: true };
    } catch (error) { if (swapping) await rollbackRestore(profileDir); throw error; }
    finally { await fs.rm(staging, { recursive: true, force: true }); }
  });
}

export function shellCompletion(shell: 'bash' | 'zsh' | 'fish' | 'powershell'): string {
  const commands = 'login auth vault engines models local-models auxiliary-models providers devices chat attach tasks resources teammates teammate-models routines schedules projects worktrees plugins plugin-market libraries skills mcp channels memory contacts shares provider-groups requests config service desktop status browser doctor backup restore completion update storage profiles terminal ssh files serve';
  if (shell === 'powershell') return `Register-ArgumentCompleter -Native -CommandName cindy -ScriptBlock {\n  param($wordToComplete, $commandAst, $cursorPosition)\n  '${commands} --profile --state-dir --lang --json --help'.Split(' ') | Where-Object { $_.StartsWith($wordToComplete, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }\n}\n`;
  if (shell === 'fish') return `complete -c cindy -f -a '${commands}'\ncomplete -c cindy -l profile -r\ncomplete -c cindy -l state-dir -r\ncomplete -c cindy -l lang -xa 'en zh-CN zh-TW ja ko'\n`;
  if (shell === 'zsh') return `#compdef cindy\n_arguments '1:command:(${commands})' '--profile[Profile name]:profile:' '--state-dir[Profile directory]:directory:_files -/' '--lang[Language]:locale:(en zh-CN zh-TW ja ko)' '*:argument:_files'\n`;
  if (shell === 'bash') return `_cindy_complete() { local cur="\${COMP_WORDS[COMP_CWORD]}"; COMPREPLY=($(compgen -W '${commands} --profile --state-dir --lang --json --help' -- "$cur")); }\ncomplete -F _cindy_complete cindy\n`;
  throw new Error('UNSUPPORTED_SHELL');
}

/** Explicit verified-artifact install/update. There is no claimed cloud update
 * feed: a publisher must distribute the matching .sha256 alongside the archive.
 * Immutable releases plus a small atomic launcher never replace Cindy GUI. */
export async function installTerminalPackage(archive: string, sha256: string, installRoot: string): Promise<{ version: string; launcher: string; previousRelease?: string }> {
  if (!path.isAbsolute(installRoot) || !/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('TERMINAL_PACKAGE_ARGUMENT_INVALID');
  await fs.mkdir(path.dirname(installRoot), { recursive: true, mode: 0o700 });
  const lock = path.join(path.dirname(installRoot), `.cindy-terminal-install-${createHash('sha256').update(path.resolve(installRoot)).digest('hex').slice(0, 24)}.lock`);
  return withCrossProcessLock(lock, { label: 'terminal package installation' }, async state => {
    if (!state.held) throw new Error('TERMINAL_INSTALL_BUSY');
    return installTerminalPackageLocked(archive, sha256, installRoot);
  });
}

async function installTerminalPackageLocked(archive: string, sha256: string, installRoot: string): Promise<{ version: string; launcher: string; previousRelease?: string }> {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== sha256.toLowerCase()) throw new Error('TERMINAL_PACKAGE_CHECKSUM_MISMATCH');
  const existing = await fs.lstat(installRoot).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('NOT_A_TERMINAL_INSTALLATION');
  const marker = path.join(installRoot, '.cindy-terminal-installation');
  const known = await readPrivateFile(marker);
  if (known && known.toString() !== 'cindy-terminal:1') throw new Error('NOT_A_TERMINAL_INSTALLATION');
  if (!known && existing && (await fs.readdir(installRoot)).length) throw new Error('TERMINAL_INSTALL_DIRECTORY_NOT_EMPTY');
  await privateDirectory(installRoot);
  const stage = path.join(installRoot, `.package-${randomUUID()}`); await privateDirectory(stage);
  try {
    await extractEngineArchive(archive, stage, 'tar.gz');
    const entries = await fs.readdir(stage, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0]!.isDirectory()) throw new Error('TERMINAL_PACKAGE_LAYOUT_INVALID');
    const root = path.join(stage, entries[0]!.name);
    const metadata = JSON.parse(await fs.readFile(path.join(root, 'runtime-manifest.json'), 'utf8'));
    const app = JSON.parse(await fs.readFile(path.join(root, 'app/package.json'), 'utf8'));
    if (app.name !== 'cindy-terminal' || metadata.target !== `${process.platform}-${process.arch}` || !/^[\w.+-]+$/.test(metadata.version)) throw new Error('TERMINAL_PACKAGE_INCOMPATIBLE');
    const node = path.join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
    const smokeHome = path.join(stage, '.smoke-home'); await privateDirectory(smokeHome);
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
    const test = await runNative(node, [path.join(root, 'app/dist/cli.js'), '--version'], { cwd: smokeHome, env: { ...env, HOME: smokeHome, USERPROFILE: smokeHome, LOCALAPPDATA: smokeHome, APPDATA: smokeHome, XDG_CONFIG_HOME: smokeHome, XDG_STATE_HOME: smokeHome, NODE_OPTIONS: '', NODE_PATH: '' } });
    if (test.code || test.stdout.trim() !== metadata.version) throw new Error('TERMINAL_PACKAGE_START_FAILED');
    const release = `${metadata.version}-${sha256.slice(0, 16)}`;
    const releases = path.join(installRoot, 'releases'); await privateDirectory(releases);
    const target = path.join(releases, release);
    if (await fs.lstat(target).catch(() => null)) throw new Error('TERMINAL_PACKAGE_ALREADY_INSTALLED');
    await atomicPrivateWrite(path.join(root, 'installation.json'), JSON.stringify({ version: metadata.version, release, sha256 }));
    await fs.rename(root, target);
    const receipt = path.join(installRoot, 'current.json');
    const previous = await readPrivateFile(receipt);
    const launcher = path.join(installRoot, process.platform === 'win32' ? 'cindy.cmd' : 'cindy');
    const script = process.platform === 'win32'
      ? `@echo off\r\n"%~dp0releases\\${release}\\runtime\\node.exe" "%~dp0releases\\${release}\\app\\dist\\cli.js" %*\r\n`
      : `#!/bin/sh\nCINDY_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$CINDY_ROOT/releases/${release}/runtime/node" "$CINDY_ROOT/releases/${release}/app/dist/cli.js" "$@"\n`;
    await atomicPrivateWrite(marker, 'cindy-terminal:1');
    await atomicPrivateWrite(receipt, JSON.stringify({ version: metadata.version, release, sha256, ...(previous ? { previousRelease: JSON.parse(previous.toString()).release } : {}) }));
    try {
      const temporaryLauncher = `${launcher}.${randomUUID()}.tmp`;
      try {
        const file = await fs.open(temporaryLauncher, 'wx', 0o700);
        try { await file.writeFile(script); await file.sync(); } finally { await file.close(); }
        await fs.rename(temporaryLauncher, launcher);
      } finally { await fs.rm(temporaryLauncher, { force: true }); }
    }
    catch (error) { if (previous) await atomicPrivateWrite(receipt, previous); else await fs.rm(receipt, { force: true }); throw error; }
    return { version: metadata.version, launcher, ...(previous ? { previousRelease: JSON.parse(previous.toString()).release } : {}) };
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

interface InstallationReceipt { version: string; release: string; sha256: string; previousRelease?: string }
const RELEASE_NAME = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,180}$/;
async function installationReceipt(installRoot: string): Promise<InstallationReceipt | null> {
  if (!path.isAbsolute(installRoot) || path.resolve(installRoot) !== installRoot) throw new Error('TERMINAL_PACKAGE_ARGUMENT_INVALID');
  const stat = await fs.lstat(installRoot).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('NOT_A_TERMINAL_INSTALLATION');
  const marker = await readPrivateFile(path.join(installRoot, '.cindy-terminal-installation'));
  if (marker?.toString() !== 'cindy-terminal:1') throw new Error('NOT_A_TERMINAL_INSTALLATION');
  const raw = await readPrivateFile(path.join(installRoot, 'current.json'));
  if (!raw) return null;
  const receipt = JSON.parse(raw.toString()) as InstallationReceipt;
  if (!RELEASE_NAME.test(receipt.release) || !/^[a-f0-9]{64}$/i.test(receipt.sha256) || typeof receipt.version !== 'string' || receipt.previousRelease !== undefined && !RELEASE_NAME.test(receipt.previousRelease)) throw new Error('TERMINAL_INSTALL_RECEIPT_INVALID');
  return receipt;
}

export async function terminalInstallationStatus(installRoot: string): Promise<{ installed: boolean; current?: InstallationReceipt; releases: string[] }> {
  const current = await installationReceipt(installRoot);
  if (!current) return { installed: false, releases: [] };
  const entries = await fs.readdir(path.join(installRoot, 'releases'), { withFileTypes: true });
  return { installed: true, current, releases: entries.filter(entry => entry.isDirectory() && RELEASE_NAME.test(entry.name)).map(entry => entry.name).sort() };
}

export interface TerminalReleaseManifest { product: 'cindy-terminal'; format: 1; version: string; target: string; url: string; sha256: string }
function versionParts(value: string): { core: number[]; pre: string[] } {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) throw new Error('TERMINAL_RELEASE_VERSION_INVALID');
  return { core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? [] };
}
function compareVersions(left: string, right: string): number {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return Math.sign(a.core[i] - b.core[i]);
  if (!a.pre.length || !b.pre.length) return Math.sign(b.pre.length - a.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined || b.pre[i] === undefined) return a.pre[i] === undefined ? -1 : 1;
    if (a.pre[i] === b.pre[i]) continue;
    const an = /^\d+$/.test(a.pre[i]), bn = /^\d+$/.test(b.pre[i]);
    if (an && bn) return Math.sign(Number(a.pre[i]) - Number(b.pre[i]));
    if (an !== bn) return an ? -1 : 1;
    return a.pre[i] < b.pre[i] ? -1 : 1;
  }
  return 0;
}

/** The caller explicitly selects a publisher manifest. No undeployed official
 * feed or GUI updater is assumed; checking never downloads executable code. */
export async function checkTerminalUpdate(installRoot: string, manifestUrl: string, fetcher: typeof fetch = fetch): Promise<{ status: 'not-installed' | 'update-available' | 'current' | 'installed-newer'; installedVersion?: string; release: TerminalReleaseManifest }> {
  const url = new URL(manifestUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('TERMINAL_RELEASE_URL_INVALID');
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok || Number(response.headers.get('content-length')) > 64 * 1024 || !response.body) throw new Error('TERMINAL_RELEASE_UNAVAILABLE');
  let size = 0; const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) { size += chunk.length; if (size > 64 * 1024) throw new Error('TERMINAL_RELEASE_TOO_LARGE'); chunks.push(chunk); }
  const release = JSON.parse(Buffer.concat(chunks).toString()) as TerminalReleaseManifest;
  if (release.product !== 'cindy-terminal' || release.format !== 1 || release.target !== `${process.platform}-${process.arch}` || !/^[a-f0-9]{64}$/i.test(release.sha256)) throw new Error('TERMINAL_RELEASE_INVALID');
  versionParts(release.version);
  const artifact = new URL(release.url);
  if (artifact.protocol !== 'https:' || artifact.username || artifact.password || artifact.hash) throw new Error('TERMINAL_RELEASE_URL_INVALID');
  const current = await installationReceipt(installRoot);
  const comparison = current ? compareVersions(release.version, current.version) : 1;
  return { status: !current ? 'not-installed' : comparison > 0 ? 'update-available' : comparison < 0 ? 'installed-newer' : 'current', ...(current ? { installedVersion: current.version } : {}), release };
}

/** Changes only the terminal installation launcher. Running services must be
 * re-registered/restarted by the foreground CLI, which reports that explicitly. */
export async function rollbackTerminalPackage(installRoot: string, requestedRelease?: string): Promise<{ version: string; launcher: string; previousRelease: string; restartRequired: true }> {
  const lock = path.join(path.dirname(installRoot), `.cindy-terminal-install-${createHash('sha256').update(path.resolve(installRoot)).digest('hex').slice(0, 24)}.lock`);
  return withCrossProcessLock(lock, { label: 'terminal package rollback' }, async state => {
    if (!state.held) throw new Error('TERMINAL_INSTALL_BUSY');
    const previous = await installationReceipt(installRoot);
    if (!previous) throw new Error('NOT_A_TERMINAL_INSTALLATION');
    const release = requestedRelease ?? previous.previousRelease;
    if (!release || !RELEASE_NAME.test(release) || release === previous.release) throw new Error('TERMINAL_ROLLBACK_UNAVAILABLE');
    const root = path.join(installRoot, 'releases', release);
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('TERMINAL_PACKAGE_LAYOUT_INVALID');
    const metadata = JSON.parse(await fs.readFile(path.join(root, 'runtime-manifest.json'), 'utf8'));
    const app = JSON.parse(await fs.readFile(path.join(root, 'app/package.json'), 'utf8'));
    if (app.name !== 'cindy-terminal' || metadata.target !== `${process.platform}-${process.arch}` || !/^[\w.+-]+$/.test(metadata.version) || !release.startsWith(`${metadata.version}-`)) throw new Error('TERMINAL_PACKAGE_INCOMPATIBLE');
    const node = path.join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-rollback-check-')); await privateDirectory(temporary);
    try {
      const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
      const test = await runNative(node, [path.join(root, 'app/dist/cli.js'), '--version'], { cwd: temporary, env: { ...env, HOME: temporary, USERPROFILE: temporary, APPDATA: temporary, LOCALAPPDATA: temporary, NODE_OPTIONS: '', NODE_PATH: '' } });
      if (test.code || test.stdout.trim() !== metadata.version) throw new Error('TERMINAL_PACKAGE_START_FAILED');
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    const launcher = path.join(installRoot, process.platform === 'win32' ? 'cindy.cmd' : 'cindy');
    const script = process.platform === 'win32'
      ? `@echo off\r\n"%~dp0releases\\${release}\\runtime\\node.exe" "%~dp0releases\\${release}\\app\\dist\\cli.js" %*\r\n`
      : `#!/bin/sh\nCINDY_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$CINDY_ROOT/releases/${release}/runtime/node" "$CINDY_ROOT/releases/${release}/app/dist/cli.js" "$@"\n`;
    const history = await readPrivateFile(path.join(root, 'installation.json'));
    if (!history) throw new Error('TERMINAL_ROLLBACK_RECEIPT_UNAVAILABLE');
    const recorded = JSON.parse(history.toString()) as InstallationReceipt;
    if (recorded.release !== release || recorded.version !== metadata.version || !/^[a-f0-9]{64}$/i.test(recorded.sha256)) throw new Error('TERMINAL_INSTALL_RECEIPT_INVALID');
    const receipt = { ...recorded, previousRelease: previous.release };
    const oldReceipt = await readPrivateFile(path.join(installRoot, 'current.json'));
    await atomicPrivateWrite(path.join(installRoot, 'current.json'), JSON.stringify(receipt));
    try {
      await atomicPrivateWrite(launcher, script); if (process.platform !== 'win32') await fs.chmod(launcher, 0o700);
    } catch (error) { if (oldReceipt) await atomicPrivateWrite(path.join(installRoot, 'current.json'), oldReceipt); throw error; }
    return { version: metadata.version, launcher, previousRelease: previous.release, restartRequired: true };
  });
}

export async function profileStorage(profileDir: string): Promise<{ bytes: number; files: number; symlinks: number; categories: Record<string, number> }> {
  const result = { bytes: 0, files: 0, symlinks: 0, categories: {} as Record<string, number> };
  const stat = await fs.lstat(profileDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UNSAFE_PROFILE_DIRECTORY');
  const visit = async (file: string, category: string): Promise<void> => {
    const info = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return;
    if (info.isSymbolicLink()) { result.symlinks++; return; }
    if (info.isDirectory()) { for (const name of await fs.readdir(file)) await visit(path.join(file, name), category); return; }
    if (info.isFile()) { result.bytes += info.size; result.files++; result.categories[category] = (result.categories[category] ?? 0) + info.size; }
  };
  for (const name of await fs.readdir(profileDir)) await visit(path.join(profileDir, name), name === 'owners' ? 'user-data' : name === 'engine-binaries' ? 'engines' : 'host-state');
  return result;
}

export async function listTerminalProfiles(directory = path.dirname(profilePath())): Promise<Array<{ name: string; path: string }>> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const result: Array<{ name: string; path: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.name)) continue;
    const location = path.join(directory, entry.name);
    if (await readPrivateFile(path.join(location, 'settings.json'))) result.push({ name: entry.name, path: location });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

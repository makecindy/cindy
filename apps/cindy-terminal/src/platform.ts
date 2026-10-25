import { RUNTIME_DIRECTORY } from './version.js';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync, readFileSync, fstatSync, lstatSync } from 'node:fs';
import { restrictWindowsDirectory } from './windows-acl.js';
export { VERSION } from './version.js';
export const runtimeResourcesDirectory = () => path.join(RUNTIME_DIRECTORY,'resources');

/** Git Bash ships a different whoami.exe. OS management must not depend on
 * whichever Unix compatibility utilities appear first in the interactive PATH. */
export function windowsSystemCommand(name:'whoami'|'schtasks'|'powershell',env:NodeJS.ProcessEnv=process.env):string {
  const root=env.SystemRoot||env.SYSTEMROOT||env.WINDIR||'C:\\Windows';
  if(!path.win32.isAbsolute(root)||/[\r\n\0]/.test(root))throw new Error('WINDOWS_SYSTEM_ROOT_INVALID');
  return path.win32.join(root,'System32',name==='powershell'?'WindowsPowerShell\\v1.0\\powershell.exe':`${name}.exe`);
}

/** Windows PowerShell 5 must rebuild its own module search path. Inheriting
 * PowerShell 7's PSModulePath can load incompatible Security module assemblies. */
export function windowsPowerShellEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
}

/** Kept outside the profile so a stopped-profile restore can swap directories
 * without dropping the same lock used by daemon startup. */
export function profileLifecycleLockPath(profileDir: string): string {
  const hash = createHash('sha256').update(path.resolve(profileDir)).digest('hex').slice(0, 24);
  return path.join(path.dirname(profileDir), `.cindy-profile-${hash}.lock`);
}

export function profilePath(name = 'default', env: NodeJS.ProcessEnv = process.env): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error('INVALID_PROFILE');
  const home = os.homedir();
  const base = process.platform === 'win32'
    ? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  if (!path.isAbsolute(base)) throw new Error('PROFILE_ROOT_MUST_BE_ABSOLUTE');
  return path.join(base, 'CindyTerminal', 'profiles', name);
}

export function socketPath(profileDir: string): string {
  const hash = createHash('sha256').update(profileDir).digest('hex').slice(0, 24);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\cindy-terminal-${hash}`
    : path.join(os.tmpdir(), `cindy-${hash.slice(0, 12)}`, 'rpc.sock');
}

/** Create a private app-owned directory before storing any credential material. */
export async function privateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UNSAFE_PROFILE_DIRECTORY');
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('PROFILE_OWNER_MISMATCH');
    await fs.chmod(directory, 0o700);
    return;
  }
  await restrictWindowsDirectory(path.resolve(directory), windowsSystemCommand('powershell'), windowsPowerShellEnv());
}

export async function readPrivateFile(file: string): Promise<Buffer | null> {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      const link = await fs.lstat(file);
      if (!stat.isFile() || link.isSymbolicLink() || link.ino !== stat.ino) throw new Error('UNSAFE_PRIVATE_FILE');
      if (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) throw new Error('PRIVATE_FILE_PERMISSIONS');
      if (stat.size > 16 * 1024 * 1024) throw new Error('PRIVATE_FILE_TOO_LARGE');
      return await handle.readFile();
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function atomicPrivateWrite(file: string, data: string | Buffer): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    try { await handle.writeFile(data); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temp, file);
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
  finally { await fs.rm(temp, { force: true }); }
}

/** Synchronous counterpart for shared registries whose read-modify-write is
 * already protected by a cross-process lock. Same private-file read boundary. */
export function readPrivateFileSync(file: string): Buffer | null {
  try {
    const handle = openSync(file, 'r');
    try {
      const stat = fstatSync(handle), link = lstatSync(file);
      if (!stat.isFile() || link.isSymbolicLink() || link.ino !== stat.ino) throw new Error('UNSAFE_PRIVATE_FILE');
      if (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) throw new Error('PRIVATE_FILE_PERMISSIONS');
      if (stat.size > 16 * 1024 * 1024) throw new Error('PRIVATE_FILE_TOO_LARGE');
      return readFileSync(handle);
    } finally { closeSync(handle); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Synchronous transaction boundary for the shared plugin credential managers.
 * Same private-file and durable rename contract as atomicPrivateWrite. */
export function atomicPrivateWriteSync(file: string, data: string | Buffer): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = openSync(temp, 'wx', 0o600);
  try {
    try { writeFileSync(handle, data); fsyncSync(handle); }
    finally { closeSync(handle); }
    renameSync(temp, file);
    if (process.platform !== 'win32') {
      const directory = openSync(path.dirname(file), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally { rmSync(temp, { force: true }); }
}

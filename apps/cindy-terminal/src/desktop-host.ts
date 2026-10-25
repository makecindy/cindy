import path from 'node:path';
import { constants } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import { RUNTIME_DIRECTORY } from './version.js';
import type { TerminalHostCommand } from './host-command.js';

/** Installed beside this distribution; never searches PATH or starts another
 * Cindy installation. Remote RPC and profile settings cannot choose this path. */
export async function desktopHostCommand(directory = RUNTIME_DIRECTORY): Promise<TerminalHostCommand> {
  let manifest: { version: number; platform: string; arch: string; executable: string };
  try { manifest = JSON.parse(await readFile(path.join(directory, 'desktop-host.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('DESKTOP_COMPONENT_NOT_INSTALLED');
    throw new Error('DESKTOP_COMPONENT_INVALID');
  }
  if (manifest?.version !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch
    || typeof manifest.executable !== 'string' || !manifest.executable.startsWith('platform/')
    || manifest.executable.includes('\\') || manifest.executable.split('/').some(part => !part || part === '.' || part === '..')
    || /[\r\n\0]/.test(manifest.executable)) throw new Error('DESKTOP_COMPONENT_INVALID');
  const root = await realpath(path.resolve(directory, '../..'));
  const executable = await realpath(path.join(root, manifest.executable));
  if (!executable.startsWith(root + path.sep)) throw new Error('DESKTOP_COMPONENT_INVALID');
  await access(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
  return { executable, args: [] };
}

import { app } from 'electron';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export function linuxCredentialCommand(directory?: string): { file: string; args: string[] } {
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'tools', 'remote-desktop', 'linux-credentials', 'main.py')
    : path.join(app.getAppPath(), 'native', 'remote-desktop', 'linux-credentials', 'main.py');
  return {
    file: '/usr/bin/python3',
    args: [
      '-I',
      '-B',
      '-u',
      script,
      ...(directory
        ? ['--serve', directory, String(process.pid), process.execPath]
        : ['--lock-state']),
    ],
  };
}

/** Read-only probe: no keyring access, password prompt or lock-screen mutation. */
export async function readLinuxUnlockState(): Promise<'locked' | 'unlocked' | 'unavailable'> {
  if (process.platform !== 'linux') return 'unavailable';
  try {
    const command = linuxCredentialCommand();
    const { stdout } = await exec(command.file, command.args, { timeout: 6000, maxBuffer: 1024 });
    const state = stdout.trim();
    return state === 'locked' || state === 'unlocked' ? state : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

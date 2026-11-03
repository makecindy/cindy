import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { installedTool } from '../managed-tools/installer.js';
import { ghArtifact } from './ghArtifact.js';

let managedRoot: string | undefined;
export function configureManagedGhRoot(root: string): void {
  managedRoot = root;
}

export function systemGhBinary(
  platform: string = process.platform,
  exists: (candidate: string) => boolean = existsSync,
  home = homedir(),
): string {
  const candidates: Record<string, string[]> = {
    darwin: ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', path.join(home, '.local/bin/gh')],
    linux: [
      '/usr/bin/gh',
      '/usr/local/bin/gh',
      '/home/linuxbrew/.linuxbrew/bin/gh',
      path.join(home, '.local/bin/gh'),
    ],
    win32: [
      'C:\\Program Files\\GitHub CLI\\gh.exe',
      'C:\\Program Files (x86)\\GitHub CLI\\gh.exe',
      path.join(home, '.local', 'bin', 'gh.exe'),
    ],
  };
  return candidates[platform]?.find(exists) ?? (platform === 'win32' ? 'gh.exe' : 'gh');
}

export async function resolveGhBinary(): Promise<string> {
  const artifact = ghArtifact(process.platform, process.arch);
  if (managedRoot && artifact) {
    const installed = await installedTool(managedRoot, artifact);
    if (installed) return installed;
  }
  return systemGhBinary();
}

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { installedTool } from '../managed-tools/installed.js';
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

/**
 * Tasks, schedule pre-run checks and script schedules run `gh` by name and inherit
 * process.env, so a copy only Cindy can locate is invisible to them. Append the
 * managed copy's directory last: a gh the user installed keeps precedence. A newer
 * managed generation replaces the entry left by the previous one.
 */
export function exposeManagedGhOnPath(
  root: string,
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const key =
    Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ??
    (platform === 'win32' ? 'Path' : 'PATH');
  const directory = paths.dirname(executable);
  const previousGenerations = paths.join(root, 'tools', 'gh-');
  const raw = env[key] ?? '';
  // An empty PATH stays without an implicit current-directory entry.
  const entries = (raw === '' ? [] : raw.split(paths.delimiter)).filter(
    (entry) => entry === directory || !entry.startsWith(previousGenerations),
  );
  if (!entries.includes(directory)) entries.push(directory);
  env[key] = entries.join(paths.delimiter);
}

/** Exposes an already installed managed gh; does nothing when Cindy never installed one. */
export async function exposeInstalledManagedGh(): Promise<void> {
  const artifact = ghArtifact(process.platform, process.arch);
  if (!managedRoot || !artifact) return;
  const installed = await installedTool(managedRoot, artifact);
  if (installed) exposeManagedGhOnPath(managedRoot, installed);
}

export async function resolveGhBinary(): Promise<string> {
  const artifact = ghArtifact(process.platform, process.arch);
  if (managedRoot && artifact) {
    const installed = await installedTool(managedRoot, artifact);
    if (installed) return installed;
  }
  return systemGhBinary();
}

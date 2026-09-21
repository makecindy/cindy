import fs from 'node:fs';

/** Finder-launched processes may retain a minimal PATH when shell startup fails. */
export function ensureMacPackageManagerPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isDirectory: (directory: string) => boolean = (directory) => {
    try { return fs.statSync(directory).isDirectory(); } catch { return false; }
  },
): void {
  if (platform !== 'darwin') return;
  const current = env.PATH?.split(':') ?? [];
  // Keep the user's existing version-manager order. These are fallback locations,
  // not replacements for a successfully recovered shell PATH.
  for (const directory of ['/opt/homebrew/bin', '/usr/local/bin']) {
    if (!current.includes(directory) && isDirectory(directory)) current.push(directory);
  }
  if (current.length) env.PATH = current.join(':');
}

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Same identity as register-desktop.sh, stable across releases and valid for
 * portals requiring reverse-DNS application IDs. This does not rename the app
 * or its keyring identity.
 */
export function linuxUserDesktopName(prefix: string): string {
  return `com.xd.cindy.user.h${createHash('sha256').update(prefix).digest('hex').slice(0, 16)}.desktop`;
}

/** Only our marked, user-owned release layout is eligible for unprivileged
 * self-update. A writable arbitrary directory is not an installation contract.
 */
export interface LinuxUserInstallation {
  prefix: string;
  current: string;
  region: 'global' | 'cn';
}

/** Recognize the stable desktop identity without requiring update access. */
export function recognizeLinuxUserInstallation(
  exePath: string, home: string, uid: number,
): LinuxUserInstallation | null {
  try {
    const exe = fs.realpathSync(exePath);
    const release = path.dirname(exe);
    const prefix = path.dirname(path.dirname(release));
    const relative = path.relative(fs.realpathSync(home), prefix);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return null;
    if (path.basename(exe) !== 'Cindy' || path.basename(path.dirname(release)) !== 'releases') return null;
    const markerPath = path.join(prefix, '.cindy-user-install');
    const marker = fs.lstatSync(markerPath);
    if (!marker.isFile() || marker.uid !== uid || fs.statSync(prefix).uid !== uid) return null;
    const identity = fs.readFileSync(markerPath, 'utf8').trim();
    const region = identity === 'cindy-user-install-v1:global' ? 'global'
      : identity === 'cindy-user-install-v1:cn' ? 'cn' : null;
    if (!region) return null;
    const current = fs.readlinkSync(path.join(prefix, 'current'));
    if (!/^releases\/[A-Za-z0-9.+-]+$/.test(current)) return null;
    if (fs.realpathSync(path.join(prefix, current)) !== release) return null;
    return { prefix, current, region };
  } catch { return null; }
}

/** Strict preflight for self-update, checked again before stopping work. */
export function findLinuxUserInstallation(
  exePath: string, home: string, uid: number,
): LinuxUserInstallation | null {
  const installation = recognizeLinuxUserInstallation(exePath, home, uid);
  if (!installation) return null;
  const { prefix } = installation;
  try {
    // Check the paths the installer actually writes before stopping active
    // work. A writable prefix alone says nothing about staging or flock.
    const releasesPath = path.join(prefix, 'releases');
    const releases = fs.lstatSync(releasesPath);
    if (!releases.isDirectory() || releases.uid !== uid) return null;
    fs.accessSync(prefix, fs.constants.W_OK | fs.constants.X_OK);
    fs.accessSync(releasesPath, fs.constants.W_OK | fs.constants.X_OK);
    for (const name of ['.install.lock', 'previous']) {
      const entryPath = path.join(prefix, name);
      let entry: fs.Stats;
      try { entry = fs.lstatSync(entryPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (name === '.install.lock') {
        if (!entry.isFile() || entry.uid !== uid) return null;
        fs.accessSync(entryPath, fs.constants.W_OK);
      } else if (!entry.isSymbolicLink()) return null;
    }
    return installation;
  } catch { return null; }
}

/** Query ownership, not just tool existence: dpkg installed on Arch must not
 * cause us to install a second Cindy while relaunching a pacman-owned binary.
 */
export type DebianManagedInstallationCheck =
  | { status: 'managed' }
  | { status: 'not-managed' }
  | { status: 'error'; error: unknown };

/** Confirmed non-ownership, not a retryable probe failure.
 * - dpkg-query -S exits 1 when no package owns the path.
 * - spawn ENOENT means /usr/bin/dpkg-query is absent (Arch and other
 *   non-Debian systems). That must keep the unsupported-install block.
 * Timeouts and exit 2 (database or usage faults) stay errors.
 */
function isConfirmedDebianOwnershipMiss(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const details = error as { status?: unknown; signal?: unknown; code?: unknown; killed?: unknown };
  if (details.killed === true || details.signal != null) return false;
  // execFileSync sets status null when the binary itself cannot be spawned.
  if (details.code === 'ENOENT' && details.status == null) return true;
  if (typeof details.code === 'string' && details.code.length > 0) return false;
  return details.status === 1;
}

export function checkDebianManagedInstallation(
  exePath: string,
  query: (exe: string) => string = (exe) => execFileSync('/usr/bin/dpkg-query', ['-S', exe], {
    encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
  }),
): DebianManagedInstallationCheck {
  try {
    const managed = query(exePath).split('\n').some((line) => /^cindy(?::[a-z0-9]+)?: /.test(line)
      && line.slice(line.indexOf(': ') + 2) === exePath);
    return managed ? { status: 'managed' } : { status: 'not-managed' };
  } catch (error) {
    if (isConfirmedDebianOwnershipMiss(error)) return { status: 'not-managed' };
    return { status: 'error', error };
  }
}

/** Compatibility predicate for callers that only need a confirmed yes/no. */
export function isDebianManagedInstallation(
  exePath: string,
  query?: (exe: string) => string,
): boolean {
  return checkDebianManagedInstallation(exePath, query).status === 'managed';
}

export function missingLinuxUserInstallTools(
  probe: (name: string) => boolean = (name) => {
    try {
      execFileSync('/bin/bash', ['-c', 'command -v -- "$1" >/dev/null', 'cindy-probe', name], {
        timeout: 2000, stdio: 'ignore',
      });
      return true;
    } catch { return false; }
  },
): string[] {
  return ['bsdtar', 'sha256sum', 'stat', 'dd', 'mktemp', 'realpath', 'flock', 'find', 'readlink', 'mv', 'ln', 'setsid', 'pgrep']
    .filter((name) => !probe(name));
}

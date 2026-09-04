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

export function findLinuxUserInstallation(
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
    fs.accessSync(prefix, fs.constants.W_OK);
    return { prefix, current, region };
  } catch { return null; }
}

/** Query ownership, not just tool existence: dpkg installed on Arch must not
 * cause us to install a second Cindy while relaunching a pacman-owned binary.
 */
export function isDebianManagedInstallation(
  exePath: string,
  query: (exe: string) => string = (exe) => execFileSync('/usr/bin/dpkg-query', ['-S', exe], {
    encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
  }),
): boolean {
  try {
    return query(exePath).split('\n').some((line) => /^cindy(?::[a-z0-9]+)?: /.test(line)
      && line.slice(line.indexOf(': ') + 2) === exePath);
  } catch { return false; }
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

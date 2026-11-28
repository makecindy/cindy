import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Read compositor lock ownership, not logind's advisory LockedHint. Mirrors the
 * credential helper's session probe without requiring an unlock-capable locker. */
export async function isLinuxDesktopUnlocked(): Promise<boolean> {
  try {
    const { stdout } = await exec('/usr/bin/hyprctl', ['-j', 'monitors'], {
      timeout: 1000,
      maxBuffer: 128000,
    });
    const monitors: unknown = JSON.parse(stdout);
    if (!Array.isArray(monitors) || !monitors.length || monitors.length > 32) return false;
    const blockers = monitors.map((monitor) => monitor?.solitaryBlockedBy);
    return (
      blockers.every(
        (items) => Array.isArray(items) && items.every((item) => typeof item === 'string'),
      ) &&
      !blockers.some((items) => items.includes('LOCK')) &&
      blockers.some((items) => !items.includes('WORKSPACE'))
    );
  } catch {
    return false;
  }
}

/** Verify a systemd-logind graphical session is owned by this user and unlocked.
 * Seated sessions also require Active=yes to catch VT-switching lockers such as
 * light-locker. Fails closed on missing, invalid or unreadable session state. */
export async function isLogindSessionUnlocked(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const session = env.XDG_SESSION_ID ?? '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(session)) return false;
  try {
    const { stdout } = await exec(
      '/usr/bin/loginctl',
      ['show-session', session, '-p', 'User', '-p', 'Seat', '-p', 'Active', '-p', 'LockedHint'],
      { timeout: 1000, maxBuffer: 4096 },
    );
    const props = new Map<string, string>();
    for (const line of stdout.split(/\r?\n/)) {
      const separator = line.indexOf('=');
      if (separator > 0) props.set(line.slice(0, separator), line.slice(separator + 1));
    }
    const uid = typeof process.getuid === 'function' ? String(process.getuid()) : null;
    if (uid !== null && props.get('User') !== uid) return false;
    if (props.get('LockedHint') !== 'no') return false;
    if (props.get('Seat') && props.get('Active') !== 'yes') return false;
    return true;
  } catch {
    return false;
  }
}

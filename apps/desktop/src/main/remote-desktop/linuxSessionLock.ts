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

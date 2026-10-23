import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** `unknown` is every platform or failure where the answer cannot be read; callers treat it as "not locked". */
export type ScreenLockState = 'locked' | 'unlocked' | 'unknown';

export type ScreenLockExec = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

const IOREG = '/usr/sbin/ioreg';
const IOREG_ARGS = ['-n', 'Root', '-d1', '-a'];
const LOCKED_KEY = /<key>CGSSessionScreenIsLocked<\/key>\s*<(true|false)\s*\/>/;

/**
 * Whether the console session's screen is locked. macOS publishes the same flag as
 * `CGSessionCopyCurrentDictionary()["CGSSessionScreenIsLocked"]` in the IORegistry root
 * (`IOConsoleUsers`), so it is read with the system `ioreg` — no native module, and unlike
 * `powerMonitor.getSystemIdleState` (reports `idle`, never `locked`) or the `lock-screen` event
 * (not observed to fire) it is correct at any moment. The key is absent while nobody holds a
 * console session, which is also not "locked". Other platforms and any read failure are `unknown`.
 */
export async function readScreenLockState(
  options: { platform?: NodeJS.Platform; exec?: ScreenLockExec } = {},
): Promise<ScreenLockState> {
  if ((options.platform ?? process.platform) !== 'darwin') return 'unknown';
  try {
    const { stdout } = await (options.exec ?? execFileAsync)(IOREG, IOREG_ARGS, {
      timeout: 2000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const match = LOCKED_KEY.exec(stdout);
    if (match) return match[1] === 'true' ? 'locked' : 'unlocked';
    return stdout.includes('IOConsoleUsers') ? 'unlocked' : 'unknown';
  } catch {
    return 'unknown';
  }
}

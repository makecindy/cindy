/**
 * OS-level best-effort hardening for local directories where Cindy or a plugin engine keeps
 * file-backed account sign-ins (for example `owners/<account>/plugin-engine-accounts/` and
 * Cindy-created `~/.claude-cindy-*` / `~/.codex-cindy-*` homes):
 *
 * - POSIX: `0o700` directory permissions (tightened with `chmod` even if pre-existing).
 * - macOS: Time Machine exclusion xattr (`com.apple.metadata:com_apple_backup_excludeItem`) via
 *   `/usr/bin/xattr` (fast, ~5 ms, no admin prompt, verified by `tmutil isexcluded`) plus an empty
 *   `.metadata_never_index` Spotlight marker when `writeMarkers` is enabled.
 * - Cross-platform generic backup tools: standard `CACHEDIR.TAG` marker (Borg, Restic, GNU tar
 *   `--exclude-caches`, etc.) when `writeMarkers` is enabled (only on Cindy-owned wrapper roots,
 *   never inside a third-party CLI's own config root).
 * - Windows: tighten NTFS ACL to current user + SYSTEM + Administrators with inheritance disabled
 *   via `icacls.exe`, and mark the directory not content-indexed (`attrib.exe +I`).
 *
 * All OS-specific metadata steps are best-effort and memoized per directory so they never block or
 * break account login when a tool is unavailable.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveWindowsAclPrincipal } from '../maker-host/codex-auth-link.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';

const execFileP = promisify(execFile);
const log = desktopMakerLogger.child('credential-dir-protection');

export const MACOS_TIME_MACHINE_EXCLUDE_XATTR = 'com.apple.metadata:com_apple_backup_excludeItem';
/** Standard binary plist for `"com.apple.backupd"`, matching what `tmutil addexclusion` writes. */
export const MACOS_TIME_MACHINE_EXCLUDE_PLIST_HEX =
  '62706c69737430305f1011636f6d2e6170706c652e6261636b75706408000000000000010100000000000000010000000000000000000000000000001c';
export const CACHEDIR_TAG_CONTENT =
  'Signature: 8a477f597d28d172789f06886806bc55\n'
  + '# This file is a directory tag created by Cindy to keep local engine account credentials out of backups.\n';

const SYSTEM_SID = '*S-1-5-18';
const ADMINISTRATORS_SID = '*S-1-5-32-544';
const EXEC_TIMEOUT_MS = 5_000;

export type CredentialDirExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide?: boolean },
) => Promise<unknown>;

export interface HardenLocalCredentialDirOptions {
  /**
   * Write non-backup / non-index marker files (`CACHEDIR.TAG`, and `.metadata_never_index` on
   * macOS) inside `dir`. Enable only for Cindy-owned wrapper roots such as
   * `owners/<account>/plugin-engine-accounts/`, not inside third-party CLI config homes.
   */
  writeMarkers?: boolean;
  /** Test seam. */
  platform?: NodeJS.Platform;
  /** Test seam. */
  execFile?: CredentialDirExecFile;
  /** Test seam for Windows ACL principal. */
  principal?: string;
  /** Test seam to bypass the in-process memoization set. */
  skipCache?: boolean;
}

const defaultExecFile: CredentialDirExecFile = (file, args, options) =>
  execFileP(file, [...args], options);

const hardenedDirs = new Set<string>();
const inFlight = new Map<string, Promise<void>>();

function windowsSystem32Exe(name: string): string {
  const root = process.env.SystemRoot?.trim() || process.env.windir?.trim() || 'C:\\Windows';
  return path.win32.join(root, 'System32', name);
}

async function writeMarkerIfMissing(filePath: string, content: string): Promise<boolean> {
  try {
    await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') return true;
    log.warn('writing credential directory exclusion marker failed', {
      error: error instanceof Error ? error.name : typeof error,
    });
    return false;
  }
}

async function applyHardening(
  dir: string,
  writeMarkers: boolean,
  platform: NodeJS.Platform,
  runExecFile: CredentialDirExecFile,
  principalOverride?: string,
): Promise<boolean> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  let allSucceeded = true;

  if (platform !== 'win32') {
    try {
      await fs.chmod(dir, 0o700);
    } catch (error) {
      allSucceeded = false;
      log.warn('tightening POSIX permissions on credential directory failed', {
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  if (writeMarkers) {
    if (!(await writeMarkerIfMissing(path.join(dir, 'CACHEDIR.TAG'), CACHEDIR_TAG_CONTENT))) {
      allSucceeded = false;
    }
    if (platform === 'darwin') {
      if (!(await writeMarkerIfMissing(path.join(dir, '.metadata_never_index'), ''))) {
        allSucceeded = false;
      }
    }
  }

  if (platform === 'darwin') {
    try {
      await runExecFile(
        '/usr/bin/xattr',
        ['-wx', MACOS_TIME_MACHINE_EXCLUDE_XATTR, MACOS_TIME_MACHINE_EXCLUDE_PLIST_HEX, dir],
        { timeout: EXEC_TIMEOUT_MS },
      );
    } catch (error) {
      allSucceeded = false;
      log.warn('setting macOS Time Machine exclusion on credential directory failed', {
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  } else if (platform === 'win32') {
    const principal = principalOverride?.trim() || resolveWindowsAclPrincipal();
    try {
      await runExecFile(
        windowsSystem32Exe('icacls.exe'),
        [
          dir,
          '/inheritance:r',
          '/grant:r',
          `${principal}:(OI)(CI)F`,
          `${SYSTEM_SID}:(OI)(CI)F`,
          `${ADMINISTRATORS_SID}:(OI)(CI)F`,
        ],
        { timeout: EXEC_TIMEOUT_MS, windowsHide: true },
      );
    } catch (error) {
      allSucceeded = false;
      log.warn('tightening Windows ACL on credential directory failed', {
        error: error instanceof Error ? error.name : typeof error,
      });
    }
    try {
      await runExecFile(
        windowsSystem32Exe('attrib.exe'),
        ['+I', dir],
        { timeout: EXEC_TIMEOUT_MS, windowsHide: true },
      );
    } catch (error) {
      allSucceeded = false;
      log.warn('marking Windows credential directory not content-indexed failed', {
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  return allSucceeded;
}

export async function hardenLocalCredentialDirectory(
  dir: string,
  options: HardenLocalCredentialDirOptions = {},
): Promise<void> {
  const writeMarkers = options.writeMarkers === true;
  const platform = options.platform ?? process.platform;
  const runExecFile = options.execFile ?? defaultExecFile;
  const useCache = !options.skipCache && !options.execFile && options.platform === undefined && options.principal === undefined;
  const cacheKey = `${path.resolve(dir)}|${writeMarkers ? '1' : '0'}`;

  if (useCache && hardenedDirs.has(cacheKey)) {
    // Directory may have been removed (e.g., plugin uninstalled); ensure it still exists.
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return;
  }

  if (useCache) {
    const existing = inFlight.get(cacheKey);
    if (existing) return existing;
  }

  const run = (async () => {
    const ok = await applyHardening(dir, writeMarkers, platform, runExecFile, options.principal);
    if (useCache && ok) hardenedDirs.add(cacheKey);
  })();

  if (useCache) {
    inFlight.set(cacheKey, run);
    try {
      await run;
    } finally {
      if (inFlight.get(cacheKey) === run) inFlight.delete(cacheKey);
    }
    return;
  }
  await run;
}

/** Test seam: clear memoized directories. */
export function resetLocalCredentialDirHardeningCacheForTests(): void {
  hardenedDirs.clear();
  inFlight.clear();
}

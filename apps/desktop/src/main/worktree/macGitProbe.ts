import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const APPLE_GIT = '/usr/bin/git';
const DEFAULT_PATH = '/usr/bin:/bin';
const DEVELOPER_TOOLS_CACHE_MS = 5_000;
let developerToolsCheck: {
  developerDir: string | undefined;
  expiresAt: number;
  available: Promise<boolean>;
} | undefined;

function hasDeveloperTools(env: NodeJS.ProcessEnv): Promise<boolean> {
  const developerDir = env.DEVELOPER_DIR;
  const now = performance.now();
  if (developerToolsCheck && developerToolsCheck.developerDir === developerDir && developerToolsCheck.expiresAt > now) {
    return developerToolsCheck.available;
  }

  // xcode-select -p only reads the selection. Even git --version can launch
  // Apple's installer if invoked through the stub without developer tools.
  const available = new Promise<boolean>((resolve) => {
    execFile('/usr/bin/xcode-select', ['-p'], { env, timeout: 1_000 }, (error, stdout) => {
      resolve(!error && stdout.trim().length > 0);
    });
  });
  developerToolsCheck = { developerDir, expiresAt: now + DEVELOPER_TOOLS_CACHE_MS, available };
  return available;
}

/** Return null if starting the selected Git could open the installer. */
export async function resolveMacGitProbe(
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string | null | undefined> {
  for (const directory of (env.PATH ?? DEFAULT_PATH).split(path.posix.delimiter)) {
    // Relative PATH entries are resolved in the child cwd. Preserve symlink/..
    // components so the filesystem resolves the same path as spawn.
    const candidate = (path.posix.isAbsolute(directory)
      ? [directory, 'git']
      : [path.posix.resolve(cwd ?? process.cwd()), directory, 'git']
    ).filter(Boolean).join(path.posix.sep);
    let executable: string;
    try {
      await fs.access(candidate, constants.X_OK);
      if (!(await fs.stat(candidate)).isFile()) continue;
      executable = await fs.realpath(candidate);
    } catch {
      continue;
    }
    if (executable === APPLE_GIT && !(await hasDeveloperTools(env))) return null;
    // Retain the PATH spelling for independent Git binaries and wrappers.
    return candidate;
  }
  // Preserve spawn's error when Git cannot be resolved from PATH.
  return undefined;
}

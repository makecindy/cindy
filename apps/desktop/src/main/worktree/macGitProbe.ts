import { execFile } from 'node:child_process';
import path from 'node:path';

const DEFAULT_PATH = '/usr/bin:/bin';
const DEVELOPER_TOOLS_CACHE_MS = 5_000;
// Shell builtins keep potentially blocked filesystem calls out of Main's
// libuv pool. Arguments are literal paths, and the shell starts no children.
// -ef follows aliases to Apple's stub, like the previous realpath check.
const SELECT_GIT = `
  index=0
  for candidate do
    if [ -x "$candidate" ] && [ -f "$candidate" ]; then
      kind=independent
      if [ "$candidate" -ef /usr/bin/git ]; then kind=apple; fi
      printf '%s %s\\n' "$index" "$kind"
      exit 0
    fi
    index=$((index + 1))
  done
`;
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
  signal: AbortSignal,
): Promise<string | null | undefined> {
  const candidates = (env.PATH ?? DEFAULT_PATH).split(path.posix.delimiter).map((directory) => {
    // Relative PATH entries are resolved in the child cwd. Preserve symlink/..
    // components so the filesystem resolves the same path as spawn.
    return (path.posix.isAbsolute(directory)
      ? [directory, 'git']
      : [path.posix.resolve(cwd ?? process.cwd()), directory, 'git']
    ).filter(Boolean).join(path.posix.sep);
  });

  const selection = await new Promise<string>((resolve, reject) => {
    execFile('/bin/sh', ['-c', SELECT_GIT, 'git-path-probe', ...candidates],
      { signal }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      });
  });
  signal.throwIfAborted();
  if (!selection) return undefined; // Preserve spawn's normal missing-Git error.
  const [index, kind] = selection.split(' ');
  if (kind === 'apple' && !(await hasDeveloperTools(env))) return null;
  return candidates[Number(index)];
}

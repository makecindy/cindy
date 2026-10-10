/** Discover a user-installed native Cursor CLI without installing or invoking a shell. */
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface CursorBinaryDiscoveryDeps {
  platform: NodeJS.Platform;
  home: string;
  pathEnv?: string;
  localAppData?: string;
  executable(candidate: string): boolean;
}
export type CursorBinaryStatus = { installed: true; binaryPath: string } | { installed: false };

export function discoverCursorAgentBinarySync(deps: CursorBinaryDiscoveryDeps = {
  platform: process.platform,
  home: homedir(),
  pathEnv: process.env.PATH,
  localAppData: process.env.LOCALAPPDATA,
  executable: (candidate) => {
    try {
      if (!statSync(candidate).isFile()) return false;
      accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return true;
    } catch { return false; }
  },
}): CursorBinaryStatus {
  const paths = deps.platform === 'win32' ? path.win32 : path.posix;
  // Do not accept .cmd/.bat wrappers: ACP uses shell:false and must never interpolate a command.
  const names = deps.platform === 'win32' ? ['cursor-agent.exe'] : ['cursor-agent'];
  // The official generic `agent` name is accepted only in Cursor's known install roots.
  const officialDirs = [paths.join(deps.home, '.local', 'bin'),
    ...(deps.platform === 'win32' && deps.localAppData && paths.isAbsolute(deps.localAppData)
      ? [paths.join(deps.localAppData, 'cursor-agent')] : [])];
  for (const dir of officialDirs) {
    for (const name of [...names, deps.platform === 'win32' ? 'agent.exe' : 'agent']) {
      const candidate = paths.join(dir, name);
      if (deps.executable(candidate)) return { installed: true, binaryPath: candidate };
    }
  }
  const dirs = (deps.pathEnv ?? '').split(paths.delimiter);
  for (const dir of dirs) {
    // Relative PATH entries must not resolve against an untrusted project working directory.
    if (!paths.isAbsolute(dir)) continue;
    for (const name of names) {
      const candidate = paths.join(dir, name);
      if (deps.executable(candidate)) return { installed: true, binaryPath: candidate };
    }
  }
  return { installed: false };
}

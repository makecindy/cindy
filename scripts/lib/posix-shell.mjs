import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Locate a shell bundled with Git for Windows without falling back to the WSL
 * launcher in System32. Non-Windows callers keep using their normal PATH.
 */
export function resolvePosixShell(
  shellName,
  {
    platform = process.platform,
    env = process.env,
    spawnSyncImpl = spawnSync,
    existsSync = fs.existsSync,
  } = {},
) {
  if (platform !== 'win32') return shellName;

  const winPath = path.win32;
  const executable = `${shellName}.exe`;
  const candidates = [];
  const absoluteEnvDir = (value, fallback = null) => {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized && winPath.isAbsolute(normalized) ? normalized : fallback;
  };
  const probe = spawnSyncImpl('where.exe', ['git.exe'], { encoding: 'utf8' });
  if (probe.status === 0 && typeof probe.stdout === 'string') {
    for (const line of probe.stdout.split(/\r?\n/)) {
      const gitExe = line.trim();
      if (!gitExe) continue;
      candidates.push(winPath.join(winPath.dirname(winPath.dirname(gitExe)), 'bin', executable));
    }
  }

  const programFiles = absoluteEnvDir(env.ProgramFiles, 'C:\\Program Files');
  const programFilesX86 = absoluteEnvDir(env['ProgramFiles(x86)'], 'C:\\Program Files (x86)');
  const localAppData = absoluteEnvDir(env.LOCALAPPDATA);
  candidates.push(
    winPath.join(programFiles, 'Git', 'bin', executable),
    winPath.join(programFilesX86, 'Git', 'bin', executable),
  );
  if (localAppData) {
    candidates.push(winPath.join(localAppData, 'Programs', 'Git', 'bin', executable));
  }
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

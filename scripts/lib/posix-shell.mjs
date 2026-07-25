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
  const probe = spawnSyncImpl('where.exe', ['git.exe'], { encoding: 'utf8' });
  if (probe.status === 0 && typeof probe.stdout === 'string') {
    for (const line of probe.stdout.split(/\r?\n/)) {
      const gitExe = line.trim();
      if (!gitExe) continue;
      candidates.push(winPath.join(winPath.dirname(winPath.dirname(gitExe)), 'bin', executable));
    }
  }

  candidates.push(
    winPath.join(env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', executable),
    winPath.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', executable),
    winPath.join(env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', executable),
  );
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

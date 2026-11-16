import fs from 'node:fs';
import path from 'node:path';

/**
 * Locate a shell bundled with Git for Windows without falling back to the WSL
 * launcher in System32. Non-Windows callers keep using their normal PATH.
 */
export function resolvePosixShell(
  shellName,
  {
    platform = process.platform,
    env = process.env,
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
  // Resolve Git's PATH entries directly: starting where.exe synchronously adds
  // an unbounded process launch to callers such as test fixture initialization.
  // Never search the working directory or use the System32 WSL shell launcher.
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  for (const entry of (pathKey ? env[pathKey] ?? '' : '').split(';')) {
    const directory = absoluteEnvDir(entry.trim().replace(/^"(.*)"$/, '$1'));
    if (!directory || !existsSync(winPath.join(directory, 'git.exe'))) continue;
    candidates.push(winPath.join(winPath.dirname(directory), 'bin', executable));
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

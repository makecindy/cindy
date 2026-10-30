import { stripTrailingPathSeparators } from '../../../../shared/pathText';
import { isWindowsPathLike, workingDirComparisonKey } from '../../../../shared/workingDir';

type InstallPathComparisonOptions = { windows?: boolean };

function usesWindowsSeparator(pathValue: string): boolean {
  return pathValue.includes('\\') && !pathValue.includes('/');
}

function trimTrailingSeparators(pathValue: string): string {
  if (/^[A-Za-z]:[\\/]?$/.test(pathValue)) return pathValue;
  if (pathValue === '/' || pathValue === '\\') return pathValue;
  return stripTrailingPathSeparators(pathValue);
}

export function normalizeInstallPathKey(pathValue: string, options: InstallPathComparisonOptions = {}): string {
  // Remote paths cannot use the viewing computer's platform. The default keeps
  // the existing drive-path comparison and extends it to UNC; local callers
  // explicitly pass their platform to retain POSIX case sensitivity.
  const normalized = workingDirComparisonKey(pathValue.trim(), { windows: options.windows ?? true }) ?? '';
  const prefix = normalized.startsWith('//') ? '//' : '';
  return prefix + normalized.slice(prefix.length).replace(/\/+/g, '/');
}

export function joinSkillInstallPath(baseDir: string, skillName: string): string {
  const base = trimTrailingSeparators(baseDir);
  const sep = usesWindowsSeparator(base) ? '\\' : '/';
  return [base, '.agents', 'skills', skillName].join(sep);
}

export function isInstallPathForSkill(pathValue: string, skillName: string, options: InstallPathComparisonOptions = {}): boolean {
  const normalized = normalizeInstallPathKey(pathValue, options);
  const suffix = `/.agents/skills/${skillName}`;
  return normalized.endsWith(options.windows !== false && isWindowsPathLike(normalized) ? suffix.toLowerCase() : suffix);
}

export function isInstallPathUnderProject(pathValue: string, projectRoot: string, options: InstallPathComparisonOptions = {}): boolean {
  const normalizedPath = normalizeInstallPathKey(pathValue, options);
  const normalizedRoot = normalizeInstallPathKey(projectRoot, options);
  return normalizedPath.startsWith(`${normalizedRoot}/`);
}

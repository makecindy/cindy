import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

/**
 * Windows Git/PATH helpers for the future Pi shell integration.
 *
 * Behavior is adapted from oh-my-pi's `crates/pi-shell/src/windows.rs`
 * (https://github.com/can1357/oh-my-pi, commit 326d24bd40d9858e24e1036ae739c27c72eeb543).
 * The upstream project is MIT-licensed; this small, dependency-free port is
 * compatible with Cindy's Apache-2.0 distribution. It is intentionally not
 * wired into PiAgent or any production startup path in this PR.
 */

export interface WindowsGitPathProbes {
  readRegistryInstallPaths: () => readonly string[];
  whereGit: () => readonly string[];
  isDirectory: (candidate: string) => boolean;
  isFile: (candidate: string) => boolean;
}

export interface ResolveWindowsGitPathOptions {
  platform?: NodeJS.Platform;
  existingPath: string | undefined;
  probes?: Partial<WindowsGitPathProbes>;
}

const REGISTRY_KEYS = [
  'HKLM\\SOFTWARE\\GitForWindows',
  'HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows',
] as const;

function defaultReadRegistryInstallPaths(): readonly string[] {
  if (process.platform !== 'win32') return [];
  const paths: string[] = [];
  for (const key of REGISTRY_KEYS) {
    try {
      const output = execFileSync('reg', ['query', key, '/v', 'InstallPath'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      const match = output.match(/InstallPath\s+REG_SZ\s+(.+)/i);
      const value = match?.[1]?.trim();
      if (value) paths.push(value);
    } catch {
      // Registry access is best-effort. PATH resolution must remain fail-open.
    }
  }
  return paths;
}

function defaultWhereGit(): readonly string[] {
  if (process.platform !== 'win32') return [];
  try {
    const output = execFileSync('where', ['git'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const defaultProbes: WindowsGitPathProbes = {
  readRegistryInstallPaths: defaultReadRegistryInstallPaths,
  whereGit: defaultWhereGit,
  isDirectory: (candidate) => {
    try {
      return statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  },
  isFile: (candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  },
};

function normalizedWindowsPath(value: string): string {
  const trimmed = value.trim().replace(/^"|"$/g, '');
  if (!trimmed) return '';
  const normalized = path.win32.normalize(trimmed.replaceAll('/', '\\'));
  const root = path.win32.parse(normalized).root;
  const withoutTrailingSeparators = normalized.length > root.length
    ? normalized.replace(/[\\]+$/, '')
    : normalized;
  return withoutTrailingSeparators.toLowerCase();
}

function uniqueWindowsPaths(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizedWindowsPath(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value);
  }
  return result;
}

export function gitInstallRootFromPath(gitPath: string): string | undefined {
  const normalized = path.win32.normalize(gitPath.replaceAll('/', '\\'));
  const parent = path.win32.dirname(normalized);
  const parentName = path.win32.basename(parent);
  if (parentName.toLowerCase() === 'cmd') {
    return path.win32.dirname(parent);
  }
  if (parentName.toLowerCase() === 'bin') {
    const grandparent = path.win32.dirname(parent);
    const grandparentName = path.win32.basename(grandparent).toLowerCase();
    if (grandparentName === 'usr' || grandparentName.startsWith('mingw')) {
      return path.win32.dirname(grandparent);
    }
    return grandparent;
  }
  return path.win32.dirname(parent);
}

type WindowsGitFileProbes = Pick<WindowsGitPathProbes, 'isDirectory' | 'isFile'>;

function hasGitCommand(directory: string, probes: WindowsGitFileProbes): boolean {
  if (!probes.isDirectory(directory)) return false;
  return ['git.exe', 'git.cmd', 'git.bat'].some((name) => probes.isFile(path.win32.join(directory, name)));
}

export function gitPathsForInstallRoot(
  installRoot: string,
  probes: Pick<WindowsGitPathProbes, 'isDirectory' | 'isFile'>,
): string[] {
  const root = path.win32.normalize(installRoot);
  const candidates: string[] = [];
  const cmd = path.win32.join(root, 'cmd');
  if (hasGitCommand(cmd, probes)) candidates.push(cmd);
  const bin = path.win32.join(root, 'bin');
  if (hasGitCommand(bin, probes)) candidates.push(bin);
  const usrBin = path.win32.join(root, 'usr', 'bin');
  if (hasGitCommand(usrBin, probes) || probes.isFile(path.win32.join(usrBin, 'ls.exe'))) candidates.push(usrBin);
  return uniqueWindowsPaths(candidates);
}

export function translateMsysPathSegment(segment: string, installRoots: readonly string[], isDirectory: (candidate: string) => boolean): string | undefined {
  const trimmed = segment.trim().replace(/^"|"$/g, '');
  if (!trimmed || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')) return undefined;
  const forward = trimmed.replaceAll('\\', '/');
  if (!forward.startsWith('/')) return undefined;
  const rest = forward.slice(1);
  const slash = rest.indexOf('/');
  const head = slash >= 0 ? rest.slice(0, slash) : rest;
  const tail = slash >= 0 ? rest.slice(slash + 1) : '';
  if (/^[A-Za-z]$/.test(head)) return `${head.toUpperCase()}:\\${tail.replaceAll('/', '\\')}`;
  const relative = rest.replaceAll('/', '\\');
  for (const root of installRoots) {
    const candidate = path.win32.join(root, relative);
    if (isDirectory(candidate)) return candidate;
  }
  return undefined;
}

export function resolveWindowsGitPath({ platform = process.platform, existingPath, probes: overrides }: ResolveWindowsGitPathOptions): string {
  if (platform !== 'win32') return existingPath ?? '';
  const probes: WindowsGitPathProbes = { ...defaultProbes, ...overrides };
  const original = existingPath ?? '';
  const roots = uniqueWindowsPaths([
    ...probes.readRegistryInstallPaths(),
    ...probes.whereGit().map(gitInstallRootFromPath).filter((value): value is string => Boolean(value)),
  ]);
  const added = roots.flatMap((root) => gitPathsForInstallRoot(root, probes));
  if (added.length === 0) return original;

  const segments = original.split(';').filter((segment) => segment.trim() !== '');
  const seen = new Set<string>();
  const result: string[] = [];
  for (const segment of segments) {
    const translated = translateMsysPathSegment(segment, roots, probes.isDirectory) ?? segment;
    const normalized = normalizedWindowsPath(translated);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(translated);
  }
  for (const candidate of added) {
    const normalized = normalizedWindowsPath(candidate);
    if (!normalized || seen.has(normalized) || !probes.isDirectory(candidate)) continue;
    seen.add(normalized);
    result.push(candidate);
  }
  return result.join(';');
}

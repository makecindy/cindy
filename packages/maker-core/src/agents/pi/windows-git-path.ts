import { execFileSync } from 'node:child_process';
import path from 'node:path';

export type WindowsPathKind = 'file' | 'directory';

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
  findGitExecutablesOnPath: (pathValue: string | undefined) => readonly string[];
  readGitExecPath: (gitPath: string) => string | undefined;
  probePathKinds: (candidates: readonly string[]) => ReadonlyMap<string, WindowsPathKind>;
  isDirectory: (candidate: string) => boolean;
  isFile: (candidate: string) => boolean;
}

export interface ResolveWindowsGitPathOptions {
  platform?: NodeJS.Platform;
  existingPath: string | undefined;
  probes?: Partial<WindowsGitPathProbes>;
}

export const WINDOWS_GIT_REGISTRY_KEYS = [
  'HKCU\\SOFTWARE\\GitForWindows',
  'HKLM\\SOFTWARE\\GitForWindows',
  'HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows',
] as const;

const WINDOWS_GIT_EXECUTABLE = 'git.exe';
const WINDOWS_PATH_PROBE_TIMEOUT_MS = 3_000;

/**
 * PowerShell emits each registry value as UTF-16LE Base64. The transport is
 * therefore ASCII-only and cannot be corrupted by the active Windows console
 * code page before Node receives it.
 */
export function decodeWindowsRegistryBase64Lines(output: string): string[] {
  const values: string[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (
      line.length === 0
      || line.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(line)
    ) {
      continue;
    }
    const bytes = Buffer.from(line, 'base64');
    if (bytes.length === 0 || bytes.length % 2 !== 0) continue;
    const value = bytes.toString('utf16le').trim();
    if (value) values.push(value);
  }
  return values;
}

function windowsPowerShellPath(): string | undefined {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) return undefined;
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function windowsRegistryProviderPath(key: typeof WINDOWS_GIT_REGISTRY_KEYS[number]): string {
  if (key.startsWith('HKCU\\')) {
    return `Registry::HKEY_CURRENT_USER\\${key.slice('HKCU\\'.length)}`;
  }
  return `Registry::HKEY_LOCAL_MACHINE\\${key.slice('HKLM\\'.length)}`;
}

function defaultReadRegistryInstallPaths(): readonly string[] {
  if (process.platform !== 'win32') return [];
  const powershell = windowsPowerShellPath();
  if (!powershell) return [];
  const registryPaths = WINDOWS_GIT_REGISTRY_KEYS
    .map((key) => `'${windowsRegistryProviderPath(key)}'`)
    .join(', ');
  const script = [
    `$keys = @(${registryPaths})`,
    'foreach ($key in $keys) {',
    '  try {',
    "    $value = Get-ItemPropertyValue -LiteralPath $key -Name 'InstallPath' -ErrorAction Stop",
    '    if ($null -ne $value -and -not [string]::IsNullOrWhiteSpace([string]$value)) {',
    '      [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([string]$value))',
    '    }',
    '  } catch {}',
    '}',
  ].join('\n');
  try {
    const output = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
      windowsHide: true,
    });
    return decodeWindowsRegistryBase64Lines(output);
  } catch {
    // Registry access is best-effort. PATH resolution must remain fail-open.
    return [];
  }
}

/** Decode the ASCII-only records emitted by the bounded PowerShell path probe. */
export function decodeWindowsPathKindLines(output: string): Map<string, WindowsPathKind> {
  const kinds = new Map<string, WindowsPathKind>();
  for (const rawLine of output.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^([FD])\t(.+)$/);
    if (!match) continue;
    const encoded = match[2];
    if (
      encoded.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    ) {
      continue;
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length === 0 || bytes.length % 2 !== 0) continue;
    const candidate = bytes.toString('utf16le');
    const normalized = normalizedWindowsPath(candidate);
    if (!normalized) continue;
    kinds.set(normalized, match[1] === 'D' ? 'directory' : 'file');
  }
  return kinds;
}

/** Preserve records emitted before a bounded native probe fails or times out. */
export function decodeWindowsPathKindsFromProbeError(error: unknown): Map<string, WindowsPathKind> {
  const partialOutput = (error as { stdout?: string | Buffer } | undefined)?.stdout;
  if (typeof partialOutput === 'string') return decodeWindowsPathKindLines(partialOutput);
  if (Buffer.isBuffer(partialOutput)) return decodeWindowsPathKindLines(partialOutput.toString('utf8'));
  return new Map();
}

/**
 * Resolve a batch of filesystem metadata in one native subprocess with one
 * total timeout. A disconnected UNC share or mapped drive can therefore delay
 * each best-effort batch only up to the bounded probe, never an unbounded
 * `statSync` call in Cindy's process.
 */
function defaultProbeWindowsPathKinds(candidates: readonly string[]): ReadonlyMap<string, WindowsPathKind> {
  if (process.platform !== 'win32') return new Map();
  const powershell = windowsPowerShellPath();
  if (!powershell) return new Map();
  const absoluteCandidates = uniqueWindowsPaths(candidates)
    .filter(isFullyQualifiedWindowsPath);
  if (absoluteCandidates.length === 0) return new Map();
  const script = [
    '$stdin = [Console]::OpenStandardInput()',
    '$memory = New-Object System.IO.MemoryStream',
    '$stdin.CopyTo($memory)',
    '$json = [Text.Encoding]::UTF8.GetString($memory.ToArray())',
    '$paths = @($json | ConvertFrom-Json)',
    'foreach ($candidate in $paths) {',
    '  try {',
    '    $item = Get-Item -LiteralPath ([string]$candidate) -Force -ErrorAction Stop',
    "    $kind = if ($item.PSIsContainer) { 'D' } else { 'F' }",
    '    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([string]$candidate))',
    '    [Console]::Out.WriteLine($kind + "`t" + $encoded)',
    '  } catch {}',
    '}',
  ].join('\n');
  try {
    const output = execFileSync(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        input: Buffer.from(JSON.stringify(absoluteCandidates), 'utf8'),
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: WINDOWS_PATH_PROBE_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    return decodeWindowsPathKindLines(output);
  } catch (error) {
    // `execFileSync` attaches partial stdout to timeout errors. Keep records
    // emitted before a disconnected UNC/mapped-drive candidate blocked the
    // batch; discarding them would also discard already-probed local Git paths.
    const partialKinds = decodeWindowsPathKindsFromProbeError(error);
    if (partialKinds.size > 0) return partialKinds;
    // Filesystem discovery is best-effort. PATH resolution must remain fail-open.
    return new Map();
  }
}

function isFullyQualifiedWindowsPath(candidate: string): boolean {
  if (!path.win32.isAbsolute(candidate)) return false;
  const root = path.win32.parse(candidate).root;
  // `\foo` and `/foo` resolve against the process's current drive on Windows.
  // Only drive-rooted, UNC and device paths are stable discovery inputs.
  return root !== '\\' && root !== '/';
}

function windowsExecutableCandidatesOnPath(
  pathValue: string | undefined,
  executableName: string,
): string[] {
  if (!pathValue) return [];
  const candidates: string[] = [];
  for (const rawDirectory of pathValue.split(';')) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, '');
    // Blank and relative PATH entries both mean the current directory on
    // Windows. Discovery must never inspect or execute workspace files.
    if (!directory || !isFullyQualifiedWindowsPath(directory)) continue;
    candidates.push(path.win32.join(directory, executableName));
  }
  return uniqueWindowsPaths(candidates);
}

export function findWindowsExecutablesOnPath(
  pathValue: string | undefined,
  executableName: string,
  isFile: (candidate: string) => boolean,
): string[] {
  return windowsExecutableCandidatesOnPath(pathValue, executableName).filter(isFile);
}

function defaultFindGitExecutablesOnPath(pathValue: string | undefined): readonly string[] {
  if (process.platform !== 'win32') return [];
  const candidates = windowsExecutableCandidatesOnPath(pathValue, WINDOWS_GIT_EXECUTABLE);
  const kinds = defaultProbeWindowsPathKinds(candidates);
  return candidates.filter((candidate) => kinds.get(normalizedWindowsPath(candidate)) === 'file');
}

function defaultReadGitExecPath(gitPath: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const extension = path.win32.extname(gitPath).toLowerCase();
  if (extension !== '.exe' && extension !== '.com') return undefined;
  try {
    const output = execFileSync(gitPath, ['--exec-path'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
      windowsHide: true,
    });
    return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  } catch {
    return undefined;
  }
}

const defaultProbes: WindowsGitPathProbes = {
  readRegistryInstallPaths: defaultReadRegistryInstallPaths,
  findGitExecutablesOnPath: defaultFindGitExecutablesOnPath,
  readGitExecPath: defaultReadGitExecPath,
  probePathKinds: defaultProbeWindowsPathKinds,
  // The production resolver replaces these placeholders with one batched
  // snapshot. They remain injectable for cross-platform pure-function tests.
  isDirectory: () => false,
  isFile: () => false,
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
  return undefined;
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

function gitInstallRootCandidatesFromExecPath(execPath: string | undefined): string[] {
  if (!execPath) return [];
  const candidates: string[] = [];
  let candidate = path.win32.normalize(execPath.replaceAll('/', '\\'));
  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(candidate);
    const parent = path.win32.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return uniqueWindowsPaths(candidates);
}

function gitInstallRootCandidatesForPath(gitPath: string, probes: WindowsGitPathProbes): string[] {
  const candidates: string[] = [];
  const inferred = gitInstallRootFromPath(gitPath);
  if (inferred) candidates.push(inferred);
  candidates.push(...gitInstallRootCandidatesFromExecPath(probes.readGitExecPath(gitPath)));
  return uniqueWindowsPaths(candidates);
}

function installRootProbeCandidates(installRoot: string): string[] {
  const root = path.win32.normalize(installRoot);
  const candidates: string[] = [];
  for (const directory of [
    path.win32.join(root, 'cmd'),
    path.win32.join(root, 'bin'),
    path.win32.join(root, 'usr', 'bin'),
  ]) {
    candidates.push(directory);
    for (const executable of ['git.exe', 'git.cmd', 'git.bat']) {
      candidates.push(path.win32.join(directory, executable));
    }
  }
  candidates.push(path.win32.join(root, 'usr', 'bin', 'ls.exe'));
  return candidates;
}

function msysRootProbeCandidates(segments: readonly string[], installRoots: readonly string[]): string[] {
  const candidates: string[] = [];
  for (const segment of segments) {
    const trimmed = segment.trim().replace(/^"|"$/g, '');
    if (!trimmed || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')) continue;
    const forward = trimmed.replaceAll('\\', '/');
    if (!forward.startsWith('/')) continue;
    const rest = forward.slice(1);
    const slash = rest.indexOf('/');
    const head = slash >= 0 ? rest.slice(0, slash) : rest;
    if (/^[A-Za-z]$/.test(head)) continue;
    const relative = rest.replaceAll('/', '\\');
    for (const root of installRoots) candidates.push(path.win32.join(root, relative));
  }
  return candidates;
}

function fileProbesFromPathKinds(kinds: ReadonlyMap<string, WindowsPathKind>): WindowsGitFileProbes {
  const normalizedKinds = new Map<string, WindowsPathKind>();
  for (const [candidate, kind] of kinds) {
    const normalized = normalizedWindowsPath(candidate);
    if (normalized) normalizedKinds.set(normalized, kind);
  }
  return {
    isDirectory: (candidate) => normalizedKinds.get(normalizedWindowsPath(candidate)) === 'directory',
    isFile: (candidate) => normalizedKinds.get(normalizedWindowsPath(candidate)) === 'file',
  };
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
  const segments = original.split(';').filter((segment) => segment.trim() !== '');
  const rootCandidates = uniqueWindowsPaths([
    ...probes.readRegistryInstallPaths(),
    ...probes.findGitExecutablesOnPath(existingPath)
      .flatMap((gitPath) => gitInstallRootCandidatesForPath(gitPath, probes)),
  ]);
  const injectedFileProbes = overrides?.isDirectory !== undefined || overrides?.isFile !== undefined;
  const fileProbes: WindowsGitFileProbes = injectedFileProbes
    ? { isDirectory: probes.isDirectory, isFile: probes.isFile }
    : fileProbesFromPathKinds(probes.probePathKinds([
      ...rootCandidates.flatMap(installRootProbeCandidates),
      ...msysRootProbeCandidates(segments, rootCandidates),
    ]));
  const roots = rootCandidates.filter((root) => gitPathsForInstallRoot(root, fileProbes).length > 0);
  const added = roots.flatMap((root) => gitPathsForInstallRoot(root, fileProbes));
  if (added.length === 0) return original;

  const seen = new Set<string>();
  const result: string[] = [];
  for (const segment of segments) {
    const translated = translateMsysPathSegment(segment, roots, fileProbes.isDirectory) ?? segment;
    const normalized = normalizedWindowsPath(translated);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(translated);
  }
  for (const candidate of added) {
    const normalized = normalizedWindowsPath(candidate);
    if (!normalized || seen.has(normalized) || !fileProbes.isDirectory(candidate)) continue;
    seen.add(normalized);
    result.push(candidate);
  }
  return result.join(';');
}

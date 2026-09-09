import { execFileSync } from 'node:child_process';
import path from 'node:path';

import {
  buildWindowsNetworkDriveProbeScript,
  buildWindowsPathKindProbeScript,
  buildWindowsRegistryProbeScript,
  maxWindowsPathKindProbeBatchCount,
  terminateWindowsPowerShellDescendants,
  type WindowsGitPathLogger,
  warnWindowsGitPathProbeDiagnostics,
  warnWindowsGitPathProbeFailure,
} from './windows-git-path-powershell.js';

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
  probePathKinds: (candidates: readonly string[]) => ReadonlyMap<string, WindowsPathKind>;
  isDirectory: (candidate: string) => boolean;
  isFile: (candidate: string) => boolean;
}

export interface ResolveWindowsGitPathOptions {
  platform?: NodeJS.Platform;
  existingPath: string | undefined;
  probes?: Partial<WindowsGitPathProbes>;
  logger?: WindowsGitPathLogger;
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

function defaultReadRegistryInstallPaths(logger?: WindowsGitPathLogger): readonly string[] {
  if (process.platform !== 'win32') return [];
  const powershell = windowsPowerShellPath();
  if (!powershell) return [];
  const script = buildWindowsRegistryProbeScript(WINDOWS_GIT_REGISTRY_KEYS.map(windowsRegistryProviderPath));
  try {
    const output = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
      windowsHide: true,
    });
    warnWindowsGitPathProbeDiagnostics(logger, 'registry', output);
    return decodeWindowsRegistryBase64Lines(output);
  } catch (error) {
    warnWindowsGitPathProbeFailure(logger, 'registry', error);
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

function isWindowsUncPath(candidate: string): boolean {
  if (!candidate.startsWith('\\\\') && !candidate.startsWith('//')) return false;
  // Device paths (`\\?\` and `\\.\`) are not network shares.
  return !/^\\\\[?.]\\/.test(candidate);
}

/**
 * Keep network candidates in a separate native probe: an offline UNC share or
 * mapped network drive must not consume the timeout for local Git paths.
 */
export function partitionWindowsProbeCandidates(
  candidates: readonly string[],
  networkDriveLetters: ReadonlySet<string>,
): { local: string[]; network: string[] } {
  const normalizedNetworkDriveLetters = new Set(
    [...networkDriveLetters].map((letter) => letter.trim().toUpperCase()),
  );
  const local: string[] = [];
  const network: string[] = [];
  for (const candidate of candidates) {
    const driveLetter = candidate.match(/^([A-Za-z]):/)?.[1]?.toUpperCase();
    (isWindowsUncPath(candidate)
      || (driveLetter !== undefined && normalizedNetworkDriveLetters.has(driveLetter))
      ? network
      : local).push(candidate);
  }
  return { local, network };
}

function windowsGitInstallRootForProbeCandidate(candidate: string): string | undefined {
  const normalized = path.win32.normalize(candidate);
  const executableRoot = gitInstallRootFromPath(normalized);
  if (executableRoot) return executableRoot;
  const name = path.win32.basename(normalized).toLowerCase();
  if (name === 'cmd') return path.win32.dirname(normalized);
  if (name !== 'bin') return undefined;
  const parent = path.win32.dirname(normalized);
  const parentName = path.win32.basename(parent).toLowerCase();
  return parentName === 'usr' || parentName.startsWith('mingw')
    ? path.win32.dirname(parent)
    : parent;
}

function windowsPathProbeBatches(candidates: readonly string[]): string[][] {
  const installRoots = uniqueWindowsPaths(candidates.flatMap((candidate) => (
    windowsGitInstallRootForProbeCandidate(candidate) ?? []
  )))
    .map(normalizedWindowsPath)
    .sort((left, right) => right.length - left.length);
  const batches = new Map<string, string[]>();
  for (const candidate of candidates) {
    const normalized = normalizedWindowsPath(candidate);
    const installRoot = installRoots.find((root) => (
      normalized === root || normalized.startsWith(`${root}\\`)
    ));
    const key = installRoot ?? normalizedWindowsPath(path.win32.parse(candidate).root) ?? normalized;
    const batch = batches.get(key);
    if (batch) batch.push(candidate);
    else batches.set(key, [candidate]);
  }
  return [...batches.values()];
}

function defaultNetworkDriveLetters(powershell: string, logger?: WindowsGitPathLogger): ReadonlySet<string> {
  const script = buildWindowsNetworkDriveProbeScript();
  try {
    const output = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: WINDOWS_PATH_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    warnWindowsGitPathProbeDiagnostics(logger, 'network-drives', output);
    return new Set(output.split(/\r?\n/)
      .map((line) => line.trim().toUpperCase())
      .filter((line) => /^[A-Z]$/.test(line)));
  } catch (error) {
    warnWindowsGitPathProbeFailure(logger, 'network-drives', error);
    return new Set();
  }
}

export function probePartitionedWindowsPathKinds(
  candidates: readonly string[],
  networkDriveLetters: ReadonlySet<string>,
  probeBatches: (
    batches: readonly (readonly string[])[],
  ) => ReadonlyMap<string, WindowsPathKind>,
): Map<string, WindowsPathKind> {
  const { local, network } = partitionWindowsProbeCandidates(candidates, networkDriveLetters);
  const kinds = new Map<string, WindowsPathKind>();
  for (const phase of [local, network]) {
    if (phase.length === 0) continue;
    for (const [candidate, kind] of probeBatches(windowsPathProbeBatches(phase))) {
      kinds.set(candidate, kind);
    }
  }
  return kinds;
}

function defaultProbeWindowsPathKindBatches(
  powershell: string,
  batches: readonly (readonly string[])[],
  logger?: WindowsGitPathLogger,
): ReadonlyMap<string, WindowsPathKind> {
  const nonEmptyBatches = batches.filter((batch) => batch.length > 0);
  if (nonEmptyBatches.length === 0) return new Map();
  const candidates = nonEmptyBatches.flat();
  const script = buildWindowsPathKindProbeScript(
    candidates.length,
    WINDOWS_PATH_PROBE_TIMEOUT_MS,
    nonEmptyBatches.length,
  );
  const input = candidates.length === 1
    ? candidates[0]
    : nonEmptyBatches.map((paths) => ({ paths }));
  try {
    const output = execFileSync(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        input: Buffer.from(JSON.stringify(input), 'utf8'),
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: WINDOWS_PATH_PROBE_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    warnWindowsGitPathProbeDiagnostics(logger, 'path-kinds', output);
    return decodeWindowsPathKindLines(output);
  } catch (error) {
    terminateWindowsPowerShellDescendants(
      powershell,
      (error as { pid?: number } | undefined)?.pid,
      logger,
    );
    warnWindowsGitPathProbeFailure(logger, 'path-kinds', error);
    return decodeWindowsPathKindsFromProbeError(error);
  }
}

/**
 * Resolve local and network filesystem metadata in separate bounded native
 * subprocesses. A disconnected UNC share or mapped drive can never delay
 * local Git discovery, and can delay its own best-effort batch only up to the
 * configured timeout.
 */
function defaultProbeWindowsPathKinds(
  candidates: readonly string[],
  logger?: WindowsGitPathLogger,
): ReadonlyMap<string, WindowsPathKind> {
  if (process.platform !== 'win32') return new Map();
  const powershell = windowsPowerShellPath();
  if (!powershell) return new Map();
  const absoluteCandidates = uniqueWindowsPaths(candidates).filter(isFullyQualifiedWindowsPath);
  if (absoluteCandidates.length === 0) return new Map();
  return probePartitionedWindowsPathKinds(
    absoluteCandidates,
    defaultNetworkDriveLetters(powershell, logger),
    (batches) => defaultProbeWindowsPathKindBatches(powershell, batches, logger),
  );
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
  return windowsExecutableCandidatesOnPath(pathValue, WINDOWS_GIT_EXECUTABLE);
}

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

function pathExecutableValidatesInstallRoot(
  gitPath: string,
  installRoot: string,
  probes: WindowsGitFileProbes,
): boolean {
  const normalized = path.win32.normalize(gitPath);
  const parent = path.win32.dirname(normalized);
  const parentName = path.win32.basename(parent).toLowerCase();
  const root = path.win32.normalize(installRoot);
  if (parentName === 'cmd') {
    const bin = path.win32.join(root, 'bin');
    const usrBin = path.win32.join(root, 'usr', 'bin');
    return hasGitCommand(bin, probes)
      || hasGitCommand(usrBin, probes)
      || probes.isFile(path.win32.join(usrBin, 'ls.exe'));
  }
  if (parentName !== 'bin') return true;
  const grandparentName = path.win32.basename(path.win32.dirname(parent)).toLowerCase();
  if (grandparentName === 'usr' || grandparentName.startsWith('mingw')) return true;
  const cmd = path.win32.join(root, 'cmd');
  const usrBin = path.win32.join(root, 'usr', 'bin');
  return hasGitCommand(cmd, probes)
    || hasGitCommand(usrBin, probes)
    || probes.isFile(path.win32.join(usrBin, 'ls.exe'));
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
    if (!trimmed || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\')) continue;
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
  if (!trimmed || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\')) return undefined;
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

export function resolveWindowsGitPath({
  platform = process.platform,
  existingPath,
  probes: overrides,
  logger,
}: ResolveWindowsGitPathOptions): string {
  if (platform !== 'win32') return existingPath ?? '';
  const probes: WindowsGitPathProbes = {
    readRegistryInstallPaths: () => defaultReadRegistryInstallPaths(logger),
    findGitExecutablesOnPath: defaultFindGitExecutablesOnPath,
    probePathKinds: (candidates) => defaultProbeWindowsPathKinds(candidates, logger),
    // The production resolver replaces these placeholders with one batched
    // snapshot. They remain injectable for cross-platform pure-function tests.
    isDirectory: () => false,
    isFile: () => false,
    ...overrides,
  };
  const original = existingPath ?? '';
  const segments = original.split(';').filter((segment) => segment.trim() !== '');
  const registryRoots = uniqueWindowsPaths(probes.readRegistryInstallPaths());
  const gitExecutableCandidates = probes.findGitExecutablesOnPath(existingPath);
  const allInferredRoots = uniqueWindowsPaths(
    gitExecutableCandidates.flatMap((gitPath) => gitInstallRootFromPath(gitPath) ?? []),
  );
  const inferredRootLimit = Math.max(
    maxWindowsPathKindProbeBatchCount(WINDOWS_PATH_PROBE_TIMEOUT_MS) - registryRoots.length,
    0,
  );
  const inferredRoots = allInferredRoots.slice(0, inferredRootLimit);
  if (allInferredRoots.length > inferredRoots.length) {
    logger?.warn('windows git path PATH install-root candidates truncated', {
      limit: inferredRootLimit,
      omitted: allInferredRoots.length - inferredRoots.length,
    });
  }
  const potentialRoots = uniqueWindowsPaths([...inferredRoots, ...registryRoots]);
  const potentialRootKeys = new Set(potentialRoots.map(normalizedWindowsPath));
  const prioritizedGitExecutableCandidates = gitExecutableCandidates.filter((gitPath) => {
    const installRoot = gitInstallRootFromPath(gitPath);
    return installRoot !== undefined && potentialRootKeys.has(normalizedWindowsPath(installRoot));
  });
  const deferredGitExecutableCandidates = gitExecutableCandidates.filter(
    (gitPath) => !prioritizedGitExecutableCandidates.includes(gitPath),
  );
  const injectedFileProbes = overrides?.isDirectory !== undefined || overrides?.isFile !== undefined;
  const fileProbes: WindowsGitFileProbes = injectedFileProbes
    ? { isDirectory: probes.isDirectory, isFile: probes.isFile }
    : fileProbesFromPathKinds(probes.probePathKinds([
      ...prioritizedGitExecutableCandidates,
      ...potentialRoots.flatMap(installRootProbeCandidates),
      ...msysRootProbeCandidates(segments, potentialRoots),
      ...deferredGitExecutableCandidates,
    ]));
  const rootCandidates = uniqueWindowsPaths([
    ...gitExecutableCandidates
      .filter(fileProbes.isFile)
      .flatMap((gitPath) => {
        const installRoot = gitInstallRootFromPath(gitPath);
        return installRoot && pathExecutableValidatesInstallRoot(gitPath, installRoot, fileProbes)
          ? [installRoot]
          : [];
      }),
    ...registryRoots,
  ]);
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

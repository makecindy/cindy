import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  piProjectKey,
  type PiProjectCanonicalPathEvidence,
  type PiProjectIdentityResolution,
  type PiProjectTrustInputSnapshot,
} from '@cindy/maker-core';

type HostPlatform = PiProjectIdentityResolution['platform'];
type PathApi = typeof path.posix | typeof path.win32;
type WindowsCaseComparison = Exclude<
  PiProjectIdentityResolution['windowsCaseComparison'],
  undefined
>;

interface FsStatLike {
  isDirectory(): boolean;
  isFile(): boolean;
  dev?: number | bigint;
  ino?: number | bigint;
}

interface FsDirentLike {
  name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

interface FsLstatLike extends FsStatLike {
  isSymbolicLink(): boolean;
}

export interface DesktopPiProjectIdentityDeps {
  platform: HostPlatform;
  stat: (candidate: string) => Promise<FsStatLike>;
  realpath: (candidate: string) => Promise<string>;
  resolveWindowsCaseComparison?: (
    canonicalWorkingDir: string,
  ) => Promise<WindowsCaseComparison>;
}

export interface PiProjectSkillAdmissionResolverDeps {
  resolveIdentity: (
    workingDir: string,
    deadlineAtMs?: number,
  ) => Promise<PiProjectIdentityResolution | null>;
  scanProjectSkills: (
    identity: PiProjectIdentityResolution,
    deadlineAtMs?: number,
  ) => Promise<PiProjectCanonicalPathEvidence[] | null>;
}

interface ProjectSkillScanDeps {
  readdir: (candidate: string) => Promise<FsDirentLike[]>;
  /** Production uses this bounded streaming reader; readdir remains a test seam. */
  openDirectory?: (candidate: string) => Promise<AsyncIterable<FsDirentLike>>;
  lstat: (candidate: string) => Promise<FsLstatLike>;
  stat: (candidate: string) => Promise<FsStatLike>;
  realpath: (candidate: string) => Promise<string>;
  resolveWindowsCaseComparison?: (candidate: string) => Promise<WindowsCaseComparison>;
}

interface WindowsCaseProbeDeps {
  readdir: (candidate: string) => Promise<Array<{ name: string }>>;
  openDirectory?: (candidate: string) => Promise<AsyncIterable<{ name: string }>>;
  lstat: (candidate: string) => Promise<{ dev?: number | bigint; ino?: number | bigint }>;
}

export const MAX_PI_PROJECT_SKILL_DISCOVERY_ENTRIES = 10_000;
export const PI_PROJECT_SKILL_DISCOVERY_DEADLINE_MS = 30_000;

interface ProjectSkillDiscoveryBudget {
  remainingEntries: number;
  readonly deadlineAtMs: number;
}

function assertProjectSkillDiscoveryBudget(budget: ProjectSkillDiscoveryBudget): void {
  if (Date.now() >= budget.deadlineAtMs) {
    throw new Error('project skill discovery deadline expired');
  }
  if (budget.remainingEntries <= 0) {
    throw new Error('project skill discovery entry budget exhausted');
  }
}

async function awaitProjectSkillDiscoveryStep<T>(
  operation: () => Promise<T>,
  budget: ProjectSkillDiscoveryBudget,
): Promise<T> {
  const remainingMs = budget.deadlineAtMs - Date.now();
  if (remainingMs <= 0) throw new Error('project skill discovery deadline expired');
  const pending = operation();
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('project skill discovery deadline expired')),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function closeProjectSkillDirectoryIterator<T>(
  iterator: AsyncIterator<T>,
): void {
  if (!iterator.return) return;
  try {
    void iterator.return().catch(() => undefined);
  } catch {
    // Best-effort cleanup must not replace the original discovery result.
  }
}

async function readProjectSkillDirectory(
  candidate: string,
  dependencies: ProjectSkillScanDeps,
  budget: ProjectSkillDiscoveryBudget,
): Promise<FsDirentLike[]> {
  const entries: FsDirentLike[] = [];
  if (dependencies.openDirectory) {
    const directory = await awaitProjectSkillDiscoveryStep(
      () => dependencies.openDirectory!(candidate),
      budget,
    );
    const iterator = directory[Symbol.asyncIterator]();
    try {
      while (true) {
        const result = await awaitProjectSkillDiscoveryStep(() => iterator.next(), budget);
        if (result.done) break;
        assertProjectSkillDiscoveryBudget(budget);
        budget.remainingEntries -= 1;
        entries.push(result.value);
      }
    } finally {
      closeProjectSkillDirectoryIterator(iterator);
    }
    return entries;
  }

  // Compatibility seam for focused tests that inject only readdir. The host
  // default never takes this path, so production discovery remains streaming.
  const listed = await awaitProjectSkillDiscoveryStep(
    () => dependencies.readdir(candidate),
    budget,
  );
  if (Date.now() >= budget.deadlineAtMs || listed.length > budget.remainingEntries) {
    throw new Error('project skill discovery budget exhausted');
  }
  budget.remainingEntries -= listed.length;
  return listed;
}

function losslessPosixPath(value: string): boolean {
  return value.startsWith('/')
    && !value.includes('\0')
    && !value.includes('\uFFFD')
    && Buffer.from(value, 'utf8').toString('utf8') === value;
}

function losslessUtf16Path(value: string): boolean {
  if (!value || value.includes('\0') || value.includes('\uFFFD')) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function hasDotSegments(value: string): boolean {
  return value.split('/').some((segment) => segment === '.' || segment === '..');
}

function comparisonPath(
  identity: Pick<PiProjectIdentityResolution, 'platform' | 'windowsCaseComparison'>,
  value: string,
): string | null {
  if (value.includes('\0') || value.includes('\uFFFD')) return null;
  if (identity.platform === 'posix') {
    return value.startsWith('/') && !hasDotSegments(value) ? value : null;
  }
  const comparison = identity.windowsCaseComparison;
  if (comparison !== 'ordinal-insensitive' && comparison !== 'case-sensitive') return null;
  let normalized = value.replaceAll('\\', '/');
  if (
    comparison === 'ordinal-insensitive'
    && Array.from(normalized).some((character) => (character.codePointAt(0) ?? 0) > 0x7f)
  ) return null;
  if (normalized.toLowerCase().startsWith('//?/unc/')) {
    normalized = `//${normalized.slice(8)}`;
  } else if (/^\/\/\?\/[A-Za-z]:\//.test(normalized)) {
    normalized = normalized.slice(4);
  } else if (normalized.startsWith('//?/') || normalized.startsWith('//./')) {
    return null;
  }
  normalized = normalized.startsWith('//')
    ? `//${normalized.slice(2).replace(/\/+/g, '/')}`
    : normalized.replace(/\/+/g, '/');
  if (hasDotSegments(normalized)) return null;
  if (!/^(?:[A-Za-z]:\/|\/\/)/.test(normalized)) return null;
  if (normalized.startsWith('//') && !/^\/\/[^/]+\/[^/]+(?:\/|$)/.test(normalized)) return null;
  if (!/^[A-Za-z]:\/$/.test(normalized)) normalized = normalized.replace(/\/$/, '');
  return comparison === 'ordinal-insensitive' ? normalized.toLowerCase() : normalized;
}

function canonicalPathsEqual(
  identity: PiProjectIdentityResolution,
  first: string,
  second: string,
): boolean {
  const left = comparisonPath(identity, first);
  const right = comparisonPath(identity, second);
  return left !== null && right !== null && left === right;
}

function canonicalPathIsWithin(
  identity: PiProjectIdentityResolution,
  root: string,
  candidate: string,
): boolean {
  const normalizedRoot = comparisonPath(identity, root);
  const normalizedCandidate = comparisonPath(identity, candidate);
  if (!normalizedRoot || !normalizedCandidate) return false;
  const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(prefix);
}

async function nearestGitRoot(
  start: string,
  stat: DesktopPiProjectIdentityDeps['stat'],
  pathApi: PathApi,
): Promise<string | null> {
  let current = start;
  while (true) {
    try {
      const marker = await stat(pathApi.join(current, '.git'));
      if (marker.isDirectory() || marker.isFile()) return current;
      return null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
    }
    const parent = pathApi.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function swapAsciiCase(value: string): string | null {
  if (!/[A-Za-z]/.test(value)) return null;
  return value === value.toLowerCase() ? value.toUpperCase() : value.toLowerCase();
}

async function detectWindowsCaseComparison(
  canonicalWorkingDir: string,
  dependencies: WindowsCaseProbeDeps = {
    readdir: (candidate) => fsp.readdir(candidate, { withFileTypes: true }),
    openDirectory: async (candidate) => fsp.opendir(candidate),
    lstat: (candidate) => fsp.lstat(candidate),
  },
  suppliedBudget?: ProjectSkillDiscoveryBudget,
): Promise<WindowsCaseComparison> {
  // Windows case sensitivity is a per-directory property. Changing the
  // spelling of workingDir itself probes its parent, not the lookup semantics
  // used for Skill children. Probe one existing child without mutating the
  // project; an empty/non-ASCII-only directory cannot provide this proof.
  try {
    const budget = suppliedBudget ?? {
      remainingEntries: MAX_PI_PROJECT_SKILL_DISCOVERY_ENTRIES,
      deadlineAtMs: Date.now() + PI_PROJECT_SKILL_DISCOVERY_DEADLINE_MS,
    };
    const foldedNames = new Set<string>();
    let probeName: string | null = null;
    const inspectEntry = (entry: { name: string }): WindowsCaseComparison | null => {
      const folded = entry.name.replace(/[A-Z]/g, (character) => character.toLowerCase());
      if (foldedNames.has(folded)) return 'case-sensitive';
      foldedNames.add(folded);
      if (!probeName) {
        const alternateName = swapAsciiCase(entry.name);
        if (alternateName && alternateName !== entry.name) probeName = entry.name;
      }
      return null;
    };

    if (dependencies.openDirectory) {
      const directory = await awaitProjectSkillDiscoveryStep(
        () => dependencies.openDirectory!(canonicalWorkingDir),
        budget,
      );
      const iterator = directory[Symbol.asyncIterator]();
      try {
        while (true) {
          const result = await awaitProjectSkillDiscoveryStep(() => iterator.next(), budget);
          if (result.done) break;
          assertProjectSkillDiscoveryBudget(budget);
          budget.remainingEntries -= 1;
          const comparison = inspectEntry(result.value);
          if (comparison) return comparison;
        }
      } finally {
        closeProjectSkillDirectoryIterator(iterator);
      }
    } else {
      // Compatibility seam for focused tests. Production always uses the
      // streaming reader so an oversized directory cannot be materialized.
      const entries = await awaitProjectSkillDiscoveryStep(
        () => dependencies.readdir(canonicalWorkingDir),
        budget,
      );
      if (Date.now() >= budget.deadlineAtMs || entries.length > budget.remainingEntries) {
        throw new Error('project skill discovery budget exhausted');
      }
      budget.remainingEntries -= entries.length;
      for (const entry of entries) {
        const comparison = inspectEntry(entry);
        if (comparison) return comparison;
      }
    }

    if (probeName) {
      const alternateName = swapAsciiCase(probeName)!;
      const originalPath = path.win32.join(canonicalWorkingDir, probeName);
      const alternatePath = path.win32.join(canonicalWorkingDir, alternateName);
      try {
        const [original, probe] = await Promise.all([
          awaitProjectSkillDiscoveryStep(() => dependencies.lstat(originalPath), budget),
          awaitProjectSkillDiscoveryStep(() => dependencies.lstat(alternatePath), budget),
        ]);
        if (
          original.dev === undefined
          || original.ino === undefined
          || original.ino === 0
          || original.ino === 0n
          || probe.dev === undefined
          || probe.ino === undefined
          || probe.ino === 0
          || probe.ino === 0n
        ) return 'unavailable';
        return original.dev === probe.dev && original.ino === probe.ino
          ? 'ordinal-insensitive'
          : 'case-sensitive';
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === 'ENOENT' || code === 'ENOTDIR' ? 'case-sensitive' : 'unavailable';
      }
    }
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function defaultIdentityDeps(): DesktopPiProjectIdentityDeps {
  return {
    platform: process.platform === 'win32' ? 'win32' : 'posix',
    stat: (candidate) => fsp.stat(candidate),
    realpath: (candidate) => fsp.realpath(candidate),
  };
}

export async function resolveDesktopPiProjectIdentity(
  workingDir: string,
  dependenciesOrDeadline?: DesktopPiProjectIdentityDeps | number,
  suppliedDeadlineAtMs?: number,
): Promise<PiProjectIdentityResolution | null> {
  const usingDefaultDependencies = dependenciesOrDeadline === undefined
    || typeof dependenciesOrDeadline === 'number';
  const dependencies = usingDefaultDependencies
    ? defaultIdentityDeps()
    : dependenciesOrDeadline;
  const deadlineAtMs = typeof dependenciesOrDeadline === 'number'
    ? dependenciesOrDeadline
    : suppliedDeadlineAtMs ?? Date.now() + PI_PROJECT_SKILL_DISCOVERY_DEADLINE_MS;
  if (!workingDir || workingDir.includes('\0')) return null;
  const pathApi = dependencies.platform === 'win32' ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(workingDir)) return null;
  const requestedWorkingDir = pathApi.resolve(workingDir);
  const budget: ProjectSkillDiscoveryBudget = {
    remainingEntries: MAX_PI_PROJECT_SKILL_DISCOVERY_ENTRIES,
    deadlineAtMs,
  };
  try {
    if (!(await awaitProjectSkillDiscoveryStep(
      () => dependencies.stat(requestedWorkingDir),
      budget,
    )).isDirectory()) return null;
    const canonicalWorkingDir = await awaitProjectSkillDiscoveryStep(
      () => dependencies.realpath(requestedWorkingDir),
      budget,
    );
    const lexicalRepoRoot = await awaitProjectSkillDiscoveryStep(
      () => nearestGitRoot(canonicalWorkingDir, dependencies.stat, pathApi),
      budget,
    );
    if (!lexicalRepoRoot) return null;
    const canonicalRepoRoot = await awaitProjectSkillDiscoveryStep(
      () => dependencies.realpath(lexicalRepoRoot),
      budget,
    );
    let identity: PiProjectIdentityResolution;
    if (dependencies.platform === 'posix') {
      if (!losslessPosixPath(canonicalWorkingDir) || !losslessPosixPath(canonicalRepoRoot)) return null;
      identity = {
        workingDir: requestedWorkingDir,
        canonicalWorkingDir,
        canonicalRepoRoot,
        repoRootStatus: 'resolved',
        platform: 'posix',
        canonicalPathEncoding: 'utf8-lossless',
      };
    } else {
      if (!losslessUtf16Path(canonicalWorkingDir) || !losslessUtf16Path(canonicalRepoRoot)) return null;
      const windowsCaseComparison = dependencies.resolveWindowsCaseComparison
        ? await awaitProjectSkillDiscoveryStep(
            () => dependencies.resolveWindowsCaseComparison!(canonicalWorkingDir),
            budget,
          )
        : usingDefaultDependencies
          ? await detectWindowsCaseComparison(canonicalWorkingDir, undefined, budget)
          : 'unavailable';
      if (windowsCaseComparison === 'unavailable') return null;
      identity = {
        workingDir: requestedWorkingDir,
        canonicalWorkingDir,
        canonicalRepoRoot,
        repoRootStatus: 'resolved',
        platform: 'win32',
        canonicalPathEncoding: 'utf16-lossless',
        windowsCaseComparison,
      };
    }
    return canonicalPathIsWithin(identity, canonicalRepoRoot, canonicalWorkingDir)
      && piProjectKey(identity)
      ? identity
      : null;
  } catch {
    return null;
  }
}

function projectSkillSourceRoots(identity: PiProjectIdentityResolution): string[] | null {
  const workingDir = identity.canonicalWorkingDir;
  const repoRoot = identity.canonicalRepoRoot;
  if (!workingDir || !repoRoot) return null;
  const pathApi = identity.platform === 'win32' ? path.win32 : path.posix;
  const roots = [pathApi.join(workingDir, '.pi', 'skills')];
  let current = workingDir;
  while (true) {
    roots.push(pathApi.join(current, '.agents', 'skills'));
    if (canonicalPathsEqual(identity, current, repoRoot)) break;
    const parent = pathApi.dirname(current);
    if (parent === current || !canonicalPathIsWithin(identity, repoRoot, parent)) return null;
    current = parent;
  }
  return roots;
}

async function statOrNull(
  candidate: string,
  stat: ProjectSkillScanDeps['stat'],
  budget: ProjectSkillDiscoveryBudget,
): Promise<FsStatLike | null> {
  try {
    return await awaitProjectSkillDiscoveryStep(() => stat(candidate), budget);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

async function lstatOrNull(
  candidate: string,
  lstat: ProjectSkillScanDeps['lstat'],
  budget: ProjectSkillDiscoveryBudget,
): Promise<FsLstatLike | null> {
  try {
    return await awaitProjectSkillDiscoveryStep(() => lstat(candidate), budget);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

async function scanOneProjectSkillRoot(
  identity: PiProjectIdentityResolution,
  sourceRoot: string,
  dependencies: ProjectSkillScanDeps,
  checkedWindowsDirectories: Map<string, boolean>,
  budget: ProjectSkillDiscoveryBudget,
): Promise<PiProjectCanonicalPathEvidence[] | null> {
  assertProjectSkillDiscoveryBudget(budget);
  const rootEntry = await lstatOrNull(sourceRoot, dependencies.lstat, budget);
  if (!rootEntry) return [];
  const rootStat = await statOrNull(sourceRoot, dependencies.stat, budget);
  if (!rootStat) return null;
  if (!rootStat.isDirectory()) return null;
  const canonicalSourceRoot = await awaitProjectSkillDiscoveryStep(
    () => dependencies.realpath(sourceRoot),
    budget,
  );
  if (!canonicalPathIsWithin(identity, identity.canonicalRepoRoot!, canonicalSourceRoot)) return null;
  if (!await windowsDirectoryChainMatchesIdentity(
    identity,
    canonicalSourceRoot,
    dependencies,
    checkedWindowsDirectories,
    budget,
  )) return null;
  const entries = await readProjectSkillDirectory(sourceRoot, dependencies, budget);
  const result: PiProjectCanonicalPathEvidence[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || /\.bak\.\d+$/.test(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const folder = pathFor(identity).join(sourceRoot, entry.name);
    assertProjectSkillDiscoveryBudget(budget);
    const canonicalFolder = await awaitProjectSkillDiscoveryStep(
      () => dependencies.realpath(folder),
      budget,
    );
    if (!canonicalPathIsWithin(identity, identity.canonicalRepoRoot!, canonicalFolder)) return null;
    if (!await windowsDirectoryChainMatchesIdentity(
      identity,
      canonicalFolder,
      dependencies,
      checkedWindowsDirectories,
      budget,
    )) return null;
    const folderStat = await statOrNull(folder, dependencies.stat, budget);
    if (!folderStat?.isDirectory()) return null;

    const upperManifest = pathFor(identity).join(folder, 'SKILL.md');
    const upperEntry = await lstatOrNull(upperManifest, dependencies.lstat, budget);
    if (!upperEntry) continue;
    const upperStat = await statOrNull(upperManifest, dependencies.stat, budget);
    if (!upperStat?.isFile()) return null;
    const canonicalManifest = await awaitProjectSkillDiscoveryStep(
      () => dependencies.realpath(upperManifest),
      budget,
    );
    if (!canonicalPathIsWithin(identity, identity.canonicalRepoRoot!, canonicalManifest)) return null;
    result.push({ discoveredPath: folder, canonicalPath: canonicalFolder });
  }
  const reboundSourceRoot = await awaitProjectSkillDiscoveryStep(
    () => dependencies.realpath(sourceRoot),
    budget,
  );
  return canonicalPathsEqual(identity, canonicalSourceRoot, reboundSourceRoot) ? result : null;
}

function pathFor(identity: PiProjectIdentityResolution): PathApi {
  return identity.platform === 'win32' ? path.win32 : path.posix;
}

const defaultScanDeps = (): ProjectSkillScanDeps => ({
  readdir: (candidate) => fsp.readdir(candidate, { withFileTypes: true }),
  openDirectory: async (candidate) => fsp.opendir(candidate),
  lstat: (candidate) => fsp.lstat(candidate),
  stat: (candidate) => fsp.stat(candidate),
  realpath: (candidate) => fsp.realpath(candidate),
});

async function windowsDirectoryChainMatchesIdentity(
  identity: PiProjectIdentityResolution,
  canonicalDirectory: string,
  dependencies: ProjectSkillScanDeps,
  checked: Map<string, boolean> = new Map<string, boolean>(),
  budget?: ProjectSkillDiscoveryBudget,
): Promise<boolean> {
  if (identity.platform !== 'win32') return true;
  const expected = identity.windowsCaseComparison;
  const repoRoot = identity.canonicalRepoRoot;
  if (!repoRoot || !expected) return false;
  const resolve = async (candidate: string): Promise<WindowsCaseComparison> => {
    if (dependencies.resolveWindowsCaseComparison) {
      return budget
        ? await awaitProjectSkillDiscoveryStep(
            () => dependencies.resolveWindowsCaseComparison!(candidate),
            budget,
          )
        : dependencies.resolveWindowsCaseComparison(candidate);
    }
    return detectWindowsCaseComparison(candidate, {
      readdir: dependencies.readdir,
      openDirectory: dependencies.openDirectory,
      lstat: dependencies.lstat,
    }, budget);
  };
  let current = canonicalDirectory;
  for (let depth = 0; depth < 1024; depth += 1) {
    const comparison = comparisonPath(identity, current);
    if (!comparison || !canonicalPathIsWithin(identity, repoRoot, current)) return false;
    let matches = checked.get(comparison);
    if (matches === undefined) {
      matches = await resolve(current) === expected;
      checked.set(comparison, matches);
    }
    if (!matches) return false;
    if (canonicalPathsEqual(identity, current, repoRoot)) {
      // The lookup semantics for the repoRoot path component belong to its
      // parent. Without this proof an insensitive repo directory inside a
      // sensitive parent could fold a distinct sibling (Repo vs repo) into
      // the admitted boundary. A volume/share root has no parent component.
      const boundaryParent = path.win32.dirname(current);
      if (boundaryParent === current) return true;
      const parentComparison = comparisonPath(identity, boundaryParent);
      if (!parentComparison) return false;
      let parentMatches = checked.get(parentComparison);
      if (parentMatches === undefined) {
        parentMatches = await resolve(boundaryParent) === expected;
        checked.set(parentComparison, parentMatches);
      }
      return parentMatches;
    }
    const parent = path.win32.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

export async function scanContainedDesktopPiProjectSkills(
  identity: PiProjectIdentityResolution,
  dependenciesOrDeadline?: ProjectSkillScanDeps | number,
  suppliedDeadlineAtMs?: number,
): Promise<PiProjectCanonicalPathEvidence[] | null> {
  const dependencies = dependenciesOrDeadline === undefined
    || typeof dependenciesOrDeadline === 'number'
    ? defaultScanDeps()
    : dependenciesOrDeadline;
  const deadlineAtMs = typeof dependenciesOrDeadline === 'number'
    ? dependenciesOrDeadline
    : suppliedDeadlineAtMs ?? Date.now() + PI_PROJECT_SKILL_DISCOVERY_DEADLINE_MS;
  const roots = projectSkillSourceRoots(identity);
  if (!roots) return null;
  try {
    const evidence: PiProjectCanonicalPathEvidence[] = [];
    const canonicalPaths = new Set<string>();
    const checkedWindowsDirectories = new Map<string, boolean>();
    const budget: ProjectSkillDiscoveryBudget = {
      remainingEntries: MAX_PI_PROJECT_SKILL_DISCOVERY_ENTRIES,
      deadlineAtMs,
    };
    if (!await windowsDirectoryChainMatchesIdentity(
      identity,
      identity.canonicalWorkingDir!,
      dependencies,
      checkedWindowsDirectories,
      budget,
    )) return null;
    for (const root of roots) {
      const scanned = await scanOneProjectSkillRoot(
        identity,
        root,
        dependencies,
        checkedWindowsDirectories,
        budget,
      );
      if (!scanned) return null;
      for (const item of scanned) {
        const comparison = comparisonPath(identity, item.canonicalPath);
        if (!comparison || canonicalPaths.has(comparison)) return null;
        canonicalPaths.add(comparison);
        evidence.push(item);
      }
    }
    evidence.sort((left, right) => left.discoveredPath.localeCompare(right.discoveredPath));
    return evidence;
  } catch {
    return null;
  }
}

const defaultResolverDeps = (
  identityImplementation: typeof resolveDesktopPiProjectIdentity = resolveDesktopPiProjectIdentity,
  scanImplementation: typeof scanContainedDesktopPiProjectSkills = scanContainedDesktopPiProjectSkills,
): PiProjectSkillAdmissionResolverDeps => ({
  resolveIdentity: (workingDir, deadlineAtMs) => identityImplementation(
    workingDir,
    deadlineAtMs,
  ),
  scanProjectSkills: (identity, deadlineAtMs) => scanImplementation(
    identity,
    deadlineAtMs,
  ),
});

function admissionRevision(
  projectKey: string,
  evidence: readonly PiProjectCanonicalPathEvidence[],
): string {
  const hash = createHash('sha256');
  hash.update('desktop-auto-project-skills-v1\0');
  hash.update(projectKey);
  for (const item of evidence) {
    hash.update('\0');
    hash.update(item.discoveredPath);
    hash.update('\0');
    hash.update(item.canonicalPath);
  }
  return `auto-skills-v1:${hash.digest('hex')}`;
}

function sameProjectIdentity(
  first: PiProjectIdentityResolution,
  second: PiProjectIdentityResolution,
): boolean {
  return first.platform === second.platform
    && first.canonicalPathEncoding === second.canonicalPathEncoding
    && first.windowsCaseComparison === second.windowsCaseComparison
    && piProjectKey(first) !== null
    && piProjectKey(first) === piProjectKey(second);
}

function sameEvidence(
  identity: PiProjectIdentityResolution,
  first: readonly PiProjectCanonicalPathEvidence[],
  second: readonly PiProjectCanonicalPathEvidence[],
): boolean {
  return first.length === second.length && first.every((item, index) =>
    item.discoveredPath === second[index]?.discoveredPath
    && canonicalPathsEqual(identity, item.canonicalPath, second[index]!.canonicalPath));
}

/** Re-evaluated once for every new local Pi runtime; no user approval state is read or written. */
export async function resolveDesktopPiProjectTrustInput(
  context: { sessionId?: string; workingDir: string; remoteHostId?: string },
  dependencies: PiProjectSkillAdmissionResolverDeps = defaultResolverDeps(),
): Promise<PiProjectTrustInputSnapshot | null> {
  if (context.remoteHostId) return null;
  const deadlineAtMs = Date.now() + PI_PROJECT_SKILL_DISCOVERY_DEADLINE_MS;
  const budget: ProjectSkillDiscoveryBudget = {
    remainingEntries: MAX_PI_PROJECT_SKILL_DISCOVERY_ENTRIES,
    deadlineAtMs,
  };
  let identity: PiProjectIdentityResolution | null;
  let evidence: PiProjectCanonicalPathEvidence[] | null;
  try {
    identity = await awaitProjectSkillDiscoveryStep(
      () => dependencies.resolveIdentity(context.workingDir, deadlineAtMs),
      budget,
    );
    const projectKey = identity && piProjectKey(identity);
    if (!identity || !projectKey) return null;
    evidence = await awaitProjectSkillDiscoveryStep(
      () => dependencies.scanProjectSkills(identity!, deadlineAtMs),
      budget,
    );
    if (!evidence) return null;

    const reboundIdentity = await awaitProjectSkillDiscoveryStep(
      () => dependencies.resolveIdentity(context.workingDir, deadlineAtMs),
      budget,
    );
    if (!reboundIdentity || !sameProjectIdentity(identity, reboundIdentity)) return null;
    const reboundEvidence = await awaitProjectSkillDiscoveryStep(
      () => dependencies.scanProjectSkills(reboundIdentity, deadlineAtMs),
      budget,
    );
    if (!reboundEvidence || !sameEvidence(identity, evidence, reboundEvidence)) return null;

    const frozenEvidence = Object.freeze(
      evidence.map((item) => Object.freeze({ ...item })),
    );
    const snapshot: PiProjectTrustInputSnapshot = {
      identity: Object.freeze({ ...identity }),
      approval: Object.freeze({
        status: 'approved',
        scope: 'working-dir',
        scopeKey: projectKey,
        revision: admissionRevision(projectKey, frozenEvidence),
      }),
      discovered: Object.freeze({
        skills: Object.freeze(evidence.map((item) => item.discoveredPath)),
        canonicalSkillEvidence: frozenEvidence,
        settings: Object.freeze([]),
        packages: Object.freeze([]),
        extensions: Object.freeze([]),
      }),
    };
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

export const __testing = {
  admissionRevision,
  canonicalPathIsWithin,
  canonicalPathsEqual,
  comparisonPath,
  defaultResolverDeps,
  detectWindowsCaseComparison,
  nearestGitRoot,
  projectSkillSourceRoots,
  windowsDirectoryChainMatchesIdentity,
};

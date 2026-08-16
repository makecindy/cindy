/**
 * Cindy-owned Pi package store.
 *
 * Pi's own package CLI owns source parsing, downloads, dependency installation,
 * updates, and removal. Cindy gives it an isolated PI_CODING_AGENT_DIR under
 * userData, then inspects the installed package roots for the explicit resource
 * paths that may be projected into a normal local Pi runtime.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { app } from 'electron';
import matter from 'gray-matter';

import {
  isRelativeLocalPiPackageSource,
  type PiPackageListResult,
  type PiPackageMutationRequest,
  type PiPackageMutationResult,
  type PiPackageResourceKind,
  type PiPackageResourceView,
  type PiPackageView,
} from '../../shared/piPackages.js';
import { createLogger } from '../logger.js';
import { getReadyBinaryPath } from '../agent-binaries/index.js';
import { withSecurityBoundaryLock } from '../device-link/crossProcessLock.js';
import {
  analyzePiExtensionCompatibility,
  evaluatePiRuntimeRequirements,
} from './pi-package-compatibility.js';
import {
  consumePiPackageMutationGrant,
  piPackageMutationNeedsGrant,
  type PiPackageMutationGrant,
} from './pi-package-mutation-grant.js';
import { killProcessTree } from '../scheduler-host/proc-util.js';

const log = createLogger('pi-package-store');
interface PicomatchOptions {
  dot?: boolean;
}
type Picomatch = (pattern: string, options?: PicomatchOptions) => (value: string) => boolean;
const picomatch = createRequire(import.meta.url)('picomatch') as Picomatch;
const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_FORCE_SETTLE_MS = 1_000;
const PACKAGE_MUTATION_LOCK_WAIT_MS = COMMAND_TIMEOUT_MS + 60_000;
const MAX_COMMAND_OUTPUT_BYTES = 128 * 1024;
const MAX_SOURCE_LENGTH = 2_048;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_INSPECTION_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_ENTRIES = 256;
const MAX_INSPECTION_ENTRIES = 4_096;
const MAX_INSPECTION_DEPTH = 32;
const MAX_INSPECTION_MS = 2_000;
const MAX_INSPECTED_PACKAGES = 128;
const MAX_ALL_INSPECTION_MS = 10_000;
const MAX_EXTENSION_FILES = 128;
const INSPECTION_CACHE_MS = 1_000;
const SNAPSHOT_COPY_CHUNK_BYTES = 256 * 1024;
const DEFAULT_SNAPSHOT_LIMITS: PiPackageSnapshotLimits = {
  maxEntries: 10_000,
  maxBytes: 128 * 1024 * 1024,
  maxDurationMs: 15_000,
};
const STATE_VERSION = 2;
const changeListeners = new Set<() => void>();
const PACKAGE_URL_PATTERN = /(?:git:)?[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi;
const INSTALL_LIFECYCLE_SCRIPTS = new Set([
  'preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly',
]);

export function onPiPackagesChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function notifyPiPackagesChanged(): void {
  for (const listener of changeListeners) {
    try {
      listener();
    } catch (error) {
      log.warn('Pi package change listener failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

interface PiPackageState {
  version: typeof STATE_VERSION;
  disabledSources: string[];
  approvedExtensionSources: string[];
}

interface PiPackageStateV1 {
  version: 1;
  disabledSources: string[];
}

interface ListedPackage {
  source: string;
  installedPath?: string;
  filtered?: boolean;
}

interface PackageManifest {
  name?: string;
  version?: string;
  pi?: Partial<Record<'extensions' | 'skills' | 'prompts' | 'themes', unknown>>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, unknown>;
}

let currentPiVersionPromise: Promise<string | undefined> | undefined;

export interface PiManagedPackageSkill {
  path: string;
  name: string;
  description?: string;
}

export interface PiManagedPackageResources {
  extensions: string[];
  skills: PiManagedPackageSkill[];
  promptTemplates: string[];
  /** Canonical package roots used to authenticate get_commands provenance. */
  packageRoots: string[];
}

export interface PiPackageSnapshotLimits {
  maxEntries: number;
  maxBytes: number;
  maxDurationMs: number;
}

interface InspectedPackage {
  /** Original Pi-owned identifier. Never expose this field across IPC. */
  rawSource: string;
  view: PiPackageView;
  launch: PiManagedPackageResources;
  promptCommands: Array<{ name: string; description: string }>;
  /** Canonical installed path, retained even while the package is disabled. */
  installedRoot?: string;
}

interface PackageSourceProjection {
  displaySource: string;
  unsafe: boolean;
}

interface InspectionBudget {
  startedAt: number;
  entries: number;
  metadataBytes: number;
  walkedFiles: Map<string, string[]>;
}

class PiPackageInspectionLimitError extends Error {
  constructor() {
    super('Pi package inspection limit exceeded');
    this.name = 'PiPackageInspectionLimitError';
  }
}

let mutationTail: Promise<void> = Promise.resolve();
let inspectionPromise: Promise<InspectedPackage[]> | undefined;
let inspectionCache: { expiresAt: number; value: InspectedPackage[] } | undefined;
let inspectionGeneration = 0;

function packageHome(): string {
  return path.join(app.getPath('userData'), 'pi-package-home');
}

function statePath(): string {
  return path.join(packageHome(), 'cindy-package-state.json');
}

function mutationLockPath(): string {
  return path.join(app.getPath('userData'), 'pi-package-home.mutation.lock');
}

async function withPiPackageMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const lockPath = mutationLockPath();
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  return withSecurityBoundaryLock(
    lockPath,
    { label: 'pi-package-mutation', waitMs: PACKAGE_MUTATION_LOCK_WAIT_MS },
    async (status) => {
      if (!status.held) {
        throw new Error('Pi extension store is busy or unavailable');
      }
      return operation();
    },
  );
}

async function readState(): Promise<PiPackageState> {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath(), 'utf8')) as Partial<PiPackageState | PiPackageStateV1>;
    if (
      parsed.version === STATE_VERSION
      && Array.isArray(parsed.disabledSources)
      && parsed.disabledSources.every((source) => typeof source === 'string')
      && Array.isArray(parsed.approvedExtensionSources)
      && parsed.approvedExtensionSources.every((source) => typeof source === 'string')
    ) {
      return {
        version: STATE_VERSION,
        disabledSources: [...new Set(parsed.disabledSources)],
        approvedExtensionSources: [...new Set(parsed.approvedExtensionSources)],
      };
    }
    if (
      parsed.version === 1
      && Array.isArray(parsed.disabledSources)
      && parsed.disabledSources.every((source) => typeof source === 'string')
    ) {
      // Preserve every explicit disable while requiring one-time approval for
      // extension code under the safer v2 model.
      return {
        version: STATE_VERSION,
        disabledSources: [...new Set(parsed.disabledSources)],
        approvedExtensionSources: [],
      };
    }
  } catch {
    // Missing/corrupt state is safe for data-only packages; extension-bearing
    // packages are still held disabled after inspection until approved.
  }
  return { version: STATE_VERSION, disabledSources: [], approvedExtensionSources: [] };
}

async function writeState(state: PiPackageState): Promise<void> {
  await fs.mkdir(packageHome(), { recursive: true, mode: 0o700 });
  const target = statePath();
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function boundedAppend(current: string, chunk: Buffer): string {
  const next = Buffer.concat([Buffer.from(current, 'utf8'), chunk]);
  return (next.length <= MAX_COMMAND_OUTPUT_BYTES
    ? next
    : next.subarray(next.length - MAX_COMMAND_OUTPUT_BYTES)
  ).toString('utf8');
}

export async function runPiPackageCommand(
  args: string[],
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  const binaryPath = getReadyBinaryPath('pi');
  if (!binaryPath) throw new Error('Pi is not installed in Cindy');
  await fs.mkdir(packageHome(), { recursive: true, mode: 0o700 });

  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      cwd: packageHome(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: packageHome(),
        NO_COLOR: '1',
        GIT_TERMINAL_PROMPT: '0',
        npm_config_yes: 'true',
        // Pi's package manager does not currently pass --ignore-scripts.
        // Keep install/update from executing arbitrary package lifecycle hooks;
        // extension code has a separate post-inspection approval boundary.
        npm_config_ignore_scripts: 'true',
        NPM_CONFIG_IGNORE_SCRIPTS: 'true',
      },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let childClosedAfterTimeout = false;
    let treeTerminationSettled = false;
    let forceSettleTimer: ReturnType<typeof setTimeout> | undefined;
    const clearCommandTimers = (): void => {
      clearTimeout(timer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
    };
    const settleTimedOutCommand = (): void => {
      if (settled || !timedOut || !childClosedAfterTimeout || !treeTerminationSettled) return;
      settled = true;
      clearCommandTimers();
      reject(new Error('Pi package command timed out'));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      // `close` follows inherited stdio release, so the mutation lock remains
      // held until Pi and npm/git descendants have stopped touching the store.
      killProcessTree(child.pid, child, () => {
        treeTerminationSettled = true;
        settleTimedOutCommand();
        if (settled || childClosedAfterTimeout) return;
        // Windows taskkill (and descendants retaining inherited stdio) does
        // not guarantee that Node will ever emit `close`. Once the bounded
        // tree-termination routine has finished, give stdio one final grace
        // window, then reject so the cross-process mutation lock is released.
        forceSettleTimer = setTimeout(() => {
          childClosedAfterTimeout = true;
          settleTimedOutCommand();
        }, COMMAND_FORCE_SETTLE_MS);
        forceSettleTimer.unref?.();
      });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout = boundedAppend(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = boundedAppend(stderr, chunk); });
    child.once('error', (error) => {
      if (settled) return;
      if (timedOut) return;
      settled = true;
      clearCommandTimers();
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      if (timedOut) {
        childClosedAfterTimeout = true;
        settleTimedOutCommand();
        return;
      }
      settled = true;
      clearCommandTimers();
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(redactPackageCommandMessage(
        (stderr || stdout || `Pi package command failed (${code ?? 'unknown'})`).trim(),
      )));
    });
  });
}

function parsePiVersionOutput(output: string): string | undefined {
  const match = output.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$)/m);
  return match?.[1];
}

async function getCurrentPiVersion(): Promise<string | undefined> {
  if (currentPiVersionPromise) return currentPiVersionPromise;
  currentPiVersionPromise = (async () => {
    const binaryPath = getReadyBinaryPath('pi');
    if (!binaryPath) return undefined;
    const directoryVersion = path.basename(path.dirname(binaryPath));
    if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(directoryVersion)) return directoryVersion;
    try {
      const { stdout, stderr } = await runPiPackageCommand(['--version']);
      return parsePiVersionOutput(`${stdout}\n${stderr}`);
    } catch (error) {
      log.warn('failed to read Cindy Pi version for package compatibility', {
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  })();
  return currentPiVersionPromise;
}

export function parsePiPackageListOutput(output: string): ListedPackage[] {
  const packages: ListedPackage[] = [];
  let current: ListedPackage | null = null;
  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine.trim() || /^(User|Project) packages:$/.test(rawLine.trim())) continue;
    const sourceMatch = rawLine.match(/^\s{2}(\S.*?)( \(filtered\))?\s*$/);
    if (sourceMatch?.[1]) {
      current = { source: sourceMatch[1], ...(sourceMatch[2] ? { filtered: true } : {}) };
      packages.push(current);
      continue;
    }
    const pathMatch = rawLine.match(/^\s{4}(\S.*)\s*$/);
    if (current && pathMatch?.[1]) current.installedPath = pathMatch[1];
  }
  return packages;
}

function hasGlob(value: string): boolean {
  return /[*?[]/.test(value);
}

function createInspectionBudget(): InspectionBudget {
  return { startedAt: Date.now(), entries: 0, metadataBytes: 0, walkedFiles: new Map() };
}

function assertInspectionBudget(budget: InspectionBudget, depth = 0, increment = 0): void {
  budget.entries += increment;
  if (
    depth > MAX_INSPECTION_DEPTH
    || budget.entries > MAX_INSPECTION_ENTRIES
    || Date.now() - budget.startedAt > MAX_INSPECTION_MS
  ) {
    throw new PiPackageInspectionLimitError();
  }
}

async function readUtf8FileBounded(
  file: string,
  maxBytes: number,
): Promise<{ text: string; bytes: number }> {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size > maxBytes) throw new PiPackageInspectionLimitError();
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    if (bytes > maxBytes) throw new PiPackageInspectionLimitError();
    return { text: buffer.subarray(0, bytes).toString('utf8'), bytes };
  } finally {
    await handle.close();
  }
}

async function readInspectionMetadata(file: string, budget: InspectionBudget): Promise<string> {
  const remaining = MAX_INSPECTION_METADATA_BYTES - budget.metadataBytes;
  if (remaining < 0) throw new PiPackageInspectionLimitError();
  const result = await readUtf8FileBounded(file, remaining);
  budget.metadataBytes += result.bytes;
  assertInspectionBudget(budget);
  return result.text;
}

function normalizeManifestEntries(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) throw new Error('Invalid Pi package manifest entries');
  if (value.length > MAX_MANIFEST_ENTRIES) throw new PiPackageInspectionLimitError();
  const entries: string[] = [];
  for (const entry of value) {
    if (
      typeof entry !== 'string'
      || entry.length === 0
      || entry.length > MAX_SOURCE_LENGTH
      || /[\r\n\0]/.test(entry)
    ) {
      throw new Error('Invalid Pi package manifest entry');
    }
    entries.push(entry);
  }
  return entries;
}

function hasDisabledInstallLifecycleScript(scripts: Record<string, unknown> | undefined): boolean {
  return Boolean(scripts && Object.entries(scripts).some(([name, command]) => (
    INSTALL_LIFECYCLE_SCRIPTS.has(name) && typeof command === 'string' && command.trim().length > 0
  )));
}

function globMatcher(pattern: string): (value: string) => boolean {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  // Pi package manifests use standard glob semantics, including globstar
  // matching zero directory levels, braces, and character classes.
  return picomatch(normalized, { dot: false });
}

async function walkFiles(root: string, budget: InspectionBudget): Promise<string[]> {
  const files: string[] = [];
  const visitedDirectories = new Set<string>();
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(root);
  } catch {
    return files;
  }
  const cached = budget.walkedFiles.get(canonicalRoot);
  if (cached) return cached;
  const rootPrefix = `${canonicalRoot}${path.sep}`;
  const visit = async (dir: string, depth: number): Promise<void> => {
    assertInspectionBudget(budget, depth, 1);
    let canonicalDir: string;
    try {
      canonicalDir = await fs.realpath(dir);
    } catch {
      return;
    }
    if (canonicalDir !== canonicalRoot && !canonicalDir.startsWith(rootPrefix)) return;
    if (visitedDirectories.has(canonicalDir)) return;
    visitedDirectories.add(canonicalDir);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      assertInspectionBudget(budget, depth, 1);
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const candidate = path.join(dir, entry.name);
      let stat;
      try {
        stat = entry.isSymbolicLink() ? await fs.stat(candidate) : entry;
      } catch {
        continue;
      }
      if (stat.isDirectory()) await visit(candidate, depth + 1);
      else if (stat.isFile()) files.push(candidate);
    }
  };
  await visit(root, 0);
  budget.walkedFiles.set(canonicalRoot, files);
  return files;
}

async function confinedExistingPaths(root: string, candidates: string[]): Promise<string[]> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(root);
  } catch {
    return [];
  }
  const prefix = `${canonicalRoot}${path.sep}`;
  const accepted: string[] = [];
  for (const candidate of candidates) {
    try {
      const canonical = await fs.realpath(candidate);
      if (canonical === canonicalRoot || canonical.startsWith(prefix)) accepted.push(canonical);
    } catch {
      // Missing and broken-link resources are not projected.
    }
  }
  return [...new Set(accepted)];
}

async function expandManifestEntries(
  root: string,
  entries: string[],
  budget: InspectionBudget,
): Promise<string[]> {
  if (entries.length === 0) return [];
  const allFiles = entries.some(hasGlob) ? await walkFiles(root, budget) : [];
  const selected = new Set<string>();
  const addEntry = async (entry: string): Promise<void> => {
    if (hasGlob(entry)) {
      const matches = globMatcher(entry);
      for (const file of allFiles) {
        if (matches(path.relative(root, file).replaceAll('\\', '/'))) selected.add(file);
      }
      return;
    }
    const [candidate] = await confinedExistingPaths(root, [path.resolve(root, entry)]);
    if (!candidate) return;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        for (const file of await walkFiles(candidate, budget)) selected.add(file);
      } else if (stat.isFile()) {
        selected.add(candidate);
      }
    } catch {
      // Missing and broken-link entries are ignored by Pi's loader as well.
    }
  };
  const removeEntry = (entry: string): void => {
    const pattern = entry.slice(1);
    if (hasGlob(pattern)) {
      const matches = globMatcher(pattern);
      for (const file of selected) {
        if (matches(path.relative(root, file).replaceAll('\\', '/'))) selected.delete(file);
      }
      return;
    }
    const excluded = path.resolve(root, pattern);
    for (const file of selected) {
      const relative = path.relative(excluded, file);
      if (file === excluded || (relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
        selected.delete(file);
      }
    }
  };
  for (const entry of entries) {
    if (!entry || entry.startsWith('!') || entry.startsWith('-')) continue;
    await addEntry(entry.startsWith('+') ? entry.slice(1) : entry);
  }
  for (const entry of entries) {
    if (entry.startsWith('!') || entry.startsWith('-')) removeEntry(entry);
  }
  return confinedExistingPaths(root, [...selected]);
}

/**
 * Pi skills have one extra convention that differs from other resources:
 * nested directories contribute SKILL.md, while only Markdown files directly
 * under the selected skills directory are standalone skills. Keep that
 * distinction while still applying the manifest's exclusion filters.
 */
async function expandSkillManifestEntries(
  root: string,
  entries: string[],
  budget: InspectionBudget,
): Promise<string[]> {
  if (entries.length === 0) return [];
  const selected = new Set<string>();
  const addDirectory = async (directory: string): Promise<void> => {
    let files: string[];
    try { files = await walkFiles(directory, budget); } catch (error) {
      if (error instanceof PiPackageInspectionLimitError) throw error;
      return;
    }
    for (const file of files) {
      if (path.basename(file).toLowerCase() === 'skill.md') selected.add(file);
    }
    try {
      const directEntries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of directEntries) {
        assertInspectionBudget(budget, 0, 1);
        if (entry.isFile() && !entry.name.startsWith('.') && path.extname(entry.name).toLowerCase() === '.md') {
          selected.add(path.join(directory, entry.name));
        }
      }
    } catch (error) {
      if (error instanceof PiPackageInspectionLimitError) throw error;
      // Missing directories are ignored by Pi's loader.
    }
  };
  const allFiles = entries.some(hasGlob) ? await walkFiles(root, budget) : [];
  for (const rawEntry of entries) {
    if (!rawEntry || rawEntry.startsWith('!') || rawEntry.startsWith('-')) continue;
    const entry = rawEntry.startsWith('+') ? rawEntry.slice(1) : rawEntry;
    if (hasGlob(entry)) {
      const matches = globMatcher(entry);
      for (const file of allFiles) {
        const relative = path.relative(root, file).replaceAll('\\', '/');
        const relativeDir = path.posix.dirname(relative);
        const isSkillDirectory = path.basename(file).toLowerCase() === 'skill.md' && matches(relativeDir);
        const isDirectMarkdown = path.extname(file).toLowerCase() === '.md' && matches(relative);
        if (isSkillDirectory || isDirectMarkdown) selected.add(file);
      }
      continue;
    }
    const [candidate] = await confinedExistingPaths(root, [path.resolve(root, entry)]);
    if (!candidate) continue;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) await addDirectory(candidate);
      else if (stat.isFile() && path.extname(candidate).toLowerCase() === '.md') selected.add(candidate);
    } catch {
      // Missing and broken-link entries are ignored by Pi's loader.
    }
  }
  for (const rawEntry of entries) {
    if (!rawEntry.startsWith('!') && !rawEntry.startsWith('-')) continue;
    const pattern = rawEntry.slice(1);
    const matches = hasGlob(pattern) ? globMatcher(pattern) : undefined;
    const excluded = matches ? undefined : path.resolve(root, pattern);
    for (const file of selected) {
      const relative = path.relative(root, file).replaceAll('\\', '/');
      const underExcluded = excluded && (file === excluded || (() => {
        const child = path.relative(excluded, file);
        return Boolean(child) && !child.startsWith(`..${path.sep}`) && !path.isAbsolute(child);
      })());
      if ((matches && matches(relative)) || underExcluded) selected.delete(file);
    }
  }
  return confinedExistingPaths(root, [...selected]);
}

async function collectFilesByExtension(
  input: string[],
  extensions: readonly string[],
  budget: InspectionBudget,
): Promise<string[]> {
  const out: string[] = [];
  for (const candidate of input) {
    let stat;
    try { stat = await fs.stat(candidate); } catch { continue; }
    if (stat.isFile()) {
      if (extensions.includes(path.extname(candidate).toLowerCase())) out.push(candidate);
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...(await walkFiles(candidate, budget)).filter((file) => extensions.includes(path.extname(file).toLowerCase())));
    }
  }
  return [...new Set(out)];
}

async function collectSkills(input: string[], budget: InspectionBudget): Promise<PiManagedPackageSkill[]> {
  const skillFiles: string[] = [];
  for (const candidate of input) {
    let stat;
    try { stat = await fs.stat(candidate); } catch { continue; }
    if (stat.isFile() && path.extname(candidate).toLowerCase() === '.md') skillFiles.push(candidate);
    if (stat.isDirectory()) {
      const files = await walkFiles(candidate, budget);
      skillFiles.push(...files.filter((file) => path.basename(file).toLowerCase() === 'skill.md'));
      // Pi's package convention also treats Markdown files directly under
      // skills/ as individual skills; nested arbitrary Markdown is not a skill.
      try {
        const directEntries = await fs.readdir(candidate, { withFileTypes: true });
        assertInspectionBudget(budget, 0, directEntries.length);
        skillFiles.push(...directEntries
          .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && path.extname(entry.name).toLowerCase() === '.md')
          .map((entry) => path.join(candidate, entry.name)));
      } catch (error) {
        if (error instanceof PiPackageInspectionLimitError) throw error;
        // Missing directories are ignored by Pi's loader.
      }
    }
  }
  const skills: PiManagedPackageSkill[] = [];
  for (const file of [...new Set(skillFiles)]) {
    const root = path.dirname(file);
    let name = path.basename(file, path.extname(file));
    let description: string | undefined;
    try {
      const parsed = matter(await readInspectionMetadata(file, budget));
      if (typeof parsed.data.name === 'string' && parsed.data.name.trim()) name = parsed.data.name.trim();
      if (typeof parsed.data.description === 'string' && parsed.data.description.trim()) {
        description = parsed.data.description.trim();
      }
    } catch (error) {
      if (error instanceof PiPackageInspectionLimitError) throw error;
      // Filename fallback remains usable.
    }
    skills.push({ path: file, name, ...(description ? { description } : {}) });
  }
  return skills;
}

async function collectExtensions(input: string[], budget: InspectionBudget): Promise<string[]> {
  const entries: string[] = [];
  for (const candidate of input) {
    let stat;
    try { stat = await fs.stat(candidate); } catch { continue; }
    if (stat.isFile()) {
      if (/\.(ts|js)$/i.test(candidate)) entries.push(candidate);
      continue;
    }
    const indexTs = path.join(candidate, 'index.ts');
    const indexJs = path.join(candidate, 'index.js');
    try { if ((await fs.stat(indexTs)).isFile()) { entries.push(indexTs); continue; } } catch {}
    try { if ((await fs.stat(indexJs)).isFile()) { entries.push(indexJs); continue; } } catch {}
    let children;
    try { children = await fs.readdir(candidate, { withFileTypes: true }); } catch { continue; }
    assertInspectionBudget(budget, 0, children.length);
    for (const child of children) {
      if (child.name.startsWith('.') || child.name === 'node_modules') continue;
      const childPath = path.join(candidate, child.name);
      if (child.isFile() && /\.(ts|js)$/i.test(child.name)) entries.push(childPath);
      if (child.isDirectory()) {
        for (const filename of ['index.ts', 'index.js']) {
          const nested = path.join(childPath, filename);
          try { if ((await fs.stat(nested)).isFile()) { entries.push(nested); break; } } catch {}
        }
      }
    }
  }
  return [...new Set(entries)];
}

function resourceView(kind: Exclude<PiPackageResourceKind, 'extension'>, file: string): PiPackageResourceView {
  return {
    kind,
    name: kind === 'skill' ? path.basename(path.dirname(file)) : path.basename(file),
    compatibility: kind === 'theme' ? 'unsupported' : 'supported',
  };
}

async function extensionResourceView(root: string, file: string): Promise<PiPackageResourceView> {
  try {
    const analysis = await analyzePiExtensionCompatibility(file, root);
    return {
      kind: 'extension',
      name: path.basename(file),
      compatibility: analysis.compatibility,
      ...(analysis.compatibilityIssues.length > 0
        ? { compatibilityIssues: analysis.compatibilityIssues }
        : {}),
      ...(analysis.detectedApis.length > 0 ? { detectedApis: analysis.detectedApis } : {}),
    };
  } catch {
    return {
      kind: 'extension',
      name: path.basename(file),
      compatibility: 'unknown',
      compatibilityIssues: ['analysis-incomplete'],
    };
  }
}

async function promptCommand(
  file: string,
  budget: InspectionBudget,
): Promise<{ name: string; description: string }> {
  const name = path.basename(file, path.extname(file));
  try {
    const parsed = matter(await readInspectionMetadata(file, budget));
    const description = typeof parsed.data.description === 'string'
      ? parsed.data.description.trim()
      : '';
    return { name, description: description || `Pi prompt template: ${name}` };
  } catch (error) {
    if (error instanceof PiPackageInspectionLimitError) throw error;
    return { name, description: `Pi prompt template: ${name}` };
  }
}

async function inspectPackage(pkg: ListedPackage, state: PiPackageState): Promise<InspectedPackage> {
  const empty: PiManagedPackageResources = {
    extensions: [], skills: [], promptTemplates: [], packageRoots: [],
  };
  const { displaySource, unsafe } = projectPackageSource(pkg.source);
  if (unsafe) {
    return {
      rawSource: pkg.source,
      view: {
        source: displaySource,
        name: displaySource,
        enabled: false,
        manageable: false,
        resources: [],
        warning: 'unsafe-source',
      },
      launch: empty,
      promptCommands: [],
    };
  }
  const explicitlyDisabled = state.disabledSources.includes(pkg.source);
  if (!pkg.installedPath) {
    return {
      rawSource: pkg.source,
      view: {
        source: displaySource,
        name: displaySource,
        enabled: false,
        resources: [],
        warning: 'inspection-failed',
      },
      launch: empty,
      promptCommands: [],
    };
  }
  let installedRoot: string | undefined;
  try {
    const budget = createInspectionBudget();
    const root = await fs.realpath(pkg.installedPath);
    installedRoot = root;
    if (pkg.filtered) {
      return {
        rawSource: pkg.source,
        view: {
          source: displaySource,
          name: displaySource,
          enabled: false,
          resources: [],
          warning: 'unsupported-filter',
        },
        launch: empty,
        promptCommands: [],
        installedRoot: root,
      };
    }
    const rootStat = await fs.stat(root);
    if (rootStat.isFile()) {
      const isExtension = /\.(?:ts|js)$/i.test(root);
      const resources = isExtension ? [await extensionResourceView(path.dirname(root), root)] : [];
      const requiresExtensionApproval = isExtension
        && !state.approvedExtensionSources.includes(pkg.source);
      const enabled = !explicitlyDisabled && !requiresExtensionApproval;
      return {
        rawSource: pkg.source,
        view: {
          source: displaySource,
          name: path.basename(root),
          enabled,
          ...(requiresExtensionApproval ? { requiresExtensionApproval: true } : {}),
          resources,
          ...(resources.length === 0 ? { warning: 'no-resources' as const } : {}),
        },
        launch: enabled && isExtension
          ? { extensions: [root], skills: [], promptTemplates: [], packageRoots: [root] }
          : empty,
        promptCommands: [],
        installedRoot: root,
      };
    }
    const manifestPath = path.join(root, 'package.json');
    let manifest: PackageManifest = {};
    try {
      manifest = JSON.parse(
        (await readUtf8FileBounded(manifestPath, MAX_PACKAGE_JSON_BYTES)).text,
      ) as PackageManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const runtimeRequirements = evaluatePiRuntimeRequirements(
      manifest.peerDependencies,
      await getCurrentPiVersion(),
    );
    const declared = manifest.pi;
    const extensionEntries = normalizeManifestEntries(declared?.extensions, ['extensions']);
    const skillEntries = normalizeManifestEntries(declared?.skills, ['skills']);
    const promptEntries = normalizeManifestEntries(declared?.prompts, ['prompts']);
    const themeEntries = normalizeManifestEntries(declared?.themes, ['themes']);
    const extensionInputs = await expandManifestEntries(root, extensionEntries, budget);
    const skillInputs = await expandSkillManifestEntries(root, skillEntries, budget);
    const promptInputs = await expandManifestEntries(root, promptEntries, budget);
    const themeInputs = await expandManifestEntries(root, themeEntries, budget);
    const [extensions, skills, prompts, themes] = await Promise.all([
      collectExtensions(await confinedExistingPaths(root, extensionInputs), budget),
      collectSkills(await confinedExistingPaths(root, skillInputs), budget),
      collectFilesByExtension(await confinedExistingPaths(root, promptInputs), ['.md'], budget),
      collectFilesByExtension(await confinedExistingPaths(root, themeInputs), ['.json'], budget),
    ]);
    assertInspectionBudget(budget);
    if (extensions.length > MAX_EXTENSION_FILES) throw new PiPackageInspectionLimitError();
    // Babel parsing happens in Electron's main process. Keep analysis
    // sequential and re-check the package-wide wall-clock budget between
    // entries so a package cannot fan out thousands of CPU-heavy parses.
    const extensionResources: PiPackageResourceView[] = [];
    for (const file of extensions) {
      assertInspectionBudget(budget);
      extensionResources.push(await extensionResourceView(root, file));
      assertInspectionBudget(budget);
    }
    const resources: PiPackageResourceView[] = [
      ...extensionResources,
      ...skills.map((skill) => ({ kind: 'skill' as const, name: skill.name, compatibility: 'supported' as const })),
      ...prompts.map((file) => resourceView('prompt', file)),
      ...themes.map((file) => resourceView('theme', file)),
    ];
    const requiresExtensionApproval = extensions.length > 0
      && !state.approvedExtensionSources.includes(pkg.source);
    const enabled = !explicitlyDisabled && !requiresExtensionApproval;
    const promptCommands = enabled
      ? await Promise.all(prompts.map((file) => promptCommand(file, budget)))
      : [];
    const warning = hasDisabledInstallLifecycleScript(manifest.scripts)
      ? 'lifecycle-scripts-disabled' as const
      : resources.length === 0
        ? 'no-resources' as const
        : undefined;
    return {
      rawSource: pkg.source,
      view: {
        source: displaySource,
        name: manifest.name?.trim() || displaySource,
        ...(manifest.version?.trim() ? { version: manifest.version.trim() } : {}),
        enabled,
        ...(requiresExtensionApproval ? { requiresExtensionApproval: true } : {}),
        resources,
        ...(runtimeRequirements.length > 0 ? { runtimeRequirements } : {}),
        ...(warning ? { warning } : {}),
      },
      launch: enabled ? { extensions, skills, promptTemplates: prompts, packageRoots: [root] } : empty,
      promptCommands,
      installedRoot: root,
    };
  } catch (error) {
    log.warn('failed to inspect Pi package', {
      source: displaySource,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      rawSource: pkg.source,
      view: {
        source: displaySource,
        name: displaySource,
        enabled: false,
        resources: [],
        warning: error instanceof PiPackageInspectionLimitError
          ? 'inspection-limit'
          : 'inspection-failed',
      },
      launch: empty,
      promptCommands: [],
      ...(installedRoot ? { installedRoot } : {}),
    };
  }
}

async function inspectAllPackagesUncached(): Promise<InspectedPackage[]> {
  const [{ stdout }, state] = await Promise.all([
    runPiPackageCommand(['list', '--no-approve']),
    readState(),
  ]);
  const listed = parsePiPackageListOutput(stdout);
  const startedAt = Date.now();
  const inspected: InspectedPackage[] = [];
  for (const [index, pkg] of listed.entries()) {
    if (index >= MAX_INSPECTED_PACKAGES || Date.now() - startedAt > MAX_ALL_INSPECTION_MS) {
      const { displaySource, unsafe } = projectPackageSource(pkg.source);
      inspected.push({
        rawSource: pkg.source,
        view: {
          source: displaySource,
          name: displaySource,
          enabled: false,
          ...(unsafe ? { manageable: false as const } : {}),
          resources: [],
          warning: unsafe ? 'unsafe-source' : 'inspection-limit',
        },
        launch: { extensions: [], skills: [], promptTemplates: [], packageRoots: [] },
        promptCommands: [],
      });
      continue;
    }
    inspected.push(await inspectPackage(pkg, state));
    // Package inspection includes synchronous parser work in Electron's main
    // process. Yield between packages so a long roster cannot monopolize it.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return inspected;
}

function invalidateInspectionCache(): void {
  inspectionGeneration += 1;
  inspectionCache = undefined;
  inspectionPromise = undefined;
}

async function inspectAllPackages(): Promise<InspectedPackage[]> {
  if (inspectionCache && inspectionCache.expiresAt > Date.now()) return inspectionCache.value;
  if (inspectionPromise) return inspectionPromise;
  const generation = inspectionGeneration;
  const pending = inspectAllPackagesUncached().then((value) => {
    if (generation === inspectionGeneration) {
      inspectionCache = { expiresAt: Date.now() + INSPECTION_CACHE_MS, value };
    }
    return value;
  }).finally(() => {
    if (inspectionPromise === pending) inspectionPromise = undefined;
  });
  inspectionPromise = pending;
  return pending;
}

async function listPiPackagesNow(): Promise<PiPackageListResult> {
  if (!getReadyBinaryPath('pi')) return { available: false, packages: [] };
  const inspected = await inspectAllPackages();
  return { available: true, packages: inspected.map((pkg) => pkg.view) };
}

export async function listPiPackages(): Promise<PiPackageListResult> {
  await mutationTail;
  return listPiPackagesNow();
}

export async function resolveManagedPiPackageResources(
  options?: { snapshotRoot: string },
): Promise<PiManagedPackageResources> {
  if (!getReadyBinaryPath('pi')) {
    return { extensions: [], skills: [], promptTemplates: [], packageRoots: [] };
  }
  try {
    const resolveResources = async (): Promise<PiManagedPackageResources> => {
      const inspected = await inspectAllPackages();
      const resources = {
        extensions: [...new Set(inspected.flatMap((pkg) => pkg.launch.extensions))],
        skills: inspected.flatMap((pkg) => pkg.launch.skills),
        promptTemplates: [...new Set(inspected.flatMap((pkg) => pkg.launch.promptTemplates))],
        packageRoots: [...new Set(inspected.flatMap((pkg) => pkg.launch.packageRoots))],
      };
      return options ? stageManagedPackageSnapshot(resources, options.snapshotRoot) : resources;
    };
    if (options) return await enqueueMutation(resolveResources);
    await mutationTail;
    return await resolveResources();
  } catch (error) {
    log.warn('Pi package resources unavailable; starting without user packages', {
      message: error instanceof Error ? error.message : String(error),
    });
    return { extensions: [], skills: [], promptTemplates: [], packageRoots: [] };
  }
}

export async function listManagedPiPromptCommands(): Promise<Array<{ name: string; description: string }>> {
  await mutationTail;
  try {
    const inspected = await inspectAllPackages();
    return inspected.flatMap((pkg) => pkg.promptCommands);
  } catch {
    return [];
  }
}

function requireSource(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Pi package source is required');
  const source = value.trim();
  if (!source || source.startsWith('-') || source.length > MAX_SOURCE_LENGTH || /[\r\n\0]/.test(source)) {
    throw new Error('Invalid Pi package source');
  }
  const urlSource = source.startsWith('git:') ? source.slice(4) : source;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(urlSource)) {
    let parsed: URL;
    try {
      parsed = new URL(urlSource);
    } catch {
      throw new Error('Invalid Pi package source URL');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('Pi package source URLs must not contain embedded credentials or query data');
    }
  }
  return normalizeRequestedPackageSource(source);
}

function normalizeRequestedPackageSource(source: string): string {
  // Pi requires the npm: prefix and otherwise interprets a bare package name
  // as a path relative to PI_CODING_AGENT_DIR. Accept the common package-page
  // shorthand while preserving every explicit URL, git source, and local path.
  const unscoped = /^[a-z0-9][a-z0-9._-]*(?:@[^/@\s]+)?$/i;
  const scoped = /^@[^/@\s]+\/[a-z0-9][a-z0-9._-]*(?:@[^/@\s]+)?$/i;
  return unscoped.test(source) || scoped.test(source) ? `npm:${source}` : source;
}

function projectPackageSource(source: string): PackageSourceProjection {
  const gitPrefix = source.startsWith('git:') ? 'git:' : '';
  const urlSource = gitPrefix ? source.slice(gitPrefix.length) : source;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(urlSource)) {
    return { displaySource: source, unsafe: false };
  }
  let parsed: URL;
  try {
    parsed = new URL(urlSource);
  } catch {
    const scheme = urlSource.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1] ?? 'url';
    return { displaySource: `${gitPrefix}${scheme}://[invalid-source]`, unsafe: true };
  }
  const unsafe = Boolean(parsed.username || parsed.password || parsed.search || parsed.hash);
  if (!unsafe) return { displaySource: source, unsafe: false };
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return { displaySource: `${gitPrefix}${parsed.toString()}`, unsafe: true };
}

function redactPackageCommandMessage(message: string): string {
  return message.replace(PACKAGE_URL_PATTERN, (source) => projectPackageSource(source).displaySource);
}

export function findAffectedPiPackage(packages: PiPackageView[], requestedSource: string): PiPackageView | undefined {
  const candidates = new Set([requestedSource]);
  if (!isLocalPackageSource(requestedSource) && !requestedSource.includes(':') && !requestedSource.includes('://')) {
    candidates.add(`npm:${requestedSource}`);
  }
  return packages.find((pkg) => candidates.has(pkg.source));
}

function isLocalPackageSource(source: string): boolean {
  return path.isAbsolute(source)
    || source === '.'
    || source.startsWith(`.${path.sep}`)
    || source.startsWith(`..${path.sep}`)
    || source.startsWith('./')
    || source.startsWith('../');
}

async function canonicalLocalPackageSource(source: string): Promise<string | undefined> {
  if (!isLocalPackageSource(source)) return undefined;
  try {
    return await fs.realpath(path.resolve(packageHome(), source));
  } catch {
    return undefined;
  }
}

async function findAffectedInspectedPackage(
  packages: InspectedPackage[],
  requestedSource: string,
): Promise<InspectedPackage | undefined> {
  const candidates = new Set(sourceAliases(requestedSource));
  const bySource = packages.find((pkg) => candidates.has(pkg.rawSource));
  if (bySource) return bySource;
  const requestedRoot = await canonicalLocalPackageSource(requestedSource);
  if (!requestedRoot) return undefined;
  return packages.find((pkg) => pkg.installedRoot === requestedRoot);
}

function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  // mutationTail prevents overlapping work inside one Main process. The
  // strict file lock extends the same critical section across packaged, dev,
  // and --passive instances sharing userData. It also recovers abandoned locks
  // after an owner exits and releases normally when an operation times out.
  const result = mutationTail.then(() => withPiPackageMutationLock(operation));
  mutationTail = result.then(() => undefined, () => undefined);
  return result;
}

function isWithinPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

class PiPackageSnapshotLimitError extends Error {
  constructor() {
    super('Pi extension snapshot exceeds the safe resource limit');
    this.name = 'PiPackageSnapshotLimitError';
  }
}

interface SnapshotCopyBudget {
  startedAt: number;
  entries: number;
  bytes: number;
  activeDirectories: Set<string>;
  limits: PiPackageSnapshotLimits;
}

function assertSnapshotBudget(budget: SnapshotCopyBudget, additionalBytes = 0): void {
  if (
    budget.entries > budget.limits.maxEntries
    || budget.bytes + additionalBytes > budget.limits.maxBytes
    || Date.now() - budget.startedAt >= budget.limits.maxDurationMs
  ) {
    throw new PiPackageSnapshotLimitError();
  }
}

async function copySnapshotEntryBounded(
  confinementRoot: string,
  sourcePath: string,
  targetPath: string,
  budget: SnapshotCopyBudget,
): Promise<void> {
  assertSnapshotBudget(budget);
  const canonicalSource = await fs.realpath(sourcePath);
  if (!isWithinPath(confinementRoot, canonicalSource)) {
    throw new Error('Pi extension snapshot contains an escaped link');
  }
  const sourceStat = await fs.stat(canonicalSource);
  budget.entries += 1;
  assertSnapshotBudget(budget, sourceStat.isFile() ? sourceStat.size : 0);

  if (sourceStat.isDirectory()) {
    if (budget.activeDirectories.has(canonicalSource)) {
      throw new Error('Pi extension snapshot contains a cyclic link');
    }
    budget.activeDirectories.add(canonicalSource);
    const directory = await fs.opendir(canonicalSource);
    try {
      await fs.mkdir(targetPath, { mode: sourceStat.mode & 0o777 });
      for await (const entry of directory) {
        await copySnapshotEntryBounded(
          confinementRoot,
          path.join(canonicalSource, entry.name),
          path.join(targetPath, entry.name),
          budget,
        );
      }
    } finally {
      await directory.close().catch(() => undefined);
      budget.activeDirectories.delete(canonicalSource);
    }
    return;
  }
  if (!sourceStat.isFile()) throw new Error('Pi extension snapshot contains a special file');

  const sourceHandle = await fs.open(canonicalSource, 'r');
  let targetHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    targetHandle = await fs.open(targetPath, 'wx', sourceStat.mode & 0o777);
    const chunk = Buffer.allocUnsafe(SNAPSHOT_COPY_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      assertSnapshotBudget(budget);
      const { bytesRead } = await sourceHandle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      assertSnapshotBudget(budget, bytesRead);
      await targetHandle.write(chunk, 0, bytesRead, position);
      budget.bytes += bytesRead;
      position += bytesRead;
    }
  } finally {
    await sourceHandle.close().catch(() => undefined);
    await targetHandle?.close().catch(() => undefined);
  }
}

function mapSnapshotPath(
  sourcePath: string,
  mappings: Array<{ source: string; target: string; directory: boolean }>,
): string {
  const resolved = path.resolve(sourcePath);
  for (const mapping of mappings) {
    if (!mapping.directory && resolved === mapping.source) return mapping.target;
    if (mapping.directory && isWithinPath(mapping.source, resolved)) {
      return path.join(mapping.target, path.relative(mapping.source, resolved));
    }
  }
  throw new Error('Pi extension resource is outside its inspected package root');
}

export async function stageManagedPackageSnapshot(
  resources: PiManagedPackageResources,
  snapshotRoot: string,
  limits: PiPackageSnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): Promise<PiManagedPackageResources> {
  if (!path.isAbsolute(snapshotRoot)) throw new Error('Pi extension snapshot root must be absolute');
  const temporaryRoot = `${snapshotRoot}.tmp-${process.pid}-${Date.now()}`;
  const mappings: Array<{ source: string; target: string; directory: boolean }> = [];
  const budget: SnapshotCopyBudget = {
    startedAt: Date.now(),
    entries: 0,
    bytes: 0,
    activeDirectories: new Set(),
    limits,
  };
  try {
    await fs.mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    for (const [index, rawRoot] of resources.packageRoots.entries()) {
      const source = await fs.realpath(rawRoot);
      const sourceStat = await fs.stat(source);
      const directory = sourceStat.isDirectory();
      if (!directory && !sourceStat.isFile()) throw new Error('Pi extension package root is not a file or directory');
      const relativeTarget = directory ? String(index) : path.join(String(index), path.basename(source));
      const temporaryTarget = path.join(temporaryRoot, relativeTarget);
      await fs.mkdir(path.dirname(temporaryTarget), { recursive: true, mode: 0o700 });
      await copySnapshotEntryBounded(source, source, temporaryTarget, budget);
      mappings.push({ source, target: path.join(snapshotRoot, relativeTarget), directory });
    }
    await fs.rename(temporaryRoot, snapshotRoot);
    return {
      extensions: resources.extensions.map((entry) => mapSnapshotPath(entry, mappings)),
      skills: resources.skills.map((skill) => ({ ...skill, path: mapSnapshotPath(skill.path, mappings) })),
      promptTemplates: resources.promptTemplates.map((entry) => mapSnapshotPath(entry, mappings)),
      packageRoots: mappings.map((mapping) => mapping.target),
    };
  } catch (error) {
    await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function revokeExtensionApproval(sources: Iterable<string>): Promise<void> {
  const targets = new Set(sources);
  if (targets.size === 0) return;
  const state = await readState();
  const approvedExtensionSources = state.approvedExtensionSources
    .filter((source) => !targets.has(source));
  if (approvedExtensionSources.length === state.approvedExtensionSources.length) return;
  await writeState({ ...state, approvedExtensionSources });
}

function sourceAliases(source: string): string[] {
  return source.includes(':') || source.includes('://') || isLocalPackageSource(source)
    ? [source]
    : [source, `npm:${source}`];
}

function mutationCommandSource(
  requestedSource: string,
  installed: InspectedPackage | undefined,
): string {
  return installed?.installedRoot && isLocalPackageSource(installed.rawSource)
    ? installed.installedRoot
    : requestedSource;
}

export async function mutatePiPackage(
  request: PiPackageMutationRequest,
  grant?: PiPackageMutationGrant,
): Promise<PiPackageMutationResult> {
  if (piPackageMutationNeedsGrant(request)) {
    // The grant is an in-process, one-shot capability issued only after Main
    // observed a real user decision (or an exact whole user command). Renderer
    // booleans and Full Access never cross this boundary.
    consumePiPackageMutationGrant(request, grant);
  }
  const source = requireSource(request.source);
  if (request.action === 'install' && isRelativeLocalPiPackageSource(source)) {
    throw new Error('Relative local Pi package sources require a task working directory');
  }
  let mutationMayHaveChangedState = false;
  return enqueueMutation(async () => {
    // A list/runtime resource read that started before this mutation may still
    // be walking package files. Let it finish before Pi rewrites the install
    // tree; new reads already wait on mutationTail and cannot enter here.
    await inspectionPromise?.catch(() => undefined);
    let affectedSource: string | undefined;
    if (request.action === 'install') {
      mutationMayHaveChangedState = true;
      // Reinstalling an existing source can replace executable code. Revoke
      // before invoking Pi so even a partially failed install cannot inherit a
      // stale approval on the next runtime.
      const previous = await findAffectedInspectedPackage(await inspectAllPackages(), source);
      await revokeExtensionApproval([
        ...sourceAliases(source),
        ...(previous ? sourceAliases(previous.rawSource) : []),
      ]);
      invalidateInspectionCache();
      await runPiPackageCommand(['install', source, '--no-approve']);
      invalidateInspectionCache();
      const affected = await findAffectedInspectedPackage(await inspectAllPackages(), source);
      affectedSource = affected?.rawSource;
      await revokeExtensionApproval([
        ...sourceAliases(source),
        ...(affectedSource ? sourceAliases(affectedSource) : []),
      ]);
    } else if (request.action === 'remove') {
      mutationMayHaveChangedState = true;
      const previous = await findAffectedInspectedPackage(await inspectAllPackages(), source);
      await runPiPackageCommand([
        'remove',
        mutationCommandSource(source, previous),
        '--no-approve',
      ]);
      const state = await readState();
      const removedSources = new Set([
        ...sourceAliases(source),
        ...(previous ? sourceAliases(previous.rawSource) : []),
      ]);
      await writeState({
        version: STATE_VERSION,
        disabledSources: state.disabledSources.filter((item) => !removedSources.has(item)),
        approvedExtensionSources: state.approvedExtensionSources.filter((item) => !removedSources.has(item)),
      });
    } else if (request.action === 'update') {
      mutationMayHaveChangedState = true;
      const previous = await findAffectedInspectedPackage(await inspectAllPackages(), source);
      await revokeExtensionApproval([
        ...sourceAliases(source),
        ...(previous ? sourceAliases(previous.rawSource) : []),
      ]);
      invalidateInspectionCache();
      await runPiPackageCommand([
        'update',
        mutationCommandSource(source, previous),
        '--no-approve',
      ]);
      invalidateInspectionCache();
      const affected = await findAffectedInspectedPackage(await inspectAllPackages(), source);
      affectedSource = affected?.rawSource ?? previous?.rawSource ?? source;
      // An update changes executable code. Require a fresh, post-inspection
      // approval before any extension from that source can run again.
      await revokeExtensionApproval([
        ...sourceAliases(source),
        ...sourceAliases(affectedSource),
      ]);
    } else if (request.action === 'set-enabled') {
      if (typeof request.enabled !== 'boolean') throw new Error('enabled must be a boolean');
      const current = await listPiPackagesNow();
      const target = findAffectedPiPackage(current.packages, source);
      if (!target) throw new Error('Pi package is not installed');
      affectedSource = target.source;
      const state = await readState();
      const disabled = new Set(state.disabledSources);
      const approved = new Set(state.approvedExtensionSources);
      if (request.enabled) {
        if (target.resources.some((resource) => resource.kind === 'extension')) {
          approved.add(target.source);
        }
        disabled.delete(target.source);
      } else {
        disabled.add(target.source);
      }
      // writeState atomically replaces the state file. Mark the mutation before
      // entering that durable write so a successful write followed by a failed
      // inspection still invalidates caches and notifies every open Renderer.
      mutationMayHaveChangedState = true;
      await writeState({
        version: STATE_VERSION,
        disabledSources: [...disabled].sort(),
        approvedExtensionSources: [...approved].sort(),
      });
    }
    invalidateInspectionCache();
    const result = await listPiPackagesNow();
    const affectedPackage = affectedSource
      ? findAffectedPiPackage(result.packages, affectedSource)
      : findAffectedPiPackage(result.packages, source);
    const mutationResult = { ...result, changed: true, ...(affectedPackage ? { affectedPackage } : {}) };
    notifyPiPackagesChanged();
    return mutationResult;
  }).catch((error) => {
    // Any action may already have changed Pi's package tree or Cindy's state
    // before a later CLI/inspection step reports failure. Refresh every open
    // Settings view and command palette instead of leaving stale state visible
    // until the next manual reload.
    if (mutationMayHaveChangedState) {
      invalidateInspectionCache();
      notifyPiPackagesChanged();
    }
    throw error;
  });
}

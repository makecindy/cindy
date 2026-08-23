/**
 * Cindy-owned Pi package store.
 *
 * Pi's own package CLI owns source parsing, downloads, dependency installation,
 * updates, and removal. Cindy gives it an isolated PI_CODING_AGENT_DIR under
 * userData, then inspects the installed package roots for the explicit resource
 * paths that may be projected into a normal local Pi runtime.
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, unwatchFile, watchFile, type Stats } from 'node:fs';
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
import { atomicWriteFileSync } from '../utils/atomicWriteFile.js';
import {
  analyzePiExtensionCompatibility,
  evaluatePiRuntimeRequirements,
} from './pi-package-compatibility.js';
import {
  isWithinConfinement,
  openConstrainedRegularFile,
  resolveStablePackagePath,
  sameStableFileIdentity,
} from './pi-package-file-boundary.js';
import {
  consumePiPackageMutationGrant,
  piPackageMutationNeedsGrant,
  type PiPackageMutationGrant,
  type PiPackageMutationGrantBinding,
} from './pi-package-mutation-grant.js';
import { escapePiPackageNativeDialogText } from './pi-package-native-dialog.js';
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
const MAX_DISPLAY_NAME_BYTES = 256;
const MAX_DISPLAY_VERSION_BYTES = 128;
const MAX_DISPLAY_DESCRIPTION_BYTES = 1_024;
const DISPLAY_TRUNCATION_MARKER = '…';
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
const STATE_VERSION = 3;
const CHANGE_TOKEN_POLL_MS = 250;
const changeListeners = new Set<() => void>();
let changeTokenWatcherActive = false;
let lastObservedChangeToken: string | null | undefined;
let changeTokenReadInFlight: Promise<void> | undefined;
let changeTokenReadQueued = false;
const changeTokenWatchListener = () => void observePiPackageChangeToken();
const PACKAGE_URL_PATTERN = /(?:git:)?[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi;
const INSTALL_LIFECYCLE_SCRIPTS = new Set([
  'preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly',
]);

export function onPiPackagesChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  startPiPackageChangeTokenWatcher();
  return () => {
    changeListeners.delete(listener);
    if (changeListeners.size === 0) stopPiPackageChangeTokenWatcher();
  };
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

async function readPiPackageChangeToken(): Promise<string | null> {
  try {
    const handle = await fs.open(changeTokenPath(), 'r');
    try {
      const stat = await handle.stat();
      if (stat.size > 512) throw new Error('Pi package change token is invalid');
      return (await handle.readFile('utf8')).trim() || null;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function observePiPackageChangeToken(): Promise<void> {
  if (changeTokenReadInFlight) {
    changeTokenReadQueued = true;
    return changeTokenReadInFlight;
  }
  const pending = readPiPackageChangeToken().then((token) => {
    if (lastObservedChangeToken === undefined) {
      lastObservedChangeToken = token;
      return;
    }
    if (token === lastObservedChangeToken) return;
    lastObservedChangeToken = token;
    invalidateInspectionCache();
    notifyPiPackagesChanged();
  }).catch((error) => {
    log.warn('Pi package change token observation failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }).finally(() => {
    if (changeTokenReadInFlight === pending) changeTokenReadInFlight = undefined;
    if (changeTokenReadQueued) {
      changeTokenReadQueued = false;
      void observePiPackageChangeToken();
    }
  });
  changeTokenReadInFlight = pending;
  return pending;
}

function startPiPackageChangeTokenWatcher(): void {
  if (changeTokenWatcherActive) return;
  changeTokenWatcherActive = true;
  void observePiPackageChangeToken();
  watchFile(
    changeTokenPath(),
    { interval: CHANGE_TOKEN_POLL_MS, persistent: false },
    changeTokenWatchListener,
  );
}

function stopPiPackageChangeTokenWatcher(): void {
  if (!changeTokenWatcherActive) return;
  changeTokenWatcherActive = false;
  unwatchFile(changeTokenPath(), changeTokenWatchListener);
}

type SnapshotUnavailableWarning = 'inspection-failed' | 'inspection-limit';

interface PiPackageState {
  version: typeof STATE_VERSION;
  disabledSources: string[];
  approvedExtensionSources: string[];
  approvedExtensionFingerprints: Record<string, string>;
  snapshotUnavailableRoots: Record<string, SnapshotUnavailableWarning>;
}

type PiPackageStateReadResult =
  | { ok: true; state: PiPackageState }
  | { ok: false; error: unknown };

class PiPackageStateUnavailableError extends Error {
  constructor() {
    super('Pi extension state is unavailable');
    this.name = 'PiPackageStateUnavailableError';
  }
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
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
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
  /** Complete content identity of the exact root that a session would copy. */
  contentFingerprint?: string;
  /** Persisted approval exists but no longer matches the current package tree. */
  staleApproval?: boolean;
}

interface PackageSourceProjection {
  displaySource: string;
  unsafe: boolean;
}

interface FreshExtensionApprovalIdentity {
  closureFingerprint: string;
  installedRoot: string;
  snapshotRoot: string;
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
const snapshotUnavailableRoots = new Map<string, SnapshotUnavailableWarning>();

function packageHome(): string {
  return path.join(app.getPath('userData'), 'pi-package-home');
}

async function snapshotRootForInstalledPackage(
  source: string,
  installedRoot: string,
): Promise<string> {
  if (!source.startsWith('npm:')) return installedRoot;
  try {
    const npmRoot = await fs.realpath(path.join(packageHome(), 'npm'));
    const nodeModulesRoot = await fs.realpath(path.join(npmRoot, 'node_modules'));
    // Pi installs registry packages below one shared npm/node_modules tree.
    // Snapshot that resolver root so hoisted siblings remain reachable from
    // the copied extension. A forged/out-of-store list entry falls back to
    // its own package root instead of widening the copy boundary.
    return installedRoot !== nodeModulesRoot
      && isWithinConfinement(nodeModulesRoot, installedRoot)
      ? npmRoot
      : installedRoot;
  } catch {
    return installedRoot;
  }
}

function statePath(): string {
  return path.join(packageHome(), 'cindy-package-state.json');
}

function changeTokenPath(): string {
  return path.join(packageHome(), 'cindy-package-change-token');
}

async function persistPiPackageChangeToken(): Promise<void> {
  const token = `${Date.now()}-${process.pid}-${randomUUID()}`;
  // Set the local baseline before the atomic publish. The local process emits
  // synchronously below; its watcher must not duplicate the same refresh.
  lastObservedChangeToken = token;
  atomicWriteFileSync(changeTokenPath(), `${token}\n`);
}

async function publishPiPackagesChanged(options: { invalidateCache?: boolean } = {}): Promise<void> {
  await persistPiPackageChangeToken();
  if (options.invalidateCache !== false) invalidateInspectionCache();
  notifyPiPackagesChanged();
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

function parseApprovedExtensionFingerprints(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([source, fingerprint]) => (
    source.length > 0
    && typeof fingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(fingerprint)
  ))) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

function parseSnapshotUnavailableRoots(
  value: unknown,
): Record<string, SnapshotUnavailableWarning> | undefined {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (
    entries.length > MAX_INSPECTED_PACKAGES
    || !entries.every(([root, warning]) => (
      root.length > 0
      && root.length <= MAX_SOURCE_LENGTH
      && (warning === 'inspection-failed' || warning === 'inspection-limit')
    ))
  ) return undefined;
  return Object.fromEntries(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  ) as Record<string, SnapshotUnavailableWarning>;
}

function applySharedSnapshotUnavailableRoots(
  roots: Readonly<Record<string, SnapshotUnavailableWarning>>,
): void {
  snapshotUnavailableRoots.clear();
  for (const [root, warning] of Object.entries(roots)) {
    snapshotUnavailableRoots.set(path.resolve(root), warning);
  }
}

function emptyState(): PiPackageState {
  return {
    version: STATE_VERSION,
    disabledSources: [],
    approvedExtensionSources: [],
    approvedExtensionFingerprints: {},
    snapshotUnavailableRoots: {},
  };
}

async function readState(): Promise<PiPackageStateReadResult> {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath(), 'utf8')) as Record<string, unknown>;
    const fingerprints = parseApprovedExtensionFingerprints(
      parsed.approvedExtensionFingerprints,
    );
    const unavailableRoots = parseSnapshotUnavailableRoots(parsed.snapshotUnavailableRoots);
    if (
      parsed.version === STATE_VERSION
      && Array.isArray(parsed.disabledSources)
      && parsed.disabledSources.every((source) => typeof source === 'string')
      && Array.isArray(parsed.approvedExtensionSources)
      && parsed.approvedExtensionSources.every((source) => typeof source === 'string')
      && fingerprints
      && unavailableRoots
    ) {
      const approvedExtensionSources = [...new Set(parsed.approvedExtensionSources)]
        .filter((source) => Object.hasOwn(fingerprints, source));
      return {
        ok: true,
        state: {
          version: STATE_VERSION,
          disabledSources: [...new Set(parsed.disabledSources)],
          approvedExtensionSources,
          approvedExtensionFingerprints: Object.fromEntries(
            approvedExtensionSources.map((source) => [source, fingerprints[source]!]),
          ),
          snapshotUnavailableRoots: unavailableRoots,
        },
      };
    }
    if (
      (parsed.version === 1 || parsed.version === 2)
      && Array.isArray(parsed.disabledSources)
      && parsed.disabledSources.every((source) => typeof source === 'string')
    ) {
      // Preserve explicit disables. Older approvals had no byte identity, so
      // they cannot authorize executable code under the v3 content boundary.
      return {
        ok: true,
        state: {
          version: STATE_VERSION,
          disabledSources: [...new Set(parsed.disabledSources)],
          approvedExtensionSources: [],
          approvedExtensionFingerprints: {},
          snapshotUnavailableRoots: {},
        },
      };
    }
    throw new Error('Pi extension state has an invalid structure');
  } catch (error) {
    // A missing file is the expected initial state before Cindy has persisted
    // any package preference. Every other read/parse failure is distinct: an
    // empty fallback there could silently re-enable a package the user disabled.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, state: emptyState() };
    }
    log.warn('failed to read Pi extension state', {
      message: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error };
  }
}

async function requireState(): Promise<PiPackageState> {
  const result = await readState();
  if (!result.ok) throw new PiPackageStateUnavailableError();
  return result.state;
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

interface RunPiPackageCommandOptions {
  /** Reject successful commands whose stdout could not be retained in full. */
  requireCompleteStdout?: boolean;
}

function truncateDisplayField(value: string, maxBytes: number): string {
  const trimmed = value.trim();
  if (Buffer.byteLength(trimmed, 'utf8') <= maxBytes) return trimmed;
  const budget = maxBytes - Buffer.byteLength(DISPLAY_TRUNCATION_MARKER, 'utf8');
  let bytes = 0;
  let truncated = '';
  for (const character of trimmed) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > budget) break;
    truncated += character;
    bytes += characterBytes;
  }
  return `${truncated}${DISPLAY_TRUNCATION_MARKER}`;
}

export async function runPiPackageCommand(
  args: string[],
  timeoutMs = COMMAND_TIMEOUT_MS,
  options: RunPiPackageCommandOptions = {},
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
    let stdoutBytes = 0;
    let stdoutTruncated = false;
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
        // A platform tree-termination routine that can prove descendants are
        // gone may still leave inherited stdio open. Give it one final grace
        // window, then reject so the cross-process mutation lock is released.
        forceSettleTimer = setTimeout(() => {
          childClosedAfterTimeout = true;
          settleTimedOutCommand();
        }, COMMAND_FORCE_SETTLE_MS);
        forceSettleTimer.unref?.();
      }, {
        // A timed-out package manager may outlive the direct Pi child while
        // retaining inherited stdio and write access to the shared store.
        // Windows strict mode never sends taskkill to a reusable PID; without
        // a launch-time Job Object it withholds onSettled so this mutation lock
        // remains fail closed until restart rather than risking another process.
        requireWindowsIdentityBoundTermination: true,
      });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      stdoutTruncated = stdoutTruncated || stdoutBytes > MAX_COMMAND_OUTPUT_BYTES;
      stdout = boundedAppend(stdout, chunk);
    });
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
      if (code === 0) {
        if (options.requireCompleteStdout && stdoutTruncated) {
          reject(new Error('Pi package list output exceeded the safe limit'));
          return;
        }
        resolve({ stdout, stderr });
      }
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
  confinementRoot: string,
): Promise<{ text: string; bytes: number }> {
  const { handle, stat } = await openConstrainedRegularFile(
    confinementRoot,
    file,
    'Pi package metadata contains an escaped link',
    'Pi package metadata changed before reading',
  );
  try {
    if (stat.size > maxBytes) throw new PiPackageInspectionLimitError();
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    if (bytes > maxBytes) throw new PiPackageInspectionLimitError();
    const after = await handle.stat();
    if (!sameStableFileIdentity(stat, after) || bytes !== after.size) {
      throw new Error('Pi package metadata changed while reading');
    }
    return { text: buffer.subarray(0, bytes).toString('utf8'), bytes };
  } finally {
    await handle.close();
  }
}

async function readInspectionMetadata(
  file: string,
  budget: InspectionBudget,
  confinementRoot: string,
): Promise<string> {
  const remaining = MAX_INSPECTION_METADATA_BYTES - budget.metadataBytes;
  if (remaining < 0) throw new PiPackageInspectionLimitError();
  const result = await readUtf8FileBounded(file, remaining, confinementRoot);
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

async function collectSkills(
  input: string[],
  budget: InspectionBudget,
  confinementRoot: string,
): Promise<PiManagedPackageSkill[]> {
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
    let name = path.basename(file, path.extname(file));
    let description: string | undefined;
    try {
      const parsed = matter(await readInspectionMetadata(file, budget, confinementRoot));
      if (typeof parsed.data.name === 'string' && parsed.data.name.trim()) name = parsed.data.name.trim();
      if (typeof parsed.data.description === 'string' && parsed.data.description.trim()) {
        description = parsed.data.description.trim();
      }
    } catch (error) {
      if (error instanceof PiPackageInspectionLimitError) throw error;
      // Filename fallback remains usable.
    }
    skills.push({
      path: file,
      name: truncateDisplayField(name, MAX_DISPLAY_NAME_BYTES),
      ...(description
        ? { description: truncateDisplayField(description, MAX_DISPLAY_DESCRIPTION_BYTES) }
        : {}),
    });
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
    name: truncateDisplayField(
      kind === 'skill' ? path.basename(path.dirname(file)) : path.basename(file),
      MAX_DISPLAY_NAME_BYTES,
    ),
    compatibility: kind === 'theme' ? 'unsupported' : 'supported',
  };
}

async function extensionResourceView(root: string, file: string): Promise<PiPackageResourceView> {
  try {
    const analysis = await analyzePiExtensionCompatibility(file, root);
    return {
      kind: 'extension',
      name: truncateDisplayField(path.basename(file), MAX_DISPLAY_NAME_BYTES),
      compatibility: analysis.compatibility,
      ...(analysis.compatibilityIssues.length > 0
        ? { compatibilityIssues: analysis.compatibilityIssues }
        : {}),
      ...(analysis.detectedApis.length > 0 ? { detectedApis: analysis.detectedApis } : {}),
    };
  } catch {
    return {
      kind: 'extension',
      name: truncateDisplayField(path.basename(file), MAX_DISPLAY_NAME_BYTES),
      compatibility: 'unknown',
      compatibilityIssues: ['analysis-incomplete'],
    };
  }
}

async function promptCommand(
  file: string,
  budget: InspectionBudget,
  confinementRoot: string,
): Promise<{ name: string; description: string }> {
  const name = truncateDisplayField(
    path.basename(file, path.extname(file)),
    MAX_DISPLAY_NAME_BYTES,
  );
  try {
    const parsed = matter(await readInspectionMetadata(file, budget, confinementRoot));
    const description = typeof parsed.data.description === 'string'
      ? parsed.data.description.trim()
      : '';
    return {
      name,
      description: truncateDisplayField(
        description || `Pi prompt template: ${name}`,
        MAX_DISPLAY_DESCRIPTION_BYTES,
      ),
    };
  } catch (error) {
    if (error instanceof PiPackageInspectionLimitError) throw error;
    return {
      name,
      description: truncateDisplayField(
        `Pi prompt template: ${name}`,
        MAX_DISPLAY_DESCRIPTION_BYTES,
      ),
    };
  }
}

function fingerprintPackageTreeCached(
  root: string,
  cache: Map<string, Promise<string>>,
  aggregateBudget: SnapshotBudgetCounters,
): Promise<string> {
  const current = cache.get(root);
  if (current) return current;
  const pending = fingerprintPiPackageTree(root, DEFAULT_SNAPSHOT_LIMITS, aggregateBudget);
  cache.set(root, pending);
  return pending;
}

function hasApprovedExtensionFingerprint(
  state: PiPackageState,
  source: string,
  fingerprint: string,
): boolean {
  return state.approvedExtensionSources.includes(source)
    && state.approvedExtensionFingerprints[source] === fingerprint;
}

function hasToggleableResources(resources: PiPackageResourceView[]): boolean {
  return resources.some((resource) => (
    resource.kind === 'extension'
    || resource.kind === 'skill'
    || resource.kind === 'prompt'
  ));
}

async function inspectPackage(
  pkg: ListedPackage,
  state: PiPackageState,
  fingerprintCache: Map<string, Promise<string>>,
  aggregateFingerprintBudget: SnapshotBudgetCounters,
): Promise<InspectedPackage> {
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
        canToggle: false,
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
    const { canonicalPath: root, stat: rootStat } = await resolveStablePackagePath(
      pkg.installedPath,
      'Pi package root changed during inspection',
    );
    installedRoot = root;
    if (pkg.filtered) {
      return {
        rawSource: pkg.source,
        view: {
          source: displaySource,
          name: displaySource,
          enabled: false,
          canToggle: false,
          resources: [],
          warning: 'unsupported-filter',
        },
        launch: empty,
        promptCommands: [],
        installedRoot: root,
      };
    }
    if (rootStat.isFile()) {
      const isExtension = /\.(?:ts|js)$/i.test(root);
      const launchRoot = await snapshotRootForInstalledPackage(pkg.source, root);
      const resources = isExtension ? [await extensionResourceView(path.dirname(root), root)] : [];
      const contentFingerprint = isExtension
        ? await fingerprintPackageTreeCached(
            launchRoot,
            fingerprintCache,
            aggregateFingerprintBudget,
          )
        : undefined;
      const requiresExtensionApproval = isExtension && !(
        contentFingerprint
        && hasApprovedExtensionFingerprint(state, pkg.source, contentFingerprint)
      );
      const staleApproval = isExtension
        && state.approvedExtensionSources.includes(pkg.source)
        && requiresExtensionApproval;
      const enabled = isExtension && !explicitlyDisabled && !requiresExtensionApproval;
      return {
        rawSource: pkg.source,
        view: {
          source: displaySource,
          name: truncateDisplayField(path.basename(root), MAX_DISPLAY_NAME_BYTES),
          enabled,
          ...(!isExtension ? { canToggle: false as const } : {}),
          ...(requiresExtensionApproval ? { requiresExtensionApproval: true } : {}),
          resources,
          ...(resources.length === 0 ? { warning: 'no-resources' as const } : {}),
        },
        launch: enabled && isExtension
          ? { extensions: [root], skills: [], promptTemplates: [], packageRoots: [launchRoot] }
          : empty,
        promptCommands: [],
        installedRoot: root,
        ...(contentFingerprint ? { contentFingerprint } : {}),
        ...(staleApproval ? { staleApproval: true } : {}),
      };
    }
    const manifestPath = path.join(root, 'package.json');
    let manifest: PackageManifest = {};
    try {
      manifest = JSON.parse(
        (await readUtf8FileBounded(manifestPath, MAX_PACKAGE_JSON_BYTES, root)).text,
      ) as PackageManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const runtimeRequirements = evaluatePiRuntimeRequirements(
      manifest.peerDependencies,
      await getCurrentPiVersion(),
    ).map((requirement) => ({
      ...requirement,
      range: truncateDisplayField(requirement.range, MAX_DISPLAY_NAME_BYTES),
      ...(requirement.currentVersion
        ? { currentVersion: truncateDisplayField(requirement.currentVersion, MAX_DISPLAY_VERSION_BYTES) }
        : {}),
    }));
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
      collectSkills(await confinedExistingPaths(root, skillInputs), budget, root),
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
    const launchRoot = await snapshotRootForInstalledPackage(pkg.source, root);
    const hasLaunchResources = extensions.length > 0 || skills.length > 0 || prompts.length > 0;
    // Every enabled directory package is copied as one launch root, including
    // Skills/Prompts-only packages. Apply the exact snapshot tree limits here
    // so one oversized package is quarantined during inspection instead of
    // aborting the combined task snapshot and hiding otherwise valid packages.
    const contentFingerprint = hasLaunchResources
      ? await fingerprintPackageTreeCached(
          launchRoot,
          fingerprintCache,
          aggregateFingerprintBudget,
        )
      : undefined;
    const requiresExtensionApproval = extensions.length > 0 && !(
      contentFingerprint
      && hasApprovedExtensionFingerprint(state, pkg.source, contentFingerprint)
    );
    const staleApproval = extensions.length > 0
      && state.approvedExtensionSources.includes(pkg.source)
      && requiresExtensionApproval;
    const enabled = hasLaunchResources
      && !explicitlyDisabled
      && !requiresExtensionApproval;
    const promptCommands = enabled
      ? await Promise.all(prompts.map((file) => promptCommand(file, budget, root)))
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
        name: manifest.name?.trim()
          ? truncateDisplayField(manifest.name, MAX_DISPLAY_NAME_BYTES)
          : packageDisplayNameFallback(pkg.source, root),
        ...(manifest.version?.trim()
          ? { version: truncateDisplayField(manifest.version, MAX_DISPLAY_VERSION_BYTES) }
          : {}),
        enabled,
        ...(!hasLaunchResources ? { canToggle: false as const } : {}),
        ...(requiresExtensionApproval ? { requiresExtensionApproval: true } : {}),
        resources,
        ...(runtimeRequirements.length > 0 ? { runtimeRequirements } : {}),
        ...(warning ? { warning } : {}),
      },
      launch: enabled && hasLaunchResources
        ? { extensions, skills, promptTemplates: prompts, packageRoots: [launchRoot] }
        : empty,
      promptCommands,
      installedRoot: root,
      ...(contentFingerprint ? { contentFingerprint } : {}),
      ...(staleApproval ? { staleApproval: true } : {}),
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
        canToggle: false,
        resources: [],
        warning: error instanceof PiPackageInspectionLimitError
          || error instanceof PiPackageSnapshotLimitError
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
  const [{ stdout }, stateResult] = await Promise.all([
    runPiPackageCommand(
      ['list', '--no-approve'],
      COMMAND_TIMEOUT_MS,
      { requireCompleteStdout: true },
    ),
    readState(),
  ]);
  // Snapshot failures are shared package-store state, not a property of one
  // Main process. Every fresh inspection replaces the local projection with
  // the atomically persisted view so packaged/dev peers agree after the
  // existing change-token invalidation.
  const state = stateResult.ok ? stateResult.state : emptyState();
  if (stateResult.ok) {
    applySharedSnapshotUnavailableRoots(state.snapshotUnavailableRoots);
  }
  const listed = parsePiPackageListOutput(stdout);
  const startedAt = Date.now();
  const inspected: InspectedPackage[] = [];
  const fingerprintCache = new Map<string, Promise<string>>();
  const aggregateFingerprintBudget = createSnapshotBudgetCounters(DEFAULT_SNAPSHOT_LIMITS);
  for (const [index, pkg] of listed.entries()) {
    if (index >= MAX_INSPECTED_PACKAGES || Date.now() - startedAt > MAX_ALL_INSPECTION_MS) {
      const { displaySource, unsafe } = projectPackageSource(pkg.source);
      inspected.push({
        rawSource: pkg.source,
        view: {
          source: displaySource,
          name: displaySource,
          enabled: false,
          ...(unsafe ? { manageable: false as const } : { canToggle: false as const }),
          resources: [],
          warning: unsafe ? 'unsafe-source' : 'inspection-limit',
        },
        launch: { extensions: [], skills: [], promptTemplates: [], packageRoots: [] },
        promptCommands: [],
      });
      continue;
    }
    const inspectedPackage = await inspectPackage(
      pkg,
      state,
      fingerprintCache,
      aggregateFingerprintBudget,
    );
    if (stateResult.ok) {
      inspected.push(inspectedPackage);
    } else {
      inspected.push({
        rawSource: inspectedPackage.rawSource,
        view: {
          ...inspectedPackage.view,
          enabled: false,
          canToggle: false,
          warning: 'inspection-failed',
        },
        launch: { extensions: [], skills: [], promptTemplates: [], packageRoots: [] },
        promptCommands: [],
        ...(inspectedPackage.installedRoot
          ? { installedRoot: inspectedPackage.installedRoot }
          : {}),
        ...(inspectedPackage.contentFingerprint
          ? { contentFingerprint: inspectedPackage.contentFingerprint }
          : {}),
      });
    }
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

async function inspectAllPackagesFreshUnderMutationLock(): Promise<InspectedPackage[]> {
  // A local inspection that began before another process changed the shared
  // package store must finish before its generation is retired. Starting the
  // replacement under the cross-process mutation lock then re-reads both the
  // package tree and Cindy's approval state as one fresh projection.
  const staleInspection = inspectionPromise;
  if (staleInspection) await staleInspection.catch(() => undefined);
  invalidateInspectionCache();
  return inspectAllPackages();
}

async function listPiPackagesNow(): Promise<PiPackageListResult> {
  if (!getReadyBinaryPath('pi')) return { available: false, packages: [] };
  const inspected = await inspectAllPackages();
  return {
    available: true,
    packages: inspected.map((pkg) => {
      const warning = snapshotUnavailableWarningForPackage(pkg);
      return warning ? { ...pkg.view, enabled: false, canToggle: false, warning } : pkg.view;
    }),
  };
}

export async function listPiPackages(): Promise<PiPackageListResult> {
  await mutationTail;
  return listPiPackagesNow();
}

export interface PiPackageEnableIdentity {
  displayLabel: string;
  expectedPackageFingerprint: string;
}

function nativeConfirmationField(value: string, maxBytes: number): string {
  return truncateDisplayField(
    escapePiPackageNativeDialogText(value).replace(/\s+/g, ' '),
    maxBytes,
  );
}

function piPackageEnableDisplayLabel(
  target: InspectedPackage,
  packageFingerprint: string,
): string {
  let name = nativeConfirmationField(target.view.name, MAX_DISPLAY_NAME_BYTES);
  if (
    !name
    || path.isAbsolute(name)
    || path.win32.isAbsolute(name)
    || name.includes('/')
    || name.includes('\\')
  ) {
    name = nativeConfirmationField(
      target.installedRoot ? path.basename(target.installedRoot) : 'Pi extension',
      MAX_DISPLAY_NAME_BYTES,
    ) || 'Pi extension';
  }
  const rawVersion = target.view.version
    ? nativeConfirmationField(target.view.version, MAX_DISPLAY_VERSION_BYTES)
    : '';
  const version = rawVersion
    && !path.isAbsolute(rawVersion)
    && !path.win32.isAbsolute(rawVersion)
    && !rawVersion.includes('/')
    && !rawVersion.includes('\\')
    ? rawVersion
    : '';
  const packageLabel = version ? `${name} (${version})` : name;
  return `${packageLabel}\nSHA-256: ${packageFingerprint}`;
}

/**
 * Captures the Main-inspected package identity shown before enabling it. The
 * later mutation must match the same content fingerprint again under the
 * shared lock; Renderer-provided display fields never enter this object.
 */
export async function capturePiPackageEnableIdentity(source: string): Promise<PiPackageEnableIdentity> {
  const normalizedSource = requireSource(source);
  return enqueueMutation(async () => {
    await requireState();
    const inspected = await inspectAllPackagesFreshUnderMutationLock();
    const target = await findAffectedInspectedPackage(inspected, normalizedSource);
    if (!target) throw new Error('Pi package is not installed');
    if (!hasToggleableResources(target.view.resources)) {
      throw new Error('Pi package has no launchable resources');
    }
    if (!target.contentFingerprint) {
      throw new Error('Pi package fingerprint is unavailable');
    }
    return {
      displayLabel: piPackageEnableDisplayLabel(target, target.contentFingerprint),
      expectedPackageFingerprint: target.contentFingerprint,
    };
  });
}

async function persistSnapshotUnavailableProjection(
  unavailableRoots: Iterable<readonly [string, SnapshotUnavailableWarning]>,
): Promise<boolean> {
  const state = await requireState();
  const next: Record<string, SnapshotUnavailableWarning> = {};
  for (const [root, warning] of unavailableRoots) {
    next[path.resolve(root)] = warning;
  }
  const entries = Object.entries(next).sort(([left], [right]) => left.localeCompare(right));
  const currentEntries = Object.entries(state.snapshotUnavailableRoots)
    .sort(([left], [right]) => left.localeCompare(right));
  const changed = entries.length !== currentEntries.length
    || entries.some(([root, warning], index) => (
      root !== currentEntries[index]?.[0] || warning !== currentEntries[index]?.[1]
    ));
  if (changed) {
    await writeState({
      ...state,
      snapshotUnavailableRoots: Object.fromEntries(entries),
    });
  }
  applySharedSnapshotUnavailableRoots(next);
  return changed;
}

function snapshotUnavailableWarningForPackage(
  pkg: InspectedPackage,
): SnapshotUnavailableWarning | undefined {
  let warning: SnapshotUnavailableWarning | undefined;
  for (const root of pkg.launch.packageRoots) {
    const candidate = snapshotUnavailableRoots.get(path.resolve(root));
    if (candidate === 'inspection-failed') return candidate;
    if (candidate) warning = candidate;
  }
  return warning;
}

export async function resolveManagedPiPackageResources(
  options?: { snapshotRoot: string; snapshotLimits?: PiPackageSnapshotLimits },
): Promise<PiManagedPackageResources> {
  if (!getReadyBinaryPath('pi')) {
    return { extensions: [], skills: [], promptTemplates: [], packageRoots: [] };
  }
  try {
    const resolveResources = async (forceFresh = false): Promise<PiManagedPackageResources> => {
      const inspected = forceFresh
        ? await inspectAllPackagesFreshUnderMutationLock()
        : await inspectAllPackages();
      if (options) {
        const staleApprovals = inspected
          .filter((pkg) => pkg.staleApproval)
          .map((pkg) => pkg.rawSource);
        if (staleApprovals.length > 0) {
          await revokeExtensionApproval(staleApprovals);
          await publishPiPackagesChanged();
        }
      }
      const resources = {
        extensions: [...new Set(inspected.flatMap((pkg) => pkg.launch.extensions))],
        skills: inspected.flatMap((pkg) => pkg.launch.skills),
        promptTemplates: [...new Set(inspected.flatMap((pkg) => pkg.launch.promptTemplates))],
        packageRoots: [...new Set(inspected.flatMap((pkg) => pkg.launch.packageRoots))],
      };
      if (!options) return resources;

      const approvalsByRoot = new Map<string, Array<{ source: string; fingerprint: string }>>();
      for (const pkg of inspected) {
        if (!pkg.contentFingerprint || pkg.launch.extensions.length === 0) continue;
        for (const root of pkg.launch.packageRoots) {
          const approvals = approvalsByRoot.get(root) ?? [];
          approvals.push({ source: pkg.rawSource, fingerprint: pkg.contentFingerprint });
          approvalsByRoot.set(root, approvals);
        }
      }
      try {
        const snapshotLimits = options.snapshotLimits ?? DEFAULT_SNAPSHOT_LIMITS;
        let staged = await stageManagedPackageSnapshot(
          resources,
          options.snapshotRoot,
          snapshotLimits,
        );
        const stageMetadata = snapshotStageMetadata.get(staged);
        const changedSources = new Set<string>();
        const copiedSourceRoots = stageMetadata?.sourcePackageRoots ?? resources.packageRoots;
        const verificationBudget = createSnapshotBudgetCounters(snapshotLimits);
        const unavailableVerificationRoots = new Map<string, SnapshotUnavailableWarning>();
        const failedVerificationIndexes = new Set<number>();
        let aggregateVerificationLimitReached = false;
        // Fingerprint verification has the same partial-success contract as
        // staging: a budget breach quarantines only the unverified roots, so
        // already copied and authenticated resources remain usable.
        for (const [index, sourceRoot] of copiedSourceRoots.entries()) {
          const approvals = approvalsByRoot.get(sourceRoot);
          if (!approvals?.length) continue;
          if (aggregateVerificationLimitReached) {
            unavailableVerificationRoots.set(sourceRoot, 'inspection-limit');
            failedVerificationIndexes.add(index);
            continue;
          }
          const stagedRoot = staged.packageRoots[index];
          if (!stagedRoot) throw new Error('Pi extension snapshot root mapping is incomplete');
          let copiedFingerprint: string;
          try {
            copiedFingerprint = await fingerprintPiPackageTree(
              stagedRoot,
              snapshotLimits,
              verificationBudget,
            );
          } catch (error) {
            if (!(error instanceof PiPackageSnapshotLimitError)) throw error;
            unavailableVerificationRoots.set(sourceRoot, 'inspection-limit');
            failedVerificationIndexes.add(index);
            if (error.scope === 'aggregate') aggregateVerificationLimitReached = true;
            continue;
          }
          for (const approval of approvals) {
            if (approval.fingerprint !== copiedFingerprint) changedSources.add(approval.source);
          }
        }
        if (changedSources.size > 0) {
          await fs.rm(options.snapshotRoot, { recursive: true, force: true });
          await revokeExtensionApproval(changedSources);
          await publishPiPackagesChanged();
          return { extensions: [], skills: [], promptTemplates: [], packageRoots: [] };
        }

        if (failedVerificationIndexes.size > 0) {
          for (const index of failedVerificationIndexes) {
            const stagedRoot = staged.packageRoots[index];
            if (stagedRoot) {
              await fs.rm(stagedRoot, { recursive: true, force: true });
            }
          }
          const failedTargets = [...failedVerificationIndexes]
            .map((index) => staged.packageRoots[index])
            .filter((target): target is string => Boolean(target));
          const isFailedResource = (resourcePath: string): boolean => failedTargets.some((target) => (
            isWithinConfinement(target, resourcePath)
          ));
          const filtered: PiManagedPackageResources = {
            extensions: staged.extensions.filter((entry) => !isFailedResource(entry)),
            skills: staged.skills.filter((skill) => !isFailedResource(skill.path)),
            promptTemplates: staged.promptTemplates.filter((entry) => !isFailedResource(entry)),
            packageRoots: staged.packageRoots.filter((_, index) => !failedVerificationIndexes.has(index)),
          };
          const failedSources = copiedSourceRoots.filter((_, index) => (
            failedVerificationIndexes.has(index)
          ));
          const nextSkippedRoots = [
            ...(stageMetadata?.skippedPackageRoots ?? []),
            ...failedSources,
          ];
          snapshotStageMetadata.set(filtered, {
            sourcePackageRoots: copiedSourceRoots.filter((_, index) => (
              !failedVerificationIndexes.has(index)
            )),
            skippedPackageRoots: [...new Set(nextSkippedRoots)],
          });
          staged = filtered;
        }

        const unavailableRoots = new Map<string, SnapshotUnavailableWarning>();
        for (const root of stageMetadata?.skippedPackageRoots ?? []) {
          unavailableRoots.set(root, 'inspection-limit');
        }
        for (const [root, warning] of unavailableVerificationRoots) {
          unavailableRoots.set(root, warning);
        }
        const snapshotProjectionChanged = await persistSnapshotUnavailableProjection(
          unavailableRoots,
        );
        if (snapshotProjectionChanged) {
          await publishPiPackagesChanged({ invalidateCache: false });
        }
        return staged;
      } catch (error) {
        await fs.rm(options.snapshotRoot, { recursive: true, force: true }).catch(() => undefined);
        const warning = error instanceof PiPackageSnapshotLimitError
          ? 'inspection-limit'
          : 'inspection-failed';
        if (await persistSnapshotUnavailableProjection(
          resources.packageRoots.map((root) => [root, warning] as const),
        )) {
          await publishPiPackagesChanged({ invalidateCache: false });
        }
        throw error;
      }
    };
    if (options) return await enqueueMutation(() => resolveResources(true));
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
    return inspected.flatMap((pkg) => (
      snapshotUnavailableWarningForPackage(pkg) ? [] : pkg.promptCommands
    ));
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
    return {
      displaySource: truncateDisplayField(source, MAX_SOURCE_LENGTH),
      unsafe: false,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(urlSource);
  } catch {
    const scheme = urlSource.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1] ?? 'url';
    return {
      displaySource: truncateDisplayField(`${gitPrefix}${scheme}://[invalid-source]`, MAX_SOURCE_LENGTH),
      unsafe: true,
    };
  }
  const unsafe = Boolean(parsed.username || parsed.password || parsed.search || parsed.hash);
  if (!unsafe) {
    return {
      displaySource: truncateDisplayField(source, MAX_SOURCE_LENGTH),
      unsafe: false,
    };
  }
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return {
    displaySource: truncateDisplayField(`${gitPrefix}${parsed.toString()}`, MAX_SOURCE_LENGTH),
    unsafe: true,
  };
}

function redactPackageCommandMessage(message: string): string {
  return message.replace(PACKAGE_URL_PATTERN, (source) => projectPackageSource(source).displaySource);
}

function packageDisplayNameFallback(source: string, installedRoot: string): string {
  const localSource = isLocalPackageSource(source)
    || path.win32.isAbsolute(source)
    || /^file:/i.test(source);
  return truncateDisplayField(
    localSource ? path.basename(installedRoot) : projectPackageSource(source).displaySource,
    MAX_DISPLAY_NAME_BYTES,
  );
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

function enqueueMutation<T>(
  operation: () => Promise<T>,
  onErrorUnderLock?: (error: unknown) => Promise<void>,
): Promise<T> {
  // mutationTail prevents overlapping work inside one Main process. The
  // strict file lock extends the same critical section across packaged, dev,
  // and --passive instances sharing userData. It also recovers abandoned locks
  // after an owner exits and releases normally when an operation times out.
  const guardedOperation = async (): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      await onErrorUnderLock?.(error);
      throw error;
    }
  };
  const result = mutationTail.then(() => withPiPackageMutationLock(guardedOperation));
  mutationTail = result.then(() => undefined, () => undefined);
  return result;
}

class PiPackageSnapshotLimitError extends Error {
  constructor(readonly scope: 'package' | 'aggregate' = 'package') {
    super('Pi extension snapshot exceeds the safe resource limit');
    this.name = 'PiPackageSnapshotLimitError';
  }
}

interface SnapshotBudgetCounters {
  startedAt: number;
  entries: number;
  bytes: number;
  limits: PiPackageSnapshotLimits;
}

interface SnapshotCopyBudget extends SnapshotBudgetCounters {
  activeDirectories: Set<string>;
  aggregate?: SnapshotBudgetCounters;
}

function createSnapshotBudgetCounters(
  limits: PiPackageSnapshotLimits,
): SnapshotBudgetCounters {
  return {
    startedAt: Date.now(),
    entries: 0,
    bytes: 0,
    limits,
  };
}

function createSnapshotCopyBudget(
  limits: PiPackageSnapshotLimits,
  aggregate?: SnapshotBudgetCounters,
): SnapshotCopyBudget {
  return {
    ...createSnapshotBudgetCounters(limits),
    activeDirectories: new Set(),
    ...(aggregate ? { aggregate } : {}),
  };
}

function snapshotBudgetExceeded(
  budget: SnapshotBudgetCounters,
  additionalBytes = 0,
): boolean {
  return budget.entries > budget.limits.maxEntries
    || budget.bytes + additionalBytes > budget.limits.maxBytes
    || Date.now() - budget.startedAt >= budget.limits.maxDurationMs;
}

function assertSnapshotBudget(budget: SnapshotCopyBudget, additionalBytes = 0): void {
  if (snapshotBudgetExceeded(budget, additionalBytes)) {
    throw new PiPackageSnapshotLimitError('package');
  }
  if (budget.aggregate && snapshotBudgetExceeded(budget.aggregate, additionalBytes)) {
    throw new PiPackageSnapshotLimitError('aggregate');
  }
}

function recordSnapshotEntry(budget: SnapshotCopyBudget): void {
  budget.entries += 1;
  if (budget.aggregate) budget.aggregate.entries += 1;
}

function recordSnapshotBytes(budget: SnapshotCopyBudget, bytes: number): void {
  budget.bytes += bytes;
  if (budget.aggregate) budget.aggregate.bytes += bytes;
}

function updatePackageFingerprintField(
  hash: ReturnType<typeof createHash>,
  value: string,
): void {
  const encoded = Buffer.from(value, 'utf8');
  hash.update(`${encoded.length}:`);
  hash.update(encoded);
}

function sameStableStat(
  before: Stats,
  after: Stats,
): boolean {
  return sameStableFileIdentity(before, after);
}

/**
 * Hashes the complete tree that Cindy would materialize for a Pi session.
 * Relative names, file modes, and bytes are included in a stable order so an
 * added/removed/replaced module (including an npm-hoisted sibling) changes the
 * approval identity even when the extension entrypoint itself is untouched.
 */
async function fingerprintPiPackageTree(
  rawRoot: string,
  limits: PiPackageSnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
  aggregateBudget?: SnapshotBudgetCounters,
): Promise<string> {
  const { canonicalPath: root } = await resolveStablePackagePath(
    rawRoot,
    'Pi extension package changed before fingerprinting',
  );
  const budget = createSnapshotCopyBudget(limits, aggregateBudget);
  const hash = createHash('sha256');
  updatePackageFingerprintField(hash, 'cindy-pi-package-fingerprint-v1');

  const visit = async (candidate: string, relativePath: string): Promise<void> => {
    assertSnapshotBudget(budget);
    const { canonicalPath: canonical, stat: before } = await resolveStablePackagePath(
      candidate,
      'Pi extension package changed before fingerprinting',
    );
    if (!isWithinConfinement(root, canonical)) {
      throw new Error('Pi extension fingerprint contains an escaped link');
    }
    recordSnapshotEntry(budget);
    assertSnapshotBudget(budget, before.isFile() ? before.size : 0);
    const name = relativePath || '.';

    if (before.isDirectory()) {
      if (budget.activeDirectories.has(canonical)) {
        throw new Error('Pi extension fingerprint contains a cyclic link');
      }
      budget.activeDirectories.add(canonical);
      try {
        updatePackageFingerprintField(hash, `directory:${name}:${before.mode & 0o777}`);
        const entries = (await fs.readdir(canonical)).sort();
        for (const entry of entries) {
          await visit(path.join(canonical, entry), relativePath ? path.join(relativePath, entry) : entry);
        }
        const [{ stat: after }, finalEntries] = await Promise.all([
          resolveStablePackagePath(
            canonical,
            'Pi extension package changed while fingerprinting',
          ),
          fs.readdir(canonical).then((items) => items.sort()),
        ]);
        if (!sameStableStat(before, after) || entries.join('\0') !== finalEntries.join('\0')) {
          throw new Error('Pi extension package changed while fingerprinting');
        }
      } finally {
        budget.activeDirectories.delete(canonical);
      }
      return;
    }
    if (!before.isFile()) throw new Error('Pi extension fingerprint contains a special file');

    updatePackageFingerprintField(
      hash,
      `file:${name}:${before.mode & 0o777}:${before.size}`,
    );
    const { handle, stat: opened } = await openConstrainedRegularFile(
      root,
      canonical,
      'Pi extension fingerprint contains an escaped link',
      'Pi extension package changed before fingerprinting',
    );
    try {
      if (!sameStableStat(before, opened)) {
        throw new Error('Pi extension package changed before fingerprinting');
      }
      const chunk = Buffer.allocUnsafe(SNAPSHOT_COPY_CHUNK_BYTES);
      let position = 0;
      for (;;) {
        assertSnapshotBudget(budget);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        assertSnapshotBudget(budget, bytesRead);
        hash.update(chunk.subarray(0, bytesRead));
        recordSnapshotBytes(budget, bytesRead);
        position += bytesRead;
      }
      const after = await handle.stat();
      if (!sameStableStat(opened, after) || position !== after.size) {
        throw new Error('Pi extension package changed while fingerprinting');
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  };

  await visit(root, '');
  return hash.digest('hex');
}

async function copySnapshotEntryBounded(
  confinementRoot: string,
  sourcePath: string,
  targetPath: string,
  budget: SnapshotCopyBudget,
): Promise<void> {
  assertSnapshotBudget(budget);
  const { canonicalPath: canonicalSource, stat: sourceStat } = await resolveStablePackagePath(
    sourcePath,
    'Pi extension package changed before copying snapshot',
  );
  if (!isWithinConfinement(confinementRoot, canonicalSource)) {
    throw new Error('Pi extension snapshot contains an escaped link');
  }
  const sourceMode = sourceStat.mode & 0o777;
  recordSnapshotEntry(budget);
  assertSnapshotBudget(budget, sourceStat.isFile() ? sourceStat.size : 0);

  if (sourceStat.isDirectory()) {
    if (budget.activeDirectories.has(canonicalSource)) {
      throw new Error('Pi extension snapshot contains a cyclic link');
    }
    budget.activeDirectories.add(canonicalSource);
    const directory = await fs.opendir(canonicalSource);
    const copiedEntries: string[] = [];
    try {
      // Keep the in-progress directory host-writable even when the source is
      // read-only; restore the source mode only after all children are copied.
      await fs.mkdir(targetPath, { mode: 0o700 });
      for await (const entry of directory) {
        copiedEntries.push(entry.name);
        await copySnapshotEntryBounded(
          confinementRoot,
          path.join(canonicalSource, entry.name),
          path.join(targetPath, entry.name),
          budget,
        );
      }
      const [{ stat: after }, finalEntries] = await Promise.all([
        resolveStablePackagePath(
          canonicalSource,
          'Pi extension package changed while copying snapshot',
        ),
        fs.readdir(canonicalSource).then((entries) => entries.sort()),
      ]);
      if (
        !sameStableStat(sourceStat, after)
        || copiedEntries.sort().join('\0') !== finalEntries.join('\0')
      ) {
        throw new Error('Pi extension package changed while copying snapshot');
      }
      // mkdir applies the process umask. Restore the source mode only after
      // children are materialized so a read-only source directory cannot make
      // its in-progress snapshot unwritable.
      await fs.chmod(targetPath, sourceMode);
    } finally {
      await directory.close().catch(() => undefined);
      budget.activeDirectories.delete(canonicalSource);
    }
    return;
  }
  if (!sourceStat.isFile()) throw new Error('Pi extension snapshot contains a special file');

  const { handle: sourceHandle, stat: opened } = await openConstrainedRegularFile(
    confinementRoot,
    canonicalSource,
    'Pi extension snapshot contains an escaped link',
    'Pi extension package changed before copying snapshot',
  );
  let targetHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    if (!sameStableStat(sourceStat, opened)) {
      throw new Error('Pi extension package changed before copying snapshot');
    }
    targetHandle = await fs.open(targetPath, 'wx', sourceMode);
    const chunk = Buffer.allocUnsafe(SNAPSHOT_COPY_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      assertSnapshotBudget(budget);
      const { bytesRead } = await sourceHandle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      assertSnapshotBudget(budget, bytesRead);
      await targetHandle.write(chunk, 0, bytesRead, position);
      recordSnapshotBytes(budget, bytesRead);
      position += bytesRead;
    }
    const after = await sourceHandle.stat();
    if (!sameStableStat(opened, after) || position !== after.size) {
      throw new Error('Pi extension package changed while copying snapshot');
    }
    // open(mode) is also masked by umask; the already-open handle can restore
    // the exact approved mode without a path replacement race.
    await targetHandle.chmod(sourceMode);
  } finally {
    await sourceHandle.close().catch(() => undefined);
    await targetHandle?.close().catch(() => undefined);
  }
}

interface SnapshotPathOwner {
  source: string;
  target?: string;
  directory: boolean;
  skipped: boolean;
}

function mostSpecificSnapshotOwner(
  sourcePath: string,
  mappings: Array<{ source: string; target: string; directory: boolean }>,
  skippedPackageRoots: string[],
): SnapshotPathOwner | undefined {
  const resolved = path.resolve(sourcePath);
  let owner: SnapshotPathOwner | undefined;
  const consider = (candidate: SnapshotPathOwner): void => {
    if (
      !owner
      || candidate.source.length > owner.source.length
      || (candidate.source.length === owner.source.length && candidate.skipped && !owner.skipped)
    ) {
      owner = candidate;
    }
  };
  for (const mapping of mappings) {
    if (!mapping.directory && resolved !== mapping.source) continue;
    if (mapping.directory && !isWithinConfinement(mapping.source, resolved)) continue;
    consider({ ...mapping, skipped: false });
  }
  for (const skippedRoot of skippedPackageRoots) {
    const source = path.resolve(skippedRoot);
    if (resolved !== source && !isWithinConfinement(source, resolved)) continue;
    consider({ source, directory: resolved !== source, skipped: true });
  }
  return owner;
}

function mapSnapshotPathOrSkip(
  sourcePath: string,
  mappings: Array<{ source: string; target: string; directory: boolean }>,
  skippedPackageRoots: string[],
): string | undefined {
  const resolved = path.resolve(sourcePath);
  const owner = mostSpecificSnapshotOwner(resolved, mappings, skippedPackageRoots);
  if (!owner) throw new Error('Pi extension resource is outside its inspected package root');
  if (owner.skipped) return undefined;
  if (!owner.target) throw new Error('Pi extension snapshot root mapping is incomplete');
  return owner.directory
    ? path.join(owner.target, path.relative(owner.source, resolved))
    : owner.target;
}

interface SnapshotStageMetadata {
  sourcePackageRoots: string[];
  skippedPackageRoots: string[];
}

const snapshotStageMetadata = new WeakMap<PiManagedPackageResources, SnapshotStageMetadata>();

export async function stageManagedPackageSnapshot(
  resources: PiManagedPackageResources,
  snapshotRoot: string,
  limits: PiPackageSnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): Promise<PiManagedPackageResources> {
  if (!path.isAbsolute(snapshotRoot)) throw new Error('Pi extension snapshot root must be absolute');
  const temporaryRoot = `${snapshotRoot}.tmp-${process.pid}-${Date.now()}`;
  const mappings: Array<{ source: string; target: string; directory: boolean }> = [];
  const skippedPackageRoots: string[] = [];
  const aggregateBudget = createSnapshotBudgetCounters(limits);
  let aggregateLimitReached = false;
  try {
    await fs.mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    for (const [index, rawRoot] of resources.packageRoots.entries()) {
      if (aggregateLimitReached) {
        skippedPackageRoots.push(
          await fs.realpath(rawRoot).catch(() => path.resolve(rawRoot)),
        );
        continue;
      }
      let source: string | undefined;
      try {
        const resolvedRoot = await resolveStablePackagePath(
          rawRoot,
          'Pi extension package root changed before snapshotting',
        );
        source = resolvedRoot.canonicalPath;
        const sourceStat = resolvedRoot.stat;
        const directory = sourceStat.isDirectory();
        if (!directory && !sourceStat.isFile()) {
          throw new Error('Pi extension package root is not a file or directory');
        }
        const relativeTarget = directory
          ? String(index)
          : path.join(String(index), path.basename(source));
        const temporaryTarget = path.join(temporaryRoot, relativeTarget);
        await fs.mkdir(path.dirname(temporaryTarget), { recursive: true, mode: 0o700 });
        await copySnapshotEntryBounded(
          source,
          source,
          temporaryTarget,
          createSnapshotCopyBudget(limits, aggregateBudget),
        );
        mappings.push({ source, target: path.join(snapshotRoot, relativeTarget), directory });
      } catch (error) {
        if (!(error instanceof PiPackageSnapshotLimitError)) throw error;
        skippedPackageRoots.push(source ?? path.resolve(rawRoot));
        await fs.rm(path.join(temporaryRoot, String(index)), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
        // A package-scoped failure quarantines only this root. Existing
        // mappings remain valid; only the shared aggregate limit stops later
        // packages from being attempted.
        if (error.scope === 'aggregate') aggregateLimitReached = true;
      }
    }
    // Windows temp paths can use an 8.3/user-profile spelling while realpath
    // returns the canonical long form. Compare resources and roots in the same
    // canonical namespace so the most-specific approved root remains stable on
    // every platform (and symlinked resources cannot inherit an ancestor root).
    const mappedExtensions = await Promise.all(resources.extensions.map(async (entry) =>
      mapSnapshotPathOrSkip(await fs.realpath(entry), mappings, skippedPackageRoots)));
    const mappedSkills = await Promise.all(resources.skills.map(async (skill) => {
      const mappedPath = mapSnapshotPathOrSkip(
        await fs.realpath(skill.path),
        mappings,
        skippedPackageRoots,
      );
      return mappedPath ? { ...skill, path: mappedPath } : undefined;
    }));
    const mappedPromptTemplates = await Promise.all(resources.promptTemplates.map(async (entry) =>
      mapSnapshotPathOrSkip(await fs.realpath(entry), mappings, skippedPackageRoots)));
    const mappedResources: PiManagedPackageResources = {
      extensions: mappedExtensions.filter((entry): entry is string => Boolean(entry)),
      skills: mappedSkills.filter((skill): skill is PiManagedPackageSkill => Boolean(skill)),
      promptTemplates: mappedPromptTemplates.filter((entry): entry is string => Boolean(entry)),
      packageRoots: mappings.map((mapping) => mapping.target),
    };
    await fs.rename(temporaryRoot, snapshotRoot);
    snapshotStageMetadata.set(mappedResources, {
      sourcePackageRoots: mappings.map((mapping) => mapping.source),
      skippedPackageRoots,
    });
    return mappedResources;
  } catch (error) {
    await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function revokeExtensionApproval(sources: Iterable<string>): Promise<void> {
  const targets = new Set(sources);
  if (targets.size === 0) return;
  const state = await requireState();
  const approvedExtensionSources = state.approvedExtensionSources
    .filter((source) => !targets.has(source));
  const approvedExtensionFingerprints = Object.fromEntries(
    Object.entries(state.approvedExtensionFingerprints)
      .filter(([source]) => !targets.has(source)),
  );
  if (
    approvedExtensionSources.length === state.approvedExtensionSources.length
    && Object.keys(approvedExtensionFingerprints).length
      === Object.keys(state.approvedExtensionFingerprints).length
  ) return;
  await writeState({
    ...state,
    approvedExtensionSources,
    approvedExtensionFingerprints,
  });
}

/**
 * One confirmed install/update is enough to run the affected package.
 * Sibling npm packages share one copy-root, so their fingerprints change when
 * another package is added. Rebase only identities that still matched before
 * the mutation; stale or uninspectable approvals must remain fail closed.
 */
async function persistEnabledExtensionApprovals(options: {
  inspected: InspectedPackage[];
  rebaseSources: ReadonlySet<string>;
  enable?: InspectedPackage;
}): Promise<void> {
  const state = await requireState();
  const disabled = new Set(state.disabledSources);
  const approved = new Set(state.approvedExtensionSources);
  const fingerprints = { ...state.approvedExtensionFingerprints };
  const inspectedBySource = new Map(
    options.inspected.map((pkg) => [pkg.rawSource, pkg]),
  );

  for (const source of approved) {
    const pkg = inspectedBySource.get(source);
    if (!options.rebaseSources.has(source) || !pkg?.contentFingerprint) {
      approved.delete(source);
      delete fingerprints[source];
      continue;
    }
    fingerprints[source] = pkg.contentFingerprint;
  }

  if (options.enable) {
    const pkg = options.enable;
    if (pkg.view.resources.some((resource) => resource.kind === 'extension')) {
      if (pkg.contentFingerprint) {
        approved.add(pkg.rawSource);
        fingerprints[pkg.rawSource] = pkg.contentFingerprint;
        disabled.delete(pkg.rawSource);
      }
    } else {
      approved.delete(pkg.rawSource);
      delete fingerprints[pkg.rawSource];
      disabled.delete(pkg.rawSource);
    }
  }

  await writeState({
    version: STATE_VERSION,
    disabledSources: [...disabled].sort(),
    approvedExtensionSources: [...approved].sort(),
    approvedExtensionFingerprints: Object.fromEntries(
      Object.entries(fingerprints).sort(([left], [right]) => left.localeCompare(right)),
    ),
    snapshotUnavailableRoots: state.snapshotUnavailableRoots,
  });
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

async function resolveClosureDependency(
  packageRoot: string,
  name: string,
  nodeModulesRoot: string,
): Promise<string | undefined> {
  if (!/^(?:@[^/\\\0]+\/)?[^/\\\0]+$/.test(name)
    || name.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('Invalid npm dependency name');
  }
  const candidates = new Set<string>();
  let cursor = packageRoot;
  for (;;) {
    candidates.add(path.basename(cursor) === 'node_modules'
      ? path.join(cursor, name)
      : path.join(cursor, 'node_modules', name));
    if (cursor === nodeModulesRoot) break;
    const parent = path.dirname(cursor);
    if (parent === cursor || !isWithinConfinement(nodeModulesRoot, parent)) break;
    cursor = parent;
  }
  for (const candidate of candidates) {
    try {
      const { canonicalPath, stat } = await resolveStablePackagePath(candidate,
        'Pi extension dependency changed while proving approval identity');
      if (!stat.isDirectory() || !isWithinConfinement(nodeModulesRoot, canonicalPath)) {
        throw new Error('Pi extension dependency escaped the shared npm root');
      }
      return canonicalPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}

async function fingerprintExtensionClosure(
  installedRoot: string,
  snapshotRoot: string,
): Promise<string> {
  const nodeModulesRoot = await fs.realpath(path.join(snapshotRoot, 'node_modules'));
  if (!isWithinConfinement(nodeModulesRoot, installedRoot)) {
    throw new Error('Pi extension escaped the shared npm root');
  }
  const pending = [installedRoot];
  const roots = new Set<string>();
  let metadataBytes = 0;
  while (pending.length > 0) {
    if (roots.size >= MAX_INSPECTION_ENTRIES) throw new PiPackageInspectionLimitError();
    const root = await fs.realpath(pending.shift()!);
    if (roots.has(root)) continue;
    roots.add(root);
    const manifestResult = await readUtf8FileBounded(
      path.join(root, 'package.json'), MAX_PACKAGE_JSON_BYTES, root);
    metadataBytes += manifestResult.bytes;
    if (metadataBytes > MAX_INSPECTION_METADATA_BYTES) throw new PiPackageInspectionLimitError();
    const manifest = JSON.parse(manifestResult.text) as PackageManifest;
    const dependencyNames = new Set(Object.keys({ ...manifest.peerDependencies,
      ...manifest.optionalDependencies, ...manifest.dependencies }));
    for (const name of [...dependencyNames].sort()) {
      const dependency = await resolveClosureDependency(root, name, nodeModulesRoot);
      if (dependency && !roots.has(dependency)) pending.push(dependency);
    }
  }

  const selectedRoots: string[] = [];
  for (const root of [...roots].sort((left, right) => left.length - right.length)) {
    if (!selectedRoots.some((ancestor) => isWithinConfinement(ancestor, root))) selectedRoots.push(root);
  }
  const aggregate = createSnapshotBudgetCounters(DEFAULT_SNAPSHOT_LIMITS);
  const hash = createHash('sha256');
  updatePackageFingerprintField(hash, 'cindy-pi-extension-closure-v1');
  for (const root of selectedRoots.sort()) {
    updatePackageFingerprintField(hash, path.relative(snapshotRoot, root));
    updatePackageFingerprintField(hash, await fingerprintPiPackageTree(
      root, DEFAULT_SNAPSHOT_LIMITS, aggregate));
  }
  return hash.digest('hex');
}

async function captureExtensionApprovalIdentities(
  packages: InspectedPackage[],
): Promise<Map<string, FreshExtensionApprovalIdentity>> {
  const identities = new Map<string, FreshExtensionApprovalIdentity>();
  for (const pkg of packages) {
    if (!pkg.contentFingerprint || !pkg.installedRoot) continue;
    try {
      const snapshotRoot = await snapshotRootForInstalledPackage(pkg.rawSource, pkg.installedRoot);
      const closureFingerprint = snapshotRoot === pkg.installedRoot
        ? pkg.contentFingerprint
        : await fingerprintExtensionClosure(pkg.installedRoot, snapshotRoot);
      if (await fingerprintPiPackageTree(snapshotRoot) !== pkg.contentFingerprint) continue;
      identities.set(pkg.rawSource, {
        closureFingerprint,
        installedRoot: pkg.installedRoot,
        snapshotRoot,
      });
    } catch {
      // Unprovable closures are not eligible for rebasing.
    }
  }
  return identities;
}

async function unchangedExtensionClosureSources(
  before: ReadonlyMap<string, FreshExtensionApprovalIdentity>,
  inspectedAfter: InspectedPackage[],
): Promise<Set<string>> {
  const after = await captureExtensionApprovalIdentities(
    inspectedAfter.filter((pkg) => before.has(pkg.rawSource)));
  return new Set([...before].filter(([source, identity]) => {
    const current = after.get(source);
    return current?.installedRoot === identity.installedRoot
      && current.snapshotRoot === identity.snapshotRoot
      && current.closureFingerprint === identity.closureFingerprint;
  }).map(([source]) => source));
}

export async function mutatePiPackage(
  request: PiPackageMutationRequest,
  grant?: PiPackageMutationGrant,
): Promise<PiPackageMutationResult> {
  let grantBinding: Readonly<PiPackageMutationGrantBinding> = {};
  if (piPackageMutationNeedsGrant(request)) {
    // The grant is an in-process, one-shot capability issued only after Main
    // observed a real user decision (or an exact whole user command). Renderer
    // booleans and Full Access never cross this boundary.
    grantBinding = consumePiPackageMutationGrant(request, grant);
  }
  const source = requireSource(request.source);
  if (request.action === 'install' && isRelativeLocalPiPackageSource(source)) {
    throw new Error('Relative local Pi package sources require a task working directory');
  }
  let mutationMayHaveChangedState = false;
  return enqueueMutation(async () => {
    // Never mutate the package tree or replace the durable preference file if
    // the existing state cannot be read. Otherwise a transient read failure
    // could erase explicit disables after a successful package command.
    await requireState();
    // Every mutation starts from one fresh projection acquired after the
    // shared cross-process lock. A packaged/dev/--passive peer may have
    // installed, removed, updated, or changed approval state since this
    // process populated its cache; no mutation may persist decisions derived
    // from that lock-external snapshot.
    const inspectedBeforeMutation = await inspectAllPackagesFreshUnderMutationLock();
    const preMutationFreshApprovals = await captureExtensionApprovalIdentities(
      inspectedBeforeMutation.filter((pkg) => (
        pkg.view.requiresExtensionApproval !== true
        && pkg.view.resources.some((resource) => resource.kind === 'extension')
      )),
    );
    let affectedSource: string | undefined;
    if (request.action === 'install') {
      mutationMayHaveChangedState = true;
      // Reinstalling an existing source can replace executable code. Revoke
      // before invoking Pi so even a partially failed install cannot inherit a
      // stale approval on the next runtime. A successful install is itself the
      // user decision to enable the new bytes.
      const previous = await findAffectedInspectedPackage(inspectedBeforeMutation, source);
      await revokeExtensionApproval([
        ...sourceAliases(source),
        ...(previous ? sourceAliases(previous.rawSource) : []),
      ]);
      invalidateInspectionCache();
      await runPiPackageCommand(['install', source, '--no-approve']);
      invalidateInspectionCache();
      const inspectedAfterInstall = await inspectAllPackages();
      const affected = await findAffectedInspectedPackage(inspectedAfterInstall, source);
      affectedSource = affected?.rawSource;
      await persistEnabledExtensionApprovals({
        inspected: inspectedAfterInstall,
        rebaseSources: await unchangedExtensionClosureSources(
          preMutationFreshApprovals,
          inspectedAfterInstall,
        ),
        ...(affected ? { enable: affected } : {}),
      });
    } else if (request.action === 'remove') {
      mutationMayHaveChangedState = true;
      const previous = await findAffectedInspectedPackage(inspectedBeforeMutation, source);
      await runPiPackageCommand([
        'remove',
        mutationCommandSource(source, previous),
        '--no-approve',
      ]);
      const state = await requireState();
      const removedSources = new Set([
        ...sourceAliases(source),
        ...(previous ? sourceAliases(previous.rawSource) : []),
      ]);
      await writeState({
        version: STATE_VERSION,
        disabledSources: state.disabledSources.filter((item) => !removedSources.has(item)),
        approvedExtensionSources: state.approvedExtensionSources.filter((item) => !removedSources.has(item)),
        approvedExtensionFingerprints: Object.fromEntries(
          Object.entries(state.approvedExtensionFingerprints)
            .filter(([item]) => !removedSources.has(item)),
        ),
        snapshotUnavailableRoots: state.snapshotUnavailableRoots,
      });
    } else if (request.action === 'update') {
      mutationMayHaveChangedState = true;
      const previous = await findAffectedInspectedPackage(inspectedBeforeMutation, source);
      const updateAliases = [
        ...sourceAliases(source),
        ...(previous ? sourceAliases(previous.rawSource) : []),
      ];
      const stateBeforeUpdate = await requireState();
      const wasExplicitlyDisabled = updateAliases.some((item) => (
        stateBeforeUpdate.disabledSources.includes(item)
      ));
      await revokeExtensionApproval(updateAliases);
      invalidateInspectionCache();
      await runPiPackageCommand([
        'update',
        mutationCommandSource(source, previous),
        '--no-approve',
      ]);
      invalidateInspectionCache();
      const inspectedAfterUpdate = await inspectAllPackages();
      const affected = await findAffectedInspectedPackage(inspectedAfterUpdate, source);
      affectedSource = affected?.rawSource ?? previous?.rawSource ?? source;
      // A confirmed update is enough to keep running the new bytes, unless the
      // user had already turned this package off.
      await persistEnabledExtensionApprovals({
        inspected: inspectedAfterUpdate,
        rebaseSources: await unchangedExtensionClosureSources(
          preMutationFreshApprovals,
          inspectedAfterUpdate,
        ),
        ...(!wasExplicitlyDisabled && affected ? { enable: affected } : {}),
      });
    } else if (request.action === 'set-enabled') {
      if (typeof request.enabled !== 'boolean') throw new Error('enabled must be a boolean');
      const target = await findAffectedInspectedPackage(inspectedBeforeMutation, source);
      if (!target) throw new Error('Pi package is not installed');
      affectedSource = target.rawSource;
      const state = await requireState();
      const disabled = new Set(state.disabledSources);
      const approved = new Set(state.approvedExtensionSources);
      const approvedFingerprints = { ...state.approvedExtensionFingerprints };
      if (request.enabled) {
        if (!hasToggleableResources(target.view.resources)) {
          throw new Error('Pi package has no launchable resources');
        }
        if (
          !Object.hasOwn(grantBinding, 'expectedPackageFingerprint')
          || grantBinding.expectedPackageFingerprint !== (target.contentFingerprint ?? null)
        ) {
          throw new Error('Pi extension package changed after authorization');
        }
        if (target.view.resources.some((resource) => resource.kind === 'extension')) {
          if (!target.contentFingerprint) {
            throw new Error('Pi extension package fingerprint is unavailable');
          }
          approved.add(target.rawSource);
          approvedFingerprints[target.rawSource] = target.contentFingerprint;
        } else {
          approved.delete(target.rawSource);
          delete approvedFingerprints[target.rawSource];
        }
        disabled.delete(target.rawSource);
      } else {
        disabled.add(target.rawSource);
      }
      // writeState atomically replaces the state file. Mark the mutation before
      // entering that durable write so a successful write followed by a failed
      // inspection still invalidates caches and notifies every open Renderer.
      mutationMayHaveChangedState = true;
      await writeState({
        version: STATE_VERSION,
        disabledSources: [...disabled].sort(),
        approvedExtensionSources: [...approved].sort(),
        approvedExtensionFingerprints: Object.fromEntries(
          Object.entries(approvedFingerprints).sort(([left], [right]) => left.localeCompare(right)),
        ),
        snapshotUnavailableRoots: state.snapshotUnavailableRoots,
      });
    }
    invalidateInspectionCache();
    const result = await listPiPackagesNow();
    const affectedPackage = affectedSource
      ? findAffectedPiPackage(result.packages, affectedSource)
      : findAffectedPiPackage(result.packages, source);
    const mutationResult = { ...result, changed: true, ...(affectedPackage ? { affectedPackage } : {}) };
    await publishPiPackagesChanged({ invalidateCache: false });
    return mutationResult;
  }, async () => {
    // Any action may already have changed Pi's package tree or Cindy's state
    // before a later CLI/inspection step reports failure. Persist the shared
    // change token before releasing the cross-process lock, then refresh every
    // open Settings view and command palette.
    if (mutationMayHaveChangedState) {
      await publishPiPackagesChanged();
    }
  });
}

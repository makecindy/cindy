/**
 * Cindy-owned Pi package store.
 *
 * Pi's own package CLI owns source parsing, downloads, dependency installation,
 * updates, and removal. Cindy gives it an isolated PI_CODING_AGENT_DIR under
 * userData. Normal local runtimes receive installed roots as native Pi package
 * settings; Cindy inspection supplies advisory UI metadata, never an allowlist.
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, unwatchFile, watchFile, type Stats } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type {
  PiManagedPackageMutationFailureCode,
  PiNativePackageEntry,
} from '@cindy/maker-core';
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
const PACKAGE_MUTATION_TARGET_PREFIX = 'cindy-pi-package:';
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
export type PiPackagesChangeOrigin = 'local' | 'external' | 'external-runtime';
const changeListeners = new Set<(origin: PiPackagesChangeOrigin) => void>();
const packageMutationMayHaveChangedErrors = new WeakSet<object>();
let changeTokenWatcherActive = false;
let changeTokenWatcherStartedAtMs: number | undefined;
let lastObservedRuntimeChangeToken: string | null | undefined;
let runtimeChangeTokenReadFailedBeforeBaseline = false;
let runtimeRecoveryLegacyBaseline: string | null = null;
let runtimeRecoveryLegacyBaselineInitialized = false;
let lastObservedLegacyChangeToken: string | null | undefined;
let lastObservedViewChangeToken: string | null | undefined;
let lastNotifiedRuntimeChangeToken: string | null | undefined;
let lastExternallyNotifiedRuntimeChangeToken: string | null | undefined;
let changeTokenReadInFlight: Promise<void> | undefined;
let changeTokenReadQueued = false;
const changeTokenWatchListener = () => void observePiPackageChangeToken();
// Remove userinfo before token projection. The authority match is deliberately
// quote-tolerant because apostrophes and JSON quotes can occur around valid URLs.
const PACKAGE_URL_USERINFO_PATTERN = /((?:git:)?[a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi;
const PACKAGE_URL_PATTERN = /(?:git:)?[a-z][a-z0-9+.-]*:\/\/\S+/gi;

export function onPiPackagesChanged(
  listener: (origin: PiPackagesChangeOrigin) => void,
): () => void {
  changeListeners.add(listener);
  startPiPackageChangeTokenWatcher();
  return () => {
    changeListeners.delete(listener);
    if (changeListeners.size === 0) stopPiPackageChangeTokenWatcher();
  };
}

function notifyPiPackagesChanged(origin: PiPackagesChangeOrigin): void {
  for (const listener of changeListeners) {
    try {
      listener(origin);
    } catch (error) {
      log.warn('Pi package change listener failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function readPiPackageChangeToken(tokenPath: string): Promise<string | null> {
  try {
    const handle = await fs.open(tokenPath, 'r');
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

function changeTokenReadFailureCategory(error: unknown): 'access-denied' | 'io-failure' | 'invalid-token' | 'unavailable' {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'access-denied';
  if (code === 'EIO') return 'io-failure';
  if (error instanceof Error && error.message === 'Pi package change token is invalid') return 'invalid-token';
  return 'unavailable';
}

function runtimeTokenWasPublishedAfterWatcherStarted(token: string | null): boolean {
  if (!token || changeTokenWatcherStartedAtMs === undefined) return false;
  const match = token.match(/^runtime:(\d+)-/);
  if (!match) return false;
  const publishedAtMs = Number(match[1]);
  return Number.isSafeInteger(publishedAtMs)
    && publishedAtMs >= changeTokenWatcherStartedAtMs;
}

function observePiPackageChangeToken(): Promise<void> {
  if (changeTokenReadInFlight) {
    changeTokenReadQueued = true;
    return changeTokenReadInFlight;
  }
  const runtimeBaselineAtReadStart = lastObservedRuntimeChangeToken;
  const legacyBaselineAtReadStart = lastObservedLegacyChangeToken;
  const viewBaselineAtReadStart = lastObservedViewChangeToken;
  const pending = Promise.allSettled([
    readPiPackageChangeToken(runtimeChangeTokenPath()),
    readPiPackageChangeToken(changeTokenPath()),
    readPiPackageChangeToken(viewChangeTokenPath()),
  ]).then(([runtimeResult, legacyResult, viewResult]) => {
    // A local publication may rebase observations while async reads are open.
    // Ignore that stale batch per token and immediately read the published edge.
    const runtimeObservationCurrent = lastObservedRuntimeChangeToken === runtimeBaselineAtReadStart;
    const legacyObservationCurrent = lastObservedLegacyChangeToken === legacyBaselineAtReadStart;
    const viewObservationCurrent = lastObservedViewChangeToken === viewBaselineAtReadStart;
    if (!runtimeObservationCurrent || !legacyObservationCurrent || !viewObservationCurrent) {
      changeTokenReadQueued = true;
    }
    for (const [tokenKind, result] of [
      ['runtime', runtimeResult],
      ['legacy', legacyResult],
      ['view', viewResult],
    ] as const) {
      if (result.status === 'rejected') {
        if (tokenKind === 'runtime'
          && runtimeObservationCurrent
          && lastObservedRuntimeChangeToken === undefined) {
          runtimeChangeTokenReadFailedBeforeBaseline = true;
        }
        log.warn('Pi package change token read failed', {
          tokenKind,
          failureCategory: changeTokenReadFailureCategory(result.reason),
        });
      }
    }

    let runtimeChanged = false;
    let legacyChanged = false;
    let viewChanged = false;
    let runtimeToken: string | null = null;
    let legacyToken: string | null = null;
    let viewToken: string | null = null;
    if (runtimeResult.status === 'fulfilled' && runtimeObservationCurrent) {
      runtimeToken = runtimeResult.value;
      if (lastObservedRuntimeChangeToken === undefined) {
        // A first successful read is a cold-start baseline only when runtime
        // observation has never failed. After a failed read, an initialized
        // legacy baseline lets us distinguish a peer runtime edge from the
        // token that this Main had already observed.
        runtimeChanged = runtimeTokenWasPublishedAfterWatcherStarted(runtimeToken)
          || (runtimeChangeTokenReadFailedBeforeBaseline
            && runtimeRecoveryLegacyBaselineInitialized
            && runtimeToken !== runtimeRecoveryLegacyBaseline);
        runtimeChangeTokenReadFailedBeforeBaseline = false;
        runtimeRecoveryLegacyBaseline = null;
        runtimeRecoveryLegacyBaselineInitialized = false;
        lastObservedRuntimeChangeToken = runtimeToken;
        if (!runtimeChanged && lastNotifiedRuntimeChangeToken === undefined) {
          lastNotifiedRuntimeChangeToken = runtimeToken;
        }
      } else {
        runtimeChanged = runtimeToken !== lastObservedRuntimeChangeToken;
        lastObservedRuntimeChangeToken = runtimeToken;
      }
    }
    if (legacyResult.status === 'fulfilled' && legacyObservationCurrent) {
      legacyToken = legacyResult.value;
      if (lastObservedLegacyChangeToken === undefined) {
        legacyChanged = runtimeTokenWasPublishedAfterWatcherStarted(legacyToken);
        lastObservedLegacyChangeToken = legacyToken;
        if (!runtimeChanged && !legacyChanged && lastNotifiedRuntimeChangeToken === undefined) {
          lastNotifiedRuntimeChangeToken = legacyToken?.startsWith('view:') ? null : legacyToken;
        }
      } else {
        legacyChanged = legacyToken !== lastObservedLegacyChangeToken;
        lastObservedLegacyChangeToken = legacyToken;
      }
    }
    if (runtimeResult.status === 'rejected'
      && runtimeObservationCurrent
      && lastObservedRuntimeChangeToken === undefined
      && !runtimeRecoveryLegacyBaselineInitialized
      && !legacyChanged
      && lastObservedLegacyChangeToken !== undefined
      && (lastObservedLegacyChangeToken === null
        || (!lastObservedLegacyChangeToken.startsWith('view:')
          && lastObservedLegacyChangeToken !== lastExternallyNotifiedRuntimeChangeToken))) {
      // Freeze the first trustworthy runtime-style legacy observation available
      // during the outage. A missing legacy token is a valid null baseline, not
      // an uninitialized one. Later legacy edges converge independently and must
      // not move this recovery comparison point.
      runtimeRecoveryLegacyBaseline = lastObservedLegacyChangeToken;
      runtimeRecoveryLegacyBaselineInitialized = true;
    }
    if (viewResult.status === 'fulfilled' && viewObservationCurrent) {
      viewToken = viewResult.value;
      if (lastObservedViewChangeToken === undefined) {
        lastObservedViewChangeToken = viewToken;
      } else {
        viewChanged = viewToken !== lastObservedViewChangeToken;
        lastObservedViewChangeToken = viewToken;
      }
    }
    if (!runtimeChanged && !legacyChanged && !viewChanged) return;
    invalidateInspectionCache();
    const runtimeCandidate = runtimeChanged && runtimeToken
      ? runtimeToken
      : legacyChanged && legacyToken && !legacyToken.startsWith('view:')
        ? legacyToken
        : null;
    if (runtimeCandidate && runtimeCandidate !== lastNotifiedRuntimeChangeToken) {
      lastNotifiedRuntimeChangeToken = runtimeCandidate;
      lastExternallyNotifiedRuntimeChangeToken = runtimeCandidate;
      notifyPiPackagesChanged('external-runtime');
    } else if (viewChanged || (legacyChanged && legacyToken?.startsWith('view:'))) {
      notifyPiPackagesChanged('external');
    }
  }).catch(() => {
    log.warn('Pi package change token observation failed', {
      failureCategory: 'observer-failed',
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
  changeTokenWatcherStartedAtMs ??= Date.now();
  void observePiPackageChangeToken();
  for (const tokenPath of [
    runtimeChangeTokenPath(),
    changeTokenPath(),
    viewChangeTokenPath(),
  ]) {
    watchFile(
      tokenPath,
      { interval: CHANGE_TOKEN_POLL_MS, persistent: false },
      changeTokenWatchListener,
    );
  }
}

function stopPiPackageChangeTokenWatcher(): void {
  if (!changeTokenWatcherActive) return;
  changeTokenWatcherActive = false;
  unwatchFile(runtimeChangeTokenPath(), changeTokenWatchListener);
  unwatchFile(changeTokenPath(), changeTokenWatchListener);
  unwatchFile(viewChangeTokenPath(), changeTokenWatchListener);
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

export function piPackageMutationFailureCategory(
  error: unknown,
): PiManagedPackageMutationFailureCode {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes('state is unavailable')) return 'state-unavailable';
  if (/\betarget\b|no matching version|version[^\n]*not found/.test(message)) {
    return 'version-not-found';
  }
  if (/\be404\b|package[^\n]*not found|repository[^\n]*not found|404 not found/.test(message)) {
    return 'package-not-found';
  }
  if (/\benotfound\b|\beai_again\b|\beconnrefused\b|\betimedout\b|network|fetch failed|could not resolve host|unable to access/.test(message)) {
    return 'source-unavailable';
  }
  return 'native-command-failed';
}

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
  /** Manifest explicitly declares Extension entries, but none exist after dependency install. */
  missingDeclaredExtensions?: boolean;
  /** User-authorized package build script available to repair missing generated entries. */
  buildScript?: string;
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
const pendingEnabledSources = new Set<string>();

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

function pendingEnablePath(): string {
  return path.join(packageHome(), 'cindy-package-pending-enable.json');
}

function changeTokenPath(): string {
  return path.join(packageHome(), 'cindy-package-change-token');
}

function runtimeChangeTokenPath(): string {
  return path.join(packageHome(), 'cindy-package-runtime-change-token');
}

function viewChangeTokenPath(): string {
  return path.join(packageHome(), 'cindy-package-view-change-token');
}

function changeTokenPublicationFailureCategory(
  error: unknown,
): 'access-denied' | 'io-failure' | 'unavailable' {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'access-denied';
  if (code === 'EIO') return 'io-failure';
  return 'unavailable';
}

function tryPublishPiPackageRuntimeChangeToken(
  tokenKind: 'runtime' | 'legacy',
  tokenPath: string,
  token: string,
): boolean {
  try {
    atomicWriteFileSync(tokenPath, `${token}\n`);
    return true;
  } catch (error) {
    log.warn('Pi package change token publication failed; local convergence continued', {
      tokenKind,
      failureCategory: 'runtime-token-publication-failed',
      causeCategory: changeTokenPublicationFailureCategory(error),
      recoveryAction: 'restart-cindy-to-refresh-packages',
    });
    return false;
  }
}

async function persistPiPackageChangeToken(runtimeInvalidation: boolean): Promise<void> {
  const scope = runtimeInvalidation ? 'runtime' : 'view';
  const token = `${scope}:${Date.now()}-${process.pid}-${randomUUID()}`;
  // Set each local baseline before its synchronous atomic publication so this
  // Main never re-observes its own edge. Restore the old baseline when a write
  // fails; local convergence still proceeds, while a later real edge remains
  // observable.
  if (runtimeInvalidation) {
    const previousRuntime = lastObservedRuntimeChangeToken;
    lastObservedRuntimeChangeToken = token;
    const runtimePublished = tryPublishPiPackageRuntimeChangeToken(
      'runtime', runtimeChangeTokenPath(), token,
    );
    if (!runtimePublished) lastObservedRuntimeChangeToken = previousRuntime;

    const previousLegacy = lastObservedLegacyChangeToken;
    lastObservedLegacyChangeToken = token;
    const legacyPublished = tryPublishPiPackageRuntimeChangeToken(
      'legacy', changeTokenPath(), token,
    );
    if (!legacyPublished) lastObservedLegacyChangeToken = previousLegacy;
    if (runtimePublished || legacyPublished) lastNotifiedRuntimeChangeToken = token;
  } else {
    lastObservedViewChangeToken = token;
    atomicWriteFileSync(viewChangeTokenPath(), `${token}\n`);
  }
}

async function publishPiPackagesChanged(
  options: { invalidateCache?: boolean; runtimeInvalidation?: boolean } = {},
): Promise<void> {
  await persistPiPackageChangeToken(options.runtimeInvalidation === true);
  if (options.invalidateCache !== false) invalidateInspectionCache();
  notifyPiPackagesChanged('local');
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
      failureCategory: 'state-unavailable',
    });
    return { ok: false, error };
  }
}

async function requireState(): Promise<PiPackageState> {
  const result = await readState();
  if (!result.ok) throw new PiPackageStateUnavailableError();
  return result.state;
}

async function disabledSourcesWithoutPendingAliases(
  disabledSources: string[],
  pending: ReadonlySet<string>,
): Promise<string[]> {
  const pendingAliases = new Set((await Promise.all(
    [...pending].map((source) => sourceAliasesWithCanonical(source)),
  )).flat());
  const remaining: string[] = [];
  for (const source of disabledSources) {
    const aliases = await sourceAliasesWithCanonical(source);
    if (!aliases.some((alias) => pendingAliases.has(alias))) remaining.push(source);
  }
  return remaining;
}

async function readStateWithoutBlockingPi(): Promise<PiPackageState> {
  const result = await readState();
  if (result.ok) {
    const pending = await readPendingEnabledSources();
    return {
      ...result.state,
      disabledSources: await disabledSourcesWithoutPendingAliases(
        result.state.disabledSources,
        pending,
      ),
    };
  }
  // An unavailable disable ledger cannot be projected as an empty ledger: that
  // would silently restore capabilities the user explicitly revoked. Native
  // mutations remain successful, but local startup/list projection must wait
  // until Cindy can determine the effective package state.
  throw new PiPackageStateUnavailableError();
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

async function readPendingEnabledSources(): Promise<Set<string>> {
  const pending = new Set(pendingEnabledSources);
  try {
    const parsed = JSON.parse(await fs.readFile(pendingEnablePath(), 'utf8')) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((source) => (
      typeof source === 'string' && source.length > 0 && source.length <= MAX_SOURCE_LENGTH
    ))) throw new Error('Invalid pending Pi enable reconciliation');
    for (const source of parsed) pending.add(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return pending;
    // A partial read cannot safely feed any read-modify-write caller: replacing
    // the journal would lose unseen sibling reconciliations after a restart.
    log.warn('Pi pending enable reconciliation unavailable', {
      failureCategory: 'state-unavailable',
    });
    throw new PiPackageStateUnavailableError();
  }
  return pending;
}

function replacePendingEnabledSourcesInMemory(sources: ReadonlySet<string>): void {
  pendingEnabledSources.clear();
  for (const source of sources) pendingEnabledSources.add(source);
}

async function writePendingEnabledSources(sources: ReadonlySet<string>): Promise<boolean> {
  const durableSources = new Set([...sources].filter((source) => (
    !projectPackageSource(source).unsafe && !/[?#]/.test(source)
  )));
  if (durableSources.size === 0) {
    await fs.rm(pendingEnablePath(), { force: true });
    replacePendingEnabledSourcesInMemory(sources);
    return durableSources.size === sources.size;
  }
  await fs.mkdir(packageHome(), { recursive: true, mode: 0o700 });
  const target = pendingEnablePath();
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify([...durableSources].sort())}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await fs.rename(temporary, target);
    replacePendingEnabledSourcesInMemory(sources);
    return durableSources.size === sources.size;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function persistPendingEnabledSources(sources: Iterable<string>): Promise<void> {
  const previousMemory = new Set(pendingEnabledSources);
  const pending = await readPendingEnabledSources();
  for (const source of sources) pending.add(source);
  try {
    if (!await writePendingEnabledSources(pending)) throw new PiPackageStateUnavailableError();
  } catch (error) {
    // A non-durable attempt must not become an enable override visible only to
    // this Main. Preserve any overlay that predated this mutation.
    replacePendingEnabledSourcesInMemory(previousMemory);
    throw error;
  }
}

async function reconcilePendingEnabledSources(): Promise<void> {
  const pending = await readPendingEnabledSources();
  if (pending.size === 0) return;
  const state = await requireState();
  const disabledSources = await disabledSourcesWithoutPendingAliases(
    state.disabledSources,
    pending,
  );
  if (disabledSources.length !== state.disabledSources.length) {
    await writeState({ ...state, disabledSources });
  }
  await writePendingEnabledSources(new Set());
}

function boundedAppend(current: string, chunk: Buffer): string {
  const next = Buffer.concat([Buffer.from(current, 'utf8'), chunk]);
  return (next.length <= MAX_COMMAND_OUTPUT_BYTES
    ? next
    : next.subarray(next.length - MAX_COMMAND_OUTPUT_BYTES)
  ).toString('utf8');
}

interface RunPiPackageCommandOptions {
  /** Incremental native projection; returned diagnostic stdout remains bounded. */
  onStdoutChunk?: (chunk: Buffer) => void;
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

async function runPackageProcess(
  binaryPath: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: RunPiPackageCommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      cwd,
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
        // This process exists only after the user explicitly requested the
        // exact package mutation. Do not inherit a parent-level scripts ban:
        // Git packages may need lifecycle hooks to install native dependencies
        // before their declared Extension entry can be built.
        npm_config_ignore_scripts: 'false',
        NPM_CONFIG_IGNORE_SCRIPTS: 'false',
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
      options.onStdoutChunk?.(chunk);
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
        resolve({ stdout, stderr });
      } else reject(new Error(redactPackageCommandMessage(
        (stderr || stdout || `Pi package command failed (${code ?? 'unknown'})`).trim(),
      )));
    });
  });
}

export async function runPiPackageCommand(
  args: string[],
  timeoutMs = COMMAND_TIMEOUT_MS,
  options: RunPiPackageCommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const binaryPath = getReadyBinaryPath('pi');
  if (!binaryPath) throw new Error('Pi is not installed in Cindy');
  await fs.mkdir(packageHome(), { recursive: true, mode: 0o700 });
  return runPackageProcess(binaryPath, args, packageHome(), timeoutMs, options);
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

function appendPiPackageListLine(
  rawLine: string,
  packages: ListedPackage[],
  current: ListedPackage | null,
): ListedPackage | null {
  if (!rawLine.trim() || /^(User|Project) packages:$/.test(rawLine.trim())) return current;
  const sourceMatch = rawLine.match(/^\s{2}(\S.*?)( \(filtered\))?\s*$/);
  if (sourceMatch?.[1]) {
    const next = { source: sourceMatch[1], ...(sourceMatch[2] ? { filtered: true } : {}) };
    packages.push(next);
    return next;
  }
  const pathMatch = rawLine.match(/^\s{4}(\S.*)\s*$/);
  if (current && pathMatch?.[1]) current.installedPath = pathMatch[1];
  return current;
}

export function parsePiPackageListOutput(output: string): ListedPackage[] {
  const packages: ListedPackage[] = [];
  let current: ListedPackage | null = null;
  for (const rawLine of output.split(/\r?\n/)) {
    current = appendPiPackageListLine(rawLine, packages, current);
  }
  return packages;
}

async function runPiPackageListCommand(): Promise<ListedPackage[]> {
  const decoder = new StringDecoder('utf8');
  const packages: ListedPackage[] = [];
  let current: ListedPackage | null = null;
  let pendingLine = '';
  const consume = (text: string, complete = false): void => {
    const lines = `${pendingLine}${text}`.split(/\r?\n/);
    pendingLine = complete ? '' : lines.pop() ?? '';
    for (const line of lines) current = appendPiPackageListLine(line, packages, current);
    if (complete && pendingLine) current = appendPiPackageListLine(pendingLine, packages, current);
  };
  await runPiPackageCommand(['list', '--no-approve'], COMMAND_TIMEOUT_MS, {
    onStdoutChunk: (chunk) => consume(decoder.write(chunk)),
  });
  consume(decoder.end(), true);
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

function unknownExtensionResourceView(file: string): PiPackageResourceView {
  return {
    kind: 'extension',
    name: truncateDisplayField(path.basename(file), MAX_DISPLAY_NAME_BYTES),
    compatibility: 'unknown',
    compatibilityIssues: ['analysis-incomplete'],
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
    return unknownExtensionResourceView(file);
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
  const explicitlyDisabled = isPackageSourceDisabled(new Set(state.disabledSources), pkg.source);
  if (unsafe) {
    return {
      rawSource: pkg.source,
      view: {
        source: displaySource,
        mutationTarget: packageMutationTarget(pkg.source),
        name: displaySource,
        enabled: Boolean(pkg.installedPath) && !explicitlyDisabled,
        resources: [],
        warning: 'unsafe-source',
      },
      launch: empty,
      promptCommands: [],
      ...(pkg.installedPath ? { installedRoot: pkg.installedPath } : {}),
    };
  }
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
    // Compatibility parsing is advisory and must never decide whether code is
    // installable. Keep it sequential and bounded; once its package-wide time
    // allowance is spent, project remaining entries as unknown rather than
    // failing inspection or withholding launch resources.
    const extensionResources: PiPackageResourceView[] = [];
    const compatibilityDeadline = Date.now() + MAX_INSPECTION_MS;
    for (const file of extensions) {
      extensionResources.push(Date.now() < compatibilityDeadline
        ? await extensionResourceView(root, file)
        : unknownExtensionResourceView(file));
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
    const warning = resources.length === 0
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
      ...(Array.isArray(declared?.extensions)
        && declared.extensions.length > 0
        && extensions.length === 0
        ? { missingDeclaredExtensions: true as const }
        : {}),
      ...(typeof manifest.scripts?.build === 'string' && manifest.scripts.build.trim()
        ? { buildScript: manifest.scripts.build.trim() }
        : {}),
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
      ...(installedRoot || pkg.installedPath
        ? { installedRoot: installedRoot ?? pkg.installedPath }
        : {}),
    };
  }
}

async function inspectAllPackagesUncached(): Promise<InspectedPackage[]> {
  const [listed, stateResult] = await Promise.all([
    runPiPackageListCommand(),
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
          ...(unsafe ? { mutationTarget: packageMutationTarget(pkg.source) } : {}),
          name: displaySource,
          enabled: false,
          ...(!unsafe ? { canToggle: false as const } : {}),
          resources: [],
          warning: unsafe ? 'unsafe-source' : 'inspection-limit',
        },
        launch: { extensions: [], skills: [], promptTemplates: [], packageRoots: [] },
        promptCommands: [],
        ...(pkg.installedPath ? { installedRoot: pkg.installedPath } : {}),
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

async function projectNativePackageViews(
  inspected: InspectedPackage[],
): Promise<PiPackageView[]> {
  const state = await readStateWithoutBlockingPi();
  const disabled = new Set(state.disabledSources);
  return inspected.map((pkg) => {
    const warning = snapshotUnavailableWarningForPackage(pkg) ?? pkg.view.warning;
    const mutationTarget = pkg.view.mutationTarget
      ?? (pkg.view.source !== pkg.rawSource ? packageMutationTarget(pkg.rawSource) : undefined);
    const {
      requiresExtensionApproval: _ignoredApproval,
      manageable: _ignoredManageable,
      canToggle,
      ...view
    } = pkg.view;
    // Pi's list output is the install truth. Cindy inspection, compatibility,
    // fingerprint, or snapshot failures stay advisory and cannot disable it.
    const installed = Boolean(pkg.installedRoot);
    return {
      ...view,
      ...(mutationTarget ? { mutationTarget } : {}),
      enabled: installed && !isPackageSourceDisabled(disabled, pkg.rawSource),
      ...(!installed && canToggle === false ? { canToggle: false as const } : {}),
      ...(warning ? { warning } : {}),
    };
  });
}

async function listPiPackagesNow(): Promise<PiPackageListResult> {
  if (!getReadyBinaryPath('pi')) return { available: false, packages: [] };
  const inspected = await inspectAllPackages();
  return {
    available: true,
    packages: await projectNativePackageViews(inspected),
  };
}

export async function listPiPackages(): Promise<PiPackageListResult> {
  await mutationTail;
  return listPiPackagesNow();
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

async function readNativePackageSettingsText(home: string): Promise<string> {
  const settingsPath = path.join(home, 'settings.json');
  // This is Pi's native launch configuration, not advisory package metadata.
  // Follow the same user-managed symlink Pi follows instead of applying Cindy's
  // package confinement or inspection byte budget to this projection.
  const handle = await fs.open(settingsPath, 'r');
  try {
    const stat = await handle.stat();
    const followedStat = await fs.stat(settingsPath);
    if (!stat.isFile() || !sameStableFileIdentity(stat, followedStat)) {
      throw new Error('Pi package settings changed before reading');
    }
    const buffer = await handle.readFile();
    const [after, followedAfter] = await Promise.all([
      handle.stat(),
      fs.stat(settingsPath),
    ]);
    if (
      !sameStableFileIdentity(stat, after)
      || !sameStableFileIdentity(after, followedAfter)
      || buffer.length !== after.size
    ) {
      throw new Error('Pi package settings changed while reading');
    }
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readNativePackageObjectSpecs(): Promise<Map<string, Record<string, unknown>> | null> {
  try {
    const home = await fs.realpath(packageHome());
    const parsed = JSON.parse(await readNativePackageSettingsText(home)) as { packages?: unknown };
    if (!Array.isArray(parsed.packages)) return new Map();
    return new Map(parsed.packages.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const spec = entry as Record<string, unknown>;
      return typeof spec.source === 'string' ? [[spec.source, spec] as const] : [];
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function resolveManagedPiNativePackagePaths(): Promise<PiNativePackageEntry[]> {
  if (!getReadyBinaryPath('pi')) return [];
  const [listed, state] = await Promise.all([
    runPiPackageListCommand(),
    readStateWithoutBlockingPi(),
  ]);
  const disabled = new Set(state.disabledSources);
  let objectSpecs: Map<string, Record<string, unknown>> | null = null;
  try {
    objectSpecs = await readNativePackageObjectSpecs();
  } catch {
    log.warn('Pi package filter settings unavailable', {
      failureCategory: 'state-unavailable',
    });
  }
  // Feed Pi installed roots while preserving any native object-form filters.
  // Pi then owns resource discovery without reinstalling the package.
  const entries = listed.flatMap((pkg): PiNativePackageEntry[] => {
    if (!pkg.installedPath || isPackageSourceDisabled(disabled, pkg.source)) return [];
    const spec = objectSpecs?.get(pkg.source);
    if (spec) return [{ ...spec, source: pkg.installedPath }];
    // Never silently drop or widen a natively filtered package. If its exact
    // filter cannot be recovered, fail startup with the existing actionable
    // package-state error instead of pretending the installed package vanished.
    if (pkg.filtered) throw new PiPackageStateUnavailableError();
    return [pkg.installedPath];
  });
  return entries.filter((entry, index) => (
    entries.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(entry)) === index
  ));
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
  // Preserve explicit source syntax exactly as Pi accepts it. Cindy may redact
  // credentials or query data in UI/log projections, but must not reject a
  // source that the native `pi install` command can consume.
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

function packageMutationTarget(source: string): string {
  return `${PACKAGE_MUTATION_TARGET_PREFIX}${createHash('sha256').update(source).digest('hex')}`;
}

function isPackageSourceDisabled(disabled: ReadonlySet<string>, source: string): boolean {
  return disabled.has(source) || disabled.has(packageMutationTarget(source));
}

async function resolvePackageMutationTarget(
  source: string,
  mutationTarget: string | undefined,
  requireInstalled = false,
): Promise<string> {
  if (!mutationTarget) {
    if (!requireInstalled) return source;
    try {
      const aliases = new Set(sourceAliases(source));
      const match = (await runPiPackageListCommand()).find((pkg) => aliases.has(pkg.source));
      if (match) return match.source;
    } catch {
      // A toggle cannot safely create state for a target whose native roster is
      // unavailable. Keep the public failure stable and free of source details.
    }
    throw new PiPackageStateUnavailableError();
  }
  const digest = mutationTarget.slice(PACKAGE_MUTATION_TARGET_PREFIX.length);
  if (!mutationTarget.startsWith(PACKAGE_MUTATION_TARGET_PREFIX)
    || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('Invalid Pi package mutation target');
  }
  // An opaque disable is a durable deny keyed by the Main-minted identity. It
  // neither needs the secret-bearing source nor grants authority to enable it.
  if (!requireInstalled) return mutationTarget;
  let listed: ListedPackage[];
  try {
    listed = await runPiPackageListCommand();
  } catch {
    throw new PiPackageStateUnavailableError();
  }
  const match = listed.find((pkg) => (
    packageMutationTarget(pkg.source) === mutationTarget
  ));
  if (!match) throw new Error('Pi package mutation target is no longer installed');
  return match.source;
}

function projectPackageSource(source: string): PackageSourceProjection {
  const gitPrefix = source.match(/^git:/i)?.[0] ?? '';
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
  const withoutUserinfo = message.replace(PACKAGE_URL_USERINFO_PATTERN, '$1');
  return withoutUserinfo.replace(
    PACKAGE_URL_PATTERN,
    (source) => projectPackageSource(source).displaySource,
  );
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
  const fileSource = /^file:(.*)$/i.exec(source)?.[1];
  const localSource = fileSource ?? source;
  if (!isLocalPackageSource(localSource)) return undefined;
  try {
    return await fs.realpath(path.resolve(packageHome(), localSource));
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

export function piPackageMutationMayHaveChangedState(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && packageMutationMayHaveChangedErrors.has(error);
}

async function expandAliasesWithDisabledSources(sources: Iterable<string>): Promise<string[]> {
  const expanded = new Set(sources);
  const targetAliases = new Set((await Promise.all(
    [...expanded].map((source) => sourceAliasesWithCanonical(source)),
  )).flat());
  const opaqueTargets = new Set([...targetAliases].map(packageMutationTarget));
  const state = await requireState();
  for (const disabledSource of state.disabledSources) {
    const aliases = await sourceAliasesWithCanonical(disabledSource);
    if (opaqueTargets.has(disabledSource)
      || aliases.some((alias) => targetAliases.has(alias))) expanded.add(disabledSource);
  }
  return [...expanded];
}

async function clearDisabledPackageSources(sources: Iterable<string>): Promise<void> {
  const requestedTargets = [...new Set(sources)];
  if (requestedTargets.length === 0) return;
  const targets = new Set((await Promise.all(
    requestedTargets.map((source) => sourceAliasesWithCanonical(source)),
  )).flat());
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const state = await requireState();
      const disabledSources: string[] = [];
      for (const source of state.disabledSources) {
        const aliases = await sourceAliasesWithCanonical(source);
        if (!aliases.some((alias) => targets.has(alias))) disabledSources.push(source);
      }
      if (disabledSources.length === state.disabledSources.length) return;
      await writeState({ ...state, disabledSources });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
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
 * Preserve optional snapshot metadata when Cindy can compute it. This helper
 * never decides native package enablement and never scans sibling dependency
 * closures before allowing a Pi command to run.
 */
async function persistEnabledExtensionApprovals(options: {
  enable?: InspectedPackage;
}): Promise<void> {
  const state = await requireState();
  const disabled = new Set(state.disabledSources);
  const approved = new Set(state.approvedExtensionSources);
  const fingerprints = { ...state.approvedExtensionFingerprints };

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

async function sourceAliasesWithCanonical(source: string): Promise<string[]> {
  const aliases = new Set(sourceAliases(source));
  const canonical = await canonicalLocalPackageSource(source);
  if (canonical) aliases.add(canonical);
  return [...aliases];
}

function mutationCommandSource(
  requestedSource: string,
  installed: InspectedPackage | undefined,
): string {
  return installed?.installedRoot && isLocalPackageSource(installed.rawSource)
    ? installed.installedRoot
    : requestedSource;
}

async function buildMissingDeclaredPiExtensions(pkg: InspectedPackage): Promise<boolean> {
  if (!pkg.missingDeclaredExtensions || !pkg.buildScript || !pkg.installedRoot) return false;
  const npmExecutable = process.platform === 'win32'
    ? (process.env.ComSpec || 'cmd.exe')
    : 'npm';
  const npmPrefix = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm']
    : [];
  // Git sources commonly omit generated build output. This is optional
  // convenience under the user's explicit install authorization; failure is
  // advisory because Pi's own successful install remains the result truth.
  await runPackageProcess(
    npmExecutable,
    [...npmPrefix, 'install', '--include=dev', '--no-audit', '--no-fund'],
    pkg.installedRoot,
    COMMAND_TIMEOUT_MS,
  );
  await runPackageProcess(
    npmExecutable,
    [...npmPrefix, 'run', 'build'],
    pkg.installedRoot,
    COMMAND_TIMEOUT_MS,
  );
  return true;
}

export type PiPackageRuntimeInvalidationPhase = 'commit' | 'post-build';

export interface PiPackageMutationHooks {
  /** Host callers may retire local runtimes immediately after each package-byte edge. */
  onRuntimeInvalidationPublished?: (
    phase?: PiPackageRuntimeInvalidationPhase,
  ) => void | Promise<void>;
}

export async function mutatePiPackage(
  request: PiPackageMutationRequest,
  grant?: PiPackageMutationGrant,
  hooks?: PiPackageMutationHooks,
): Promise<PiPackageMutationResult> {
  if (piPackageMutationNeedsGrant(request)) {
    // The one-shot grant binds the exact user/tool action to this mutation. It
    // is not a second package-compatibility or content-approval gate.
    consumePiPackageMutationGrant(request, grant);
  }
  const requestedSource = requireSource(request.source);
  if (request.action === 'install' && isRelativeLocalPiPackageSource(requestedSource)) {
    throw new Error('Relative local Pi package sources require a task working directory');
  }
  let mutationMayHaveChangedState = false;
  let runtimeInvalidationPublished = false;
  const publishRuntimeInvalidation = async (
    invalidateCache = false,
    phase: PiPackageRuntimeInvalidationPhase = 'commit',
  ): Promise<void> => {
    if (runtimeInvalidationPublished && phase === 'commit') return;
    runtimeInvalidationPublished = true;
    try {
      // Fence startup and bind runtimes before token I/O yields. A post-build
      // edge advances the fence again for runtimes admitted during assistance.
      await hooks?.onRuntimeInvalidationPublished?.(phase);
    } catch {
      // Convergence is best-effort after the durable package mutation edge;
      // never rewrite native success because a local runtime did not close.
      log.warn('Pi package runtime convergence callback failed', {
        failureCategory: 'runtime-invalidation-failed',
      });
    }
    await publishPiPackagesChanged({ invalidateCache, runtimeInvalidation: true });
  };
  try {
    return await enqueueMutation(async () => {
    // Renderer rows with credential/query/fragment-bearing sources carry only a
    // one-way opaque target. Resolve it from Pi's current native list inside the
    // mutation lock so the secret source never crosses into Renderer state.
    const source = await resolvePackageMutationTarget(
      requestedSource,
      request.mutationTarget,
      // Enabling and native commands must resolve an opaque row against Pi's
      // current roster. Disabling can durably deny the Main-minted opaque target.
      request.action === 'set-enabled'
        ? request.enabled === true
        : Boolean(request.mutationTarget),
    );
    const logSource = projectPackageSource(source).displaySource;
    try {
      await reconcilePendingEnabledSources();
    } catch {
      // The active journal remains the effective enable source until a later
      // mutation can fold it into the durable disable ledger.
      log.warn('Pi pending enable reconciliation deferred');
    }
    // Cindy projection state is optional metadata. Native Pi package commands
    // run before any Cindy inspection; an analyzer timeout or unknown future
    // package shape therefore cannot delay or veto the upstream command.
    const inspectedBeforeMutation: InspectedPackage[] = [];
    let affectedSource: string | undefined;
    let installEnableProjectionUnavailable = false;
    const runNativeMutationCommand = async (args: string[]): Promise<void> => {
      try {
        await runPiPackageCommand(args);
        mutationMayHaveChangedState = true;
      } catch (error) {
        mutationMayHaveChangedState = piPackageMutationFailureCategory(error) === 'native-command-failed';
        throw error;
      }
    };
    if (request.action === 'install') {
      const previous = await findAffectedInspectedPackage(inspectedBeforeMutation, source);
      // The package command may run dependency and build scripts. Keep the old
      // optional snapshot identity until that command succeeds. Native Pi
      // enablement never depends on this Cindy metadata.
      await runNativeMutationCommand(['install', source, '--no-approve']);
      const installAliases = [...new Set((await Promise.all([
        sourceAliasesWithCanonical(requestedSource),
        sourceAliasesWithCanonical(source),
      ])).flat())];
      let effectiveInstallAliases = installAliases;
      let installEnableStateCommitted = false;
      // Explicit reinstall means enabled only after its precise aliases leave
      // the durable disable ledger. Reconcile that effective state before the
      // runtime fence so a startup admitted by the new generation cannot read
      // the old disable projection and survive without the reinstalled package.
      try {
        effectiveInstallAliases = await expandAliasesWithDisabledSources(installAliases);
        await clearDisabledPackageSources(effectiveInstallAliases);
        installEnableStateCommitted = true;
        const pending = await readPendingEnabledSources();
        for (const alias of effectiveInstallAliases) pending.delete(alias);
        await writePendingEnabledSources(pending);
      } catch (error) {
        // Only a failed authoritative state commit needs the existing pending
        // journal fallback. Once the disable ledger is clear, journal cleanup
        // is auxiliary and cannot turn the committed enable into a false
        // projection-unavailable result.
        if (!installEnableStateCommitted) {
          try {
            await persistPendingEnabledSources(effectiveInstallAliases);
          } catch {
            // Native install remains committed, but a process-local override
            // cannot prove enabled state to another Main or after restart.
            installEnableProjectionUnavailable = true;
          }
        }
        log.warn('Pi package installed; enable-ledger reconciliation deferred', {
          action: 'install',
          failureCategory: 'state-unavailable',
        });
      }
      await publishRuntimeInvalidation();
      invalidateInspectionCache();
      let inspectedAfterInstall: InspectedPackage[] = [];
      try {
        inspectedAfterInstall = await inspectAllPackages();
      } catch {
        log.warn('Pi package installed; Cindy post-install analysis unavailable', {
          action: 'install',
          failureCategory: 'projection-unavailable',
        });
      }
      let affected = await findAffectedInspectedPackage(inspectedAfterInstall, source);
      if (affected?.missingDeclaredExtensions) {
        const buildTarget = affected;
        // Best-effort convenience for Git packages that omit generated output.
        // Pi already accepted the install, so a Cindy-added build attempt may
        // improve it but can never reverse that native success.
        let built = false;
        try {
          built = await buildMissingDeclaredPiExtensions(buildTarget);
        } catch (error) {
          log.warn('optional Pi package build assistance failed', {
            failureCategory: piPackageMutationFailureCategory(error),
            mayHaveChangedState: true,
          });
        } finally {
          await publishRuntimeInvalidation(true, 'post-build');
        }
        if (built) {
          invalidateInspectionCache();
          inspectedAfterInstall = await inspectAllPackages();
          affected = await findAffectedInspectedPackage(inspectedAfterInstall, source);
        }
      }
      affectedSource = affected?.rawSource ?? previous?.rawSource ?? source;
      const approvalAliases = affected
        ? [...new Set([...installAliases, ...await sourceAliasesWithCanonical(affected.rawSource)])]
        : installAliases;
      try {
        await revokeExtensionApproval(approvalAliases);
        await persistEnabledExtensionApprovals({
          ...(affected ? { enable: affected } : {}),
        });
      } catch (error) {
        log.warn('Pi package installed but optional Cindy snapshot metadata refresh failed', {
          source: logSource,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (request.action === 'remove') {
      const previous = await findAffectedInspectedPackage(inspectedBeforeMutation, source);
      await runNativeMutationCommand([
        'remove',
        mutationCommandSource(source, previous),
        '--no-approve',
      ]);
      await publishRuntimeInvalidation();
      try {
        const state = await requireState();
        const removedSources = new Set([
          ...sourceAliases(source),
          packageMutationTarget(source),
          ...(previous ? [...sourceAliases(previous.rawSource), packageMutationTarget(previous.rawSource)] : []),
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
      } catch (error) {
        log.warn('Pi package removed but Cindy projection cleanup failed', {
          source: logSource,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (request.action === 'update') {
      const previous = await findAffectedInspectedPackage(inspectedBeforeMutation, source);
      const updateAliases = [
        ...sourceAliases(source),
        ...(previous ? sourceAliases(previous.rawSource) : []),
      ];
      const stateBeforeUpdate = await readState();
      const wasExplicitlyDisabled = stateBeforeUpdate.ok
        ? updateAliases.some((item) => isPackageSourceDisabled(
            new Set(stateBeforeUpdate.state.disabledSources),
            item,
          ))
        : null;
      // Keep the last optional snapshot identity until Pi's update command
      // succeeds. Cindy may retire a stale snapshot after byte changes, but
      // must not reinterpret that as disabling the native Pi package.
      await runNativeMutationCommand([
        'update',
        mutationCommandSource(source, previous),
        '--no-approve',
      ]);
      await publishRuntimeInvalidation();
      try {
        await revokeExtensionApproval(updateAliases);
      } catch (error) {
        log.warn('Pi package updated but Cindy approval projection could not be refreshed', {
          source: logSource,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      invalidateInspectionCache();
      let inspectedAfterUpdate: InspectedPackage[] = [];
      try {
        inspectedAfterUpdate = await inspectAllPackages();
      } catch {
        log.warn('Pi package updated; Cindy post-update analysis unavailable', {
          action: 'update',
          failureCategory: 'projection-unavailable',
        });
      }
      let affected = await findAffectedInspectedPackage(inspectedAfterUpdate, source);
      if (affected?.missingDeclaredExtensions) {
        const buildTarget = affected;
        let built = false;
        try {
          built = await buildMissingDeclaredPiExtensions(buildTarget);
        } catch (error) {
          log.warn('optional Pi package update build assistance failed', {
            failureCategory: piPackageMutationFailureCategory(error),
            mayHaveChangedState: true,
          });
        } finally {
          await publishRuntimeInvalidation(true, 'post-build');
        }
        if (built) {
          invalidateInspectionCache();
          inspectedAfterUpdate = await inspectAllPackages();
          affected = await findAffectedInspectedPackage(inspectedAfterUpdate, source);
        }
      }
      affectedSource = affected?.rawSource ?? previous?.rawSource ?? source;
      // A confirmed update is enough to keep running the new bytes, unless the
      // user had already turned this package off.
      try {
        await persistEnabledExtensionApprovals({
          ...(wasExplicitlyDisabled === false && affected ? { enable: affected } : {}),
        });
      } catch (error) {
        log.warn('Pi package updated but Cindy projection refresh failed', {
          source: logSource,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (request.action === 'set-enabled') {
      if (typeof request.enabled !== 'boolean') throw new Error('enabled must be a boolean');
      const target = await findAffectedInspectedPackage(inspectedBeforeMutation, source);
      affectedSource = target?.rawSource ?? source;
      // A toggle is Cindy-owned state, unlike Pi's native install/update/remove.
      // Never replace a corrupt or temporarily unreadable disable ledger from an
      // empty fallback, which could silently re-enable sibling packages.
      const state = await requireState();
      const disabled = new Set(state.disabledSources);
      const approved = new Set(state.approvedExtensionSources);
      const approvedFingerprints = { ...state.approvedExtensionFingerprints };
      const toggleAliases = [...new Set((await Promise.all([
        sourceAliasesWithCanonical(requestedSource),
        sourceAliasesWithCanonical(source),
        sourceAliasesWithCanonical(affectedSource),
      ])).flat())];
      if (request.enabled) {
        // The precise Settings click is authorization. Pi, not Cindy's
        // inspector or fingerprint format, decides whether the package loads.
        // Preserve a fingerprint when available only for Cindy's optional
        // snapshot metadata; absence or mismatch is never an enable blocker.
        for (const alias of toggleAliases) disabled.delete(alias);
        if (request.mutationTarget) disabled.delete(request.mutationTarget);
        disabled.delete(packageMutationTarget(affectedSource));
        if (target?.contentFingerprint
          && target.view.resources.some((resource) => resource.kind === 'extension')) {
          approved.add(affectedSource);
          approvedFingerprints[affectedSource] = target.contentFingerprint;
        }
      } else {
        // Removing an effective pending-enable overlay is its own durable edge:
        // even if the following state write fails, an existing disable becomes
        // active and callers must converge runtimes. A no-op journal write is
        // not an enablement change.
        const pending = await readPendingEnabledSources();
        let pendingChanged = false;
        for (const alias of toggleAliases) {
          if (pending.delete(alias)) pendingChanged = true;
        }
        if (request.mutationTarget) {
          for (const pendingSource of pending) {
            if (packageMutationTarget(pendingSource) === request.mutationTarget) {
              pending.delete(pendingSource);
              pendingChanged = true;
            }
          }
        }
        if (pendingChanged) {
          try {
            await writePendingEnabledSources(pending);
            mutationMayHaveChangedState = true;
          } catch {
            throw new PiPackageStateUnavailableError();
          }
        }
        disabled.add(affectedSource);
      }
      await writeState({
        version: STATE_VERSION,
        disabledSources: [...disabled].sort(),
        approvedExtensionSources: [...approved].sort(),
        approvedExtensionFingerprints: Object.fromEntries(
          Object.entries(approvedFingerprints).sort(([left], [right]) => left.localeCompare(right)),
        ),
        snapshotUnavailableRoots: state.snapshotUnavailableRoots,
      });
      // Only a completed atomic replacement is a durable state enablement edge.
      mutationMayHaveChangedState = true;
      await publishRuntimeInvalidation();
    }
    invalidateInspectionCache();
    let result: PiPackageListResult;
    let projectionUnavailable = false;
    try {
      result = await listPiPackagesNow();
    } catch {
      log.warn('Pi package mutation succeeded; Cindy list projection unavailable', {
        action: request.action,
        failureCategory: 'projection-unavailable',
      });
      result = { available: false, packages: [] };
      projectionUnavailable = true;
    }
    if (installEnableProjectionUnavailable) {
      // Do not publish the stale disable ledger or a process-local override as
      // an authoritative enabled result when neither existing store converged.
      result = { available: false, packages: [] };
      projectionUnavailable = true;
    }
    const affectedLookupSource = affectedSource ?? source;
    const affectedPackage = findAffectedPiPackage(result.packages, affectedLookupSource)
      ?? result.packages.find((pkg) => (
        pkg.mutationTarget === request.mutationTarget
        || pkg.mutationTarget === packageMutationTarget(affectedLookupSource)
      ));
    if (request.action === 'install'
      && !installEnableProjectionUnavailable
      && affectedPackage?.enabled !== true) {
      // Native Pi already accepted the package. Keep a useful receipt even if
      // Cindy could not project its new/unknown manifest shape.
      const fallbackProjection = projectPackageSource(source);
      const fallbackSource = fallbackProjection.displaySource;
      const fallback: PiPackageView = {
        source: fallbackSource,
        ...(fallbackSource !== source ? { mutationTarget: packageMutationTarget(source) } : {}),
        name: fallbackSource,
        enabled: true,
        resources: [],
        warning: 'inspection-failed',
      };
      const mutationResult = {
        ...result,
        changed: true,
        packages: [...result.packages, fallback],
        affectedPackage: fallback,
        ...(projectionUnavailable ? { projectionUnavailable: true as const } : {}),
      };
      await publishRuntimeInvalidation();
      return mutationResult;
    }
    if (request.action === 'set-enabled' && request.enabled === true) {
      // Persist optional snapshot metadata only after the user-visible enable
      // result is already determined from Pi's installed package state. Any
      // inspection/fingerprint failure is swallowed and cannot veto enablement.
      try {
        const inspected = await inspectAllPackages();
        const target = await findAffectedInspectedPackage(inspected, affectedSource ?? source);
        if (target) await persistEnabledExtensionApprovals({ enable: target });
      } catch (error) {
        log.warn('Pi package enabled; optional Cindy snapshot metadata unavailable', {
          source: logSource,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const mutationResult = {
      ...result,
      changed: true,
      ...(affectedPackage ? { affectedPackage } : {}),
      ...(projectionUnavailable ? { projectionUnavailable: true as const } : {}),
    };
    await publishRuntimeInvalidation();
    return mutationResult;
  }, async () => {
    // Any action may already have changed Pi's package tree or Cindy's state
    // before a later CLI/inspection step reports failure. Persist the shared
    // change token before releasing the cross-process lock, then refresh every
    // open Settings view and command palette.
      if (mutationMayHaveChangedState && !runtimeInvalidationPublished) {
        await publishRuntimeInvalidation(true);
      }
    });
  } catch (error) {
    if (mutationMayHaveChangedState && typeof error === 'object' && error !== null) {
      packageMutationMayHaveChangedErrors.add(error);
    }
    throw error;
  }
}

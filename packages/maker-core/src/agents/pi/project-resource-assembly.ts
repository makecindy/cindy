import fs from 'node:fs/promises';
import { constants, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from 'node:timers';
import type { FileHandle } from 'node:fs/promises';

import type {
  PiProjectPathComparisonIdentity,
  PiProjectTrustDecision,
  PiProjectTrustInputSnapshot,
  PiProjectTrustStatus,
} from '../../types/pi-project-trust.js';
import {
  evaluatePiProjectTrust,
  piCanonicalPathIsWithin,
  piCanonicalPathsEqual,
} from './project-trust.js';
import type {
  PiProjectResourceRuntimeDiagnostic,
  PiRuntimeCapabilityManifest,
} from '../../types/pi-runtime-capabilities.js';
import { piExplicitSkillRuntimePath } from './skill-runtime-provenance.js';

export interface PiProjectResourceAssemblyDiagnostic {
  readonly status: PiProjectTrustStatus;
  readonly reason: string;
  readonly approvalRevision: string | null;
  readonly requestedSkillCount: number;
}

export interface PiProjectResourceAssemblySnapshot {
  readonly decision: PiProjectTrustDecision | null;
  /** Host-proven comparison semantics used for every source-tree containment check. */
  readonly pathComparisonIdentity: PiProjectPathComparisonIdentity | null;
  /** Canonical project paths represented by the host approval snapshot. */
  readonly skillPaths: readonly string[];
  /** Per-session immutable copies that are safe to pass to Pi. */
  readonly launchSkillPaths: readonly string[];
  /** Content fingerprints for the immutable launch copies, index-aligned with skillPaths. */
  readonly launchSkillDigests: readonly string[];
  /** Launch-time source-tree identities used to detect stale palette entries without hashing assets. */
  readonly launchSkillSourceFingerprints: readonly string[];
  readonly diagnostic: PiProjectResourceAssemblyDiagnostic;
}

type PiPathStat = { isDirectory(): boolean; isFile(): boolean };

const unavailableDiagnostic = (
  reason: string,
): PiProjectResourceAssemblyDiagnostic => Object.freeze({
  status: 'unavailable',
  reason,
  approvalRevision: null,
  requestedSkillCount: 0,
});

export function unavailablePiProjectResourceAssembly(
  reason: string,
): PiProjectResourceAssemblySnapshot {
  return Object.freeze({
    decision: null,
    pathComparisonIdentity: null,
    skillPaths: Object.freeze([]),
    launchSkillPaths: Object.freeze([]),
    launchSkillDigests: Object.freeze([]),
    launchSkillSourceFingerprints: Object.freeze([]),
    diagnostic: unavailableDiagnostic(reason),
  });
}

async function findNearestGitRoot(
  start: string,
  stat: (path: string) => Promise<PiPathStat>,
  pathApi: typeof path.posix | typeof path.win32,
): Promise<string | null> {
  let current = start;
  while (true) {
    try {
      const marker = await stat(pathApi.join(current, '.git'));
      if (marker.isDirectory() || marker.isFile()) return current;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Match project discovery: an unreadable marker is a conservative
      // boundary, while a genuinely absent marker permits walking upward.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return current;
    }
    const parent = pathApi.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function validateSkillPathsImmediatelyBeforeLaunch(
  skillEvidence: readonly {
    readonly discoveredPath: string;
    readonly canonicalPath: string;
  }[],
  stat: (path: string) => Promise<PiPathStat>,
  realpath: (path: string) => Promise<string>,
  identity: PiProjectTrustInputSnapshot['identity'],
  requestedWorkingDir: string,
  resolveNearestGitRoot: (
    workingDir: string,
    stat: (path: string) => Promise<PiPathStat>,
    pathApi: typeof path.posix | typeof path.win32,
  ) => Promise<string | null>,
  deadlineAtMs: number,
): Promise<
  'available' | 'unavailable' | 'request-mismatch' | 'repo-mismatch' | 'project-changed' | 'skill-changed'
> {
  try {
    const canonicalWorkingDir = identity.canonicalWorkingDir;
    const canonicalRepoRoot = identity.canonicalRepoRoot;
    if (!canonicalWorkingDir || !canonicalRepoRoot) return 'unavailable';
    const pathApi = identity.platform === 'win32' ? path.win32 : path.posix;
    const boundedStat = (candidate: string): Promise<PiPathStat> => awaitDeadlineStep(
      () => stat(candidate),
      deadlineAtMs,
      'approved skill assembly deadline expired',
    );
    const boundedRealpath = (candidate: string): Promise<string> => awaitDeadlineStep(
      () => realpath(candidate),
      deadlineAtMs,
      'approved skill assembly deadline expired',
    );
    const resolvedRequestedWorkingDir = await boundedRealpath(requestedWorkingDir);
    const [resolvedWorkingDir, resolvedRepoRoot, currentRepoRoot, entries] =
      await Promise.all([
        boundedRealpath(identity.workingDir),
        boundedRealpath(canonicalRepoRoot),
        awaitDeadlineStep(
          // Bound the resolver as one operation. Passing the raw stat preserves
          // its existing unreadable-marker semantics without letting an inner
          // timeout be mistaken for a valid conservative Git boundary.
          () => resolveNearestGitRoot(resolvedRequestedWorkingDir, stat, pathApi),
          deadlineAtMs,
          'approved skill assembly deadline expired',
        ),
        Promise.all(skillEvidence.map(async ({ discoveredPath, canonicalPath: skillPath }) => {
          const [stats, resolvedPath, resolvedDiscoveredPath] = await Promise.all([
            boundedStat(skillPath),
            boundedRealpath(skillPath),
            boundedRealpath(discoveredPath),
          ]);
          if (!stats.isDirectory()) return { skillPath, stats, resolvedPath };
          const skillFile = pathApi.join(skillPath, 'SKILL.md');
          return {
            skillPath,
            stats,
            resolvedPath,
            resolvedDiscoveredPath,
            skillFileStats: await boundedStat(skillFile),
            resolvedSkillFile: await boundedRealpath(skillFile),
          };
        })),
      ]);
    if (
      !piCanonicalPathsEqual(identity, canonicalWorkingDir, resolvedWorkingDir)
      || !piCanonicalPathsEqual(identity, canonicalRepoRoot, resolvedRepoRoot)
    ) return 'project-changed';
    if (!piCanonicalPathsEqual(identity, canonicalWorkingDir, resolvedRequestedWorkingDir)) {
      return 'request-mismatch';
    }
    if (
      !currentRepoRoot
      || !piCanonicalPathsEqual(identity, canonicalRepoRoot, currentRepoRoot)
    ) return 'repo-mismatch';
    if (entries.some(({ stats, skillFileStats }) =>
      !stats.isDirectory() || !skillFileStats?.isFile())) return 'unavailable';
    return entries.every(({
      skillPath,
      resolvedPath,
      resolvedDiscoveredPath,
      stats,
      resolvedSkillFile,
    }) =>
      piCanonicalPathsEqual(identity, skillPath, resolvedPath)
      && typeof resolvedDiscoveredPath === 'string'
      && piCanonicalPathsEqual(identity, skillPath, resolvedDiscoveredPath)
      && piCanonicalPathIsWithin(identity, canonicalRepoRoot, resolvedPath)
      && (stats.isDirectory() && (
        typeof resolvedSkillFile === 'string'
        && piCanonicalPathIsWithin(identity, canonicalRepoRoot, resolvedSkillFile)
      )))
      ? 'available'
      : 'skill-changed';
  } catch {
    return 'unavailable';
  }
}

/**
 * Convert one host-owned approval snapshot into a frozen, skills-only launch
 * snapshot. The caller's actual workingDir is rebound to that snapshot here;
 * a missing/changed path invalidates the whole approved set so a partial or
 * cross-project launch cannot silently diverge from the audited evidence.
 */
export async function assembleApprovedPiProjectResources(
  input: PiProjectTrustInputSnapshot | null,
  requestedWorkingDir: string,
  options: {
    stat?: (path: string) => Promise<PiPathStat>;
    realpath?: (path: string) => Promise<string>;
    findNearestGitRoot?: (
      workingDir: string,
      stat: (path: string) => Promise<PiPathStat>,
      pathApi: typeof path.posix | typeof path.win32,
    ) => Promise<string | null>;
    deadlineMs?: number;
  } = {},
): Promise<PiProjectResourceAssemblySnapshot> {
  if (!input) return unavailablePiProjectResourceAssembly('approval-snapshot-unavailable');

  const decision = evaluatePiProjectTrust({
    identity: input.identity,
    approval: input.approval,
    discovered: input.discovered,
    capabilities: { explicitSkills: true },
  });
  const eligibleSkillPaths = [...decision.eligibleSkillPaths];
  const eligibleSkillEvidence = eligibleSkillPaths.map((canonicalPath, index) => ({
    discoveredPath: input.discovered.skills[index] ?? '',
    canonicalPath,
  }));
  let reason = decision.reason;
  let skillPaths: readonly string[] = eligibleSkillPaths;

  if (
    decision.status === 'approved' &&
    input.discovered.skills.length > 0 &&
    eligibleSkillPaths.length === 0
  ) {
    reason = 'approved-skills-ineligible';
  } else if (eligibleSkillPaths.length > 0) {
    const deadlineMs = options.deadlineMs ?? PI_PROJECT_SKILL_SNAPSHOT_DEADLINE_MS;
    const deadlineAtMs = Number.isSafeInteger(deadlineMs) && deadlineMs >= 0
      ? Date.now() + deadlineMs
      : Date.now();
    const pathStatus = await validateSkillPathsImmediatelyBeforeLaunch(
      eligibleSkillEvidence,
      options.stat ?? fs.stat,
      options.realpath ?? fs.realpath,
      input.identity,
      requestedWorkingDir,
      options.findNearestGitRoot ?? findNearestGitRoot,
      deadlineAtMs,
    );
    if (pathStatus !== 'available') {
      if (pathStatus === 'request-mismatch') reason = 'approval-working-dir-mismatch';
      else if (pathStatus === 'repo-mismatch') reason = 'approved-repo-root-changed';
      else if (pathStatus === 'project-changed') reason = 'approved-project-path-changed';
      else if (pathStatus === 'skill-changed') reason = 'approved-skill-path-changed';
      else reason = 'approved-skill-path-unavailable';
      skillPaths = [];
    }
  }

  const frozenSkillPaths = Object.freeze([...skillPaths]);
  const pathComparisonIdentity: PiProjectPathComparisonIdentity | null =
    input.identity.platform === 'posix'
      ? Object.freeze({ platform: 'posix' })
      : input.identity.windowsCaseComparison === 'ordinal-insensitive'
        || input.identity.windowsCaseComparison === 'case-sensitive'
        ? Object.freeze({
            platform: 'win32',
            windowsCaseComparison: input.identity.windowsCaseComparison,
          })
        : null;
  return Object.freeze({
    decision,
    pathComparisonIdentity,
    skillPaths: frozenSkillPaths,
    launchSkillPaths: Object.freeze([]),
    launchSkillDigests: Object.freeze([]),
    launchSkillSourceFingerprints: Object.freeze([]),
    diagnostic: Object.freeze({
      status: decision.status,
      reason,
      approvalRevision: decision.approvalRevision,
      requestedSkillCount: frozenSkillPaths.length,
    }),
  });
}

function localPathIsWithin(
  root: string,
  candidate: string,
  identity: PiProjectPathComparisonIdentity,
): boolean {
  return piCanonicalPathIsWithin(identity, root, candidate);
}

/** Staging paths are host-owned; literal case comparison is conservative on Windows. */
function strictLocalPathComparisonIdentity(): PiProjectPathComparisonIdentity {
  return process.platform === 'win32'
    ? { platform: 'win32', windowsCaseComparison: 'case-sensitive' }
    : { platform: 'posix' };
}

function sameFileIdentity(
  first: Pick<Awaited<ReturnType<typeof fs.lstat>>, 'dev' | 'ino'>,
  second: Pick<Awaited<ReturnType<typeof fs.lstat>>, 'dev' | 'ino'>,
): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function sameEntrySnapshot(
  first: Awaited<ReturnType<FileHandle['stat']>>,
  second: Awaited<ReturnType<FileHandle['stat']>>,
): boolean {
  return sameFileIdentity(first, second)
    && first.size === second.size
    && first.mtimeMs === second.mtimeMs
    && first.ctimeMs === second.ctimeMs;
}

async function hashOpenFile(
  handle: FileHandle,
  options: {
    deadlineAtMs?: number;
    maxBytes?: number;
    expectedBytes?: number;
  } = {},
): Promise<string> {
  const deadlineAtMs = options.deadlineAtMs ?? Number.POSITIVE_INFINITY;
  if (Date.now() >= deadlineAtMs) throw new Error('approved skill fingerprint deadline expired');
  const hash = createHash('sha256');
  const controller = new AbortController();
  let hashedBytes = 0;
  let timeout: number | NodeJS.Timeout | undefined;
  if (Number.isFinite(deadlineAtMs)) {
    timeout = setNodeTimeout(
      () => controller.abort(),
      Math.max(0, deadlineAtMs - Date.now()),
    );
  }
  try {
    for await (const chunk of handle.createReadStream({
      start: 0,
      autoClose: false,
      signal: controller.signal,
    })) {
      if (Date.now() >= deadlineAtMs) {
        controller.abort();
        throw new Error('approved skill fingerprint deadline expired');
      }
      hashedBytes += chunk.length;
      if (
        (options.maxBytes !== undefined && hashedBytes > options.maxBytes)
        || (options.expectedBytes !== undefined && hashedBytes > options.expectedBytes)
      ) {
        controller.abort();
        throw new Error('approved skill fingerprint exceeded the byte fence');
      }
      hash.update(chunk);
    }
  } finally {
    if (timeout) clearNodeTimeout(timeout);
  }
  if (options.expectedBytes !== undefined && hashedBytes !== options.expectedBytes) {
    throw new Error('approved skill changed while fingerprinting');
  }
  return hash.digest('hex');
}

export interface PiProjectSkillEntrypointFingerprint {
  readonly contentDigest: string;
  readonly sourceStateDigest: string;
}

export interface PiProjectSkillFingerprintBudget {
  remainingEntries: number;
  readonly deadlineAtMs: number;
  readonly maxFileBytes?: number;
}

async function fingerprintSkillEntrypointOnce(
  rootPath: string,
  canonicalRepoRoot: string,
  pathComparisonIdentity: PiProjectPathComparisonIdentity,
  sharedBudget?: PiProjectSkillFingerprintBudget,
): Promise<string> {
  const skillPath = path.join(rootPath, 'SKILL.md');
  const [rootEntry, canonicalRoot, skillLinkEntry, canonicalSkill, skillTargetEntry] =
    await Promise.all([
      awaitFingerprintBudgetStep(() => fs.lstat(rootPath), sharedBudget),
      awaitFingerprintBudgetStep(() => fs.realpath(rootPath), sharedBudget),
      awaitFingerprintBudgetStep(() => fs.lstat(skillPath), sharedBudget),
      awaitFingerprintBudgetStep(() => fs.realpath(skillPath), sharedBudget),
      awaitFingerprintBudgetStep(() => fs.stat(skillPath), sharedBudget),
    ]);
  if (
    !rootEntry.isDirectory()
    || !skillTargetEntry.isFile()
    || !localPathIsWithin(canonicalRepoRoot, canonicalRoot, pathComparisonIdentity)
    || !localPathIsWithin(canonicalRepoRoot, canonicalSkill, pathComparisonIdentity)
  ) {
    throw new Error('approved skill entrypoint escaped its repository');
  }

  const handle = await awaitFingerprintBudgetStep(
    () => fs.open(
      canonicalSkill,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    ),
    sharedBudget,
  );
  try {
    if (sharedBudget && Date.now() >= sharedBudget.deadlineAtMs) {
      throw new Error('approved skill fingerprint deadline expired');
    }
    const openedEntry = await awaitFingerprintBudgetStep(() => handle.stat(), sharedBudget);
    if (!openedEntry.isFile() || !sameFileIdentity(skillTargetEntry, openedEntry)) {
      throw new Error('approved skill entrypoint changed before fingerprinting');
    }
    if (sharedBudget?.maxFileBytes !== undefined
      && openedEntry.size > sharedBudget.maxFileBytes) {
      throw new Error('approved skill entrypoint exceeds the snapshot file budget');
    }
    const contentDigest = await hashOpenFile(handle, {
      deadlineAtMs: sharedBudget?.deadlineAtMs,
      maxBytes: sharedBudget?.maxFileBytes,
      expectedBytes: openedEntry.size,
    });
    const [
      rootEntryAfterRead,
      canonicalRootAfterRead,
      skillLinkEntryAfterRead,
      canonicalSkillAfterRead,
      skillTargetEntryAfterRead,
      openedAfterRead,
    ] = await Promise.all([
      awaitFingerprintBudgetStep(() => fs.lstat(rootPath), sharedBudget),
      awaitFingerprintBudgetStep(() => fs.realpath(rootPath), sharedBudget),
      awaitFingerprintBudgetStep(() => fs.lstat(skillPath), sharedBudget),
      awaitFingerprintBudgetStep(() => fs.realpath(skillPath), sharedBudget),
      awaitFingerprintBudgetStep(() => fs.stat(skillPath), sharedBudget),
      awaitFingerprintBudgetStep(() => handle.stat(), sharedBudget),
    ]);
    if (
      !sameEntrySnapshot(rootEntry, rootEntryAfterRead)
      || !sameEntrySnapshot(skillLinkEntry, skillLinkEntryAfterRead)
      || !sameEntrySnapshot(skillTargetEntry, skillTargetEntryAfterRead)
      || !sameEntrySnapshot(openedEntry, openedAfterRead)
      || !sameFileIdentity(openedEntry, skillTargetEntryAfterRead)
      || !piCanonicalPathsEqual(pathComparisonIdentity, canonicalRootAfterRead, canonicalRoot)
      || !piCanonicalPathsEqual(pathComparisonIdentity, canonicalSkillAfterRead, canonicalSkill)
    ) {
      throw new Error('approved skill entrypoint changed while fingerprinting');
    }
    return contentDigest;
  } finally {
    if (sharedBudget) {
      await settleDeadlineBoundCleanup(
        () => handle.close(),
        sharedBudget.deadlineAtMs,
        'approved skill fingerprint deadline expired',
      );
    } else {
      await handle.close();
    }
  }
}

export const MAX_PI_PROJECT_SKILL_FINGERPRINT_ENTRIES = 10_000;
export const MAX_PI_PROJECT_SKILL_SNAPSHOT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PI_PROJECT_SKILL_SNAPSHOT_TOTAL_BYTES = 64 * 1024 * 1024;
export const PI_PROJECT_SKILL_SNAPSHOT_DEADLINE_MS = 30_000;

interface PiProjectSkillSnapshotBudget {
  remainingEntries: number;
  remainingBytes: number;
  readonly maxFileBytes: number;
  readonly deadlineAtMs: number;
}

function assertSnapshotBudgetAvailable(budget: PiProjectSkillSnapshotBudget): void {
  if (Date.now() >= budget.deadlineAtMs) {
    throw new Error('approved skill snapshot deadline expired');
  }
  if (budget.remainingEntries <= 0) {
    throw new Error('approved skill snapshot entry budget exhausted');
  }
  budget.remainingEntries -= 1;
}

async function awaitDeadlineStep<T>(
  operation: () => Promise<T>,
  deadlineAtMs: number,
  errorMessage: string,
): Promise<T> {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) throw new Error(errorMessage);
  if (!Number.isFinite(remainingMs)) return operation();
  const pending = operation();
  return new Promise<T>((resolve, reject) => {
    const timeout = setNodeTimeout(
      () => reject(new Error(errorMessage)),
      remainingMs,
    );
    pending.then(
      (value) => {
        clearNodeTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearNodeTimeout(timeout);
        reject(error);
      },
    );
  });
}

function awaitSnapshotBudgetStep<T>(
  operation: () => Promise<T>,
  budget: PiProjectSkillSnapshotBudget,
): Promise<T> {
  return awaitDeadlineStep(
    operation,
    budget.deadlineAtMs,
    'approved skill snapshot deadline expired',
  );
}

function awaitFingerprintBudgetStep<T>(
  operation: () => Promise<T>,
  budget?: PiProjectSkillFingerprintBudget,
): Promise<T> {
  return budget
    ? awaitDeadlineStep(
        operation,
        budget.deadlineAtMs,
        'approved skill fingerprint deadline expired',
      )
    : operation();
}

async function settleDeadlineBoundCleanup(
  operation: () => Promise<unknown>,
  deadlineAtMs: number,
  errorMessage: string,
): Promise<void> {
  const pending = operation();
  if (Date.now() >= deadlineAtMs) {
    void pending.catch(() => undefined);
    return;
  }
  try {
    await awaitDeadlineStep(() => pending, deadlineAtMs, errorMessage);
  } catch (error) {
    if (Date.now() >= deadlineAtMs) return;
    throw error;
  }
}

async function visitSnapshotDirectoryEntries(
  entryPath: string,
  budget: PiProjectSkillSnapshotBudget,
  visit: (childName: string) => Promise<void>,
): Promise<void> {
  if (typeof fs.opendir === 'function') {
    const directory = await awaitSnapshotBudgetStep(() => fs.opendir(entryPath), budget);
    const iterator = directory[Symbol.asyncIterator]();
    try {
      while (true) {
        const result = await awaitSnapshotBudgetStep(() => iterator.next(), budget);
        if (result.done) break;
        // Charge the shared budget before any child lstat/realpath work. A
        // hostile directory therefore cannot make preflight materialize or
        // probe an unbounded child list before failing closed.
        assertSnapshotBudgetAvailable(budget);
        await visit(result.value.name);
      }
    } finally {
      if (iterator.return) {
        await settleDeadlineBoundCleanup(
          () => iterator.return!().then(() => undefined),
          budget.deadlineAtMs,
          'approved skill snapshot deadline expired',
        );
      }
    }
    return;
  }

  // Compatibility seam for focused tests/runtimes without opendir. Production
  // uses the streaming path above; the fallback still has a deadline and
  // rejects the whole listing before probing any child when it exceeds budget.
  const children = await awaitSnapshotBudgetStep(
    () => fs.readdir(entryPath, { withFileTypes: true }),
    budget,
  );
  if (Date.now() >= budget.deadlineAtMs || children.length > budget.remainingEntries) {
    throw new Error('approved skill snapshot entry budget exhausted');
  }
  for (const child of children) {
    assertSnapshotBudgetAvailable(budget);
    await visit(child.name);
  }
}

async function preflightSkillSnapshotEntry(
  entryPath: string,
  canonicalRepoRoot: string,
  pathComparisonIdentity: PiProjectPathComparisonIdentity,
  budget: PiProjectSkillSnapshotBudget,
  activeDirectories: Set<string>,
  entryAlreadyCounted = false,
): Promise<void> {
  if (!entryAlreadyCounted) assertSnapshotBudgetAvailable(budget);
  const [entry, canonicalEntry] = await Promise.all([
    awaitSnapshotBudgetStep(() => fs.lstat(entryPath), budget),
    awaitSnapshotBudgetStep(() => fs.realpath(entryPath), budget),
  ]);
  if (!localPathIsWithin(canonicalRepoRoot, canonicalEntry, pathComparisonIdentity)) {
    throw new Error('approved skill snapshot entry escaped its repository');
  }
  if (entry.isSymbolicLink()) {
    await preflightSkillSnapshotEntry(
      canonicalEntry,
      canonicalRepoRoot,
      pathComparisonIdentity,
      budget,
      activeDirectories,
    );
    return;
  }
  if (entry.isDirectory()) {
    if (activeDirectories.has(canonicalEntry)) {
      throw new Error('approved skill snapshot contains a directory cycle');
    }
    activeDirectories.add(canonicalEntry);
    try {
      await visitSnapshotDirectoryEntries(entryPath, budget, async (childName) => {
        await preflightSkillSnapshotEntry(
          path.join(entryPath, childName),
          canonicalRepoRoot,
          pathComparisonIdentity,
          budget,
          activeDirectories,
          true,
        );
      });
    } finally {
      activeDirectories.delete(canonicalEntry);
    }
    return;
  }
  if (!entry.isFile()) throw new Error('approved skill snapshot contains a special file');
  if (entry.size > budget.maxFileBytes || entry.size > budget.remainingBytes) {
    throw new Error('approved skill snapshot exceeds the byte budget');
  }
  budget.remainingBytes -= entry.size;
}

function updateFingerprintValue(hash: ReturnType<typeof createHash>, value: unknown): void {
  hash.update(String(value));
  hash.update('\0');
}

async function fingerprintSkillTreeStateOnce(
  rootPath: string,
  canonicalRepoRoot: string,
  pathComparisonIdentity: PiProjectPathComparisonIdentity,
  sharedBudget?: PiProjectSkillFingerprintBudget,
): Promise<string> {
  const hash = createHash('sha256');
  const activeDirectories = new Set<string>();
  let entryCount = 0;

  const visit = async (entryPath: string, relativePath: string): Promise<void> => {
    if (sharedBudget) {
      if (Date.now() >= sharedBudget.deadlineAtMs || sharedBudget.remainingEntries <= 0) {
        throw new Error('approved skill tree exceeded the shared fingerprint budget');
      }
      sharedBudget.remainingEntries -= 1;
    }
    entryCount += 1;
    if (entryCount > MAX_PI_PROJECT_SKILL_FINGERPRINT_ENTRIES) {
      throw new Error('approved skill tree exceeds the fingerprint entry budget');
    }
    const [linkEntry, canonicalEntry, targetEntry] = await Promise.all([
      awaitFingerprintBudgetStep(() => fs.lstat(entryPath), sharedBudget),
      awaitFingerprintBudgetStep(() => fs.realpath(entryPath), sharedBudget),
      awaitFingerprintBudgetStep(() => fs.stat(entryPath), sharedBudget),
    ]);
    if (
      !localPathIsWithin(canonicalRepoRoot, canonicalEntry, pathComparisonIdentity)
      || (!targetEntry.isDirectory() && !targetEntry.isFile())
    ) {
      throw new Error('approved skill tree contains an escaped or special entry');
    }
    const kind = targetEntry.isDirectory() ? 'directory' : 'file';
    for (const value of [
      relativePath,
      linkEntry.isSymbolicLink() ? `symlink-${kind}` : kind,
      canonicalEntry,
      linkEntry.dev,
      linkEntry.ino,
      linkEntry.mode,
      linkEntry.size,
      linkEntry.mtimeMs,
      linkEntry.ctimeMs,
      targetEntry.dev,
      targetEntry.ino,
      targetEntry.mode,
      targetEntry.size,
      targetEntry.mtimeMs,
      targetEntry.ctimeMs,
    ]) updateFingerprintValue(hash, value);

    if (targetEntry.isDirectory()) {
      if (activeDirectories.has(canonicalEntry)) {
        throw new Error('approved skill tree contains a directory cycle');
      }
      activeDirectories.add(canonicalEntry);
      try {
        const remainingEntryBudget = Math.min(
          MAX_PI_PROJECT_SKILL_FINGERPRINT_ENTRIES - entryCount,
          sharedBudget?.remainingEntries ?? Number.POSITIVE_INFINITY,
        );
        const childNames: string[] = [];
        const directory = await awaitFingerprintBudgetStep(
          () => fs.opendir(entryPath),
          sharedBudget,
        );
        try {
          while (true) {
            if (sharedBudget && Date.now() >= sharedBudget.deadlineAtMs) {
              throw new Error('approved skill tree exceeded the shared fingerprint deadline');
            }
            const child = await awaitFingerprintBudgetStep(
              () => directory.read(),
              sharedBudget,
            );
            if (!child) break;
            if (childNames.length >= remainingEntryBudget) {
              throw new Error('approved skill tree exceeds the fingerprint entry budget');
            }
            childNames.push(child.name);
          }
        } finally {
          if (sharedBudget) {
            await settleDeadlineBoundCleanup(
              () => directory.close().catch(() => undefined),
              sharedBudget.deadlineAtMs,
              'approved skill fingerprint deadline expired',
            );
          } else {
            await directory.close().catch(() => undefined);
          }
        }
        if (sharedBudget && Date.now() >= sharedBudget.deadlineAtMs) {
          throw new Error('approved skill tree exceeded the shared fingerprint deadline');
        }
        childNames.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
        for (const childName of childNames) {
          await visit(
            path.join(entryPath, childName),
            relativePath === '.' ? childName : path.join(relativePath, childName),
          );
        }
      } finally {
        activeDirectories.delete(canonicalEntry);
      }
    }

    const [linkEntryAfter, canonicalEntryAfter, targetEntryAfter] = await Promise.all([
      awaitFingerprintBudgetStep(() => fs.lstat(entryPath), sharedBudget),
      awaitFingerprintBudgetStep(() => fs.realpath(entryPath), sharedBudget),
      awaitFingerprintBudgetStep(() => fs.stat(entryPath), sharedBudget),
    ]);
    if (
      !sameEntrySnapshot(linkEntry, linkEntryAfter)
      || !sameEntrySnapshot(targetEntry, targetEntryAfter)
      || !piCanonicalPathsEqual(pathComparisonIdentity, canonicalEntryAfter, canonicalEntry)
    ) {
      throw new Error('approved skill tree changed while fingerprinting');
    }
  };

  await visit(rootPath, '.');
  return hash.digest('hex');
}

/** Fail-closed SKILL.md identity used when projecting a live session into the palette. */
export async function fingerprintPiProjectSkillEntrypoint(
  rootPath: string,
  canonicalRepoRoot: string,
  options: {
    budget?: PiProjectSkillFingerprintBudget;
    pathComparisonIdentity?: PiProjectPathComparisonIdentity;
  } = {},
): Promise<PiProjectSkillEntrypointFingerprint | null> {
  try {
    if (options.budget && Date.now() >= options.budget.deadlineAtMs) return null;
    const pathComparisonIdentity = options.pathComparisonIdentity
      ?? (process.platform === 'win32' ? null : strictLocalPathComparisonIdentity());
    if (!pathComparisonIdentity) return null;
    const [canonicalRoot, canonicalBoundary] = await Promise.all([
      awaitFingerprintBudgetStep(() => fs.realpath(rootPath), options.budget),
      awaitFingerprintBudgetStep(() => fs.realpath(canonicalRepoRoot), options.budget),
    ]);
    if (!localPathIsWithin(canonicalBoundary, canonicalRoot, pathComparisonIdentity)) return null;
    const firstContentDigest = await fingerprintSkillEntrypointOnce(
      rootPath,
      canonicalBoundary,
      pathComparisonIdentity,
      options.budget,
    );
    const firstSourceStateDigest = await fingerprintSkillTreeStateOnce(
      rootPath,
      canonicalBoundary,
      pathComparisonIdentity,
      options.budget,
    );
    const secondContentDigest = await fingerprintSkillEntrypointOnce(
      rootPath,
      canonicalBoundary,
      pathComparisonIdentity,
      options.budget,
    );
    const secondSourceStateDigest = await fingerprintSkillTreeStateOnce(
      rootPath,
      canonicalBoundary,
      pathComparisonIdentity,
      options.budget,
    );
    return firstContentDigest === secondContentDigest
      && firstSourceStateDigest === secondSourceStateDigest
      ? Object.freeze({
          contentDigest: firstContentDigest,
          sourceStateDigest: firstSourceStateDigest,
        })
      : null;
  } catch {
    return null;
  }
}

async function materializeSkillEntry(
  sourcePath: string,
  targetPath: string,
  canonicalRepoRoot: string,
  pathComparisonIdentity: PiProjectPathComparisonIdentity,
  activeDirectories: Set<string>,
  budget: PiProjectSkillSnapshotBudget,
  entryAlreadyCounted = false,
): Promise<void> {
  if (!entryAlreadyCounted) assertSnapshotBudgetAvailable(budget);
  const [entry, canonicalSource] = await Promise.all([
    awaitSnapshotBudgetStep(() => fs.lstat(sourcePath), budget),
    awaitSnapshotBudgetStep(() => fs.realpath(sourcePath), budget),
  ]);
  if (!localPathIsWithin(canonicalRepoRoot, canonicalSource, pathComparisonIdentity)) {
    throw new Error('approved skill entry escaped its repository');
  }

  if (entry.isSymbolicLink()) {
    await materializeSkillEntry(
      canonicalSource,
      targetPath,
      canonicalRepoRoot,
      pathComparisonIdentity,
      activeDirectories,
      budget,
    );
    return;
  }
  if (entry.isDirectory()) {
    if (activeDirectories.has(canonicalSource)) {
      throw new Error('approved skill contains a directory cycle');
    }
    activeDirectories.add(canonicalSource);
    try {
      await awaitSnapshotBudgetStep(
        () => fs.mkdir(targetPath, { recursive: false }).then(() => undefined),
        budget,
      );
      await visitSnapshotDirectoryEntries(sourcePath, budget, async (childName) => {
        await materializeSkillEntry(
          path.join(sourcePath, childName),
          path.join(targetPath, childName),
          canonicalRepoRoot,
          pathComparisonIdentity,
          activeDirectories,
          budget,
          true,
        );
      });
      const [canonicalAfterCopy, entryAfterCopy] = await Promise.all([
        awaitSnapshotBudgetStep(() => fs.realpath(sourcePath), budget),
        awaitSnapshotBudgetStep(() => fs.lstat(sourcePath), budget),
      ]);
      if (
        !piCanonicalPathsEqual(pathComparisonIdentity, canonicalAfterCopy, canonicalSource)
        || !entryAfterCopy.isDirectory()
        || !sameEntrySnapshot(entry, entryAfterCopy)
      ) {
        throw new Error('approved skill directory changed while snapshotting');
      }
    } finally {
      activeDirectories.delete(canonicalSource);
    }
    return;
  }
  if (!entry.isFile()) throw new Error('approved skill contains a special file');

  const sourceHandle = await awaitSnapshotBudgetStep(
    () => fs.open(
      sourcePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    ),
    budget,
  );
  try {
    const openedEntry = await awaitSnapshotBudgetStep(() => sourceHandle.stat(), budget);
    if (!openedEntry.isFile() || !sameFileIdentity(entry, openedEntry)) {
      throw new Error('approved skill file changed before snapshot read');
    }
    if (openedEntry.size > budget.maxFileBytes || openedEntry.size > budget.remainingBytes) {
      throw new Error('approved skill snapshot exceeds the byte budget');
    }
    budget.remainingBytes -= openedEntry.size;
    const controller = new AbortController();
    const timeout = setNodeTimeout(
      () => controller.abort(),
      Math.max(0, budget.deadlineAtMs - Date.now()),
    );
    let copiedBytes = 0;
    const byteFence = new Transform({
      transform(chunk, _encoding, callback) {
        copiedBytes += chunk.length;
        if (copiedBytes > openedEntry.size || copiedBytes > budget.maxFileBytes) {
          callback(new Error('approved skill file grew beyond the snapshot byte budget'));
          return;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        sourceHandle.createReadStream({ autoClose: false, signal: controller.signal }),
        byteFence,
        createWriteStream(targetPath, { flags: 'wx', mode: openedEntry.mode }),
        { signal: controller.signal },
      );
    } finally {
      clearNodeTimeout(timeout);
    }
    if (copiedBytes !== openedEntry.size || Date.now() >= budget.deadlineAtMs) {
      throw new Error('approved skill file changed or timed out while snapshotting');
    }
    const [openedAfterCopy, sourcePathAfterCopy, sourceAfterCopy, targetAfterCopy] =
      await Promise.all([
        awaitSnapshotBudgetStep(() => sourceHandle.stat(), budget),
        awaitSnapshotBudgetStep(() => fs.lstat(sourcePath), budget),
        awaitSnapshotBudgetStep(() => fs.realpath(sourcePath), budget),
        awaitSnapshotBudgetStep(() => fs.lstat(targetPath), budget),
      ]);
    if (
      !sameEntrySnapshot(openedEntry, openedAfterCopy)
      || !sameFileIdentity(openedEntry, sourcePathAfterCopy)
      || !piCanonicalPathsEqual(pathComparisonIdentity, sourceAfterCopy, canonicalSource)
      || !targetAfterCopy.isFile()
    ) {
      throw new Error('approved skill file changed while snapshotting');
    }
    const targetHandle = await awaitSnapshotBudgetStep(
      () => fs.open(
        targetPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      ),
      budget,
    );
    try {
      const [sourceDigest, targetDigest] = await Promise.all([
        hashOpenFile(sourceHandle, {
          deadlineAtMs: budget.deadlineAtMs,
          maxBytes: budget.maxFileBytes,
          expectedBytes: openedAfterCopy.size,
        }),
        hashOpenFile(targetHandle, {
          deadlineAtMs: budget.deadlineAtMs,
          maxBytes: budget.maxFileBytes,
          expectedBytes: targetAfterCopy.size,
        }),
      ]);
      const [sourceAfterStableRead, targetAfterStableRead] = await Promise.all([
        awaitSnapshotBudgetStep(() => sourceHandle.stat(), budget),
        awaitSnapshotBudgetStep(() => targetHandle.stat(), budget),
      ]);
      if (
        sourceDigest !== targetDigest
        || !sameEntrySnapshot(openedAfterCopy, sourceAfterStableRead)
        || !targetAfterStableRead.isFile()
        || targetAfterStableRead.size !== sourceAfterStableRead.size
      ) {
        throw new Error('approved skill file content changed while snapshotting');
      }
    } finally {
      await settleDeadlineBoundCleanup(
        () => targetHandle.close(),
        budget.deadlineAtMs,
        'approved skill snapshot deadline expired',
      );
    }
    await awaitSnapshotBudgetStep(
      () => fs.chmod(targetPath, openedEntry.mode & 0o777),
      budget,
    );
  } finally {
    await settleDeadlineBoundCleanup(
      () => sourceHandle.close(),
      budget.deadlineAtMs,
      'approved skill snapshot deadline expired',
    );
  }
}

async function auditMaterializedTree(
  root: string,
  budget: PiProjectSkillSnapshotBudget,
): Promise<void> {
  assertSnapshotBudgetAvailable(budget);
  const entries = await awaitSnapshotBudgetStep(
    () => fs.readdir(root, { withFileTypes: true }),
    budget,
  );
  for (const entry of entries) {
    if (Date.now() >= budget.deadlineAtMs) {
      throw new Error('approved skill snapshot deadline expired');
    }
    const entryPath = path.join(root, entry.name);
    const stats = await awaitSnapshotBudgetStep(() => fs.lstat(entryPath), budget);
    if (stats.isSymbolicLink()) throw new Error('skill snapshot contains a symbolic link');
    if (stats.isDirectory()) {
      await auditMaterializedTree(entryPath, budget);
    } else if (!stats.isFile()) {
      throw new Error('skill snapshot contains a special file');
    } else {
      assertSnapshotBudgetAvailable(budget);
      if (stats.size > budget.maxFileBytes || stats.size > budget.remainingBytes) {
        throw new Error('approved skill snapshot exceeds the final byte budget');
      }
      budget.remainingBytes -= stats.size;
    }
  }
}

async function assertMaterializedSkillLayout(
  temporarySkillsRoot: string,
  relativeLaunchPaths: readonly string[],
  deadlineAtMs: number,
): Promise<void> {
  const expectedIndexes = relativeLaunchPaths.map((_entry, index) => String(index));
  const indexes = await awaitDeadlineStep(
    () => fs.readdir(temporarySkillsRoot),
    deadlineAtMs,
    'approved skill snapshot deadline expired',
  );
  const actualIndexes = new Set(indexes);
  if (
    Date.now() >= deadlineAtMs
    || indexes.length !== expectedIndexes.length
    || expectedIndexes.some((entry) => !actualIndexes.has(entry))
  ) throw new Error('approved skill snapshot layout changed');
  for (const [index, relativePath] of relativeLaunchPaths.entries()) {
    const expectedName = path.basename(relativePath);
    const entries = await awaitDeadlineStep(
      () => fs.readdir(path.join(temporarySkillsRoot, String(index))),
      deadlineAtMs,
      'approved skill snapshot deadline expired',
    );
    if (
      Date.now() >= deadlineAtMs
      || entries.length !== 1
      || entries[0] !== expectedName
    ) throw new Error('approved skill snapshot layout changed');
  }
}

/**
 * Materialize every approved directory into this session's isolated configHome.
 * Pi never receives a mutable project path: the whole set is staged off-path,
 * audited, and atomically published only after every skill succeeds.
 */
export async function stageApprovedPiProjectResources(
  assembly: PiProjectResourceAssemblySnapshot,
  configHome: string,
  limits: {
    maxFileBytes?: number;
    maxTotalBytes?: number;
    deadlineMs?: number;
  } = {},
): Promise<PiProjectResourceAssemblySnapshot> {
  if (assembly.skillPaths.length === 0) return assembly;
  const canonicalRepoRoot = assembly.decision?.canonicalRepoRoot;
  const pathComparisonIdentity = assembly.pathComparisonIdentity;
  if (!canonicalRepoRoot || !pathComparisonIdentity) {
    return Object.freeze({
      ...assembly,
      skillPaths: Object.freeze([]),
      launchSkillPaths: Object.freeze([]),
      launchSkillDigests: Object.freeze([]),
      launchSkillSourceFingerprints: Object.freeze([]),
      diagnostic: Object.freeze({
        ...assembly.diagnostic,
        reason: 'approved-skill-snapshot-failed',
        requestedSkillCount: 0,
      }),
    });
  }

  let temporaryRoot: string | null = null;
  try {
    const maxFileBytes = limits.maxFileBytes ?? MAX_PI_PROJECT_SKILL_SNAPSHOT_FILE_BYTES;
    const maxTotalBytes = limits.maxTotalBytes ?? MAX_PI_PROJECT_SKILL_SNAPSHOT_TOTAL_BYTES;
    const deadlineMs = limits.deadlineMs ?? PI_PROJECT_SKILL_SNAPSHOT_DEADLINE_MS;
    if (
      !Number.isSafeInteger(maxFileBytes)
      || !Number.isSafeInteger(maxTotalBytes)
      || !Number.isSafeInteger(deadlineMs)
      || maxFileBytes < 0
      || maxTotalBytes < 0
      || deadlineMs < 0
    ) {
      throw new Error('approved skill snapshot budget is invalid');
    }
    const deadlineAtMs = Date.now() + deadlineMs;
    const preflightBudget: PiProjectSkillSnapshotBudget = {
      remainingEntries: MAX_PI_PROJECT_SKILL_FINGERPRINT_ENTRIES,
      remainingBytes: maxTotalBytes,
      maxFileBytes,
      deadlineAtMs,
    };
    for (const sourcePath of assembly.skillPaths) {
      await preflightSkillSnapshotEntry(
        sourcePath,
        canonicalRepoRoot,
        pathComparisonIdentity,
        preflightBudget,
        new Set<string>(),
      );
    }
    const copyBudget: PiProjectSkillSnapshotBudget = {
      remainingEntries: MAX_PI_PROJECT_SKILL_FINGERPRINT_ENTRIES,
      remainingBytes: maxTotalBytes,
      maxFileBytes,
      deadlineAtMs,
    };
    const fingerprintBudget = (): PiProjectSkillFingerprintBudget => ({
      remainingEntries: Number.MAX_SAFE_INTEGER,
      deadlineAtMs,
      maxFileBytes,
    });
    temporaryRoot = await awaitDeadlineStep(
      () => fs.mkdtemp(path.join(configHome, '.project-resources-')),
      deadlineAtMs,
      'approved skill snapshot deadline expired',
    );
    const temporarySkillsRoot = path.join(temporaryRoot, 'skills');
    await awaitDeadlineStep(
      () => fs.mkdir(temporarySkillsRoot).then(() => undefined),
      deadlineAtMs,
      'approved skill snapshot deadline expired',
    );
    const relativeLaunchPaths: string[] = [];
    const launchSkillDigests: string[] = [];
    const launchSkillSourceFingerprints: string[] = [];
    const launchSnapshotFingerprints: PiProjectSkillEntrypointFingerprint[] = [];
    for (const [index, sourcePath] of assembly.skillPaths.entries()) {
      const skillName = path.basename(sourcePath);
      const relativePath = path.join('skills', String(index), skillName);
      const targetPath = path.join(temporaryRoot, relativePath);
      await awaitDeadlineStep(
        () => fs.mkdir(path.dirname(targetPath), { recursive: true }).then(() => undefined),
        deadlineAtMs,
        'approved skill snapshot deadline expired',
      );
      const [sourceRootBeforeCopy, canonicalSourceBeforeCopy] = await Promise.all([
        awaitDeadlineStep(
          () => fs.lstat(sourcePath),
          deadlineAtMs,
          'approved skill snapshot deadline expired',
        ),
        awaitDeadlineStep(
          () => fs.realpath(sourcePath),
          deadlineAtMs,
          'approved skill snapshot deadline expired',
        ),
      ]);
      if (
        !sourceRootBeforeCopy.isDirectory()
        || !piCanonicalPathsEqual(pathComparisonIdentity, canonicalSourceBeforeCopy, sourcePath)
        || !localPathIsWithin(
          canonicalRepoRoot,
          canonicalSourceBeforeCopy,
          pathComparisonIdentity,
        )
      ) {
        throw new Error('approved skill root changed before snapshotting');
      }
      const sourceFingerprintBeforeCopy = await fingerprintPiProjectSkillEntrypoint(
        sourcePath,
        canonicalRepoRoot,
        { budget: fingerprintBudget(), pathComparisonIdentity },
      );
      if (!sourceFingerprintBeforeCopy) {
        throw new Error('approved skill source fingerprint failed before snapshotting');
      }
      await materializeSkillEntry(
        sourcePath,
        targetPath,
        canonicalRepoRoot,
        pathComparisonIdentity,
        new Set<string>(),
        copyBudget,
      );
      const [canonicalSourceAfterCopy, skillEntrypoint] = await Promise.all([
        awaitDeadlineStep(
          () => fs.realpath(sourcePath),
          deadlineAtMs,
          'approved skill snapshot deadline expired',
        ),
        awaitDeadlineStep(
          () => fs.lstat(path.join(targetPath, 'SKILL.md')),
          deadlineAtMs,
          'approved skill snapshot deadline expired',
        ),
      ]);
      if (
        !piCanonicalPathsEqual(pathComparisonIdentity, canonicalSourceAfterCopy, sourcePath)
        || !skillEntrypoint.isFile()
      ) {
        throw new Error('approved skill changed before snapshot publication');
      }
      const [launchFingerprint, sourceFingerprint] = await Promise.all([
        fingerprintPiProjectSkillEntrypoint(targetPath, targetPath, {
          budget: fingerprintBudget(),
          pathComparisonIdentity: strictLocalPathComparisonIdentity(),
        }),
        fingerprintPiProjectSkillEntrypoint(sourcePath, canonicalRepoRoot, {
          budget: fingerprintBudget(),
          pathComparisonIdentity,
        }),
      ]);
      const [sourceRootAfterFingerprint, canonicalSourceAfterFingerprint] = await Promise.all([
        awaitDeadlineStep(
          () => fs.lstat(sourcePath),
          deadlineAtMs,
          'approved skill snapshot deadline expired',
        ),
        awaitDeadlineStep(
          () => fs.realpath(sourcePath),
          deadlineAtMs,
          'approved skill snapshot deadline expired',
        ),
      ]);
      if (
        !launchFingerprint
        || !sourceFingerprint
        || launchFingerprint.contentDigest !== sourceFingerprint.contentDigest
        || sourceFingerprintBeforeCopy.contentDigest !== sourceFingerprint.contentDigest
        || sourceFingerprintBeforeCopy.sourceStateDigest !== sourceFingerprint.sourceStateDigest
        || !sameEntrySnapshot(sourceRootBeforeCopy, sourceRootAfterFingerprint)
        || !piCanonicalPathsEqual(
          pathComparisonIdentity,
          canonicalSourceAfterFingerprint,
          canonicalSourceBeforeCopy,
        )
      ) {
        throw new Error('approved skill snapshot fingerprint failed');
      }
      relativeLaunchPaths.push(relativePath);
      launchSkillDigests.push(launchFingerprint.contentDigest);
      launchSkillSourceFingerprints.push(sourceFingerprint.sourceStateDigest);
      launchSnapshotFingerprints.push(launchFingerprint);
    }
    await assertMaterializedSkillLayout(
      temporarySkillsRoot,
      relativeLaunchPaths,
      deadlineAtMs,
    );
    const finalAuditBudget: PiProjectSkillSnapshotBudget = {
      remainingEntries: MAX_PI_PROJECT_SKILL_FINGERPRINT_ENTRIES,
      remainingBytes: maxTotalBytes,
      maxFileBytes,
      deadlineAtMs,
    };
    for (const relativePath of relativeLaunchPaths) {
      await auditMaterializedTree(
        path.join(temporaryRoot, relativePath),
        finalAuditBudget,
      );
    }
    await assertMaterializedSkillLayout(
      temporarySkillsRoot,
      relativeLaunchPaths,
      deadlineAtMs,
    );
    // Sandwich the per-Skill source-bound proofs between two whole-staging
    // fingerprints. A change before a Skill proof is rejected against its
    // stored launch fingerprint; a change after it is rejected by the closing
    // whole-tree pass. Nothing that can inspect the tree awaits after it.
    const canonicalTemporarySkillsRoot = await awaitDeadlineStep(
      () => fs.realpath(temporarySkillsRoot),
      deadlineAtMs,
      'approved skill snapshot deadline expired',
    );
    const baselineStagingFingerprint = await fingerprintSkillTreeStateOnce(
      temporarySkillsRoot,
      canonicalTemporarySkillsRoot,
      strictLocalPathComparisonIdentity(),
      fingerprintBudget(),
    );
    for (const [index, relativePath] of relativeLaunchPaths.entries()) {
      const targetPath = path.join(temporaryRoot, relativePath);
      const finalFingerprint = await fingerprintPiProjectSkillEntrypoint(targetPath, targetPath, {
        budget: fingerprintBudget(),
        pathComparisonIdentity: strictLocalPathComparisonIdentity(),
      });
      const expectedFingerprint = launchSnapshotFingerprints[index];
      if (
        !finalFingerprint
        || !expectedFingerprint
        || finalFingerprint.contentDigest !== expectedFingerprint.contentDigest
        || finalFingerprint.sourceStateDigest !== expectedFingerprint.sourceStateDigest
      ) throw new Error('approved skill snapshot changed during final audit');
    }
    const finalStagingFingerprint = await fingerprintSkillTreeStateOnce(
      temporarySkillsRoot,
      canonicalTemporarySkillsRoot,
      strictLocalPathComparisonIdentity(),
      fingerprintBudget(),
    );
    if (
      finalStagingFingerprint !== baselineStagingFingerprint
      || Date.now() >= deadlineAtMs
    ) {
      throw new Error('approved skill snapshot deadline expired before publication');
    }

    const publishedRoot = path.join(configHome, 'project-resources');
    await awaitDeadlineStep(
      () => fs.rename(temporaryRoot!, publishedRoot),
      deadlineAtMs,
      'approved skill snapshot deadline expired',
    );
    temporaryRoot = null;
    const launchSkillPaths = Object.freeze(relativeLaunchPaths.map((relativePath) =>
      path.join(publishedRoot, relativePath)));
    return Object.freeze({
      ...assembly,
      launchSkillPaths,
      launchSkillDigests: Object.freeze(launchSkillDigests),
      launchSkillSourceFingerprints: Object.freeze(launchSkillSourceFingerprints),
      diagnostic: Object.freeze({
        ...assembly.diagnostic,
        requestedSkillCount: launchSkillPaths.length,
      }),
    });
  } catch {
    if (temporaryRoot) {
      const cleanupDeadlineAtMs = Date.now() + 1_000;
      await awaitDeadlineStep(
        () => fs.rm(temporaryRoot!, { recursive: true, force: true }),
        cleanupDeadlineAtMs,
        'approved skill snapshot cleanup deadline expired',
      ).catch(() => undefined);
    }
    return Object.freeze({
      ...assembly,
      skillPaths: Object.freeze([]),
      launchSkillPaths: Object.freeze([]),
      launchSkillDigests: Object.freeze([]),
      launchSkillSourceFingerprints: Object.freeze([]),
      diagnostic: Object.freeze({
        ...assembly.diagnostic,
        reason: 'approved-skill-snapshot-failed',
        requestedSkillCount: 0,
      }),
    });
  }
}

function comparableRuntimePath(value: string): string {
  // Explicit --skill provenance normally echoes the canonical argv path. Keep
  // comparison case-sensitive here: a conservative false-negative is safer
  // than claiming loaded on a case-sensitive Windows directory.
  return path.resolve(value);
}

/**
 * Reconcile the approved launch snapshot with this runtime's exact command
 * catalog. Approval alone never upgrades a skill to loaded; missing commands
 * remain diagnosable even when get_commands itself succeeded.
 */
export function reconcilePiProjectResourceRuntime(
  assembly: PiProjectResourceAssemblySnapshot,
  manifest: PiRuntimeCapabilityManifest,
): PiProjectResourceRuntimeDiagnostic {
  if (manifest.status !== 'loaded' || assembly.launchSkillPaths.length === 0) {
    return assembly.diagnostic;
  }

  const expectedPaths = new Set(assembly.launchSkillPaths.map(comparableRuntimePath));
  const loadedPaths = new Map(manifest.commands.flatMap((command) => {
    const skillPath = piExplicitSkillRuntimePath(command);
    return skillPath && command.name.startsWith('skill:')
      ? [[comparableRuntimePath(skillPath), command.name] as const]
      : [];
  }));
  const loadedSkills = assembly.launchSkillPaths.flatMap((runtimePath, index) => {
    const commandName = loadedPaths.get(comparableRuntimePath(runtimePath));
    const sourcePath = assembly.skillPaths[index];
    const snapshotDigest = assembly.launchSkillDigests[index];
    const sourceFingerprint = assembly.launchSkillSourceFingerprints[index];
    const canonicalRepoRoot = assembly.decision?.canonicalRepoRoot;
    const pathComparisonIdentity = assembly.pathComparisonIdentity;
    return commandName && sourcePath && snapshotDigest && sourceFingerprint
      && canonicalRepoRoot && pathComparisonIdentity
      ? [{
          sourcePath,
          runtimePath,
          commandName,
          snapshotDigest,
          sourceFingerprint,
          canonicalRepoRoot,
          pathComparisonIdentity,
        }]
      : [];
  });
  const loadedSkillCount = [...expectedPaths].filter((skillPath) => loadedPaths.has(skillPath)).length;
  return Object.freeze({
    ...assembly.diagnostic,
    reason: loadedSkillCount === expectedPaths.size
      ? 'runtime-skills-confirmed'
      : 'runtime-skills-missing',
    loadedSkillCount,
    loadedSkills: Object.freeze(loadedSkills.map((skill) => Object.freeze(skill))),
  });
}

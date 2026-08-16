import fs from 'node:fs/promises';
import { constants, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from 'node:timers';
import type { FileHandle } from 'node:fs/promises';

import type {
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
  skillPaths: readonly string[],
  stat: (path: string) => Promise<PiPathStat>,
  realpath: (path: string) => Promise<string>,
  identity: PiProjectTrustInputSnapshot['identity'],
  requestedWorkingDir: string,
  resolveNearestGitRoot: (
    workingDir: string,
    stat: (path: string) => Promise<PiPathStat>,
    pathApi: typeof path.posix | typeof path.win32,
  ) => Promise<string | null>,
): Promise<
  'available' | 'unavailable' | 'request-mismatch' | 'repo-mismatch' | 'project-changed' | 'skill-changed'
> {
  try {
    const canonicalWorkingDir = identity.canonicalWorkingDir;
    const canonicalRepoRoot = identity.canonicalRepoRoot;
    if (!canonicalWorkingDir || !canonicalRepoRoot) return 'unavailable';
    const pathApi = identity.platform === 'win32' ? path.win32 : path.posix;
    const resolvedRequestedWorkingDir = await realpath(requestedWorkingDir);
    const [resolvedWorkingDir, resolvedRepoRoot, currentRepoRoot, entries] =
      await Promise.all([
        realpath(identity.workingDir),
        realpath(canonicalRepoRoot),
        resolveNearestGitRoot(resolvedRequestedWorkingDir, stat, pathApi),
        Promise.all(skillPaths.map(async (skillPath) => {
          const stats = await stat(skillPath);
          const resolvedPath = await realpath(skillPath);
          if (!stats.isDirectory()) return { skillPath, stats, resolvedPath };
          const skillFile = pathApi.join(skillPath, 'SKILL.md');
          return {
            skillPath,
            stats,
            resolvedPath,
            skillFileStats: await stat(skillFile),
            resolvedSkillFile: await realpath(skillFile),
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
    return entries.every(({ skillPath, resolvedPath, stats, resolvedSkillFile }) =>
      piCanonicalPathsEqual(identity, skillPath, resolvedPath)
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
  let reason = decision.reason;
  let skillPaths: readonly string[] = eligibleSkillPaths;

  if (
    decision.status === 'approved' &&
    input.discovered.skills.length > 0 &&
    eligibleSkillPaths.length === 0
  ) {
    reason = 'approved-skills-ineligible';
  } else if (eligibleSkillPaths.length > 0) {
    const pathStatus = await validateSkillPathsImmediatelyBeforeLaunch(
      eligibleSkillPaths,
      options.stat ?? fs.stat,
      options.realpath ?? fs.realpath,
      input.identity,
      requestedWorkingDir,
      options.findNearestGitRoot ?? findNearestGitRoot,
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
  return Object.freeze({
    decision,
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

function localPathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

async function hashOpenFile(handle: FileHandle, deadlineAtMs = Number.POSITIVE_INFINITY): Promise<string> {
  if (Date.now() >= deadlineAtMs) throw new Error('approved skill fingerprint deadline expired');
  const hash = createHash('sha256');
  const controller = new AbortController();
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
      hash.update(chunk);
    }
  } finally {
    if (timeout) clearNodeTimeout(timeout);
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
}

async function fingerprintSkillEntrypointOnce(
  rootPath: string,
  canonicalRepoRoot: string,
  sharedBudget?: PiProjectSkillFingerprintBudget,
): Promise<string> {
  const skillPath = path.join(rootPath, 'SKILL.md');
  const [rootEntry, canonicalRoot, skillLinkEntry, canonicalSkill, skillTargetEntry] =
    await Promise.all([
      fs.lstat(rootPath),
      fs.realpath(rootPath),
      fs.lstat(skillPath),
      fs.realpath(skillPath),
      fs.stat(skillPath),
    ]);
  if (
    !rootEntry.isDirectory()
    || !skillTargetEntry.isFile()
    || !localPathIsWithin(canonicalRepoRoot, canonicalRoot)
    || !localPathIsWithin(canonicalRepoRoot, canonicalSkill)
  ) {
    throw new Error('approved skill entrypoint escaped its repository');
  }

  const handle = await fs.open(
    canonicalSkill,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    if (sharedBudget && Date.now() >= sharedBudget.deadlineAtMs) {
      throw new Error('approved skill fingerprint deadline expired');
    }
    const openedEntry = await handle.stat();
    if (!openedEntry.isFile() || !sameFileIdentity(skillTargetEntry, openedEntry)) {
      throw new Error('approved skill entrypoint changed before fingerprinting');
    }
    const contentDigest = await hashOpenFile(handle, sharedBudget?.deadlineAtMs);
    const [
      rootEntryAfterRead,
      canonicalRootAfterRead,
      skillLinkEntryAfterRead,
      canonicalSkillAfterRead,
      skillTargetEntryAfterRead,
      openedAfterRead,
    ] = await Promise.all([
      fs.lstat(rootPath),
      fs.realpath(rootPath),
      fs.lstat(skillPath),
      fs.realpath(skillPath),
      fs.stat(skillPath),
      handle.stat(),
    ]);
    if (
      !sameEntrySnapshot(rootEntry, rootEntryAfterRead)
      || !sameEntrySnapshot(skillLinkEntry, skillLinkEntryAfterRead)
      || !sameEntrySnapshot(skillTargetEntry, skillTargetEntryAfterRead)
      || !sameEntrySnapshot(openedEntry, openedAfterRead)
      || !sameFileIdentity(openedEntry, skillTargetEntryAfterRead)
      || path.relative(canonicalRootAfterRead, canonicalRoot) !== ''
      || path.relative(canonicalSkillAfterRead, canonicalSkill) !== ''
    ) {
      throw new Error('approved skill entrypoint changed while fingerprinting');
    }
    return contentDigest;
  } finally {
    await handle.close();
  }
}

const MAX_PI_PROJECT_SKILL_FINGERPRINT_ENTRIES = 10_000;

function updateFingerprintValue(hash: ReturnType<typeof createHash>, value: unknown): void {
  hash.update(String(value));
  hash.update('\0');
}

async function fingerprintSkillTreeStateOnce(
  rootPath: string,
  canonicalRepoRoot: string,
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
      fs.lstat(entryPath),
      fs.realpath(entryPath),
      fs.stat(entryPath),
    ]);
    if (
      !localPathIsWithin(canonicalRepoRoot, canonicalEntry)
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
        const directory = await fs.opendir(entryPath);
        try {
          while (true) {
            if (sharedBudget && Date.now() >= sharedBudget.deadlineAtMs) {
              throw new Error('approved skill tree exceeded the shared fingerprint deadline');
            }
            const child = await directory.read();
            if (!child) break;
            if (childNames.length >= remainingEntryBudget) {
              throw new Error('approved skill tree exceeds the fingerprint entry budget');
            }
            childNames.push(child.name);
          }
        } finally {
          await directory.close().catch(() => undefined);
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
      fs.lstat(entryPath),
      fs.realpath(entryPath),
      fs.stat(entryPath),
    ]);
    if (
      !sameEntrySnapshot(linkEntry, linkEntryAfter)
      || !sameEntrySnapshot(targetEntry, targetEntryAfter)
      || path.resolve(canonicalEntryAfter) !== path.resolve(canonicalEntry)
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
  options: { budget?: PiProjectSkillFingerprintBudget } = {},
): Promise<PiProjectSkillEntrypointFingerprint | null> {
  try {
    if (options.budget && Date.now() >= options.budget.deadlineAtMs) return null;
    const [canonicalRoot, canonicalBoundary] = await Promise.all([
      fs.realpath(rootPath),
      fs.realpath(canonicalRepoRoot),
    ]);
    if (!localPathIsWithin(canonicalBoundary, canonicalRoot)) return null;
    const firstContentDigest = await fingerprintSkillEntrypointOnce(
      rootPath,
      canonicalBoundary,
      options.budget,
    );
    const firstSourceStateDigest = await fingerprintSkillTreeStateOnce(
      rootPath,
      canonicalBoundary,
      options.budget,
    );
    const secondContentDigest = await fingerprintSkillEntrypointOnce(
      rootPath,
      canonicalBoundary,
      options.budget,
    );
    const secondSourceStateDigest = await fingerprintSkillTreeStateOnce(
      rootPath,
      canonicalBoundary,
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
  activeDirectories: Set<string>,
): Promise<void> {
  const [entry, canonicalSource] = await Promise.all([
    fs.lstat(sourcePath),
    fs.realpath(sourcePath),
  ]);
  if (!localPathIsWithin(canonicalRepoRoot, canonicalSource)) {
    throw new Error('approved skill entry escaped its repository');
  }

  if (entry.isSymbolicLink()) {
    await materializeSkillEntry(canonicalSource, targetPath, canonicalRepoRoot, activeDirectories);
    return;
  }
  if (entry.isDirectory()) {
    if (activeDirectories.has(canonicalSource)) {
      throw new Error('approved skill contains a directory cycle');
    }
    activeDirectories.add(canonicalSource);
    try {
      await fs.mkdir(targetPath, { recursive: false });
      const children = await fs.readdir(sourcePath, { withFileTypes: true });
      for (const child of children) {
        await materializeSkillEntry(
          path.join(sourcePath, child.name),
          path.join(targetPath, child.name),
          canonicalRepoRoot,
          activeDirectories,
        );
      }
      const [canonicalAfterCopy, entryAfterCopy] = await Promise.all([
        fs.realpath(sourcePath),
        fs.lstat(sourcePath),
      ]);
      if (
        path.relative(canonicalAfterCopy, canonicalSource) !== ''
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

  const sourceHandle = await fs.open(
    sourcePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const openedEntry = await sourceHandle.stat();
    if (!openedEntry.isFile() || !sameFileIdentity(entry, openedEntry)) {
      throw new Error('approved skill file changed before snapshot read');
    }
    await pipeline(
      sourceHandle.createReadStream({ autoClose: false }),
      createWriteStream(targetPath, { flags: 'wx', mode: openedEntry.mode }),
    );
    const [openedAfterCopy, sourcePathAfterCopy, sourceAfterCopy, targetAfterCopy] =
      await Promise.all([
        sourceHandle.stat(),
        fs.lstat(sourcePath),
        fs.realpath(sourcePath),
        fs.lstat(targetPath),
      ]);
    if (
      !sameEntrySnapshot(openedEntry, openedAfterCopy)
      || !sameFileIdentity(openedEntry, sourcePathAfterCopy)
      || path.relative(sourceAfterCopy, canonicalSource) !== ''
      || !targetAfterCopy.isFile()
    ) {
      throw new Error('approved skill file changed while snapshotting');
    }
    const targetHandle = await fs.open(
      targetPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const [sourceDigest, targetDigest] = await Promise.all([
        hashOpenFile(sourceHandle),
        hashOpenFile(targetHandle),
      ]);
      const [sourceAfterStableRead, targetAfterStableRead] = await Promise.all([
        sourceHandle.stat(),
        targetHandle.stat(),
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
      await targetHandle.close();
    }
    await fs.chmod(targetPath, openedEntry.mode & 0o777);
  } finally {
    await sourceHandle.close();
  }
}

async function assertMaterializedTreeContainsNoLinksOrSpecialFiles(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    const stats = await fs.lstat(entryPath);
    if (stats.isSymbolicLink()) throw new Error('skill snapshot contains a symbolic link');
    if (stats.isDirectory()) {
      await assertMaterializedTreeContainsNoLinksOrSpecialFiles(entryPath);
    } else if (!stats.isFile()) {
      throw new Error('skill snapshot contains a special file');
    }
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
): Promise<PiProjectResourceAssemblySnapshot> {
  if (assembly.skillPaths.length === 0) return assembly;
  const canonicalRepoRoot = assembly.decision?.canonicalRepoRoot;
  if (!canonicalRepoRoot) {
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
    temporaryRoot = await fs.mkdtemp(path.join(configHome, '.project-resources-'));
    const temporarySkillsRoot = path.join(temporaryRoot, 'skills');
    await fs.mkdir(temporarySkillsRoot);
    const relativeLaunchPaths: string[] = [];
    const launchSkillDigests: string[] = [];
    const launchSkillSourceFingerprints: string[] = [];
    for (const [index, sourcePath] of assembly.skillPaths.entries()) {
      const skillName = path.basename(sourcePath);
      const relativePath = path.join('skills', String(index), skillName);
      const targetPath = path.join(temporaryRoot, relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const [sourceRootBeforeCopy, canonicalSourceBeforeCopy] = await Promise.all([
        fs.lstat(sourcePath),
        fs.realpath(sourcePath),
      ]);
      if (
        !sourceRootBeforeCopy.isDirectory()
        || path.resolve(canonicalSourceBeforeCopy) !== path.resolve(sourcePath)
        || !localPathIsWithin(canonicalRepoRoot, canonicalSourceBeforeCopy)
      ) {
        throw new Error('approved skill root changed before snapshotting');
      }
      const sourceFingerprintBeforeCopy = await fingerprintPiProjectSkillEntrypoint(
        sourcePath,
        canonicalRepoRoot,
      );
      if (!sourceFingerprintBeforeCopy) {
        throw new Error('approved skill source fingerprint failed before snapshotting');
      }
      await materializeSkillEntry(
        sourcePath,
        targetPath,
        canonicalRepoRoot,
        new Set<string>(),
      );
      const [canonicalSourceAfterCopy, skillEntrypoint] = await Promise.all([
        fs.realpath(sourcePath),
        fs.lstat(path.join(targetPath, 'SKILL.md')),
      ]);
      if (path.resolve(canonicalSourceAfterCopy) !== path.resolve(sourcePath) || !skillEntrypoint.isFile()) {
        throw new Error('approved skill changed before snapshot publication');
      }
      const [launchFingerprint, sourceFingerprint] = await Promise.all([
        fingerprintPiProjectSkillEntrypoint(targetPath, targetPath),
        fingerprintPiProjectSkillEntrypoint(sourcePath, canonicalRepoRoot),
      ]);
      const [sourceRootAfterFingerprint, canonicalSourceAfterFingerprint] = await Promise.all([
        fs.lstat(sourcePath),
        fs.realpath(sourcePath),
      ]);
      if (
        !launchFingerprint
        || !sourceFingerprint
        || launchFingerprint.contentDigest !== sourceFingerprint.contentDigest
        || sourceFingerprintBeforeCopy.contentDigest !== sourceFingerprint.contentDigest
        || sourceFingerprintBeforeCopy.sourceStateDigest !== sourceFingerprint.sourceStateDigest
        || !sameEntrySnapshot(sourceRootBeforeCopy, sourceRootAfterFingerprint)
        || path.resolve(canonicalSourceAfterFingerprint) !== path.resolve(canonicalSourceBeforeCopy)
      ) {
        throw new Error('approved skill snapshot fingerprint failed');
      }
      relativeLaunchPaths.push(relativePath);
      launchSkillDigests.push(launchFingerprint.contentDigest);
      launchSkillSourceFingerprints.push(sourceFingerprint.sourceStateDigest);
    }
    await assertMaterializedTreeContainsNoLinksOrSpecialFiles(temporarySkillsRoot);

    const publishedRoot = path.join(configHome, 'project-resources');
    await fs.rename(temporaryRoot, publishedRoot);
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
      await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
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
    return commandName && sourcePath && snapshotDigest && sourceFingerprint && canonicalRepoRoot
      ? [{
          sourcePath,
          runtimePath,
          commandName,
          snapshotDigest,
          sourceFingerprint,
          canonicalRepoRoot,
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

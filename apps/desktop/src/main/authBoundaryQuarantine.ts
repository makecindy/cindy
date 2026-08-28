/**
 * Cross-process state machine for the globally visible Ghost skill projection.
 *
 * Owner-scoped plugin bytes live under userData, but the links consumed by
 * agents live in shared home directories. Every owner transition and every
 * Ghost reconcile therefore uses the same strict lock and durable owner state.
 * Missing, malformed, or pending state never authorizes a reconcile.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

import { app } from 'electron';

import { withSecurityBoundaryLock } from './device-link/crossProcessLock.js';
import { createLogger } from './logger.js';
import { atomicWriteFileSync } from './utils/atomicWriteFile.js';
import { readBoundedFileNoFollowSync } from './utils/readBoundedFile.js';

const log = createLogger('ghost-skill-projection-boundary');
const FILE_NAME = 'ghost-skill-projection-boundary.json';
const QUARANTINE_FILE_NAME = 'ghost-skill-projection-boundary.quarantine.json';
const MAX_BYTES = 16 * 1024;
let processProjectionQuarantined = false;

export type GhostSkillProjectionBoundaryState =
  | {
      version: 1;
      phase: 'stable';
      ownerId: string | null;
      transitionId: string;
      updatedAt: number;
    }
  | {
      version: 1;
      phase: 'pending';
      previousOwnerId: string | null;
      nextOwnerId: string | null;
      transitionId: string;
      updatedAt: number;
    }
  | {
      version: 1;
      phase: 'quarantined';
      previousOwnerId: string | null;
      nextOwnerId: string | null;
      transitionId: string;
      updatedAt: number;
    };

interface OwnerCommitOptions<T> {
  previousOwnerId: string | null;
  nextOwnerId: string | null;
  prepareTransition?: (context: { ownerChanged: boolean }) => Promise<void>;
  prepareCommit?: () => Promise<void>;
  onCommitFailure?: (context: { commitApplied: boolean }) => void | Promise<void>;
  commit: () => T | Promise<T>;
}

type StateRead =
  | { kind: 'ok'; state: GhostSkillProjectionBoundaryState }
  | { kind: 'missing' | 'invalid' };

type QuarantineState =
  | Extract<GhostSkillProjectionBoundaryState, { phase: 'quarantined' }>
  | {
      version: 1;
      phase: 'released';
      transitionId: string;
      updatedAt: number;
    };

type QuarantineRead =
  | { kind: 'ok'; state: QuarantineState }
  | { kind: 'missing' | 'invalid' };

function filePath(): string {
  // This marker deliberately lives beside the shared home-level Ghost skill
  // projection. It must be visible to every Cindy instance using this OS user;
  // profile-scoped application state remains under app.getPath('userData').
  return path.join(os.homedir(), '.cindy', FILE_NAME);
}

function quarantinePath(): string {
  return path.join(os.homedir(), '.cindy', QUARANTINE_FILE_NAME);
}

function lockPath(): string {
  return `${filePath()}.lock`;
}

function normalizeOwnerId(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized === '' ? undefined : normalized;
}

function normalizeOwnerArgument(value: string | null): string | null {
  const normalized = normalizeOwnerId(value);
  if (normalized === undefined) throw new Error('Ghost skill projection owner is invalid');
  return normalized;
}

function isPassiveSharedUserDataInstance(): boolean {
  return !app.isPackaged && process.env.XDT_PASSIVE_SHARED_USER_DATA === '1';
}

function normalizeRecord(raw: unknown): GhostSkillProjectionBoundaryState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) return null;
  if (typeof value.transitionId !== 'string' || value.transitionId.trim() === '') return null;
  if (
    typeof value.updatedAt !== 'number' ||
    !Number.isFinite(value.updatedAt) ||
    value.updatedAt < 0
  ) {
    return null;
  }
  if (value.phase === 'stable') {
    const ownerId = normalizeOwnerId(value.ownerId);
    if (ownerId === undefined) return null;
    return {
      version: 1,
      phase: 'stable',
      ownerId,
      transitionId: value.transitionId,
      updatedAt: value.updatedAt,
    };
  }
  if (value.phase === 'pending') {
    const previousOwnerId = normalizeOwnerId(value.previousOwnerId);
    const nextOwnerId = normalizeOwnerId(value.nextOwnerId);
    if (previousOwnerId === undefined || nextOwnerId === undefined) return null;
    return {
      version: 1,
      phase: 'pending',
      previousOwnerId,
      nextOwnerId,
      transitionId: value.transitionId,
      updatedAt: value.updatedAt,
    };
  }
  if (value.phase === 'quarantined') {
    const previousOwnerId = normalizeOwnerId(value.previousOwnerId);
    const nextOwnerId = normalizeOwnerId(value.nextOwnerId);
    if (previousOwnerId === undefined || nextOwnerId === undefined) return null;
    return {
      version: 1,
      phase: 'quarantined',
      previousOwnerId,
      nextOwnerId,
      transitionId: value.transitionId,
      updatedAt: value.updatedAt,
    };
  }
  return null;
}

function normalizeQuarantineRecord(raw: unknown): QuarantineState | null {
  const boundary = normalizeRecord(raw);
  if (boundary?.phase === 'quarantined') return boundary;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    value.version !== 1
    || value.phase !== 'released'
    || typeof value.transitionId !== 'string'
    || value.transitionId.trim() === ''
    || typeof value.updatedAt !== 'number'
    || !Number.isFinite(value.updatedAt)
    || value.updatedAt < 0
  ) {
    return null;
  }
  return {
    version: 1,
    phase: 'released',
    transitionId: value.transitionId,
    updatedAt: value.updatedAt,
  };
}

function readState(): StateRead {
  return readStateFile(filePath(), normalizeRecord);
}

function readQuarantineState(): QuarantineRead {
  return readStateFile(quarantinePath(), normalizeQuarantineRecord);
}

function readStateFile<T>(
  targetPath: string,
  normalize: (raw: unknown) => T | null,
): { kind: 'ok'; state: T } | { kind: 'missing' | 'invalid' } {
  let bytes: Buffer | null;
  try {
    bytes = readBoundedFileNoFollowSync(targetPath, MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    log.error('Ghost skill projection boundary could not be read', error);
    return { kind: 'invalid' };
  }
  if (!bytes) return { kind: 'invalid' };
  try {
    const state = normalize(JSON.parse(bytes.toString('utf8')));
    return state ? { kind: 'ok', state } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

function isDurablyQuarantined(): boolean {
  const observed = readQuarantineState();
  return observed.kind === 'invalid'
    || (observed.kind === 'ok' && observed.state.phase === 'quarantined');
}

function syncCommittedState(file: string): void {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  // Windows rejects fsync on a read-only handle with EPERM. Open the freshly
  // replaced private marker read/write so the durability gate works on both
  // supported desktop platforms; O_NOFOLLOW still rejects a raced symlink.
  const fd = fs.openSync(file, fs.constants.O_RDWR | (fs.constants.O_NONBLOCK ?? 0) | noFollow);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (process.platform === 'win32') return;
  const dirFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

function writeState(state: GhostSkillProjectionBoundaryState): void {
  writeStateFile(filePath(), state);
}

function writeQuarantineState(state: Extract<GhostSkillProjectionBoundaryState, { phase: 'quarantined' }>): void {
  writeStateFile(quarantinePath(), state);
}

function writeStateFile(
  file: string,
  state: GhostSkillProjectionBoundaryState | QuarantineState,
): void {
  atomicWriteFileSync(file, JSON.stringify(state));
  // The caller may publish a new owner immediately after this returns. Flush
  // both the replacement file and, where supported, the containing directory.
  syncCommittedState(file);
}

function clearQuarantineState(transitionId: string): void {
  writeStateFile(quarantinePath(), {
    version: 1,
    phase: 'released',
    transitionId,
    updatedAt: Date.now(),
  });
}

async function withStrictBoundaryLock<T>(task: () => Promise<T>): Promise<T> {
  // The in-process tail and the cross-process security lock are complementary:
  // the tail preserves ordering inside this Main process, while the strict lock
  // proves the owner of the globally shared projection transition. This is an
  // authorization boundary, so busy/unavailable must fail closed and must not
  // be replaced with the ordinary advisory tier.
  const previous = inProcessBoundaryTail;
  let releaseInProcess: () => void = () => undefined;
  inProcessBoundaryTail = new Promise<void>((resolve) => {
    releaseInProcess = () => resolve();
  });
  await previous;
  try {
    const file = filePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return await withSecurityBoundaryLock(
      lockPath(),
      {
        label: 'ghost-skill-projection-boundary',
        waitMs: 12_000,
      },
      async (status) => {
        if (!status.held) {
          throw new Error('Ghost skill projection boundary lock is busy or unavailable');
        }
        return task();
      },
    );
  } finally {
    releaseInProcess();
  }
}

let inProcessBoundaryTail: Promise<void> = Promise.resolve();

/**
 * Serialize an application owner commit with the global Ghost skill projection.
 *
 * A stable matching owner may commit without another sweep, but still commits
 * under the same lock as reconcile. Missing/invalid/pending/mismatched state
 * first writes a durable quarantine record, then a pending record, before the
 * full teardown and sweep. A failed transition keeps the durable state
 * non-stable even after this process releases its in-memory boundary. The local
 * session commits while the durable state is still pending, so all owner-bound
 * consumers remain fail closed. The matching stable owner is only published
 * after that commit succeeds.
 */
export async function withGhostSkillProjectionOwnerCommit<T>(
  options: OwnerCommitOptions<T>,
): Promise<T> {
  if (isPassiveSharedUserDataInstance()) {
    throw new Error('Passive shared-userData instances cannot publish the Ghost projection owner');
  }
  const previousOwnerId = normalizeOwnerArgument(options.previousOwnerId);
  const nextOwnerId = normalizeOwnerArgument(options.nextOwnerId);
  return withStrictBoundaryLock(async () => {
    const observed = readState();
    const stable =
      observed.kind === 'ok' && observed.state.phase === 'stable'
        ? observed.state
        : null;
    const previousMatches = stable?.ownerId === previousOwnerId;
    const requiresTransition =
      processProjectionQuarantined
      || isDurablyQuarantined()
      || stable?.ownerId !== nextOwnerId
      || !previousMatches;
    const ownerChanged = previousOwnerId !== nextOwnerId;
    const transitionId = crypto.randomUUID();
    const prepareTransition = options.prepareTransition;
    let commitApplied = false;

    if (requiresTransition) {
      if (!prepareTransition) {
        throw new Error('Ghost skill projection owner transition requires a teardown hook');
      }
      processProjectionQuarantined = true;
    }

    try {
      if (requiresTransition) {
        const prepare = prepareTransition;
        if (!prepare) {
          throw new Error('Ghost skill projection owner transition requires a teardown hook');
        }
        const previousStateOwnerId = stable?.ownerId ?? previousOwnerId;
        writeQuarantineState({
          version: 1,
          phase: 'quarantined',
          previousOwnerId: previousStateOwnerId,
          nextOwnerId,
          transitionId,
          updatedAt: Date.now(),
        });
        writeState({
          version: 1,
          phase: 'pending',
          previousOwnerId: previousStateOwnerId,
          nextOwnerId,
          transitionId,
          updatedAt: Date.now(),
        });
        await prepare({ ownerChanged });
      }
      await options.prepareCommit?.();
      const result = await options.commit();
      commitApplied = true;
      if (requiresTransition) {
        writeState({
          version: 1,
          phase: 'stable',
          ownerId: nextOwnerId,
          transitionId,
          updatedAt: Date.now(),
        });
        clearQuarantineState(transitionId);
        processProjectionQuarantined = false;
      }
      return result;
    } catch (error) {
      try {
        await options.onCommitFailure?.({ commitApplied });
      } catch (rollbackError) {
        log.error('Ghost skill projection owner commit rollback failed', rollbackError);
      }
      if (requiresTransition) {
        try {
          writeState({
            version: 1,
            phase: 'pending',
            previousOwnerId: stable?.ownerId ?? previousOwnerId,
            nextOwnerId,
            transitionId,
            updatedAt: Date.now(),
          });
        } catch (stateError) {
          log.error(
            'Ghost skill projection boundary could not preserve pending after owner transition failed',
            stateError,
          );
          try {
            writeQuarantineState({
              version: 1,
              phase: 'quarantined',
              previousOwnerId: stable?.ownerId ?? previousOwnerId,
              nextOwnerId,
              transitionId,
              updatedAt: Date.now(),
            });
          } catch (quarantineError) {
            log.error(
              'Ghost skill projection boundary could not preserve durable quarantine',
              quarantineError,
            );
          }
        }
      }
      throw error;
    }
  });
}

/** Allow link mutation only for the globally stable owner, under the same lock. */
export async function withGhostSkillProjectionReconcile<T>(
  ownerId: string,
  reconcile: () => Promise<T>,
): Promise<T> {
  const normalizedOwnerId = ownerId.trim();
  if (!normalizedOwnerId) throw new Error('Ghost skill reconcile requires a committed owner');
  return withSharedGlobalSkillProjectionMutation(normalizedOwnerId, reconcile);
}

/** Serialize every mutation of the shared home-level skill discovery roots. */
export async function withSharedGlobalSkillProjectionMutation<T>(
  ownerId: string | null,
  mutation: () => Promise<T>,
): Promise<T> {
  if (isPassiveSharedUserDataInstance()) {
    throw new Error('Passive shared-userData instances cannot mutate global skill projections');
  }
  return withStableOwnerBoundaryMutation(ownerId, mutation);
}

/** Serialize non-projection state that must agree with the same durable owner. */
export async function withStableOwnerBoundaryMutation<T>(
  ownerId: string | null,
  mutation: () => Promise<T>,
): Promise<T> {
  if (isPassiveSharedUserDataInstance()) {
    throw new Error('Passive shared-userData instances cannot mutate stable owner state');
  }
  const normalizedOwnerId = normalizeOwnerArgument(ownerId);
  return withStrictBoundaryLock(async () => {
    if (processProjectionQuarantined || isDurablyQuarantined()) {
      throw new Error(
        'Ghost skill projection is quarantined after an uncertain owner commit; projection is not stable',
      );
    }
    const observed = readState();
    if (
      observed.kind !== 'ok' ||
      observed.state.phase !== 'stable' ||
      observed.state.ownerId !== normalizedOwnerId
    ) {
      throw new Error('Ghost skill projection is not stable for the active owner');
    }
    return mutation();
  });
}

/** Join an already-published owner without allowing this process to mutate it. */
export async function withGhostSkillProjectionReadOnlyOwner<T>(
  ownerId: string,
  commit: () => T | Promise<T>,
): Promise<T> {
  const normalizedOwnerId = normalizeOwnerArgument(ownerId);
  if (normalizedOwnerId === null) {
    throw new Error('Read-only Ghost projection join requires a committed owner');
  }
  return withStrictBoundaryLock(async () => {
    if (!isGhostSkillProjectionBoundaryStableForOwner(normalizedOwnerId)) {
      throw new Error('Ghost skill projection is owned by another active session');
    }
    return commit();
  });
}

export function readGhostSkillProjectionBoundaryState(): GhostSkillProjectionBoundaryState | null {
  const observed = readState();
  return observed.kind === 'ok' ? observed.state : null;
}

export function isGhostSkillProjectionBoundaryStableForOwner(ownerId: string | null): boolean {
  if (processProjectionQuarantined || isDurablyQuarantined()) return false;
  const normalizedOwnerId = normalizeOwnerArgument(ownerId);
  const observed = readState();
  return observed.kind === 'ok'
    && observed.state.phase === 'stable'
    && observed.state.ownerId === normalizedOwnerId;
}

export function assertGhostSkillProjectionStableOwner(ownerId: string): void {
  const normalizedOwnerId = ownerId.trim();
  if (!normalizedOwnerId) throw new Error('Ghost skill projection requires a committed owner');
  assertGhostSkillProjectionBoundaryStableForOwner(normalizedOwnerId);
}

export function assertGhostSkillProjectionBoundaryStableForOwner(
  ownerId: string | null,
): void {
  if (!isGhostSkillProjectionBoundaryStableForOwner(ownerId)) {
    throw new Error('Ghost skill projection is not stable for the active owner');
  }
}

export const __testing = {
  filePath,
  quarantinePath,
  lockPath,
  normalizeRecord,
  readState,
  resetProcessQuarantine: () => {
    processProjectionQuarantined = false;
  },
  maxBytes: MAX_BYTES,
};

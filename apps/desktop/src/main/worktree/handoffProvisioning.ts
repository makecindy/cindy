import fs from 'node:fs';
import path from 'node:path';

import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';

import { createLogger } from '../logger.js';
import { redactLocalPathText } from '../maker-ipc/coldPiRehydrationFailure.js';
import type { PrepareHandoffWorktreeResult } from '../maker-ipc/handoffWorktree.js';
import type { WorktreeMeta } from './types.js';
import {
  WORKTREE_PROVISIONING_LOCK_ID,
  type WorktreeProvisioningSnapshot,
  type WorktreeProvisioningStage,
} from '../../shared/worktreeProvisioning.js';

export { WORKTREE_PROVISIONING_LOCK_ID };

const log = createLogger('worktree-provisioning');

const FILE_NAME = 'worktree-provisioning.json';
/** Keep foreign-owner entries around briefly until that account signs back in. */
const FOREIGN_ENTRY_TTL_MS = 7 * 24 * 60 * 60_000;
const ERROR_MAX_CHARS = 300;
export const DEFAULT_FAST_WAIT_MS = 3_000;

export const INTERRUPTED_PROVISIONING_MESSAGE =
  '应用重启导致 worktree 创建中断，请重试创建或删除该任务。';

export interface PersistedProvisioningEntry {
  sessionId: string;
  baseRepo: string;
  workingDir: string;
  dispatcherSessionId?: string;
  sourceRef?: string;
  name?: string;
  status: 'provisioning' | 'failed';
  stage?: WorktreeProvisioningStage;
  startedAt: number;
  error?: string;
  interruptedOnRestart?: boolean;
  ownerScopeKey?: string;
}

export interface HandoffProvisioningPorts {
  getUserDataDir: () => string | null;
  getOwnerScopeKey: () => string | null;
  captureOwnerToken: () => object | null;
  isOwnerTokenCurrent: (token: object | null) => boolean;
  readSessionLifecycle: (
    sessionId: string,
  ) => Promise<{
    state: 'active' | 'terminal' | 'missing';
    hasWorktreePath?: boolean;
  }>;
  getRegisteredWorktree?: (sessionId: string) => WorktreeMeta | null;
  bindWorktreeToSession: (sessionId: string, meta: WorktreeMeta) => Promise<void>;
  updateQueuedWorkingDir?: (sessionId: string, worktreePath: string) => void;
  setProvisioningLock: (sessionId: string, locked: boolean) => void;
  createWorktree: (input: {
    sessionId: string;
    baseRepo: string;
    workingDir: string;
    dispatcherSessionId?: string;
    sourceRef?: string;
    signal: AbortSignal;
    onStageChange: (stage: WorktreeProvisioningStage) => void;
    onNameSelected: (name: string) => void;
  }) => Promise<PrepareHandoffWorktreeResult>;
  discardOrphanWorktree: (sessionId: string, worktreePath: string) => Promise<void>;
  isQueueBusy: (baseRepo: string) => Promise<boolean>;
  onChanged?: (sessionId: string, snapshot: WorktreeProvisioningSnapshot | null) => void;
  onWorktreeBound?: (sessionId: string, meta: WorktreeMeta) => void;
  fastWaitMs?: number;
  now?: () => number;
}

export type BeginProvisioningOutcome =
  | { state: 'ready'; meta: WorktreeMeta; staleBaseReason?: string }
  | { state: 'failed'; message: string }
  | { state: 'provisioning'; snapshot: WorktreeProvisioningSnapshot };

export type RetryProvisioningResult =
  | { ok: true; snapshot: WorktreeProvisioningSnapshot }
  | { ok: false; errorCode: 'NOT_FOUND' | 'PRECONDITION_FAILED' | 'INTERNAL'; message: string };

interface ActiveAttempt {
  controller: AbortController;
  ownerToken: object | null;
  handedOffToBackground: boolean;
  cancelled: boolean;
  fastOutcome?: PrepareHandoffWorktreeResult;
  promise: Promise<void>;
}

function sanitizeProvisioningError(raw: string): string {
  const cleaned = redactLocalPathText(redactSensitiveText(raw)).replace(/\s+/gu, ' ').trim();
  if (!cleaned) return 'Worktree creation failed';
  const chars = Array.from(cleaned);
  return chars.length <= ERROR_MAX_CHARS
    ? cleaned
    : `${chars.slice(0, ERROR_MAX_CHARS - 1).join('')}…`;
}

function toSnapshot(
  entry: PersistedProvisioningEntry,
  isLiveInProcess = true,
): WorktreeProvisioningSnapshot {
  const effectiveStatus =
    entry.status === 'provisioning' && !isLiveInProcess ? 'failed' : entry.status;
  const interrupted =
    entry.interruptedOnRestart || (entry.status === 'provisioning' && !isLiveInProcess);
  const error =
    effectiveStatus === 'failed'
      ? entry.error ?? (interrupted ? INTERRUPTED_PROVISIONING_MESSAGE : 'Worktree creation failed')
      : undefined;
  return {
    sessionId: entry.sessionId,
    status: effectiveStatus,
    ...(effectiveStatus === 'provisioning' && entry.stage ? { stage: entry.stage } : {}),
    ...(entry.name ? { name: entry.name } : {}),
    startedAt: entry.startedAt,
    ...(error ? { error } : {}),
    ...(interrupted ? { interruptedOnRestart: true } : {}),
  };
}

function isEntryOwnedByCurrent(
  entry: PersistedProvisioningEntry,
  currentOwnerScope: string | null,
): boolean {
  if (!currentOwnerScope || !entry.ownerScopeKey) return false;
  return entry.ownerScopeKey === currentOwnerScope;
}

/**
 * Shared two-phase worktree provisioning coordinator (Electron-free; used by Desktop & Node Host).
 *
 * Invariants:
 *  - Persists active/failed provisioning state in `<userData>/worktree-provisioning.json`
 *    (no SQLite schema migration).
 *  - Holds `WORKTREE_PROVISIONING_LOCK_ID` (`preserveOnStop: true`) throughout provisioning AND
 *    after failure so queued turns can NEVER drain into `baseRepo`.
 *  - Only unlocks after verifying the owner is current, session is still `active`, and DB
 *    `workingDir`/`worktreePath` are updated to the new worktree.
 *  - Deleting/archiving a provisioning session aborts in-flight creation immediately and
 *    discards any orphan worktree that completed concurrently.
 */
export function createHandoffProvisioningService(ports: HandoffProvisioningPorts) {
  const now = () => ports.now?.() ?? Date.now();
  const entries = new Map<string, PersistedProvisioningEntry>();
  const activeAttempts = new Map<string, ActiveAttempt>();
  const foreignEntries = new Map<string, PersistedProvisioningEntry>();
  const listeners = new Set<(sessionId: string, snapshot: WorktreeProvisioningSnapshot | null) => void>();
  let loadedFromDisk = false;
  const reconciledOwners = new WeakMap<object, Promise<void>>();

  function filePath(): string | null {
    const dir = ports.getUserDataDir();
    return dir ? path.join(dir, FILE_NAME) : null;
  }

  function ensureLoadedFromDisk(): void {
    if (loadedFromDisk) return;
    loadedFromDisk = true;
    const file = filePath();
    if (!file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries?: unknown };
      if (!Array.isArray(parsed.entries)) return;
      for (const raw of parsed.entries) {
        const item = raw as Partial<PersistedProvisioningEntry> | null;
        if (
          !item ||
          typeof item.sessionId !== 'string' ||
          !item.sessionId ||
          typeof item.baseRepo !== 'string' ||
          !item.baseRepo ||
          typeof item.workingDir !== 'string' ||
          !item.workingDir ||
          (item.status !== 'provisioning' && item.status !== 'failed') ||
          typeof item.startedAt !== 'number'
        ) {
          continue;
        }
        const entry: PersistedProvisioningEntry = {
          sessionId: item.sessionId,
          baseRepo: item.baseRepo,
          workingDir: item.workingDir,
          ...(typeof item.dispatcherSessionId === 'string'
            ? { dispatcherSessionId: item.dispatcherSessionId }
            : {}),
          ...(typeof item.sourceRef === 'string' ? { sourceRef: item.sourceRef } : {}),
          ...(typeof item.name === 'string' ? { name: item.name } : {}),
          status: item.status,
          ...(item.stage === 'queued' || item.stage === 'creating' ? { stage: item.stage } : {}),
          startedAt: item.startedAt,
          ...(typeof item.error === 'string' ? { error: item.error } : {}),
          ...(item.interruptedOnRestart === true ? { interruptedOnRestart: true } : {}),
          ...(typeof item.ownerScopeKey === 'string' ? { ownerScopeKey: item.ownerScopeKey } : {}),
        };
        foreignEntries.set(entry.sessionId, entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('worktree provisioning state file unreadable', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  function persistToDisk(): void {
    const file = filePath();
    if (!file) return;
    const merged = new Map<string, PersistedProvisioningEntry>();
    for (const [id, entry] of foreignEntries) merged.set(id, entry);
    for (const [id, entry] of entries) merged.set(id, entry);
    const list = [...merged.values()];
    try {
      if (list.length === 0) {
        fs.rmSync(file, { force: true });
        return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: list }));
      fs.renameSync(tmp, file);
    } catch (error) {
      log.warn('worktree provisioning state file write failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function emitChange(sessionId: string, snapshot: WorktreeProvisioningSnapshot | null): void {
    ports.onChanged?.(sessionId, snapshot);
    for (const listener of listeners) {
      try {
        listener(sessionId, snapshot);
      } catch {
        // Isolate subscriber failures.
      }
    }
  }

  function readOwnedEntry(sessionId: string): PersistedProvisioningEntry | null {
    ensureLoadedFromDisk();
    const ownerScope = ports.getOwnerScopeKey();
    const entry = entries.get(sessionId);
    if (entry && isEntryOwnedByCurrent(entry, ownerScope)) return entry;
    const diskEntry = foreignEntries.get(sessionId);
    if (diskEntry && isEntryOwnedByCurrent(diskEntry, ownerScope)) return diskEntry;
    return null;
  }

  async function settleBackgroundAttempt(
    sessionId: string,
    attempt: ActiveAttempt,
    result: PrepareHandoffWorktreeResult,
  ): Promise<void> {
    const currentAttempt = activeAttempts.get(sessionId);
    if (currentAttempt !== attempt || attempt.cancelled || !ports.isOwnerTokenCurrent(attempt.ownerToken)) {
      if (result.ok) {
        await ports.discardOrphanWorktree(sessionId, result.meta.path).catch(() => undefined);
      }
      return;
    }

    if (result.ok) {
      let lifecycle: Awaited<ReturnType<HandoffProvisioningPorts['readSessionLifecycle']>>;
      try {
        lifecycle = await ports.readSessionLifecycle(sessionId);
      } catch (err) {
        log.warn('worktree provisioning lifecycle check failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        await ports.discardOrphanWorktree(sessionId, result.meta.path).catch(() => undefined);
        return;
      }

      if (
        activeAttempts.get(sessionId) !== attempt ||
        attempt.cancelled ||
        !ports.isOwnerTokenCurrent(attempt.ownerToken)
      ) {
        await ports.discardOrphanWorktree(sessionId, result.meta.path).catch(() => undefined);
        return;
      }

      if (lifecycle.state !== 'active') {
        await ports.discardOrphanWorktree(sessionId, result.meta.path).catch(() => undefined);
        activeAttempts.delete(sessionId);
        entries.delete(sessionId);
        foreignEntries.delete(sessionId);
        persistToDisk();
        ports.setProvisioningLock(sessionId, false);
        emitChange(sessionId, null);
        return;
      }

      try {
        await ports.bindWorktreeToSession(sessionId, result.meta);
      } catch (err) {
        log.warn('worktree provisioning DB bind failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        const entry = entries.get(sessionId);
        if (entry && activeAttempts.get(sessionId) === attempt && !attempt.cancelled) {
          activeAttempts.delete(sessionId);
          entry.status = 'failed';
          delete entry.stage;
          entry.error = sanitizeProvisioningError(
            err instanceof Error ? err.message : String(err),
          );
          persistToDisk();
          emitChange(sessionId, toSnapshot(entry));
        }
        return;
      }

      if (
        activeAttempts.get(sessionId) !== attempt ||
        attempt.cancelled ||
        !ports.isOwnerTokenCurrent(attempt.ownerToken)
      ) {
        return;
      }

      ports.updateQueuedWorkingDir?.(sessionId, result.meta.path);
      activeAttempts.delete(sessionId);
      entries.delete(sessionId);
      foreignEntries.delete(sessionId);
      persistToDisk();
      ports.onWorktreeBound?.(sessionId, result.meta);
      emitChange(sessionId, null);
      ports.setProvisioningLock(sessionId, false);
      return;
    }

    // Failure branch: keep WORKTREE_PROVISIONING_LOCK_ID held so queued turns never drain into baseRepo.
    const entry = entries.get(sessionId);
    activeAttempts.delete(sessionId);
    if (!entry) return;
    entry.status = 'failed';
    delete entry.stage;
    entry.error = sanitizeProvisioningError(result.message);
    delete entry.interruptedOnRestart;
    persistToDisk();
    emitChange(sessionId, toSnapshot(entry));
  }

  function launchAttempt(
    entry: PersistedProvisioningEntry,
    handedOffInitially: boolean,
  ): ActiveAttempt {
    const controller = new AbortController();
    const ownerToken = ports.captureOwnerToken();
    const attempt: ActiveAttempt = {
      controller,
      ownerToken,
      handedOffToBackground: handedOffInitially,
      cancelled: false,
      promise: Promise.resolve(),
    };
    activeAttempts.set(entry.sessionId, attempt);

    attempt.promise = (async () => {
      let result: PrepareHandoffWorktreeResult;
      try {
        result = await ports.createWorktree({
          sessionId: entry.sessionId,
          baseRepo: entry.baseRepo,
          workingDir: entry.workingDir,
          dispatcherSessionId: entry.dispatcherSessionId,
          sourceRef: entry.sourceRef,
          signal: controller.signal,
          onStageChange: (stage) => {
            if (activeAttempts.get(entry.sessionId) !== attempt || attempt.cancelled) return;
            if (entry.stage === stage) return;
            entry.stage = stage;
            if (attempt.handedOffToBackground) {
              emitChange(entry.sessionId, toSnapshot(entry));
            }
          },
          onNameSelected: (name) => {
            if (activeAttempts.get(entry.sessionId) !== attempt || attempt.cancelled) return;
            if (entry.name === name) return;
            entry.name = name;
            persistToDisk();
            if (attempt.handedOffToBackground) {
              emitChange(entry.sessionId, toSnapshot(entry));
            }
          },
        });
      } catch (err) {
        result = {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }

      if (!attempt.handedOffToBackground) {
        attempt.fastOutcome = result;
        return;
      }
      await settleBackgroundAttempt(entry.sessionId, attempt, result);
    })();

    return attempt;
  }

  return {
    /**
     * Start worktree provisioning for a freshly inserted session row.
     * Waits up to `fastWaitMs` (0ms if queue is already busy):
     *  - `ready`: worktree already created, bound to DB, and unlocked (fast path).
     *  - `failed`: failed within threshold; record cleared and unlocked so caller can roll back.
     *  - `provisioning`: handed off to background; lock stays held and UI is notified.
     */
    async beginProvisioning(input: {
      sessionId: string;
      baseRepo: string;
      workingDir: string;
      dispatcherSessionId?: string;
      sourceRef?: string;
      fastWaitMs?: number;
    }): Promise<BeginProvisioningOutcome> {
      ensureLoadedFromDisk();
      const queueBusy = await ports.isQueueBusy(input.baseRepo).catch(() => false);
      const waitMs = queueBusy ? 0 : Math.max(0, input.fastWaitMs ?? ports.fastWaitMs ?? DEFAULT_FAST_WAIT_MS);
      const ownerScopeKey = ports.getOwnerScopeKey();
      if (!ownerScopeKey) {
        return { state: 'failed', message: 'No active data owner for worktree provisioning' };
      }
      const entry: PersistedProvisioningEntry = {
        sessionId: input.sessionId,
        baseRepo: input.baseRepo,
        workingDir: input.workingDir,
        ...(input.dispatcherSessionId ? { dispatcherSessionId: input.dispatcherSessionId } : {}),
        ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
        status: 'provisioning',
        stage: queueBusy ? 'queued' : 'creating',
        startedAt: now(),
        ownerScopeKey,
      };

      entries.set(input.sessionId, entry);
      foreignEntries.delete(input.sessionId);
      persistToDisk();
      ports.setProvisioningLock(input.sessionId, true);

      const attempt = launchAttempt(entry, false);

      if (waitMs > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            attempt.promise,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, waitMs);
              timer.unref?.();
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }

      // Single-threaded atomic handoff decision: either finished before deadline or moves to background.
      if (attempt.fastOutcome) {
        const outcome = attempt.fastOutcome;
        activeAttempts.delete(input.sessionId);
        entries.delete(input.sessionId);
        foreignEntries.delete(input.sessionId);
        persistToDisk();

        if (!outcome.ok) {
          ports.setProvisioningLock(input.sessionId, false);
          return { state: 'failed', message: outcome.message };
        }

        try {
          await ports.bindWorktreeToSession(input.sessionId, outcome.meta);
        } catch (err) {
          await ports.discardOrphanWorktree(input.sessionId, outcome.meta.path).catch(() => undefined);
          ports.setProvisioningLock(input.sessionId, false);
          return {
            state: 'failed',
            message: err instanceof Error ? err.message : String(err),
          };
        }
        ports.updateQueuedWorkingDir?.(input.sessionId, outcome.meta.path);
        ports.setProvisioningLock(input.sessionId, false);
        return {
          state: 'ready',
          meta: outcome.meta,
          ...(outcome.staleBaseReason ? { staleBaseReason: outcome.staleBaseReason } : {}),
        };
      }

      attempt.handedOffToBackground = true;
      const snapshot = toSnapshot(entry);
      emitChange(input.sessionId, snapshot);
      return { state: 'provisioning', snapshot };
    },

    /** Explicitly retry a failed (or restart-interrupted) worktree provisioning for an active task. */
    async retryProvisioning(sessionId: string): Promise<RetryProvisioningResult> {
      ensureLoadedFromDisk();
      const entry = readOwnedEntry(sessionId);
      if (!entry) {
        return { ok: false, errorCode: 'NOT_FOUND', message: '该任务没有待重试的 worktree 创建记录。' };
      }
      if (entry.status !== 'failed' || activeAttempts.has(sessionId)) {
        return {
          ok: false,
          errorCode: 'PRECONDITION_FAILED',
          message: 'worktree 正在创建中，请勿重复重试。',
        };
      }
      // Reserve this existing state before the first await so a second retry cannot
      // pass the same failed-state check and launch a second worktree creation.
      const ownerToken = ports.captureOwnerToken();
      if (!ownerToken) {
        return { ok: false, errorCode: 'PRECONDITION_FAILED', message: '当前账号尚未就绪。' };
      }
      entry.status = 'provisioning';
      const stillCurrent = () =>
        ports.isOwnerTokenCurrent(ownerToken) &&
        readOwnedEntry(sessionId) === entry &&
        entry.status === 'provisioning';
      let lifecycle: Awaited<ReturnType<HandoffProvisioningPorts['readSessionLifecycle']>>;
      try {
        lifecycle = await ports.readSessionLifecycle(sessionId);
      } catch (error) {
        if (stillCurrent()) entry.status = 'failed';
        return {
          ok: false,
          errorCode: 'INTERNAL',
          message: sanitizeProvisioningError(error instanceof Error ? error.message : String(error)),
        };
      }
      if (!stillCurrent()) {
        return { ok: false, errorCode: 'PRECONDITION_FAILED', message: '账号或任务状态已变化。' };
      }
      if (lifecycle.state !== 'active') {
        entries.delete(sessionId);
        foreignEntries.delete(sessionId);
        persistToDisk();
        ports.setProvisioningLock(sessionId, false);
        emitChange(sessionId, null);
        return {
          ok: false,
          errorCode: 'PRECONDITION_FAILED',
          message: '任务已归档或删除，无法重试创建 worktree。',
        };
      }

      const queueBusy = await ports.isQueueBusy(entry.baseRepo).catch(() => false);
      if (!stillCurrent()) {
        return { ok: false, errorCode: 'PRECONDITION_FAILED', message: '账号或任务状态已变化。' };
      }
      entry.stage = queueBusy ? 'queued' : 'creating';
      entry.startedAt = now();
      delete entry.error;
      delete entry.interruptedOnRestart;
      entries.set(sessionId, entry);
      foreignEntries.delete(sessionId);
      persistToDisk();
      ports.setProvisioningLock(sessionId, true);

      launchAttempt(entry, true);
      const snapshot = toSnapshot(entry);
      emitChange(sessionId, snapshot);
      return { ok: true, snapshot };
    },

    /** Abort any in-flight provisioning and clear state (called when task is deleted/archived). */
    cancelProvisioning(sessionId: string): void {
      ensureLoadedFromDisk();
      const attempt = activeAttempts.get(sessionId);
      if (attempt) {
        attempt.cancelled = true;
        activeAttempts.delete(sessionId);
        attempt.controller.abort(new Error('Task ended during worktree provisioning'));
      }
      const hadEntry = entries.delete(sessionId) || foreignEntries.delete(sessionId);
      if (hadEntry) {
        persistToDisk();
      }
      if (attempt || hadEntry) {
        ports.setProvisioningLock(sessionId, false);
        emitChange(sessionId, null);
      }
    },

    /**
     * Startup / owner-ready reconciliation:
     *  - Leftover `provisioning` records from a previous process become `failed` (`interruptedOnRestart`).
     *  - Records whose session was deleted/archived or already has a bound worktree are cleaned up.
     *  - Remaining failed records re-apply `WORKTREE_PROVISIONING_LOCK_ID` so queued inputs stay blocked.
     */
    async reconcileForCurrentOwner(): Promise<void> {
      ensureLoadedFromDisk();
      const ownerToken = ports.captureOwnerToken();
      if (!ownerToken) return;
      let run = reconciledOwners.get(ownerToken);
      if (run) return run;
      run = (async () => {
        const ownerScope = ports.getOwnerScopeKey();
        const candidates = [...foreignEntries.values()].filter((entry) =>
          isEntryOwnedByCurrent(entry, ownerScope),
        );
        if (candidates.length === 0) return;

        let dirty = false;
        const currentTime = now();
        for (const entry of candidates) {
          if (!ports.isOwnerTokenCurrent(ownerToken)) break;
          if (activeAttempts.has(entry.sessionId)) continue;

          let lifecycle: Awaited<ReturnType<HandoffProvisioningPorts['readSessionLifecycle']>>;
          try {
            lifecycle = await ports.readSessionLifecycle(entry.sessionId);
          } catch {
            continue;
          }
          if (!ports.isOwnerTokenCurrent(ownerToken)) break;

          if (lifecycle.state === 'missing') {
            if (!entry.ownerScopeKey || currentTime - entry.startedAt >= FOREIGN_ENTRY_TTL_MS) {
              foreignEntries.delete(entry.sessionId);
              dirty = true;
            }
            continue;
          }

          if (lifecycle.state === 'terminal' || lifecycle.hasWorktreePath) {
            foreignEntries.delete(entry.sessionId);
            entries.delete(entry.sessionId);
            dirty = true;
            continue;
          }

          // Crash right after worktreeStore.set but before DB update: recover seamlessly.
          const registered = ports.getRegisteredWorktree?.(entry.sessionId) ?? null;
          if (registered) {
            try {
              await ports.bindWorktreeToSession(entry.sessionId, registered);
              ports.updateQueuedWorkingDir?.(entry.sessionId, registered.path);
              foreignEntries.delete(entry.sessionId);
              entries.delete(entry.sessionId);
              dirty = true;
              ports.onWorktreeBound?.(entry.sessionId, registered);
              ports.setProvisioningLock(entry.sessionId, false);
              emitChange(entry.sessionId, null);
              continue;
            } catch (err) {
              log.warn('reconcile worktree backfill failed', {
                sessionId: entry.sessionId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          if (entry.status === 'provisioning') {
            entry.status = 'failed';
            delete entry.stage;
            entry.interruptedOnRestart = true;
            entry.error = INTERRUPTED_PROVISIONING_MESSAGE;
            dirty = true;
          }
          foreignEntries.delete(entry.sessionId);
          entries.set(entry.sessionId, entry);
          ports.setProvisioningLock(entry.sessionId, true);
          emitChange(entry.sessionId, toSnapshot(entry));
        }

        if (dirty) persistToDisk();
      })();
      reconciledOwners.set(ownerToken, run);
      return run;
    },

    /** Enforce the provisioning lock defensively whenever a session's queue is restored or touched. */
    enforceLockIfBlocked(sessionId: string): boolean {
      const blocked = readOwnedEntry(sessionId) !== null;
      if (blocked) {
        ports.setProvisioningLock(sessionId, true);
      }
      return blocked;
    },

    /** True while worktree provisioning is in-flight OR has failed and awaits retry/deletion. */
    isBlocked(sessionId: string): boolean {
      return readOwnedEntry(sessionId) !== null;
    },

    getSnapshot(sessionId: string): WorktreeProvisioningSnapshot | null {
      const entry = readOwnedEntry(sessionId);
      return entry ? toSnapshot(entry, activeAttempts.has(sessionId)) : null;
    },

    listSnapshots(): WorktreeProvisioningSnapshot[] {
      ensureLoadedFromDisk();
      const ownerScope = ports.getOwnerScopeKey();
      const out = new Map<string, WorktreeProvisioningSnapshot>();
      for (const entry of foreignEntries.values()) {
        if (isEntryOwnedByCurrent(entry, ownerScope)) {
          out.set(entry.sessionId, toSnapshot(entry, activeAttempts.has(entry.sessionId)));
        }
      }
      for (const entry of entries.values()) {
        if (isEntryOwnedByCurrent(entry, ownerScope)) {
          out.set(entry.sessionId, toSnapshot(entry, activeAttempts.has(entry.sessionId)));
        }
      }
      return [...out.values()];
    },

    subscribe(
      listener: (sessionId: string, snapshot: WorktreeProvisioningSnapshot | null) => void,
    ): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** Wait for any active background attempt (useful in tests / graceful shutdown). */
    whenIdle(sessionId?: string): Promise<void> {
      if (sessionId) {
        return activeAttempts.get(sessionId)?.promise ?? Promise.resolve();
      }
      return Promise.all([...activeAttempts.values()].map((a) => a.promise)).then(() => undefined);
    },

    /** Abort active in-memory attempts when switching accounts without erasing disk records. */
    onOwnerChanged(): void {
      for (const [sessionId, attempt] of activeAttempts) {
        attempt.cancelled = true;
        attempt.controller.abort(new Error('Account owner changed during worktree provisioning'));
        activeAttempts.delete(sessionId);
      }
      for (const [sessionId, entry] of entries) {
        foreignEntries.set(sessionId, entry);
      }
      entries.clear();
    },
  };
}

export type HandoffProvisioningService = ReturnType<typeof createHandoffProvisioningService>;

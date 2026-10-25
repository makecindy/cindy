import { normalizeAgentInputClearBoundaryMs } from '@cindy/maker-shared/agent-input-queue';
import { throwIpcError } from '@cindy/remote-agent/ipcValidate';
import type { MainOwnedInputBoundaryStamp } from '@cindy/im-runtime/mobileClientPromptNote';
import type { createSessionSnapshot } from '@cindy/runtime-db/sessionSnapshot';
import type { DbLogger } from '@cindy/runtime-db/logging';
import type { AgentInputCoordinator } from './agent-input-coordinator.js';
export interface MakerInputBoundaryHost extends Pick<ReturnType<typeof createSessionSnapshot>, 'getSessionRowSnapshotStrict' | 'getSessionRowSnapshot'> {
  inputCoordinator: Pick<AgentInputCoordinator<unknown>, 'getClearBoundaryMs' | 'getGeneration' | 'isGenerationCurrent' | 'observeClearBoundary' | 'getInputAbortSignal'>;
  clearSessionContextInDb(id: string, atMs: number): Promise<void>;
  getPersistedInputClientIds(id: string, clientIds: string[]): Promise<Set<string>>;
  assertReviewExternalInputAllowed(id: string): Promise<void>;
  log: DbLogger;
}
export function createMakerInputBoundary(host: MakerInputBoundaryHost) {
  const { inputCoordinator, getSessionRowSnapshotStrict, getSessionRowSnapshot, clearSessionContextInDb, getPersistedInputClientIds, assertReviewExternalInputAllowed, log } = host;
  const inputClearInFlightSessions = new Map<string, number>();
  const beginRemoteInputClearGate = (sessionId: string): void => {
    inputClearInFlightSessions.set(sessionId, (inputClearInFlightSessions.get(sessionId) ?? 0) + 1);
  };
  const endRemoteInputClearGate = (sessionId: string): void => {
    const count = inputClearInFlightSessions.get(sessionId) ?? 0;
    if (count <= 1) inputClearInFlightSessions.delete(sessionId);
    else inputClearInFlightSessions.set(sessionId, count - 1);
  };
  const assertRemoteInputClearNotInFlight = (sessionId: string, remote: boolean): void => {
    if (!remote || !inputClearInFlightSessions.has(sessionId)) return;
    throwIpcError(
      'PRECONDITION_FAILED',
      'REMOTE_OPTIMISTIC_INPUT_CLEARED: session clear is still sealing',
    );
  };
  const getInputSessionRow = async (sid: string) => {
    try {
      const row = await getSessionRowSnapshotStrict(sid);
      if (!row || row.status === 'deleted') {
        throwIpcError('NOT_FOUND', `Session ${sid} not found`);
      }
      return row;
    } catch (error) {
      if (error instanceof Error && (error as { code?: unknown }).code === 'NOT_FOUND') {
        throw error;
      }
      log.warn('[device-link] input session state unavailable', {
        sessionId: sid,
        err: error instanceof Error ? error.message : String(error),
      });
      throwIpcError(
        'INTERNAL',
        'REMOTE_OPTIMISTIC_SESSION_STATE_UNAVAILABLE: session state unavailable',
      );
    }
  };

  const readRemoteInputClearBoundaryPrecondition = (
    opts: unknown,
  ): { present: false } | { present: true; expected: number | null } => {
    if (
      !opts ||
      typeof opts !== 'object' ||
      !Object.prototype.hasOwnProperty.call(opts, 'expectedClearBoundaryMs')
    ) {
      return { present: false };
    }
    const expected = normalizeAgentInputClearBoundaryMs(
      (opts as { expectedClearBoundaryMs?: unknown }).expectedClearBoundaryMs,
    );
    if (expected === undefined) {
      throwIpcError(
        'INVALID_PARAMS',
        'expectedClearBoundaryMs must be null or a non-negative finite number',
      );
    }
    return { present: true, expected };
  };

  const readExpectedInputGeneration = (opts: unknown): number | undefined => {
    if (
      !opts ||
      typeof opts !== 'object' ||
      Array.isArray(opts) ||
      !Object.prototype.hasOwnProperty.call(opts, 'expectedInputGeneration')
    ) {
      return undefined;
    }
    const value = (opts as { expectedInputGeneration?: unknown }).expectedInputGeneration;
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throwIpcError(
        'INVALID_PARAMS',
        'expectedInputGeneration must be a non-negative safe integer',
      );
    }
    return value;
  };

  const assertCurrentInputGeneration = (sid: string, expected: number | undefined): void => {
    if (expected === undefined || inputCoordinator.isGenerationCurrent(sid, expected)) return;
    throwIpcError(
      'PRECONDITION_FAILED',
      'REMOTE_OPTIMISTIC_INPUT_SUPERSEDED: input preparation was superseded',
    );
  };

  const assertExpectedRemoteInputClearBoundary = (
    sid: string,
    precondition: { present: false } | { present: true; expected: number | null },
    sessionRow?: { clearedAt?: unknown } | null,
  ): void => {
    const inMemory = inputCoordinator.getClearBoundaryMs(sid);
    const persisted = normalizeAgentInputClearBoundaryMs(sessionRow?.clearedAt);
    // A clear is applied to the in-memory coordinator before the DB await. If
    // that await failed, accepting another remote control would make the new
    // epoch usable only until a host restart resurrects the old DB boundary.
    // Fail closed until a later clear/session snapshot catches the durable row
    // up; local renderer operations remain available.
    if (typeof inMemory === 'number' && (typeof persisted !== 'number' || persisted < inMemory)) {
      throwIpcError(
        'PRECONDITION_FAILED',
        `REMOTE_OPTIMISTIC_INPUT_CLEARED: clear boundary persistence pending (currentClearBoundaryMs=${inMemory})`,
      );
    }
    if (!precondition.present) return;
    const current =
      inMemory === null
        ? (persisted ?? null)
        : persisted === null || persisted === undefined
          ? inMemory
          : Math.max(inMemory, persisted);
    if (precondition.expected === current) return;
    throwIpcError(
      'PRECONDITION_FAILED',
      `REMOTE_OPTIMISTIC_INPUT_CLEARED: expectedClearBoundaryMs=${precondition.expected ?? 'null'}; currentClearBoundaryMs=${current ?? 'null'}`,
    );
  };

  // Final vendor/steer fences run synchronously and cannot perform another DB
  // read.  The IPC entry already compared the durable row; here we only need
  // to prove that the main-owned in-memory epoch did not advance meanwhile.
  const assertCurrentInputClearBoundary = (sid: string, expected: number | null): void => {
    const current = inputCoordinator.getClearBoundaryMs(sid);
    if (current === expected) return;
    throwIpcError(
      'PRECONDITION_FAILED',
      `REMOTE_OPTIMISTIC_INPUT_CLEARED: expectedClearBoundaryMs=${expected ?? 'null'}; currentClearBoundaryMs=${current ?? 'null'}`,
    );
  };

  /**
   * The coordinator advances its in-memory clear epoch before the DB write.
   * If that write transiently fails, retry it at the next input/projection
   * boundary instead of leaving remote sends permanently sealed until restart.
   * A failed retry remains fail-closed for remote callers; local renderer
   * callers keep their historical fail-soft read semantics.
   */
  const retryPendingInputClearBoundary = async (
    sid: string,
    remote: boolean,
    row: { clearedAt?: unknown } | null,
  ): Promise<{ clearedAt?: unknown } | null> => {
    const inMemory = inputCoordinator.getClearBoundaryMs(sid);
    const persisted = normalizeAgentInputClearBoundaryMs(row?.clearedAt);
    if (typeof inMemory !== 'number' || (typeof persisted === 'number' && persisted >= inMemory)) {
      return row;
    }
    try {
      await clearSessionContextInDb(sid, inMemory);
      return remote ? await getInputSessionRow(sid) : await getSessionRowSnapshot(sid);
    } catch (err) {
      log.warn('pending clear boundary persistence retry failed', {
        sessionId: sid,
        boundaryMs: inMemory,
        remote,
        err: err instanceof Error ? err.message : String(err),
      });
      return row;
    }
  };

  const observeLocalInputClearBoundary = async (sid: string): Promise<void> => {
    const row = await getSessionRowSnapshot(sid);
    const durableRow = await retryPendingInputClearBoundary(sid, false, row);
    inputCoordinator.observeClearBoundary(sid, durableRow?.clearedAt);
  };

  const remoteInputClientIdWasPersisted = async (
    sid: string,
    clientId: string,
  ): Promise<boolean> => {
    try {
      const persisted = await getPersistedInputClientIds(sid, [clientId]);
      return persisted.has(clientId);
    } catch (err) {
      log.warn('[device-link] durable input clientId lookup unavailable', {
        sessionId: sid,
        clientId,
        err: err instanceof Error ? err.message : String(err),
      });
      // A failed dedupe query is fail-closed: retrying the same optimistic
      // record is safer than dispatching it twice after a host restart.
      throwIpcError(
        'INTERNAL',
        'REMOTE_OPTIMISTIC_SESSION_STATE_UNAVAILABLE: input dedupe state unavailable',
      );
    }
  };

  const assertRemoteInputControlBoundary = async (
    sid: string,
    remote: boolean,
    opts: unknown,
    intent: 'external-input' | 'stop' = 'external-input',
  ): Promise<MainOwnedInputBoundaryStamp> => {
    // Stop is lifecycle control rather than external input. Keep the exception
    // local-only: this Review version does not expand Device Link control.
    if (intent !== 'stop' || remote) await assertReviewExternalInputAllowed(sid);
    // Capture the coordinator generation before the first database await.  A
    // concurrent /clear replaces the in-memory state; after that await we must
    // reject the old request rather than treating the new generation as its
    // baseline (same-ms clears are why the generation travels with the token).
    const expectedInputGeneration = inputCoordinator.getGeneration(sid);
    const precondition = readRemoteInputClearBoundaryPrecondition(opts);
    assertRemoteInputClearNotInFlight(sid, remote);
    if (remote) {
      const row = await getInputSessionRow(sid);
      const durableRow = await retryPendingInputClearBoundary(sid, true, row);
      if (!inputCoordinator.isGenerationCurrent(sid, expectedInputGeneration)) {
        throwIpcError(
          'PRECONDITION_FAILED',
          'REMOTE_OPTIMISTIC_INPUT_SUPERSEDED: input preparation was superseded',
        );
      }
      if (!durableRow) throwIpcError('NOT_FOUND', `Session ${sid} not found`);
      inputCoordinator.observeClearBoundary(sid, durableRow.clearedAt);
      assertRemoteInputClearNotInFlight(sid, true);
      assertExpectedRemoteInputClearBoundary(sid, precondition, durableRow);
    }
    return {
      expectedClearBoundaryMs: inputCoordinator.getClearBoundaryMs(sid),
      expectedInputGeneration,
      inputAbortSignal: inputCoordinator.getInputAbortSignal(sid, expectedInputGeneration),
    };
  };

  return { getInputSessionRow, readRemoteInputClearBoundaryPrecondition, readExpectedInputGeneration, assertCurrentInputGeneration, assertExpectedRemoteInputClearBoundary, assertCurrentInputClearBoundary, retryPendingInputClearBoundary, observeLocalInputClearBoundary, remoteInputClientIdWasPersisted, assertRemoteInputControlBoundary, beginRemoteInputClearGate, endRemoteInputClearGate, assertRemoteInputClearNotInFlight };
}

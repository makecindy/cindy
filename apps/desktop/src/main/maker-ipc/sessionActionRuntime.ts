import { throwIpcError } from '../utils/ipcValidate.js';
import { withSendToSessionLock } from './sendToSessionLock.js';

export type SessionRuntimeAction = 'rewind' | 'pi-history' | 'compact';

interface StoredSession {
  status: string;
  agentKind: string | null;
  sdkSessionId: string | null;
  agentDeviceId?: string | null;
  remoteHostId?: string | null;
}

/** Prepare native history without sending a synthetic user turn. The existing send
 * lock serializes this with sends, route changes and other cold-start callers. */
export function createSessionActionRuntime<Row extends StoredSession, Live>(deps: {
  getLive(sessionId: string): Live | undefined;
  load(sessionId: string): Promise<Row | undefined>;
  ownerGeneration(): number;
  resume(sessionId: string, row: Row, assertCurrent: () => void): Promise<Live>;
  close(sessionId: string, live: Live): Promise<void>;
  /** Claude keeps the native rewind pending on the live handle until the next send. */
  holdsPendingRewind(live: Live): boolean;
}) {
  // Runtimes started only for a history action. The renderer's start-time
  // preferences (personal prompt, memory switch) are not stored in the DB, so
  // such a runtime must not stay around for the next send to reuse.
  const restored = new Map<string, Live>();
  const prepare = async (sessionId: string, action: SessionRuntimeAction): Promise<Live | null> => {
    const generation = deps.ownerGeneration();
    const assertCurrent = () => {
      if (deps.ownerGeneration() !== generation) {
        throwIpcError('PRECONDITION_FAILED', 'Account changed while preparing task history');
      }
    };
    return withSendToSessionLock(sessionId, async () => {
      assertCurrent();
      const live = deps.getLive(sessionId);
      if (live) return live;
      const row = await deps.load(sessionId);
      assertCurrent();
      if (!row) throwIpcError('NOT_FOUND', 'Task no longer exists');
      if (row.status !== 'active') {
        throwIpcError('PRECONDITION_FAILED', 'Task is archived or deleted');
      }
      if (action === 'pi-history' && row.agentKind !== 'pi') return null;
      if (action === 'compact' && row.agentKind !== 'pi' && row.agentKind !== 'codex') return null;
      // The strict-resume marker does not travel to another computer's executor, so
      // a missing native history there could be silently replaced by an empty one.
      // Rewind and compact rewrite history: leave them to the computer that runs it.
      if (action !== 'pi-history' && row.agentDeviceId && !row.remoteHostId) {
        throwIpcError('PRECONDITION_FAILED', 'Restore this task on the computer that runs it first');
      }
      if (!row.sdkSessionId || row.sdkSessionId === '<pending>') {
        // A previous first-turn Claude rewind deliberately detached the native
        // history. Orchestration can still rewind the remaining DB projection.
        if (action === 'rewind' && row.agentKind === 'cc') return null;
        throwIpcError('PRECONDITION_FAILED', 'Task has no native history to restore');
      }
      const resumed = await deps.resume(sessionId, row, assertCurrent);
      // Tree browsing and export restore the Pi runtime as they always did; only
      // the new rewind/compact restores are released after their action.
      if (action !== 'pi-history') restored.set(sessionId, resumed);
      assertCurrent();
      return resumed;
    });
  };
  /** Close a runtime this module restored, so the next send starts it with the
   * caller's own start options. A no-op for runtimes that were already live. */
  const release = (sessionId: string, opts?: { rewindCommitted?: boolean }): Promise<void> =>
    withSendToSessionLock(sessionId, async () => {
      const session = restored.get(sessionId);
      if (session === undefined) return;
      restored.delete(sessionId);
      // A committed Claude rewind is only applied by the handle's next send, so
      // closing it now would resume the untrimmed native conversation.
      if (opts?.rewindCommitted && deps.holdsPendingRewind(session)) return;
      if (deps.getLive(sessionId) === session) await deps.close(sessionId, session);
    });
  return Object.assign(prepare, { release });
}

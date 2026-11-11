import { throwIpcError } from '../utils/ipcValidate.js';
import { withSendToSessionLock } from './sendToSessionLock.js';

export type SessionRuntimeAction = 'rewind' | 'pi-history' | 'compact';

interface StoredSession {
  status: string;
  agentKind: string | null;
  sdkSessionId: string | null;
}

/** Prepare native history without sending a synthetic user turn. The existing send
 * lock serializes this with sends, route changes and other cold-start callers. */
export function createSessionActionRuntime<Row extends StoredSession, Live>(deps: {
  getLive(sessionId: string): Live | undefined;
  load(sessionId: string): Promise<Row | undefined>;
  ownerGeneration(): number;
  resume(sessionId: string, row: Row, assertCurrent: () => void): Promise<Live>;
}) {
  return async (sessionId: string, action: SessionRuntimeAction): Promise<Live | null> => {
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
      if (!row.sdkSessionId || row.sdkSessionId === '<pending>') {
        // A previous first-turn Claude rewind deliberately detached the native
        // history. Orchestration can still rewind the remaining DB projection.
        if (action === 'rewind' && row.agentKind === 'cc') return null;
        throwIpcError('PRECONDITION_FAILED', 'Task has no native history to restore');
      }
      const resumed = await deps.resume(sessionId, row, assertCurrent);
      assertCurrent();
      return resumed;
    });
  };
}

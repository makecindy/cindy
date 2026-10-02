import { isIpcError } from '../../shared/ipc-errors.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { revalidateSessionOperation } from './operationContext.js';
import { SessionAdmissionError } from './controller.js';

export interface StopBackgroundTaskDeps {
  getLiveSession(sessionId: string): { stopBackgroundTask(taskId: string): Promise<void> } | undefined;
  stopDetachedTask?(sessionId: string, taskId: string): Promise<boolean>;
}

/** Stop one exact task, preferring detached ownership over the current harness. */
export function createStopBackgroundTask(deps: StopBackgroundTaskDeps) {
  return async (sessionId: string, taskId: string): Promise<{ ok: true }> => {
    await revalidateSessionOperation();
    const session = deps.getLiveSession(sessionId);
    try {
      if (await deps.stopDetachedTask?.(sessionId, taskId)) return { ok: true as const };
      await revalidateSessionOperation();
      if (!session) return { ok: true as const };
      await session.stopBackgroundTask(taskId);
    } catch (e) {
      // A deliberate IPC error from the detached fallback (currently: the run
      // belongs to another live instance) is already a user-facing verdict
      // with its own code. Relabelling it INTERNAL would hide why the stop
      // did not land.
      if (isIpcError(e) || e instanceof SessionAdmissionError) throw e;
      // NotSupportedError(Session 层)与 claude handle 的 'not supported' 明文
      // 都归一到 UNSUPPORTED_CAPABILITY;其余(stopTask RPC 失败等)走 INTERNAL,
      // 不把内部堆栈原样透出。
      const message = e instanceof Error ? e.message : String(e);
      if ((e instanceof Error && e.name === 'NotSupportedError') || /not supported/i.test(message)) {
        throwIpcError('UNSUPPORTED_CAPABILITY', 'stopBackgroundTask is not supported for this session');
      }
      throwIpcError('INTERNAL', `failed to stop background task: ${message}`);
    }
    return { ok: true as const };
  };
}

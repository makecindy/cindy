import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface StopAgentTaskHandlerDeps {
  stopBackgroundTask(event: unknown, sessionId: string, taskId: string): Promise<{ ok: true }>;
}

/** Transport validation only; exact background-task control belongs to Session. */
export function registerStopAgentTaskHandler(registry: IpcHandlerRegistry, deps: StopAgentTaskHandlerDeps): void {
  registry.handle(MAKER_INVOKE.STOP_AGENT_TASK, async (event, sessionId: unknown, taskId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId) throwIpcError('INVALID_PARAMS', 'sessionId required');
    if (typeof taskId !== 'string' || !taskId) throwIpcError('INVALID_PARAMS', 'taskId required');
    return deps.stopBackgroundTask(event, sessionId, taskId);
  });
}

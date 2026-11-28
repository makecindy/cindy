import { parseSessionStatusIds, type PluginObserveTask, type PluginSessionStatus } from '../../shared/pluginObserve.js';

export interface PluginObserveAdapter {
  projectTasks(project: string): Promise<PluginObserveTask[]>;
  /** Rejects with TARGET_UNAVAILABLE unless projectTasks could list the task; calls guard right before opening. */
  openTask(taskId: string, guard: () => void): Promise<void>;
  openSession?(sessionId: string, deviceId: string | undefined, guard: () => void): Promise<void>;
  sessionStatus?(sessionIds: string[], deviceId: string | undefined, guard: () => void): Promise<PluginSessionStatus[]>;
}

const OBSERVE_ERROR_CODES = new Set(['PERMISSION_DENIED', 'HOST_NOT_READY', 'INVALID_PARAMS', 'TARGET_UNAVAILABLE', 'REMOTE_UNAVAILABLE', 'UNSUPPORTED_CAPABILITY']);
const MAX_ID_LENGTH = 4096;

const fail = (code: string) => ({ ok: false as const, error: { code, message: code, retryable: false } });
const idParam = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' && value.length <= MAX_ID_LENGTH ? value : null;

/**
 * Read-only `cindy.observe`. The caller has already confirmed the plugin's
 * independent observe approval; `assertAuthorized` re-checks it after each await.
 */
export async function handlePluginObserveRequest(
  adapter: PluginObserveAdapter | null,
  payload: unknown,
  assertAuthorized: () => void,
  hasHistoryApproval: () => boolean = () => false,
) {
  if (!adapter) return fail('HOST_NOT_READY');
  const request = payload as { kind?: unknown; project?: unknown; taskId?: unknown; sessionId?: unknown; sessionIds?: unknown; deviceId?: unknown } | null;
  try {
    if (request?.kind === 'project-tasks') {
      const project = idParam(request.project);
      if (!project) return fail('INVALID_PARAMS');
      const tasks = await adapter.projectTasks(project);
      assertAuthorized();
      return { ok: true as const, data: { tasks } };
    }
    if (request?.kind === 'open-task') {
      const taskId = idParam(request.taskId);
      if (!taskId) return fail('INVALID_PARAMS');
      await adapter.openTask(taskId, assertAuthorized);
      return { ok: true as const, data: { opened: true } };
    }
    if (request?.kind === 'open-session' || request?.kind === 'session-status') {
      const { deviceId } = request;
      if (deviceId !== undefined && (typeof deviceId !== 'string' || !/^[\w.-]{1,256}$/.test(deviceId))) return fail('INVALID_PARAMS');
      const guard = () => {
        assertAuthorized();
        if (!hasHistoryApproval()) throw new Error('PERMISSION_DENIED');
      };
      if (request.kind === 'session-status') {
        const ids = parseSessionStatusIds(request.sessionIds);
        if (!ids) return fail('INVALID_PARAMS');
        guard();
        if (!adapter.sessionStatus) return fail('UNSUPPORTED_CAPABILITY');
        const sessions = await adapter.sessionStatus(ids, deviceId, guard);
        guard();
        return { ok: true as const, data: { sessions } };
      }
      const sessionId = idParam(request.sessionId);
      if (!sessionId || sessionId.includes('::') || /[\u0000-\u001f\u007f]/.test(sessionId)) return fail('INVALID_PARAMS');
      guard();
      if (!adapter.openSession) return fail('HOST_NOT_READY');
      await adapter.openSession(sessionId, deviceId, guard);
      return { ok: true as const, data: { opened: true } };
    }
    return fail('INVALID_PARAMS');
  } catch (error) {
    const code = (error as { code?: unknown })?.code ?? (error instanceof Error ? error.message : '');
    return fail(OBSERVE_ERROR_CODES.has(String(code)) ? String(code) : 'HOST_NOT_READY');
  }
}
